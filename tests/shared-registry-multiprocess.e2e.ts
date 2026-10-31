/** Independent V8 heaps, real kernel locks, real JSON store and attested IPC. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SharedHost as Host } from './support/shared-host.ts'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`shared Registry native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available)
type Row = { path: string; access: string; alias?: string }

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

nativeTest.runIf(process.platform !== 'win32')('takes over with a fresh epoch after the owner is killed, without any operation', async () => {
  const owner = await mount(), follower = await mount()
  await owner.request('add', [fixture.outside])
  const ownerEpoch = (await owner.request<{ epoch?: string }>('diagnostics')).epoch
  expect((await follower.request<{ epoch?: string }>('diagnostics')).epoch).toBe(ownerEpoch)
  await owner.kill() // SIGKILL
  // Read-only polling only: the background scheduler performs the takeover.
  let state: { authorityState: { kind: string }; epoch?: string } | undefined
  for (let i = 0; i < 400; i++) {
    state = await follower.request('diagnostics')
    if (state?.authorityState.kind === 'active') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(state?.authorityState.kind).toBe('active')
  expect(state?.epoch, 'a takeover must win a NEW epoch, never inherit the dead owner').not.toBe(ownerEpoch)
  const probe = await follower.request<{ rows: Row[] }>('probe')
  expect(probe.rows.map(row => row.path)).toEqual([fixture.outside])
}, 60_000)

nativeTest.runIf(process.platform !== 'win32')('returns to the same-owner epoch after a stopped authority resumes, without replay', async () => {
  const owner = await mount(), follower = await mount()
  await owner.request('add', [fixture.outside])
  await follower.request('list')
  const ownerEpoch = (await owner.request<{ epoch?: string }>('diagnostics')).epoch
  owner.child.kill('SIGSTOP')
  try {
    // This request drives the degrade: the frozen channel's ~5s request timer
    // destroys the connection and the follower goes contended.
    await expect(follower.request('list')).rejects.toThrow()
    // The lease stays held: no tick may take over while the owner is stopped.
    for (let i = 0; i < 30; i++) {
      expect((await follower.request<{ authorityState: { kind: string } }>('diagnostics')).authorityState.kind).not.toBe('active')
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  } finally { owner.child.kill('SIGCONT') }
  let state: { authorityState: { kind: string }; epoch?: string } | undefined
  for (let i = 0; i < 400; i++) {
    state = await follower.request('diagnostics')
    if (state?.authorityState.kind === 'follower') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // Reconnected to the SAME owner epoch — never took over, and the timed-out
  // request was never replayed (the projection came through the new hello).
  expect(state?.authorityState).toMatchObject({ kind: 'follower' })
  expect(state?.epoch).toBe(ownerEpoch)
  const probe = await follower.request<{ rows: Row[] }>('probe')
  expect(probe.rows.map(row => row.path)).toEqual([fixture.outside])
}, 60_000)
