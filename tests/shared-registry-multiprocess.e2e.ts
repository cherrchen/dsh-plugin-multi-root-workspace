/** Independent V8 heaps, real kernel locks, real JSON store and attested IPC. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`shared Registry native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available)
type Row = { path: string; access: string; alias?: string }
class Host {
  readonly child: ChildProcessWithoutNullStreams
  private next = 0
  private stderr = ''
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly events = new Map<number, () => void>()
  readonly ready: Promise<void>
  constructor(root: string, primary: string) {
    this.child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./support/shared-authority-child.ts', import.meta.url)), JSON.stringify({ root, primary })], { stdio: 'pipe' })
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192) })
    const ready = Promise.withResolvers<void>(); this.ready = ready.promise
    createInterface({ input: this.child.stdout }).on('line', line => {
      // Cordis diagnostics may share stdout; only our NDJSON is a reply.
      if (!line.startsWith('{')) return
      const reply = JSON.parse(line)
      if (reply.ready) {
        if (!['active', 'follower'].includes(reply.authority)) ready.reject(new Error(reply.unavailable))
        else ready.resolve()
      } else if (reply.event) this.events.get(reply.id)?.()
      else {
        const request = this.pending.get(reply.id)
        this.pending.delete(reply.id)
        if (reply.error) request?.reject(new Error(reply.error))
        else request?.resolve(reply.value)
      }
    })
    const fail = (error: Error) => { ready.reject(error); for (const request of this.pending.values()) request.reject(error); this.pending.clear() }
    this.child.once('error', fail)
    this.child.once('exit', (code, signal) => fail(new Error(`Host exited (${code}/${signal}): ${this.stderr}`)))
  }
  async request<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const { result } = this.send<T>(method, args)
    return result
  }
  send<T>(method: string, args: unknown[]) {
    const id = ++this.next, reply = Promise.withResolvers<unknown>()
    this.pending.set(id, reply)
    const admitted = Promise.withResolvers<void>()
    if (method === 'pause-write') this.events.set(id, admitted.resolve)
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n')
    const timeout = setTimeout(() => reply.reject(new Error(`Host request timed out: ${method}: ${this.stderr}`)), 10_000)
    const result = reply.promise.finally(() => { clearTimeout(timeout); this.pending.delete(id); this.events.delete(id) }) as Promise<T>
    return { result, admitted: admitted.promise }
  }
  async kill(signal: NodeJS.Signals = 'SIGKILL') {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit'); this.child.kill(signal); await exited
  }
}
let fixture: FixtureWorkspace, hosts: Host[]
beforeEach(() => { fixture = createFixtureWorkspace('multiprocess'); hosts = [] })
afterEach(async () => { await Promise.allSettled(hosts.map(host => host.kill())); fixture.dispose() })
async function mount(primary = fixture.workspace) {
  const host = new Host(join(fixture.base, 'store'), primary); hosts.push(host)
  await host.ready; return host
}

nativeTest('serializes concurrent mutations from separate heaps without losing either primary', async () => {
  const a = await mount(), b = await mount(), primary2 = join(fixture.base, 'second-primary')
  mkdirSync(primary2)
  const c = await mount(primary2)
  const roots = Array.from({ length: 8 }, (_, i) => join(fixture.base, `root-${i}`))
  roots.forEach(path => mkdirSync(path))
  await Promise.all(roots.map((path, i) => (i % 2 ? b : a).request('add', [path])))
  await c.request('add', [fixture.outside])
  expect((await a.request<Row[]>('list')).map(row => row.path).sort()).toEqual([...roots].sort())
  expect((await b.request<Row[]>('list')).map(row => row.path).sort()).toEqual([...roots].sort())
  expect((await c.request<Row[]>('list')).map(row => row.path)).toEqual([fixture.outside])
  await a.kill()
  expect(await b.request('list')).toHaveLength(8)
  expect(await c.request('list')).toHaveLength(1)
})

nativeTest('allows pre-revocation admitted I/O, refuses the next write, and recovers after a crash', async () => {
  const owner = await mount(), follower = await mount()
  await owner.request('add', [fixture.outside])
  const path = join(fixture.outside, 'barrier.txt')
  const paused = follower.send('pause-write', [path, 'in flight'])
  // Attach rejection handling before any cleanup can kill the writer.
  const writing = paused.result
  void writing.catch(() => {})
  await paused.admitted
  await owner.request('access', [fixture.outside, 'read-only'])
  await follower.request('resume')
  await writing
  expect(readFileSync(path, 'utf8')).toBe('in flight')
  await expect(follower.request('write', [path, 'new operation'])).rejects.toThrow()
  await owner.kill()
  expect((await follower.request<Row[]>('list'))[0]?.access).toBe('read-only')
  expect(await follower.request('authority')).toMatchObject({ kind: 'active' })
  await expect(follower.request('write', [path, 'after takeover'])).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe('in flight')
})

nativeTest('elects exactly one successor and gives a restarted old holder the new epoch', async () => {
  const owner = await mount(), b = await mount(), c = await mount()
  await owner.request('add', [fixture.outside])
  await owner.kill()
  await Promise.all([b.request('list'), c.request('list')])
  const states = await Promise.all([b.request<{ kind: string }>('authority'), c.request<{ kind: string }>('authority')])
  expect(states.map(state => state.kind).sort()).toEqual(['active', 'follower'])
  const restarted = await mount()
  expect(await restarted.request('authority')).toMatchObject({ kind: 'follower' })
  await restarted.request('access', [fixture.outside, 'read-only'])
  for (const host of [b, c, restarted]) await expect(host.request('write', [join(fixture.outside, 'must-not-exist'), 'denied'])).rejects.toThrow()
})

nativeTest.runIf(process.platform !== 'win32')('never steals a lease from a stopped authority', async () => {
  const owner = await mount(), follower = await mount()
  await owner.request('add', [fixture.outside])
  await follower.request('list')
  owner.child.kill('SIGSTOP')
  try {
    await expect(follower.request('write', [join(fixture.outside, 'stopped-owner'), 'denied'])).rejects.toThrow('result is unknown')
    expect(await follower.request('authority')).toMatchObject({ kind: 'contended' })
  } finally { owner.child.kill('SIGCONT') }
  expect(await follower.request('list')).toHaveLength(1)
  expect(await follower.request('authority')).toMatchObject({ kind: 'follower' })
})
