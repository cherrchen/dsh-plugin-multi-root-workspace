/** Deterministic admission/revocation interleavings over the production store. */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MultiRootFileSystem from '../src/fs.ts'
import type { RegistryOperation } from '../src/registry-operation.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
let policy: SandboxExecutionPolicy

beforeEach(() => {
  fixture = createFixtureWorkspace('registry-operation')
  stacks = []
  policy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const stack of stacks.reverse()) await stack.dispose()
  fixture.dispose()
})

async function mount(toolAccess?: Record<string, 'read-only'>): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {}, {
    scopeConfig: toolAccess === undefined ? {} : { toolAccess },
    beforeGate: async ctx => {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, policy)
      await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
    },
  })
  stacks.push(stack)
  return stack
}

/** Pause real durable publication; the gate is always released by the caller. */
function gatePut(stack: RegistryStack) {
  const table = (stack.registry as unknown as { table: { put(key: string, value: unknown): Promise<void> } }).table
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = table.put.bind(table)
  let first = true
  vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
    if (first) { first = false; entered.resolve(); await release.promise }
    return original(key, value)
  })
  return { entered: entered.promise, release: release.resolve }
}

describe('local Registry operation admission', () => {
  it.each(['write', 'edit'] as const)('allows an admitted %s to finish after revocation, and refuses the next invocation', async kind => {
    const stack = await mount(), { ctx, registry } = stack
    await registry.add(fixture.workspace, { path: fixture.outside })
    const path = join(fixture.outside, 'file.txt')
    writeFileSync(path, 'before')
    const target = await ctx.fs.resolve(path)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = ctx.fs.resolve.bind(ctx.fs)
    let first = true
    vi.spyOn(ctx.fs, 'resolve').mockImplementation(async (...args) => {
      const resolved = await original(...args)
      if (first) { first = false; entered.resolve(); await release.promise }
      return resolved
    })
    const perform = () => kind === 'write'
      ? ctx.fs.writeText(target, 'after', undefined, undefined, policy)
      : ctx.fs.editText(target, { oldString: 'before', newString: 'after', replaceAll: false }, undefined, undefined, policy)
    const admitted = perform()
    try {
      await entered.promise // admission has finished, target checking is paused
      await registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
      expect(readFileSync(path, 'utf8')).toBe('before')
      await expect(perform()).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally { release.resolve() }
    await admitted
    expect(readFileSync(path, 'utf8')).toBe('after')
  })

  it('places a new fs admission after an already-pending durable revocation', async () => {
    const stack = await mount(), { ctx, registry } = stack
    await registry.add(fixture.workspace, { path: fixture.outside })
    const path = join(fixture.outside, 'denied.txt'), target = await ctx.fs.resolve(path)
    const gate = gatePut(stack)
    const revoke = registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
    await gate.entered
    const write = ctx.fs.writeText(target, 'must not land', undefined, undefined, policy)
    const assertion = expect(write).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    gate.release()
    await revoke; await assertion
    expect(existsSync(path)).toBe(false)
  })

  it('orders different primary roots through the same store queue', async () => {
    const stack = await mount(), { registry } = stack
    const gate = gatePut(stack), other = join(fixture.base, 'other-primary')
    mkdirSync(other)
    const mutation = registry.add(fixture.workspace, { path: fixture.outside })
    await gate.entered
    const internal = registry as unknown as { serialize(key: string, job: () => unknown): Promise<unknown> }
    const serialize = internal.serialize.bind(internal), queued = Promise.withResolvers<void>()
    vi.spyOn(internal, 'serialize').mockImplementation((key, job) => {
      const work = serialize(key, job)
      if (key === canonicalPath(other)) queued.resolve()
      return work
    })
    const resolve = vi.spyOn(stack.scope, 'resolve')
    const operation = registry.withOperation({ ...policy, workspaceRoot: other }, 'fs-write', () => {
      expect(registry.list(fixture.workspace)).toHaveLength(1)
    })
    try {
      await queued.promise // B has reached the queue while A is still at put.
      expect(resolve).not.toHaveBeenCalled()
    } finally { gate.release() }
    await mutation; await operation
  })

  it('does not serialize operation I/O or let a failed callback poison mutations', async () => {
    const { registry } = await mount()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const operation = registry.withOperation(policy, 'fs-edit', async () => {
      entered.resolve(); await release.promise; throw new Error('operation failed')
    })
    const assertion = expect(operation).rejects.toThrow('operation failed')
    try {
      await entered.promise
      await registry.add(fixture.workspace, { path: fixture.outside })
    } finally { release.resolve() }
    await assertion
    await registry.remove(fixture.workspace, { kind: 'path', path: fixture.outside })
    expect(registry.list(fixture.workspace)).toEqual([])
  })

  it('uses immutable per-invocation identities and expires access after success or failure', async () => {
    const { registry } = await mount()
    await registry.add(fixture.workspace, { path: fixture.outside })
    let previous: RegistryOperation | undefined
    const identities = []
    for (const fail of [false, true]) {
      const call = registry.withOperation(policy, 'fs-write', operation => {
        expect(previous === undefined || operation.identity.operationId !== previous.identity.operationId).toBe(true)
        expect(Object.isFrozen(operation.scope)).toBe(true)
        expect(Object.isFrozen(operation.scope.roots[0])).toBe(true)
        expect(() => (operation.scope.writableRoots as string[]).push('/untrusted')).toThrow()
        previous = operation; identities.push(operation.identity)
        if (fail) throw new Error('body failed')
      })
      if (fail) await expect(call).rejects.toThrow('body failed')
      else await call
      expect(() => previous!.scope).toThrow('admission has expired')
    }
    expect(identities[0]).toMatchObject({ authorityEpoch: expect.any(String), revision: expect.any(Number) })
    expect(identities[1]!.authorityEpoch).toBe(identities[0]!.authorityEpoch)
  })

  it('does not let a detached async descendant use the handle after completion', async () => {
    const { registry } = await mount(), release = Promise.withResolvers<void>()
    let descendant: Promise<unknown> | undefined
    await registry.withOperation(policy, 'fs-write', operation => {
      descendant = release.promise.then(() => operation.scope)
    })
    const assertion = expect(descendant).rejects.toThrow('admission has expired')
    release.resolve()
    await assertion
  })

  it('keeps no-op refreshes quiet, versions real publications, and changes epoch on takeover', async () => {
    const owner = await mount(), { registry } = owner
    const capture = (stack: RegistryStack) => stack.registry.withOperation(policy, 'fs-write', op => op.identity)
    const initial = await capture(owner)
    const events = vi.fn(), stop = owner.scope.subscribe(events)
    try {
      await registry.refresh(fixture.workspace)
      expect((await capture(owner)).revision).toBe(initial.revision)
      expect(events).not.toHaveBeenCalled()
      await registry.add(fixture.workspace, { path: fixture.outside })
      expect((await capture(owner)).revision).toBeGreaterThan(initial.revision)
      const follower = await mount()
      const unavailable = await follower.registry.withOperation(policy, 'fs-write', op => ({ identity: op.identity, scope: op.scope }))
      expect(unavailable.identity.authorityEpoch).toBeUndefined()
      expect(unavailable.scope).toMatchObject({ authority: 'unavailable', writableRoots: [] })
      await owner.dispose()
      const successor = await capture(follower)
      expect(successor.authorityEpoch).toBeTypeOf('string')
      expect(successor.authorityEpoch).not.toBe(initial.authorityEpoch)
    } finally { stop() }
  })

  it('keeps primary-only fail-closed behavior under contention and after disposal', async () => {
    await mount()
    const stack = await mount()
    for (const mode of ['workspace-write', 'danger-full-access'] as const) {
      const target = await stack.ctx.fs.resolve(join(fixture.outside, `${mode}.txt`))
      await expect(stack.ctx.fs.writeText(target, 'denied', undefined, undefined, { ...policy, mode }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    await stack.dispose()
    const body = vi.fn()
    await expect(stack.registry.withOperation(policy, 'fs-write', body)).rejects.toThrow('after disposal')
    expect(body).not.toHaveBeenCalled()
  })

  it('preserves the scope test/smoke write port and direct-call tool caps', async () => {
    const stack = await mount({ bash: 'read-only' })
    stack.scope.setAdditionalRoots(fixture.workspace, [{
      id: 'test', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write',
    }])
    await stack.registry.withOperation(policy, 'fs-write', op => {
      expect(op.scope.additionalRoots).toEqual([canonicalPath(fixture.outside)])
      expect(op.scope.writableRoots).toEqual([]) // unknown tool identity is capped
    })
  })

  it('carries the trusted tool cap through queued admission without leaking to another dispatch', async () => {
    const stack = await mount({ bash: 'read-only' })
    await stack.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-write' })
    const dispatch = (name: string) => (stack.ctx.waterfall as Function).call(stack.ctx,
      'tools/execute', { name, callId: `call-${name}` }, async () => {
        const path = join(fixture.outside, `${name}.txt`)
        return stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), name, undefined, undefined, policy)
      }) as Promise<unknown>
    await Promise.all([
      expect(dispatch('bash')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' }),
      dispatch('write'),
    ])
    expect(existsSync(join(fixture.outside, 'bash.txt'))).toBe(false)
    expect(readFileSync(join(fixture.outside, 'write.txt'), 'utf8')).toBe('write')
  })

  it('never admits a replacement symlink as the recorded root', async context => {
    const unsupported = symlinkUnsupportedReason()
    if (unsupported) { context.skip(unsupported); return }
    const stack = await mount()
    await stack.registry.add(fixture.workspace, { path: fixture.outside })
    const replacement = join(fixture.base, 'replacement')
    mkdirSync(replacement)
    rmSync(fixture.outside, { recursive: true })
    symlinkSync(replacement, fixture.outside, process.platform === 'win32' ? 'junction' : 'dir')
    const target = await stack.ctx.fs.resolve(join(fixture.outside, 'escape.txt'))
    await expect(stack.ctx.fs.writeText(target, 'denied', undefined, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(replacement, 'escape.txt'))).toBe(false)
  })

  it.each(['inherit', 'read-only', 'read-write'] as const)('preserves the three-mode matrix for %s roots', async access => {
    const stack = await mount()
    await stack.registry.add(fixture.workspace, { path: fixture.outside, access })
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const path = join(fixture.outside, `${mode}.txt`)
      const write = stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), 'allowed', undefined, undefined, { ...policy, mode })
      if (access === 'read-only' || (access === 'inherit' && mode === 'read-only')) {
        await expect(write).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        expect(existsSync(path)).toBe(false)
      } else {
        await write
        expect(readFileSync(path, 'utf8')).toBe('allowed')
      }
    }
  })
})
