import { nativeHostAvailability } from '../src/authority/native.ts'
/** Production owner/follower facade over a real kernel lease and local IPC. */
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
  expect(invalid.registry.authority.kind).toBe('storage-failed')
  expect(invalid.registry.unavailable).toContain('canonical medium lock')
  expect(invalid.registry.available).toBe(false)
  expect(existsSync(wrongLock)).toBe(false)
  expect(owner.registry.authority.kind).toBe('active')
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
