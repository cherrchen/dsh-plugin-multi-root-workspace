import { nativeHostAvailability, listenNative, storeIdentity } from '../src/authority/native.ts'
/** Production owner/follower facade over a real kernel lease and local IPC. */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AuthorityServer } from '../src/authority/protocol.ts'
import type { Snapshot } from '../src/authority/protocol.ts'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { DOMAIN_NAME } from '../src/registry.ts'
import { RegistryAuthorityLease } from '../src/registry-lease.ts'
import type { Config as RegistryConfig } from '../src/registry.ts'
import MultiRootFileSystem from '../src/fs.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`shared Registry native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available)

let fixture: FixtureWorkspace, stacks: RegistryStack[]
beforeEach(() => { fixture = createFixtureWorkspace('shared'); stacks = [] })
afterEach(async () => { vi.restoreAllMocks(); for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })
async function mount(config: RegistryConfig = {}) {
  const root = join(fixture.base, 'store')
  const stack = await mountRegistryStack(root, { sharedStorageRoot: root, ...config }, { beforeGate: async ctx => {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
  } })
  stacks.push(stack); if (stack.registry.authority.kind === 'storage-failed') throw new Error(stack.registry.unavailable); await stack.registry.refresh(fixture.workspace); return stack
}
/** Poll until the stack's authority reaches `kind` (channel close is asynchronous). */
async function waitForAuthority(stack: RegistryStack, kind: string): Promise<void> {
  for (let i = 0; i < 200 && stack.registry.authority.kind !== kind; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(stack.registry.authority.kind).toBe(kind)
}

nativeTest('lets two Hosts use the same registered roots while opening only one domain', async () => {
  const owner = await mount()
  expect(owner.registry.authority.kind, owner.registry.unavailable).toBe('active')
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount()
  expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('follower')
  const open = vi.spyOn(follower.ctx.storageDomain, 'open')
  for (const [index, stack] of [owner, follower].entries()) {
    const path = join(fixture.outside, `host-${index}.txt`)
    await stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), `host-${index}`)
    expect(readFileSync(path, 'utf8')).toBe(`host-${index}`)
  }
  expect(open).not.toHaveBeenCalled()
  expect(follower.registry.list(fixture.workspace)).toHaveLength(1)
})

nativeTest('orders a follower admission after owner revocation even with notifications dropped', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount()
  await follower.registry.refresh(fixture.workspace)
  const internal = owner.registry as unknown as { server: { changed: (...args: unknown[]) => void } }
  vi.spyOn(internal.server, 'changed').mockImplementation(() => {})
  await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  const path = join(fixture.outside, 'revoked.txt')
  await expect(follower.ctx.fs.writeText(await follower.ctx.fs.resolve(path), 'must not land')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(existsSync(path)).toBe(false)
})

nativeTest('keeps an admitted write in flight without blocking revocation', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount(), path = join(fixture.outside, 'in-flight.txt')
  const target = await follower.ctx.fs.resolve(path), original = follower.ctx.fs.resolve.bind(follower.ctx.fs)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let first = true
  vi.spyOn(follower.ctx.fs, 'resolve').mockImplementation(async (...args) => {
    const target = await original(...args)
    if (first) { first = false; entered.resolve(); await release.promise }
    return target
  })
  const write = follower.ctx.fs.writeText(target, 'admitted')
  try {
    await entered.promise
    await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  } finally { release.resolve() }
  await write
  expect(readFileSync(path, 'utf8')).toBe('admitted')
})

nativeTest('forwards mutations and preserves them when the owner exits and a follower takes over', async () => {
  const owner = await mount(), follower = await mount()
  expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('follower')
  await follower.registry.add(fixture.workspace, { path: fixture.outside })
  await follower.registry.setAlias(fixture.workspace, { kind: 'path', path: fixture.outside }, 'shared')
  const previousEpoch = follower.registry.epoch
  await owner.dispose()
  const rows = await follower.registry.refresh(fixture.workspace)
  expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('active')
  expect(rows[0]?.alias).toBe('shared')
  expect(follower.registry.epoch).not.toBe(previousEpoch)
  const path = join(fixture.outside, 'successor.txt')
  await follower.ctx.fs.writeText(await follower.ctx.fs.resolve(path), 'successor')
  expect(readFileSync(path, 'utf8')).toBe('successor')
})

nativeTest('closes a late listener before storage and lease when disposal overlaps takeover', async () => {
  const owner = await mount(), candidate = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const internal = candidate.registry as unknown as {
    releaseAuthority(): Promise<void>
    client: { channel: { once(event: string, listener: () => void): void } }
    server: AuthorityServer | undefined
    domain: { close(): Promise<void> }
    lease: { release(): Promise<void> }
  }
  const disconnected = Promise.withResolvers<void>()
  internal.client.channel.once('close', disconnected.resolve)
  await owner.dispose(); await disconnected.promise

  const opening = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const disposing = Promise.withResolvers<void>(), events: string[] = []
  const listen = AuthorityServer.listen
  let lateServer: AuthorityServer | undefined
  vi.spyOn(AuthorityServer, 'listen').mockImplementationOnce(async (...args) => {
    // Real openDomain has acquired the kernel lease and opened durable data,
    // but has not yet assigned the asynchronous listener — and its domain is
    // still a staged local. Wrap `close` when the commit assigns it, so the
    // teardown order is still observed. No timing sleeps.
    let staged: { close(): Promise<void> } | undefined
    Object.defineProperty(internal, 'domain', {
      configurable: true,
      get() { return staged },
      set(domain) {
        staged = domain
        if (domain !== undefined) {
          const closeDomain = domain.close.bind(domain)
          domain.close = async () => { events.push('domain'); await closeDomain() }
        }
      },
    })
    const releaseLease = internal.lease.release.bind(internal.lease)
    vi.spyOn(internal.lease, 'release').mockImplementation(async () => { events.push('lease'); await releaseLease() })
    opening.resolve(); await resume.promise
    lateServer = await listen(...args)
    const closeServer = lateServer.close.bind(lateServer)
    vi.spyOn(lateServer, 'close').mockImplementation(() => { events.push('server'); closeServer() })
    return lateServer
  })
  const release = internal.releaseAuthority.bind(internal)
  vi.spyOn(internal, 'releaseAuthority').mockImplementation(() => {
    const done = release(); disposing.resolve(); return done
  })
  const refreshing = candidate.registry.refresh(fixture.workspace)
  let disposal: Promise<void> | undefined
  try {
    await opening.promise
    // Unload the Registry row, as a profile edit would, keeping its injected
    // scope/storage services alive until its own teardown has finished.
    disposal = candidate.registryFiber.dispose()
    await disposing.promise
    resume.resolve()
    await Promise.all([refreshing, disposal])
    expect([...events]).toEqual(['server', 'domain', 'lease'])
    expect(internal.server).toBeUndefined()
    expect(candidate.registry.available).toBe(false)

    // In particular Windows must be able to create a FIRST_PIPE_INSTANCE at
    // the same endpoint. A fresh follower proves the new listener serves IPC.
    const successor = await mount(), follower = await mount()
    expect(successor.registry.authority.kind, successor.registry.unavailable).toBe('active')
    expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('follower')
    expect(follower.registry.epoch).toBe(successor.registry.epoch)
    expect(follower.registry.list(fixture.workspace)).toHaveLength(1)
    const file = join(fixture.outside, 'after-overlapping-disposal.txt')
    await follower.ctx.fs.writeText(await follower.ctx.fs.resolve(file), 'successor')
    expect(readFileSync(file, 'utf8')).toBe('successor')
  } finally {
    resume.resolve()
    await Promise.allSettled([refreshing, ...(disposal ? [disposal] : [])])
    lateServer?.close() // also retire the leaked listener when testing old code
  }
})

nativeTest('refuses new shared grants after a disconnect and retains withheld paths', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
  const follower = await mount()
  await follower.registry.refresh(fixture.workspace)
  const internal = follower.registry as unknown as { client: { close(): void } }
  const closed = Promise.withResolvers<void>()
  const client = internal.client as unknown as { close(): void; channel: { on(name: string, callback: () => void): void } }
  client.channel.on('close', () => closed.resolve())
  client.close(); await closed.promise
  expect(follower.registry.available).toBe(false)
  expect(follower.registry.list(fixture.workspace)[0]?.path).toBe(fixture.outside)
  expect(follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'danger-full-access' }).authority).toBe('unavailable')
  // A later explicit refresh may reconnect; no stale projection is a permit.
  expect(follower.scope.resolve({ workspaceRoot: fixture.workspace, mode: 'danger-full-access' }).writableRoots).toEqual([])
})

nativeTest('reports an unknown mutation outcome without replay when the committed response is lost', async () => {
  const owner = await mount(), follower = await mount()
  const internal = owner.registry as unknown as { server: { close(): void }; captureSnapshot(primary: string): Promise<unknown> }
  const capture = internal.captureSnapshot.bind(internal)
  vi.spyOn(internal, 'captureSnapshot').mockImplementation(async primary => {
    const snapshot = await capture(primary)
    internal.server.close() // the durable add completed; its reply cannot arrive
    return snapshot
  })
  await expect(follower.registry.add(fixture.workspace, { path: fixture.outside })).rejects.toThrow('result is unknown')
  expect(owner.registry.list(fixture.workspace)).toHaveLength(1)
  await owner.dispose()
  expect(await follower.registry.refresh(fixture.workspace)).toHaveLength(1)
  expect(follower.registry.authority.kind).toBe('active')
})

nativeTest('does not let a new nested operation inherit an old admission after disconnect', async () => {
  const owner = await mount(), follower = await mount(), policy = { workspaceRoot: fixture.workspace, mode: 'workspace-write' as const }
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await follower.registry.withOperation(policy, 'process', async old => {
    expect(old.scope.writableRoots).toContain(fixture.outside)
    expect(Object.isFrozen(old.scope)).toBe(true)
    expect(Object.isFrozen(old.scope.writableRoots)).toBe(true)
    await owner.dispose()
    // Refuse both reconnection and election so the nested call is genuinely unknown.
    const internal = follower.registry as unknown as { ensureAuthority(): Promise<void>; client?: { close(): void; channel: { on(name: string, callback: () => void): void } } }
    if (internal.client) {
      const closed = Promise.withResolvers<void>()
      internal.client.channel.on('close', closed.resolve); internal.client.close(); await closed.promise
    }
    vi.spyOn(internal, 'ensureAuthority').mockResolvedValue()
    await follower.registry.withOperation(policy, 'fs-write', async next => {
      expect(next.scope.authority).toBe('unavailable')
      expect(next.scope.writableRoots).toEqual([])
    })
    expect(old.scope.writableRoots).toContain(fixture.outside) // existing admitted work may finish
  })
})

nativeTest.skipIf(symlinkUnsupportedReason() !== undefined)('uses one authority across canonical and aliased storage directories', async () => {
  const owner = await mount(), alias = join(fixture.base, 'store-alias')
  symlinkSync(owner.storeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount({ sharedStorageRoot: alias })
  expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('follower')
  expect(follower.registry.epoch).toBe(owner.registry.epoch)
  const file = join(fixture.outside, 'aliased-store.txt')
  await follower.ctx.fs.writeText(await follower.ctx.fs.resolve(file), 'shared medium')
  expect(readFileSync(file, 'utf8')).toBe('shared medium')
})

nativeTest('rejects an alternate lock name without opening another domain', async () => {
  const owner = await mount(), wrongLock = join(owner.storeRoot, 'other.lock')
  const invalid = await mountRegistryStack(owner.storeRoot, { sharedStorageRoot: owner.storeRoot, leasePath: wrongLock })
  stacks.push(invalid)
  expect(invalid.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'config' })
  expect(invalid.registry.unavailable).toContain('canonical medium lock')
  expect(invalid.registry.available).toBe(false)
  expect(existsSync(wrongLock)).toBe(false)
  expect(owner.registry.authority.kind).toBe('active')
  const epoch = owner.registry.epoch
  await invalid.registry.refresh(fixture.workspace).catch(() => [])
  expect(invalid.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'config' })
  expect(invalid.registry.unavailable).toContain('canonical medium lock')
  expect(existsSync(wrongLock)).toBe(false)
  expect(owner.registry.authority.kind).toBe('active')
  expect(owner.registry.epoch).toBe(epoch)
  const follower = await mount()
  expect(follower.registry.authority.kind, follower.registry.unavailable).toBe('follower')
  expect(follower.registry.epoch).toBe(owner.registry.epoch)
})

nativeTest('cancels an in-flight follower handshake when the Host is torn down', async () => {
  const root = join(fixture.base, 'store'), endpoint = storeIdentity(root).endpoint
  // A lease holder that never listens: connection attempts are refused until one exists.
  const lease = await RegistryAuthorityLease.acquire(join(root, `${DOMAIN_NAME}.lock`))
  const follower = await mountRegistryStack(root, { sharedStorageRoot: root })
  stacks.push(follower)
  expect(follower.registry.authority.kind).toBe('contended')
  // Now a listener that accepts but never replies makes the hello exchange hang.
  const listener = await listenNative(endpoint, () => {})
  const refreshing = follower.registry.refresh(fixture.workspace).catch(() => [] as const)
  await new Promise(resolve => setTimeout(resolve, 100))
  const started = Date.now()
  await follower.dispose()
  const elapsed = Date.now() - started
  await refreshing
  listener.close()
  await lease.release()
  expect(elapsed, 'teardown waited on the 5s hello timeout instead of cancelling the handshake').toBeLessThan(1000)
}, 15_000)

nativeTest('retracts the withheld deny boundary at the scope when the owner removes the root', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
  const follower = await mount()
  const denied = () => follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }).deniedRoots
  expect(denied()).toContain(fixture.outside)
  // A dropped connection withholds the cached rows but keeps their deny boundary.
  ;(follower.registry as unknown as { client: { close(): void } }).client.close()
  await waitForAuthority(follower, 'contended')
  expect(denied()).toContain(fixture.outside)
  await owner.registry.remove(fixture.workspace, { kind: 'path', path: fixture.outside })
  await follower.registry.refresh(fixture.workspace)
  expect(follower.registry.list(fixture.workspace)).toEqual([])
  expect(denied()).not.toContain(fixture.outside)
})

nativeTest('refuses a follower with a different shared root limit while the owner stays active', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount({ maxAdditionalRoots: 17 })
  expect(follower.registry.authority.kind).toBe('contended')
  expect(follower.registry.available).toBe(false)
  expect(follower.registry.granted(fixture.workspace)).toEqual([])
  await expect(follower.registry.add(fixture.workspace, { path: fixture.outside })).rejects.toMatchObject({ code: 'registry-contended' })
  expect(owner.registry.authority.kind).toBe('active')
})

nativeTest('refuses a response from an old authority epoch before executing the operation body', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount()
  const internal = follower.registry as unknown as { client: { request(method: string, args: unknown[]): Promise<unknown>; channel: { on(name: string, callback: () => void): void } } }
  const snapshot = await internal.client.request('snapshot', [fixture.workspace]) as object
  const closed = Promise.withResolvers<void>()
  internal.client.channel.on('close', closed.resolve)
  vi.spyOn(internal.client, 'request').mockResolvedValueOnce({ ...snapshot, epoch: randomUUID() })
  const body = vi.fn()
  await expect(follower.registry.withOperation({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }, 'fs-write', body)).rejects.toThrow('authority epoch')
  await closed.promise
  expect(body).not.toHaveBeenCalled()
  expect(follower.registry.available).toBe(false)
  expect(follower.registry.granted(fixture.workspace)).toEqual([])
})

nativeTest('keeps repeated takeover failures silent: private staging, dedupe, deduped logs', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
  const follower = await mount()
  const snapPolicy = { workspaceRoot: fixture.workspace, mode: 'workspace-write' as const }
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const listBefore = JSON.stringify(follower.registry.list(fixture.workspace))
  const scopeBefore = JSON.stringify(follower.scope.snapshot(snapPolicy))
  const errors: string[] = []
  vi.spyOn(follower.ctx.logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  const writes = vi.spyOn(follower.scope, 'setAdditionalRoots')
  const seen: string[] = []
  const unsubscribe = follower.scope.subscribe(() => seen.push(follower.scope.snapshot(snapPolicy).authority))
  try {
    // Phase A: the domain open keeps failing with the same reason — logged once.
    const open = vi.spyOn(DomainFacility.prototype, 'open').mockRejectedValue(new Error('open refused'))
    for (let round = 0; round < 3; round++) {
      await follower.registry.refresh(fixture.workspace)
      expect(follower.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'retryable' })
    }
    open.mockRestore()
    // Phase B: the store opens but the shared listener keeps refusing.
    const listen = vi.spyOn(AuthorityServer, 'listen').mockRejectedValue(new Error('listen refused'))
    for (let round = 0; round < 3; round++) {
      await follower.registry.refresh(fixture.workspace)
      expect(follower.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'retryable' })
    }
    listen.mockRestore()
    expect(seen).toEqual([])
    expect(writes).not.toHaveBeenCalled()
    expect(JSON.stringify(follower.registry.list(fixture.workspace))).toBe(listBefore)
    expect(JSON.stringify(follower.scope.snapshot(snapPolicy))).toBe(scopeBefore)
    expect(errors.filter(text => text.includes('cannot open the root registry store'))).toHaveLength(1)
  } finally { unsubscribe() }
})

nativeTest('commits a takeover atomically: callbacks only observe the committed state', async () => {
  const owner = await mount(), ws2 = join(fixture.base, 'ws2'), out2 = join(fixture.base, 'out2')
  mkdirSync(ws2); mkdirSync(out2)
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await owner.registry.add(ws2, { path: out2 })
  const follower = await mount()
  await follower.registry.refresh(ws2)
  const internal = owner.registry as unknown as { server: { changed(): void } }
  vi.spyOn(internal.server, 'changed').mockImplementation(() => {})
  await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  await owner.registry.setAccess(ws2, { kind: 'path', path: out2 }, 'read-only')
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const primaries: Array<readonly [string, string]> = [[fixture.workspace, fixture.outside], [ws2, out2]]
  const assertCommitted = () => {
    for (const [primary, denied] of primaries) {
      expect(follower.registry.list(primary).map(row => row.access)).toEqual(['read-only'])
      const scope = follower.scope.snapshot({ workspaceRoot: primary, mode: 'workspace-write' })
      expect(scope.deniedRoots).toContain(canonicalPath(denied))
      expect(scope.authority).toBe('available')
    }
  }
  let scopeCalls = 0
  const unsubscribe = follower.scope.subscribe(() => { scopeCalls++; assertCommitted() })
  const changedKeys: string[] = []
  const unsubscribeRegistry = follower.registry.onChange(key => { changedKeys.push(key); assertCommitted() })
  const broadcast: Snapshot[] = []
  const originalChanged = AuthorityServer.prototype.changed
  vi.spyOn(AuthorityServer.prototype, 'changed').mockImplementation(function (this: AuthorityServer, snapshot: Snapshot) {
    broadcast.push(snapshot); assertCommitted()
    return originalChanged.call(this, snapshot)
  })
  try {
    await follower.registry.refresh(fixture.workspace)
    expect(follower.registry.authority.kind).toBe('active')
    expect(scopeCalls).toBe(1)
    expect(changedKeys.sort()).toEqual(primaries.map(([primary]) => canonicalPath(primary)).sort())
    expect(broadcast).toHaveLength(2)
    for (const snapshot of broadcast) expect(snapshot.roots.map(row => row.access)).toEqual(['read-only'])
  } finally { unsubscribe(); unsubscribeRegistry() }
})

nativeTest('does not expose a half-opened authority while the shared listener is pending', async () => {
  const owner = await mount(), ws2 = join(fixture.base, 'ws2'), out2 = join(fixture.base, 'out2')
  mkdirSync(ws2); mkdirSync(out2)
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await owner.registry.add(ws2, { path: out2 })
  const follower = await mount()
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const pending = Promise.withResolvers<AuthorityServer>()
  const listen = vi.spyOn(AuthorityServer, 'listen').mockReturnValue(pending.promise)
  const listBefore = JSON.stringify(follower.registry.list(fixture.workspace))
  const scopeBefore = JSON.stringify(follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }))
  let calls = 0
  const unsubscribe = follower.scope.subscribe(() => { calls++ })
  const refreshing = follower.registry.refresh(fixture.workspace).catch(() => [] as const)
  try {
    for (let i = 0; i < 200 && listen.mock.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(listen).toHaveBeenCalled()
    // A key present only on disk must not materialize during staging.
    expect(follower.registry.list(ws2)).toEqual([])
    expect(calls).toBe(0)
    pending.reject(new Error('listen refused'))
    await refreshing
    expect(follower.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'retryable' })
    expect(JSON.stringify(follower.registry.list(fixture.workspace))).toBe(listBefore)
    expect(JSON.stringify(follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }))).toBe(scopeBefore)
    expect(calls).toBe(0)
  } finally { pending.reject(new Error('aborted')); unsubscribe(); await refreshing }
})

nativeTest('retracts a primary deleted from disk while this Host was disconnected', async () => {
  const owner = await mount(), ws3 = join(fixture.base, 'ws3'), out3 = join(fixture.base, 'out3')
  mkdirSync(ws3); mkdirSync(out3)
  await owner.registry.add(ws3, { path: out3, access: 'read-only' })
  const follower = await mount()
  await follower.registry.refresh(ws3)
  const deny = () => follower.scope.snapshot({ workspaceRoot: ws3, mode: 'workspace-write' })
  expect(deny().deniedRoots).toContain(canonicalPath(out3))
  const internal = owner.registry as unknown as { server: { changed(): void } }
  vi.spyOn(internal.server, 'changed').mockImplementation(() => {})
  await owner.registry.removeAt(ws3, { kind: 'path', path: out3 })
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  expect(deny().deniedRoots).toContain(canonicalPath(out3))
  await follower.registry.refresh(fixture.workspace)
  expect(follower.registry.authority.kind).toBe('active')
  expect(follower.registry.list(ws3)).toEqual([])
  expect(deny().additionalRoots).toEqual([])
  expect(deny().deniedRoots).toEqual([])
})

nativeTest('takes over automatically after the owner exits without any user action', async () => {
  const owner = await mount(), follower = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await follower.registry.refresh(fixture.workspace)
  await owner.dispose()
  await vi.waitFor(() => { expect(follower.registry.authority.kind).toBe('active') }, { timeout: 15000, interval: 50 })
  expect(follower.registry.list(fixture.workspace).map(row => row.path)).toEqual([fixture.outside])
  expect(follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }).additionalRoots).toEqual([fixture.outside])
}, 30_000)

nativeTest('reconnects and resynchronizes withheld projections without a refresh', async () => {
  const owner = await mount(), ws2 = join(fixture.base, 'ws2'), out2 = join(fixture.base, 'out2')
  mkdirSync(ws2); mkdirSync(out2)
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await owner.registry.add(ws2, { path: out2 })
  const follower = await mount()
  await follower.registry.refresh(ws2)
  ;(follower.registry as unknown as { client: { close(): void } }).client.close()
  await waitForAuthority(follower, 'contended')
  const internal = owner.registry as unknown as { server: { changed(): void } }
  vi.spyOn(internal.server, 'changed').mockImplementation(() => {})
  await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  await owner.registry.removeAt(ws2, { kind: 'path', path: out2 })
  await vi.waitFor(() => { expect(follower.registry.authority.kind).toBe('follower') }, { timeout: 15000, interval: 50 })
  await vi.waitFor(() => {
    expect(follower.registry.list(fixture.workspace).map(row => row.access)).toEqual(['read-only'])
    const snap2 = follower.scope.snapshot({ workspaceRoot: ws2, mode: 'workspace-write' })
    expect(snap2.additionalRoots).toEqual([])
    expect(snap2.deniedRoots).toEqual([])
    expect(snap2.authority).toBe('available')
  }, { timeout: 15000, interval: 50 })
  // The resynced boundary denies real writes: recovery restored no authority.
  const file = join(fixture.outside, 'after-recovery.txt')
  await expect(follower.ctx.fs.writeText(await follower.ctx.fs.resolve(file), 'denied')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(existsSync(file)).toBe(false)
}, 30_000)

nativeTest('resynchronizes a failed primary on a later tick while a synced one already recovered', async () => {
  const owner = await mount(), ws2 = join(fixture.base, 'ws2'), out2 = join(fixture.base, 'out2')
  mkdirSync(ws2); mkdirSync(out2)
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  await owner.registry.add(ws2, { path: out2, access: 'read-only' })
  const follower = await mount()
  await follower.registry.refresh(ws2)
  ;(follower.registry as unknown as { client: { close(): void } }).client.close()
  await waitForAuthority(follower, 'contended')
  const internal = owner.registry as unknown as { server: { changed(): void }; captureSnapshot(primary: string): Promise<unknown> }
  vi.spyOn(internal.server, 'changed').mockImplementation(() => {})
  const capture = internal.captureSnapshot.bind(internal)
  let failures = 0
  vi.spyOn(internal, 'captureSnapshot').mockImplementation(async primary => {
    if (canonicalPath(primary) === canonicalPath(ws2) && failures++ < 2) throw new Error('snapshot unavailable')
    return capture(primary)
  })
  await vi.waitFor(() => {
    const snap = follower.scope.snapshot({ workspaceRoot: ws2, mode: 'workspace-write' })
    expect(snap.authority).toBe('available')
    // primary1 synced and is visible again; primary2 stays withheld.
    expect(follower.scope.snapshot({ workspaceRoot: fixture.workspace, mode: 'workspace-write' }).additionalRoots).toEqual([fixture.outside])
    expect(snap.additionalRoots).toEqual([])
    expect(snap.deniedRoots).toContain(out2)
    // Read-only diagnostics agree: primary2 is still pending, class retryable.
    expect(follower.registry.diagnostics).toMatchObject({ recoveryClass: 'retryable' })
    expect(follower.registry.diagnostics.recovery.pendingSync).toBeGreaterThanOrEqual(1)
  }, { timeout: 20000, interval: 50 })
  vi.restoreAllMocks()
  await vi.waitFor(() => {
    expect(follower.scope.snapshot({ workspaceRoot: ws2, mode: 'workspace-write' }).additionalRoots).toEqual([out2])
  }, { timeout: 20000, interval: 50 })
  expect(follower.registry.diagnostics).toMatchObject({ recoveryClass: undefined, recovery: { pendingSync: 0 } })
}, 40_000)

nativeTest('stays silent across repeated failed takeover ticks and recovers when listen works again', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
  const follower = await mount()
  const snapPolicy = { workspaceRoot: fixture.workspace, mode: 'workspace-write' as const }
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const errors: string[] = []
  vi.spyOn(follower.ctx.logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  const seen: string[] = []
  const unsubscribe = follower.scope.subscribe(() => seen.push(follower.scope.snapshot(snapPolicy).authority))
  const listen = vi.spyOn(AuthorityServer, 'listen').mockRejectedValue(new Error('listen refused'))
  const listBefore = JSON.stringify(follower.registry.list(fixture.workspace))
  const scopeBefore = JSON.stringify(follower.scope.snapshot(snapPolicy))
  try {
    // Several background ticks run without any user action (~1s + ~2s + ~4s).
    await new Promise(resolve => setTimeout(resolve, 4500))
    expect(follower.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'retryable' })
    expect(seen).toEqual([])
    expect(JSON.stringify(follower.registry.list(fixture.workspace))).toBe(listBefore)
    expect(JSON.stringify(follower.scope.snapshot(snapPolicy))).toBe(scopeBefore)
    expect(errors.filter(text => text.includes('shared registry'))).toHaveLength(0)
    listen.mockRestore()
    await vi.waitFor(() => { expect(follower.registry.authority.kind).toBe('active') }, { timeout: 20000, interval: 50 })
    expect(follower.registry.list(fixture.workspace).map(row => row.access)).toEqual(['read-only'])
  } finally { unsubscribe() }
}, 40_000)

nativeTest('stops scheduling when the Host is torn down mid-backoff', async () => {
  const owner = await mount(), follower = await mount()
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const internal = follower.registry as unknown as { ensureAuthority(options?: unknown): Promise<void> }
  const ensure = vi.spyOn(internal, 'ensureAuthority')
  await follower.dispose()
  await new Promise(resolve => setTimeout(resolve, 2600))
  expect(ensure).not.toHaveBeenCalled()
}, 30_000)

nativeTest('honours the backgroundRecovery opt-out', async () => {
  const owner = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const follower = await mount({ backgroundRecovery: false })
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  await new Promise(resolve => setTimeout(resolve, 5200))
  expect(follower.registry.authority.kind).toBe('contended')
}, 30_000)

nativeTest('does not churn scope notifications while a contended medium never listens', async () => {
  const root = join(fixture.base, 'store')
  const lease = await RegistryAuthorityLease.acquire(join(root, `${DOMAIN_NAME}.lock`))
  const follower = await mountRegistryStack(root, { sharedStorageRoot: root })
  stacks.push(follower)
  expect(follower.registry.authority.kind).toBe('contended')
  let calls = 0
  const unsubscribe = follower.scope.subscribe(() => { calls++ })
  // Fake timers drive the recovery ticks; the failing connect resolves on
  // microtasks, so advancing fake time replays ~10+ real seconds of retries.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await vi.advanceTimersByTimeAsync(200_000)
    expect(calls).toBe(0)
  } finally { vi.useRealTimers(); unsubscribe(); await lease.release() }
}, 30_000)

nativeTest('reports structured recovery diagnostics through the degraded lifecycle', async () => {
  const owner = await mount(), follower = await mount()
  expect(owner.registry.diagnostics).toMatchObject({ recoveryClass: undefined, recovery: { phase: 'idle', pendingSync: 0 } })
  const infos: string[] = []
  vi.spyOn(follower.ctx.logger, 'info').mockImplementation((...args: unknown[]) => { infos.push(args.map(String).join(' ')) })
  await owner.dispose()
  await waitForAuthority(follower, 'contended')
  const degraded = follower.registry.diagnostics
  expect(degraded.recoveryClass).toBe('retryable')
  expect(degraded.recovery.phase).toBe('waiting')
  expect(degraded.recovery.nextRetryAt).toBeTypeOf('number')
  await vi.waitFor(() => { expect(follower.registry.authority.kind).toBe('active') }, { timeout: 15000, interval: 50 })
  expect(follower.registry.diagnostics).toMatchObject({ recoveryClass: undefined, recovery: { phase: 'idle' } })
  // One line per transition only: contended in, recovered out — nothing per tick.
  expect(infos.filter(text => text.includes('registry authority'))).toHaveLength(2)
}, 30_000)

nativeTest('marks config and quarantine classes as requires-restart', async () => {
  const invalid = await mountRegistryStack(join(fixture.base, 'broken'), {
    sharedStorageRoot: join(fixture.base, 'store'),
    leasePath: join(fixture.base, 'store/other.lock'),
  })
  stacks.push(invalid)
  expect(invalid.registry.diagnostics).toMatchObject({ recoveryClass: 'config', recovery: { phase: 'requires-restart' } })
  const zeroCap = await mountRegistryStack(join(fixture.base, 'zerocap'), { maxAdditionalRoots: 0 })
  stacks.push(zeroCap)
  expect(zeroCap.registry.diagnostics).toMatchObject({ recoveryClass: 'config', recovery: { phase: 'requires-restart' } })
  const odd = await mountRegistryStack(join(fixture.base, 'odd'), { backgroundRecovery: 'sometimes' as unknown as boolean, maxAdditionalRoots: 'x' as unknown as number })
  stacks.push(odd)
  expect(odd.registry.authority.kind).toBe('config-invalid')
  const offRoot = join(fixture.base, 'off-store')
  mkdirSync(offRoot)
  const held = await RegistryAuthorityLease.acquire(join(offRoot, `${DOMAIN_NAME}.lock`))
  const off = await mountRegistryStack(join(fixture.base, 'off'), { sharedStorageRoot: offRoot, leasePath: join(offRoot, `${DOMAIN_NAME}.lock`), backgroundRecovery: false })
  stacks.push(off)
  await held.release()
  expect(off.registry.authority.kind).toBe('contended')
  expect(off.registry.diagnostics).toMatchObject({ recoveryClass: 'retryable', recovery: { phase: 'disabled' } })
})
