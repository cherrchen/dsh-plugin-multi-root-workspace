import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { nativeHostAvailability } from '../src/authority/native.ts'
/** Real local transports, including the kernel peer gate. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthorityClient, AuthorityServer } from '../src/authority/protocol.ts'
import { listenNative, storeIdentity } from '../src/authority/native.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`shared Registry native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available)

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
nativeTest('authenticates a same-user unrestricted Host and bounds requests to its epoch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'epoch-test', 16, async (_method, args) => args)
  cleanups.push(() => server.close())
  const client = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {})
  cleanups.push(() => client.close())
  expect(await client.request('snapshot', ['/primary'])).toEqual(['/primary'])
})

nativeTest('binds the sidecar root in the handshake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-prompts-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'prompts-test', 16, async () => [], { promptsRoot: '/store/worktree-prompts' })
  cleanups.push(() => server.close())
  // A follower whose sidecar root differs must refuse the owner's envelope
  // instead of reading another configuration's decisions (ADR-0039 §5).
  await expect(AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {}, undefined, '/other/worktree-prompts'))
    .rejects.toThrow(/configuration mismatch/)
  const client = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {}, undefined, '/store/worktree-prompts')
  cleanups.push(() => client.close())
  expect(client.epoch).toBe('prompts-test')
})

nativeTest.runIf(process.platform === 'darwin')('refuses a sandboxed child even when it knows the endpoint and protocol', async () => {
  const { spawn } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-deny-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let mutations = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'deny-test', 16, async () => { mutations++; return [] })
  cleanups.push(() => server.close())
  const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny file-write* (subpath "/registry-peer-denial-probe"))',
    process.execPath, '--experimental-transform-types', fileURLToPath(new URL('./support/authority-auth-child.ts', import.meta.url)),
    identity.endpoint, identity.id, root, root + '/unauthorized-root'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks: Buffer[] = [], errors: Buffer[] = []
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  expect(code, Buffer.concat(errors).toString()).toBe(0)
  expect(Buffer.concat(chunks).toString()).toContain('management refused')
  expect(mutations).toBe(0)
})

nativeTest.runIf(process.platform === 'linux')('refuses a same-user NoNewPrivs child before management dispatch', async () => {
  const { spawn } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-nnp-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'nnp', 16, async () => { calls++; return [] })
  cleanups.push(() => server.close())
  const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./support/authority-auth-child.ts', import.meta.url)), identity.endpoint, identity.id, root, root + '/extra', 'no-new-privs'])
  cleanups.push(() => { child.kill() })
  let output = '', stderr = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { stderr += data })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  expect(code, stderr).toBe(0); expect(output).toContain('management refused'); expect(calls).toBe(0)
})

nativeTest('deduplicates a request and disconnects a peer that reuses its ID with different arguments', async () => {
  const { connectNative } = await import('../src/authority/native.ts')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-dedup-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'dedup', 16, async method => { if (method === 'add') calls++; return calls })
  cleanups.push(() => server.close())
  const channel = await connectNative(identity.endpoint)
  cleanups.push(() => channel.destroy())
  let buffer = '', replies = 0
  const first = Promise.withResolvers<void>(), duplicate = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  channel.on('close', closed.resolve)
  channel.on('data', data => {
    buffer += data.toString()
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (reply.type === 'reply') { if (++replies === 1) first.resolve(); if (replies === 3) duplicate.resolve() }
    }
  })
  const send = (id: string, method: string, args: unknown[], epoch: string | null) => channel.write(JSON.stringify({ protocol: 1, store: identity.id, id, method, args, epoch }) + '\n')
  send(randomUUID(), 'hello', [16], null); await first.promise
  const id = randomUUID()
  send(id, 'add', ['/primary', { path: '/extra' }], 'dedup')
  send(id, 'add', ['/primary', { path: '/extra' }], 'dedup')
  await duplicate.promise; expect(calls).toBe(1)
  send(id, 'add', ['/primary', { path: '/different' }], 'dedup')
  await closed.promise; expect(calls).toBe(1)
})

nativeTest.runIf(process.platform === 'win32')('refuses a real Windows ACL runner child at the IPC token boundary', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
  const { spawn } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-token-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'restricted-token', 16, async () => { calls++; return [] })
  cleanups.push(() => server.close())
  const ctx = new Context(); ctx.provide('sandboxPolicy', {} as never)
  await ctx.plugin(LocalSandboxProvider, {})
  const provider = ctx.sandbox as InstanceType<typeof LocalSandboxProvider>
  provider.internals = { chain: ['windows-acl'], windowsAclRunnerArgs: [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))] }
  try {
    const argv = [process.execPath, '--experimental-transform-types', fileURLToPath(new URL('./support/authority-auth-child.ts', import.meta.url)), identity.endpoint, identity.id, root, root + '/extra']
    const confined = await provider.confine(argv, { mode: 'workspace-write', workspaceRoot: root })
    const child = spawn(confined.argv[0]!, confined.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => { child.kill() })
    let output = '', stderr = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { stderr += data })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    expect(code, stderr).toBe(0); expect(output).toContain('management refused'); expect(calls).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

nativeTest.runIf(process.platform === 'linux')('refuses a real bubblewrap child with the public endpoint', async context => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
  const { spawn } = await import('node:child_process')
  const { requireKernelRunner } = await import('./support/kernel-runner.ts')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-bwrap-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'bwrap', 16, async () => { calls++; return [] })
  cleanups.push(() => server.close())
  const ctx = new Context(); ctx.provide('sandboxPolicy', {} as never)
  await ctx.plugin(LocalSandboxProvider, {})
  const provider = ctx.sandbox as InstanceType<typeof LocalSandboxProvider>
  provider.internals = { chain: ['bwrap'] }
  try {
    const argv = [process.execPath, '--experimental-transform-types', fileURLToPath(new URL('./support/authority-auth-child.ts', import.meta.url)), identity.endpoint, identity.id, root, root + '/extra']
    const facts = await provider.confine(argv, { mode: 'workspace-write', workspaceRoot: root })
    const child = spawn(facts.argv[0]!, facts.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => { child.kill() })
    let output = '', stderr = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { stderr += data })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    if (code !== 0 && /bwrap:/.test(stderr)) context.skip(requireKernelRunner('bwrap', stderr))
    expect(code, stderr).toBe(0); expect(output).toContain('management refused'); expect(calls).toBe(0)
  } catch (error) {
    if ((error as { code?: string }).code === 'SANDBOX_UNAVAILABLE') context.skip(requireKernelRunner('bwrap', String(error)))
    throw error
  } finally { await ctx.fiber.dispose() }
})

nativeTest.runIf(process.platform === 'win32')('refuses a Windows ambient-deny child that otherwise retains normal user access', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { pathToFileURL } = await import('node:url')
  const { mkdirSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  const { default: Scope } = await import('../src/scope.ts')
  const { MultiRootSandboxProvider } = await import(pathToFileURL(fileURLToPath(new URL('../lib/sandbox.js', import.meta.url))).href) as typeof import('../src/sandbox.ts')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-ambient-')), identity = storeIdentity(root), denied = join(root, 'denied')
  mkdirSync(denied)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'ambient', 16, async () => { calls++; return [] })
  cleanups.push(() => server.close())
  const ctx = new Context(); ctx.provide('sandboxPolicy', {} as never)
  await ctx.plugin(Scope); await ctx.plugin(MultiRootSandboxProvider, {})
  const provider = ctx.sandbox as InstanceType<typeof MultiRootSandboxProvider>
  provider.internals = { chain: ['windows-acl'], windowsAclRunnerArgs: [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))] }
  try {
    const prefix = await provider.restrictedExecution({ mode: 'danger-full-access', workspaceRoot: root }, [canonicalPath(denied)])
    const argv = [...prefix.argv, process.execPath, '--experimental-transform-types', fileURLToPath(new URL('./support/authority-auth-child.ts', import.meta.url)), identity.endpoint, identity.id, root, root + '/extra']
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => { child.kill() })
    let output = '', stderr = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { stderr += data })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    expect(code, stderr).toBe(0); expect(output).toContain('management refused'); expect(calls).toBe(0)
  } finally { await ctx.fiber.dispose() }
}, 120_000)

nativeTest('keeps repeated catalog queries bounded without consuming the mutation dedup budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-poll-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'polling', 16, async (_method, args) => args)
  cleanups.push(() => server.close())
  const client = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {})
  cleanups.push(() => client.close())
  for (let batch = 0; batch < 130; batch++) {
    const results = await Promise.all(Array.from({ length: 16 }, () => client.request('snapshot', ['/primary'])))
    expect(results).toEqual(Array.from({ length: 16 }, () => ['/primary']))
  }
})

nativeTest('cancels an in-flight hello handshake locally and clears its request timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-cancel-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  // Accepts channels but never answers: the hello exchange hangs until cancelled.
  const listener = await listenNative(identity.endpoint, () => {})
  cleanups.push(() => listener.close())
  await expect(AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {}, AbortSignal.abort()))
    .rejects.toMatchObject({ code: 'authority-cancelled' })
  const timers = vi.spyOn(globalThis, 'setTimeout'), cleared = vi.spyOn(globalThis, 'clearTimeout')
  const controller = new AbortController()
  const started = Date.now()
  const connecting = AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {}, controller.signal)
  const settled = expect(connecting).rejects.toMatchObject({ code: 'authority-cancelled' })
  await new Promise(resolve => setTimeout(resolve, 50))
  controller.abort()
  await settled
  expect(Date.now() - started).toBeLessThan(500)
  const index = timers.mock.calls.findIndex(call => call[1] === 5000)
  expect(index, 'the pending-request timeout was not created').toBeGreaterThanOrEqual(0)
  // Referenced on purpose (the Windows pipe holds no loop handle), so the
  // cancel path must clear it rather than leave a 5s keep-alive behind.
  const timer = timers.mock.results[index]!.value
  expect((timer as { hasRef(): boolean }).hasRef()).toBe(true)
  expect(cleared).toHaveBeenCalledWith(timer)
}, 15_000)

nativeTest('accepts a change in the same read buffer as its hello response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-hello-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'hello-change', 16, async () => [])
  cleanups.push(() => server.close())
  const internal = server as unknown as { accept(channel: import('../src/authority/native.ts').Channel): void }
  const accept = internal.accept.bind(internal)
  const spy = vi.spyOn(internal, 'accept').mockImplementation(channel => {
    const write = channel.write.bind(channel)
    let hello: string | undefined
    channel.write = text => {
      const value = JSON.parse(text)
      if (value.type === 'reply' && value.value?.epoch === 'hello-change') {
        hello = text
        server.changed({ protocol: 1, store: identity.id, epoch: 'hello-change', revision: 1, primary: '/primary', roots: [], available: true })
        return true
      }
      if (hello) { const combined = hello + text; hello = undefined; return write(combined) }
      return write(text)
    }
    accept(channel)
  })
  try {
    let changes = 0
    const client = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => { changes++ }, () => {})
    cleanups.push(() => client.close())
    expect(client.epoch).toBe('hello-change'); expect(changes).toBe(1)
    expect(await client.request('snapshot', ['/primary'])).toEqual([])
  } finally { spy.mockRestore() }
})

nativeTest.runIf(process.platform === 'win32')('recovers a disconnected pending pipe while an established peer stays connected', async () => {
  const { connectNative } = await import('../src/authority/native.ts')
  const root = mkdtempSync(join(tmpdir(), 'mrw-ipc-pending-')), identity = storeIdentity(root)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const server = await AuthorityServer.listen(identity.endpoint, identity.id, 'pending', 16, async () => [])
  cleanups.push(() => server.close())
  const first = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {})
  cleanups.push(() => first.close())
  const transient = await connectNative(identity.endpoint); transient.destroy()
  let next: AuthorityClient | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
    try { next = await AuthorityClient.connect(identity.endpoint, identity.id, 16, () => {}, () => {}); break } catch {}
  }
  expect(next).toBeDefined()
  if (next) { cleanups.push(() => next.close()); expect(await next.request('snapshot', ['/primary'])).toEqual([]) }
  expect(await first.request('snapshot', ['/primary'])).toEqual([])
})

// Exercise the real frame parser and dispatcher without weakening the native
// authentication gate on development hosts that cannot connect to it.
class ProtocolChannel extends EventEmitter {
  readonly sent: Array<{ type: string; value?: unknown; code?: string }> = []
  write(message: string): boolean {
    this.sent.push(JSON.parse(message))
    return true
  }
  destroy(): void { this.emit('close') }
  receive(frame: unknown): void {
    this.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
  }
}

it('keeps v1 Registry peers compatible and requires a matched worktree capability', async () => {
  const Server = AuthorityServer as unknown as new (
    store: string, epoch: string, limit: number, promptsRoot: string, dispatch: (method: string) => Promise<unknown>,
  ) => AuthorityServer & { accept(channel: ProtocolChannel): void }
  const dispatch = vi.fn(async () => 'registry result')
  const server = new Server('store', 'epoch', 16, '/expected', dispatch)
  cleanups.push(() => server.close())
  const legacy = new ProtocolChannel(), mismatched = new ProtocolChannel()
  for (const channel of [legacy, mismatched]) server.accept(channel)
  const request = (method: string, args: unknown[], epoch: string | null) =>
    ({ protocol: 1, store: 'store', epoch, method, args, id: randomUUID() })
  legacy.receive(request('hello', [16], null))
  expect(legacy.sent[0]?.value).toEqual({ protocol: 1, store: 'store', epoch: 'epoch', limit: 16 })
  legacy.receive(request('snapshot', ['/primary'], 'epoch'))
  legacy.receive(request('probeAdd', ['/primary', '/worktree'], 'epoch'))
  mismatched.receive(request('hello', [16, '/different'], null))
  await setImmediate()
  expect(legacy.sent).toContainEqual(expect.objectContaining({ code: 'worktree/not-available' }))
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('snapshot', ['/primary'])
  expect(mismatched.sent[0]?.code).toBe('authority-config-mismatch')

  // Old owners accepted the limit in args[0] and returned the original
  // envelope. The new client keeps ordinary operations available.
  const Client = AuthorityClient as unknown as new (
    channel: ProtocolChannel, store: string, limit: number, promptsRoot: string, changed: () => void, disconnected: () => void,
  ) => AuthorityClient
  const oldOwner = new ProtocolChannel()
  const client = new Client(oldOwner, 'store', 16, '/expected', () => {}, () => {})
  cleanups.push(() => client.close())
  const hello = client.request('hello', [16, '/expected'])
  const { id } = oldOwner.sent[0] as unknown as { id: string }
  oldOwner.receive({ type: 'reply', id, value: { protocol: 1, store: 'store', epoch: 'old-owner', limit: 16 } })
  await hello
  expect(client.epoch).toBe('old-owner')
  await expect(client.request('probeAdd', ['/primary', '/worktree'])).rejects.toMatchObject({ code: 'worktree/not-available' })
  expect(oldOwner.sent).toHaveLength(1)
})

it('replies to duplicate worktree requests in the original shape without repeating writes', async () => {
  const Server = AuthorityServer as unknown as new (
    store: string, epoch: string, limit: number, promptsRoot: string, dispatch: (method: string, args: unknown[]) => Promise<unknown>,
  ) => AuthorityServer & { accept(channel: ProtocolChannel): void }
  const removal = { removed: true }
  const sidecar = { ignored: [], worktreeRoots: [], revision: 2, available: true }
  const dispatch = vi.fn(async (method: string, args: unknown[]) => {
    if (method === 'removeForDeletedWorktree') return removal
    if (method === 'worktreeSidecar') return sidecar
    throw new Error('unexpected replay: ' + JSON.stringify(args))
  })
  const server = new Server('store', 'epoch', 16, '/prompts', dispatch)
  cleanups.push(() => server.close())
  const channel = new ProtocolChannel()
  server.accept(channel)
  const request = (method: string, args: unknown[], epoch: string | null) =>
    ({ protocol: 1, store: 'store', epoch, method, args, id: randomUUID() })
  channel.receive(request('hello', [16, '/prompts'], null))
  const remove = request('removeForDeletedWorktree', ['/primary', { rootId: 'id', expectedPath: '/root', expectedAddedAt: 'time' }], 'epoch')
  const reset = request('worktreeSidecar', ['/primary', { op: 'reset' }], 'epoch')
  channel.receive(remove)
  channel.receive(reset)
  await setImmediate()
  channel.receive(remove)
  channel.receive(reset)
  await setImmediate()
  expect(channel.sent.slice(1).map(reply => reply.value)).toEqual([removal, sidecar, removal, sidecar])
  expect(dispatch.mock.calls).toEqual([
    [remove.method, remove.args],
    [reset.method, reset.args],
    ['worktreeSidecar', ['/primary', { op: 'read' }]],
  ])
})
