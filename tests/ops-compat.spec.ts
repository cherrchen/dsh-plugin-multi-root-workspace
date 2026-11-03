import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import type { Config as ScopeConfig } from '../src/scope.ts'
import * as ProcessFence from '../src/process-fence.ts'
import {
  OPS_EXEC_NAMES, assertOpsPosixCacheAdmission, classifyOpsTool, opsDispatchBarrier,
} from '../src/compat/ops-tools.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { installToolExecutor, executeTool } from './support/tool-executor.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { installOpsSetting } from './support/ops-settings.ts'
import { MultiRootOpsCompatibility } from '../src/ops-compatibility.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
const stacks: Array<{ dispose(): Promise<void>, registryFiber: Awaited<ReturnType<Context['plugin']>> }> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('ops-compat')
})

afterEach(async () => {
  vi.restoreAllMocks()
  while (fibers.length > 0) await fibers.pop()?.dispose()
  while (stacks.length > 0) await stacks.pop()?.dispose()
  fixture.dispose()
})

const COMMAND = ['ops-worker', '--run']

interface Captured {
  spawned: SubprocessSpawnSpec[]
  bodies: string[]
}

interface World {
  ctx: Context
  provider: MultiRootSandboxProvider
  captured: Captured
  fenceFiber: Awaited<ReturnType<Context['plugin']>>
  scopeFiber: Awaited<ReturnType<Context['plugin']>>
  agent: Agent
  setOpsEnabled: (value: boolean) => void
}

function seatbelt(): SandboxInternals { return { chain: ['seatbelt'] } }

function member(path: string, access: 'inherit' | 'read-only' | 'read-write', index = 0) {
  return { id: `root-${index}`, path, recordedPath: canonicalPath(path), access }
}

function opsTool(ctx: Context, name: string, captured: Captured, hooks: { run?: () => Promise<unknown> | unknown } = {}): void {
  ctx.tools.register({
    name,
    description: `spec tool ${name}`,
    parameters: { type: 'object', properties: { run_in_background: { type: 'boolean' } } },
    output: {
      schema: { type: 'object', properties: { status: { type: 'string' } } },
      render: () => name,
    },
    execute: async () => {
      captured.bodies.push(name)
      await hooks.run?.()
      ctx.subprocess.spawn({ argv: COMMAND, cwd: fixture.workspace })
      return { status: 'ok' }
    },
  } as never)
}

async function mountWorld(options: {
  mode?: SandboxPolicy['mode'] | 'danger-full-access'
  scopeConfig?: ScopeConfig
  shared?: boolean
  toolsFirst?: boolean
  noFence?: boolean
  enabled?: boolean
  beforeFence?: (ctx: Context) => Promise<void>
} = {}): Promise<World> {
  const mode = options.mode ?? 'danger-full-access'
  const captured: Captured = { spawned: [], bodies: [] }
  if (options.shared) {
    const stack = await mountRegistryStack(join(fixture.base, 'store'), {
      sharedStorageRoot: join(fixture.base, 'store'),
      leasePath: join(fixture.base, 'store', 'multi_root_workspace.lock'),
    }, {
      scopeConfig: options.scopeConfig ?? {},
      beforeGate: async (ctx) => {
        await ctx.plugin(SessionProjectionRegistry)
        await ctx.plugin(Sessions)
        await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace })
        await ctx.plugin(MultiRootSandboxProvider, {})
        await ctx.plugin({
          name: 'ops-shared-surfaces',
          apply(fiber: Context) {
            fiber.provide('subprocess', {
              spawn: (spec: SubprocessSpawnSpec) => { captured.spawned.push(spec); return { pid: 1 } },
              spawnTerminal: async () => ({ pid: 2 }),
            } as never)
          },
        })
      },
    })
    stacks.push(stack)
    const setOpsEnabled = installOpsSetting(stack.ctx, options.enabled !== false)
    await stack.ctx.plugin(MultiRootOpsCompatibility, { enabled: options.enabled !== false })
    const ctx = stack.ctx
    const provider = ctx.sandbox as MultiRootSandboxProvider
    provider.internals = seatbelt()
    const toolsMount = async () => {
      fibers.push(await ctx.plugin(SystemPrompt, {}), await ctx.plugin(Tools, {}))
      await installToolExecutor(ctx)
    }
    if (options.toolsFirst === true) await toolsMount()
    await options.beforeFence?.(ctx)
    const fenceFiber = options.noFence === true ? undefined : await ctx.plugin(ProcessFence)
    if (options.toolsFirst !== true) await toolsMount()
    const agent = { id: 'ops-shared-agent', session: ctx.sessions.create(SessionId('ops-shared-session'), { meta: { cwd: fixture.workspace } }) } as unknown as Agent
    return { ctx, provider, captured, fenceFiber: fenceFiber as World['fenceFiber'], scopeFiber: undefined as unknown as World['scopeFiber'], agent, setOpsEnabled }
  }
  const ctx = new Context()
  const scopeFiber = await ctx.plugin(MultiRootScopeService, options.scopeConfig ?? {})
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(Sessions),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
    scopeFiber,
  )
  const setOpsEnabled = installOpsSetting(ctx, options.enabled !== false)
  await mountCompat(ctx)
  fibers.push(await ctx.plugin(MultiRootOpsCompatibility, { enabled: options.enabled !== false }))
  fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
  const provider = ctx.sandbox as MultiRootSandboxProvider
  provider.internals = seatbelt()
  await mountProviderGate(ctx)
  const toolsMount = async () => {
    fibers.push(await ctx.plugin(SystemPrompt, {}), await ctx.plugin(Tools, {}))
    await installToolExecutor(ctx)
  }
  await ctx.plugin({
    name: 'ops-surfaces',
    apply(fiber: Context) {
      fiber.provide('subprocess', {
        spawn: (spec: SubprocessSpawnSpec) => { captured.spawned.push(spec); return { pid: 1 } },
        spawnTerminal: async () => ({ pid: 2 }),
      } as never)
    },
  })
  if (options.toolsFirst === true) await toolsMount()
  const fenceFiber = options.noFence === true ? undefined : await ctx.plugin(ProcessFence)
  if (options.toolsFirst !== true) await toolsMount()
  const agent = { id: 'ops-agent', session: ctx.sessions.create(SessionId('ops-session'), { meta: { cwd: fixture.workspace } }) } as unknown as Agent
  return { ctx, provider, captured, fenceFiber: fenceFiber as World['fenceFiber'], scopeFiber, agent, setOpsEnabled }
}

function call(world: World, name: string, args: unknown = {}, agent: Agent | undefined = world.agent) {
  return executeTool(world.ctx, { callId: `call-${name}-${world.captured.bodies.length}`, name, args, agent, signal: new AbortController().signal })
}

const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true
const resultText = (result: unknown): string => JSON.stringify(result)

describe('the OPS dispatch barrier', () => {
  it('confines an adapted OPS call to ambient-minus-deny under full access', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const result = await call(world, 'ops_write_file', { path: join(fixture.outside, 'x.txt') })
    expect(isError(result)).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_write_file'])
    expect(world.captured.spawned).toHaveLength(1)
    const argv = world.captured.spawned[0]!.argv
    expect(argv.slice(0, 2)).toEqual(['sandbox-exec', '-p'])
    expect(argv.join(' ')).toContain('(deny file-write*')
    expect(argv.slice(-COMMAND.length)).toEqual(COMMAND)
  })

  it('refuses every adapted OPS call while the authority is unavailable — reads included', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    for (const name of ['ops_write_file', 'ops_read_files', 'ops_stat', 'ops_result', 'ops_discover_tools']) opsTool(world.ctx, name, world.captured)
    world.ctx.multiRootScope.setRegistryAuthority(false)
    for (const name of ['ops_write_file', 'ops_read_files', 'ops_stat', 'ops_result']) {
      const result = await call(world, name)
      expect(isError(result), name).toBe(true)
      expect(resultText(result)).toContain('authority is unavailable')
    }
    expect(isError(await call(world, 'ops_discover_tools'))).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_discover_tools'])
  })

  it('refuses an adapted OPS call whose session/policy cannot be confirmed', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const scope = world.ctx.get('multiRootScope')!
    const exec = { callId: 'identityless', name: 'ops_write_file' } as never
    expect(opsDispatchBarrier(world.ctx, scope, exec)).toContain('cannot be confirmed')
  })

  it('keeps workspace-write/read-only calls out of the barrier — no new refusals', async () => {
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const world = await mountWorld({ mode })
      world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
      opsTool(world.ctx, 'ops_read_files', world.captured)
      world.ctx.multiRootScope.setRegistryAuthority(false)
      const result = await call(world, 'ops_read_files')
      expect(isError(result), mode).toBe(false)
      expect(world.captured.bodies).toEqual(['ops_read_files'])
    }
  })

  it('refuses unrecognized and background OPS capabilities only where boundaries apply', async () => {
    const world = await mountWorld()
    for (const name of ['ops_mystery', 'ops_bash']) opsTool(world.ctx, name, world.captured)
    expect(isError(await call(world, 'ops_mystery'))).toBe(false)
    expect(isError(await call(world, 'ops_bash', { run_in_background: true }))).toBe(false)
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    expect(isError(await call(world, 'ops_mystery'))).toBe(true)
    expect(isError(await call(world, 'ops_bash', { run_in_background: true }))).toBe(true)
    expect(isError(await call(world, 'ops_bash', { run_in_background: false }))).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_mystery', 'ops_bash', 'ops_bash'])
  })

  it('refuses an adapted call when the protection generation was never installed', async () => {
    const world = await mountWorld({ noFence: true })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const spy = vi.spyOn(world.provider, 'restrictedExecution')
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('protection is not installed')
    expect(world.captured.bodies).toEqual([])
    expect(world.captured.spawned).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not refuse an adapted call when the compatibility gate is absent', async () => {
    const ctx = new Context()
    const scope = await ctx.plugin(MultiRootScopeService, {})
    const barrier = opsDispatchBarrier(ctx, ctx.get('multiRootScope')!, { callId: 'x', name: 'ops_write_file' } as never)
    expect(barrier).toBeUndefined()
    await scope.dispose()
  })

  it('caps only the configured OPS tool and leaves siblings alone', async () => {
    const { mkdirSync } = await import('node:fs')
    const second = join(fixture.base, 'second')
    mkdirSync(second)
    const world = await mountWorld({ scopeConfig: { toolAccess: { ops_write_file: 'read-only' } } })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      member(fixture.outside, 'read-only', 0),
      member(second, 'read-write', 1),
    ])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    opsTool(world.ctx, 'ops_stat', world.captured)
    const capped = await call(world, 'ops_write_file')
    const sibling = await call(world, 'ops_stat')
    expect(isError(capped)).toBe(false)
    expect(isError(sibling)).toBe(false)
    const cappedArgv = world.captured.spawned[0]!.argv.join(' ')
    const siblingArgv = world.captured.spawned[1]!.argv.join(' ')
    expect(cappedArgv).toContain('(deny file-write*')
    expect(cappedArgv).toContain('second')
    expect(siblingArgv).toContain('(deny file-write*')
    expect(siblingArgv).not.toContain('second')
    expect(world.captured.spawned).toHaveLength(2)
  })

  it('installs the guard in either load order', async () => {
    for (const toolsFirst of [false, true]) {
      const world = await mountWorld({ toolsFirst })
      world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
      opsTool(world.ctx, 'ops_write_file', world.captured)
      const result = await call(world, 'ops_write_file')
      expect(isError(result), `toolsFirst=${toolsFirst}`).toBe(false)
      expect(world.captured.spawned[0]!.argv.join(' ')).toContain('(deny file-write*')
    }
  })

  it.each(OPS_EXEC_NAMES)('runs adapted OPS capability %s inside a confined domain', async (name) => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, name, world.captured)
    const result = await call(world, name)
    expect(isError(result), name).toBe(false)
    const argv = world.captured.spawned.at(-1)!.argv.join(' ')
    expect(argv).toContain('(deny file-write*')
  })
})

describe('the protection lifecycle', () => {
  it('refuses a call revoked after the guard passed but before dispatch', async () => {
    const ctx = new Context()
    ctx.on('tools/execute', async (exec, next) => {
      await killFence()
      return await next()
    })
    const scopeFiber = await ctx.plugin(MultiRootScopeService, {})
    fibers.push(
      scopeFiber,
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(Sessions),
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: fixture.workspace }),
    )
    await mountCompat(ctx)
    fibers.push(await ctx.plugin(MultiRootOpsCompatibility, { enabled: true }))
    fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
    const provider = ctx.sandbox as MultiRootSandboxProvider
    provider.internals = seatbelt()
    await mountProviderGate(ctx)
    const captured: Captured = { spawned: [], bodies: [] }
    await ctx.plugin({
      name: 'ops-surfaces',
      apply(fiber: Context) {
        fiber.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => { captured.spawned.push(spec); return { pid: 1 } } } as never)
      },
    })
    fibers.push(await ctx.plugin(SystemPrompt, {}), await ctx.plugin(Tools, {}))
    const fenceFiber = await ctx.plugin(ProcessFence)
    const killFence: () => Promise<unknown> = async () => fenceFiber.dispose()
    await installToolExecutor(ctx)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(ctx, 'ops_write_file', captured)
    const agent = { id: 'ops-agent', session: ctx.sessions.create(SessionId('mid-flight'), { meta: { cwd: fixture.workspace } }) } as unknown as Agent
    const result = await executeTool(ctx, { callId: 'mid', name: 'ops_write_file', args: {}, agent, signal: new AbortController().signal })
    expect(isError(result)).toBe(true)
    expect(captured.bodies).toEqual([])
    expect(captured.spawned).toEqual([])
  })

  it('refuses a call whose protection generation was replaced during preparation', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    let releasePrepare!: (facts: never) => void
    const prepareGate = new Promise<never>(resolve => { releasePrepare = resolve })
    vi.spyOn(world.provider, 'restrictedExecution').mockImplementationOnce(() => prepareGate)
    const pending = call(world, 'ops_write_file')
    await new Promise(resolve => setTimeout(resolve, 30))
    const dispose = world.fenceFiber.dispose()
    fibers.push(await world.ctx.plugin(ProcessFence))
    releasePrepare({ argv: ['sandbox-exec', '-p', 'x', '--'] } as never)
    const result = await pending
    await dispose
    expect(isError(result)).toBe(true)
    expect(resultText(result)).toContain('generation was replaced')
    expect(world.captured.bodies).toEqual([])
    expect(world.captured.spawned).toEqual([])
  })

  it('refuses a call still queued in registry admission when the fence unloads', async () => {
    const world = await mountWorld({ shared: true })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const registry = world.ctx.get('multiRootRegistry')!
    let releaseAdmission!: (value: unknown) => void
    const admissionGate = new Promise<unknown>(resolve => { releaseAdmission = resolve })
    const original = registry.withOperation.bind(registry)
    vi.spyOn(registry, 'withOperation').mockImplementationOnce(async (policy, kind, body) =>
      admissionGate.then(() => original(policy, kind, body as () => Promise<unknown>)) as never)
    const pending = call(world, 'ops_write_file')
    await new Promise(resolve => setTimeout(resolve, 30))
    const dispose = world.fenceFiber.dispose()
    releaseAdmission(undefined)
    const result = await pending
    await dispose
    expect(isError(result)).toBe(true)
    expect(world.captured.bodies).toEqual([])
  })

  it('drains an entered dispatch before the fence unloads; later calls refuse', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    opsTool(world.ctx, 'ops_write_file', world.captured, { run: () => gate })
    const pending = call(world, 'ops_write_file')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(world.captured.bodies).toEqual(['ops_write_file'])
    const dispose = world.fenceFiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    release()
    const result = await pending
    await dispose
    expect(isError(result)).toBe(false)
    const after = await call(world, 'ops_write_file')
    expect(isError(after)).toBe(true)
    expect(resultText(after)).toContain('protection is not installed')
  })

  it('survives a stale cleanup: an older generation cannot revoke the newer claim', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    await world.fenceFiber.dispose()
    const fenceFiber = await world.ctx.plugin(ProcessFence)
    fibers.push(fenceFiber)
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(false)
    expect(world.captured.spawned[0]!.argv.join(' ')).toContain('(deny file-write*')
  })

  it('finishes an in-flight call on its snapshot while the scope row is replaced', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    opsTool(world.ctx, 'ops_write_file', world.captured, { run: () => gate })
    const pending = call(world, 'ops_write_file')
    await new Promise(resolve => setTimeout(resolve, 30))
    const oldState = world.ctx.get('multiRootScope')!.opsProtection
    const unload = world.scopeFiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    release()
    const result = await pending
    await unload
    expect(isError(result)).toBe(false)
    expect(world.captured.spawned[0]!.argv.join(' ')).toContain('(deny file-write*')
    expect(world.ctx.get('multiRootScope')).toBeUndefined()
    const scopeFiber = await world.ctx.plugin(MultiRootScopeService, {})
    fibers.push(scopeFiber)
    const newState = world.ctx.get('multiRootScope')!.opsProtection
    expect(newState).not.toBe(oldState)
    for (let i = 0; i < 100 && newState.owner === undefined; i++) await new Promise(resolve => setTimeout(resolve, 20))
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const next = await call(world, 'ops_write_file')
    expect(isError(next)).toBe(false)
    expect(world.captured.spawned[1]!.argv.join(' ')).toContain('(deny file-write*')
  })

  it('refuses a trailing asynchronous spawn once the domain has expired', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    let trailing: string = 'pending'
    opsTool(world.ctx, 'ops_write_file', world.captured, {
      run: () => setTimeout(() => {
        try { world.ctx.subprocess.spawn({ argv: ['late'], cwd: fixture.workspace }); trailing = 'spawned' }
        catch (error) { trailing = (error as Error).message }
      }, 0),
    })
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(false)
    expect(world.captured.spawned[0]!.argv).toEqual(COMMAND)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(trailing).toContain('expired')
    expect(world.captured.spawned).toHaveLength(1)
  })

  it('restores ambient behavior after a dispatch throws', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    let first = true
    opsTool(world.ctx, 'ops_write_file', world.captured, { run: () => {
      if (!first) return
      first = false
      throw new Error('body blew up')
    } })
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(true)
    let trailing = 'pending'
    setTimeout(() => {
      try { world.ctx.subprocess.spawn({ argv: ['late'], cwd: fixture.workspace }); trailing = 'spawned' }
      catch (error) { trailing = (error as Error).message }
    }, 0)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(trailing).toBe('spawned')
    const second = await call(world, 'ops_write_file')
    expect(isError(second)).toBe(false)
  })

  it('runs a nested OPS dispatch under its own confined profile', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_stat', world.captured)
    opsTool(world.ctx, 'ops_write_file', world.captured, {
      run: async () => { await call(world, 'ops_stat') },
    })
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_write_file', 'ops_stat'])
    expect(world.captured.spawned).toHaveLength(2)
    for (const spec of world.captured.spawned) {
      expect(spec.argv.join(' ')).toContain('(deny file-write*')
    }
  })

  it('keeps the scope guard alive after the registry unloads', async () => {
    const world = await mountWorld({ shared: true })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    await stacks[0]!.registryFiber.dispose()
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(true)
    expect(world.captured.bodies).toEqual([])
  })
})

describe('the D1.1c POSIX cache preflight', () => {
  const hex = 'a'.repeat(64)
  it('classifies the OPS tool surface conservatively', () => {
    expect(classifyOpsTool('ops_write_file')).toBe('exec')
    expect(classifyOpsTool('ops_result')).toBe('exec')
    expect(classifyOpsTool('ops_batch')).toBe('exec')
    expect(classifyOpsTool('ops_bash')).toBe('exec')
    expect(classifyOpsTool('ops_discover_tools')).toBe('publish')
    expect(classifyOpsTool('ops_load_sdk')).toBe('publish')
    expect(classifyOpsTool('ops_unlisted')).toBe('unknown')
    expect(classifyOpsTool('write')).toBe('other')
  })

  it('refuses when a deny boundary covers tmpdir or the result-cache family', () => {
    const tmp = realpathSync.native(tmpdir())
    expect(() => assertOpsPosixCacheAdmission([tmp])).toThrow(/covers the temporary directory/)
    expect(() => assertOpsPosixCacheAdmission([join(tmp, '..')])).toThrow(/covers the temporary directory/)
    expect(() => assertOpsPosixCacheAdmission(['/'])).toThrow(/covers the temporary directory/)
    expect(() => assertOpsPosixCacheAdmission([join(tmp, `dsh-ops-results-${hex}`)])).toThrow(/overlaps the OPS result cache/)
    expect(() => assertOpsPosixCacheAdmission([join(tmp, `dsh-ops-results-${hex}`, 'nested', 'file')])).toThrow(/overlaps the OPS result cache/)
    expect(() => assertOpsPosixCacheAdmission([join(tmp, `dsh-ops-results-${'b'.repeat(64)}`)])).toThrow(/overlaps the OPS result cache/)
    expect(() => assertOpsPosixCacheAdmission([join(tmp, 'project-root'), join(tmp, 'additional'), join(tmp, `dsh-ops-results-${'zz'.repeat(32)}`)])).not.toThrow()
    expect(() => assertOpsPosixCacheAdmission([fixture.workspace])).not.toThrow()
  })

  it('refuses when tmpdir cannot be resolved', () => {
    const spy = vi.spyOn(realpathSync, 'native').mockImplementation(() => { throw new Error('gone') })
    try {
      expect(() => assertOpsPosixCacheAdmission([fixture.workspace])).toThrow(/cannot be resolved/)
    } finally {
      spy.mockRestore()
    }
  })

  it('normalizes tmpdir alias spellings on the recorded boundary', () => {
    const raw = tmpdir()
    const canonical = realpathSync.native(raw)
    if (raw === canonical) return
    expect(() => assertOpsPosixCacheAdmission([join(raw, `dsh-ops-results-${hex}`)])).toThrow(/overlaps the OPS result cache/)
    expect(() => assertOpsPosixCacheAdmission([join(raw, 'ordinary-sibling')])).not.toThrow()
  })

  it('reaches the restricted worker for an ordinary tmpdir sibling', async () => {
    const world = await mountWorld()
    const sibling = mkdtempSync(join(tmpdir(), 'ops-compat-sibling-'))
    try {
      world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(sibling, 'read-only')])
      opsTool(world.ctx, 'ops_write_file', world.captured)
      const result = await call(world, 'ops_write_file')
      expect(isError(result)).toBe(false)
      expect(world.captured.spawned[0]!.argv.join(' ')).toContain('(deny file-write*')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('refuses the whole call before any preparation when tmpdir itself is denied', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(tmpdir(), 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const spy = vi.spyOn(world.provider, 'restrictedExecution')
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(true)
    expect(world.captured.bodies).toEqual([])
    expect(world.captured.spawned).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses to enter the body when the runner preparation fails', async () => {
    const world = await mountWorld()
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    vi.spyOn(world.provider, 'restrictedExecution').mockImplementation(() => { throw new Error('runner unavailable') })
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(true)
    expect(world.captured.bodies).toEqual([])
    expect(world.captured.spawned).toEqual([])
  })

  it('lets ambient external writes through a healthy no-deny domain', async () => {
    const world = await mountWorld()
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(false)
    expect(world.captured.spawned[0]!.argv).toEqual(COMMAND)
  })
})

describe('scoped carrier dispatch', () => {
  it('applies cap and profile through the public pipeline for an agent with a real agent.ctx', async () => {
    const world = await mountWorld({ scopeConfig: { toolAccess: { ops_write_file: 'read-only' } } })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    opsTool(world.ctx, 'ops_stat', world.captured)
    const scopedFiber = await world.ctx.plugin({ name: 'scoped-agent', apply() {} })
    const agent = { id: 'scoped-agent', session: world.agent.session, ctx: scopedFiber.ctx } as unknown as Agent
    const capped = await call(world, 'ops_write_file', {}, agent)
    expect(isError(capped)).toBe(false)
    expect(world.captured.spawned.at(-1)!.argv.join(' ')).toContain('(deny file-write*')
    const sibling = await call(world, 'ops_stat', {}, agent)
    expect(isError(sibling)).toBe(false)
    expect(world.captured.spawned.at(-1)!.argv).toEqual(COMMAND)
    await scopedFiber.dispose()
  })
})

describe('nested OPS dispatch under a shared registry', () => {
  it('prepares an inner profile for a nested call and refuses a foreign confined argv', async () => {
    const world = await mountWorld({ shared: true })
    await world.ctx.multiRootRegistry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
    const spy = vi.spyOn(world.provider, 'restrictedExecution')
    let outerArgv: readonly string[] = []
    let sameError: unknown
    let foreignError: unknown
    let innerResult: unknown
    opsTool(world.ctx, 'ops_edit_file', world.captured, {
      run: async () => {
        try {
          world.ctx.subprocess.spawn({ argv: [...outerArgv], cwd: fixture.workspace })
        } catch (error) { sameError = error }
        const tampered = [...outerArgv]
        tampered[2] = '(version 1) (allow default) (deny file-write* (subpath "/elsewhere"))'
        try {
          world.ctx.subprocess.spawn({ argv: tampered, cwd: fixture.workspace })
        } catch (error) { foreignError = error }
      },
    })
    opsTool(world.ctx, 'ops_write_file', world.captured, {
      run: async () => {
        world.ctx.subprocess.spawn({ argv: COMMAND, cwd: fixture.workspace })
        outerArgv = world.captured.spawned.at(-1)!.argv
        innerResult = await call(world, 'ops_edit_file')
      },
    })
    const result = await call(world, 'ops_write_file')
    expect(isError(result)).toBe(false)
    expect(isError(innerResult)).toBe(false)
    expect(spy.mock.calls.length).toBe(2)
    expect(sameError).toBeUndefined()
    expect(foreignError).toBeInstanceOf(Error)
    expect(String((foreignError as Error).message)).toContain("own profile")
    const innerSpawn = world.captured.spawned.at(-1)!
    expect(innerSpawn.argv.slice(-COMMAND.length)).toEqual(COMMAND)
    expect(innerSpawn.argv.join(' ')).toContain('(deny file-write*')
    expect(world.captured.bodies).toEqual(['ops_write_file', 'ops_edit_file'])
  })

  it('refuses unknown and background OPS calls when a deny boundary appears at admission', async () => {
    for (const name of ['ops_mystery', 'ops_bash']) {
      const world = await mountWorld({
        shared: true,
        beforeFence: async (ctx) => {
          await ctx.plugin({
            name: 'admission-deny-injector',
            apply(fiber: Context) {
              fiber.on('tools/execute', async (exec: { name: string }, next: () => Promise<unknown>) => {
                if (exec.name === name) {
                  await ctx.multiRootRegistry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
                }
                return await next()
              })
            },
          })
        },
      })
      opsTool(world.ctx, name, world.captured)
      const result = await call(world, name, name === 'ops_bash' ? { run_in_background: true } : {})
      expect(isError(result), name).toBe(true)
      expect(world.captured.bodies, name).toEqual([])
      expect(world.captured.spawned, name).toEqual([])
    }
  })
})

describe('OPS compatibility mode off', () => {
  it('runs an OPS write through the generic dispatch without restricted confinement', async () => {
    const world = await mountWorld({ mode: 'danger-full-access', enabled: false })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const spy = vi.spyOn(world.provider, 'restrictedExecution')
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const result = await call(world, 'ops_write_file', { path: join(fixture.outside, 'x.txt') })
    expect(isError(result)).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_write_file'])
    expect(spy).not.toHaveBeenCalled()
    expect(world.captured.spawned.length).toBeGreaterThan(0)
  })

  it('runs an unknown OPS name through the generic dispatch while off', async () => {
    const world = await mountWorld({ mode: 'danger-full-access', enabled: false })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_mystery', world.captured)
    const result = await call(world, 'ops_mystery', { path: 'x' })
    expect(isError(result)).toBe(false)
    expect(world.captured.bodies).toEqual(['ops_mystery'])
  })

  it('confines and refuses the same calls once the mode is enabled', async () => {
    const world = await mountWorld({ mode: 'danger-full-access' })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const result = await call(world, 'ops_write_file', { path: join(fixture.outside, 'x.txt') })
    expect(result.isError).toBe(false)
    expect(world.captured.spawned[0]!.argv.slice(0, 2)).toEqual(['sandbox-exec', '-p'])
    opsTool(world.ctx, 'ops_mystery', world.captured)
    const unknown = await call(world, 'ops_mystery', { path: 'x' })
    expect(unknown.isError).toBe(true)
  })
})

describe('OPS mode toggle lifecycle', () => {
  it.each([false, true])('refuses a dispatch when the mode toggles during prepare (re-enable: %s)', async (reOn) => {
    const world = await mountWorld({ mode: 'danger-full-access' })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    let release!: () => void
    let started!: () => void
    const preparing = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<{ argv: string[] }>(resolve => { release = () => resolve({ argv: ['sandbox-exec', '-p'] }) })
    vi.spyOn(world.provider, 'restrictedExecution').mockImplementationOnce(() => { started(); return gate as never })
    opsTool(world.ctx, 'ops_write_file', world.captured)
    const pending = call(world, 'ops_write_file', { path: join(fixture.outside, 'x.txt') })
    try {
      await preparing
      world.setOpsEnabled(false)
      if (reOn) world.setOpsEnabled(true)
      release()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(world.captured.bodies).toEqual([])
      expect(world.captured.spawned).toEqual([])
    } finally { release(); await pending }
  })

  it('keeps the entry-time profile for a body already running when the mode turns off', async () => {
    const world = await mountWorld({ mode: 'danger-full-access' })
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    opsTool(world.ctx, 'ops_write_file', world.captured, { run: () => { started(); return gate } })
    const pending = call(world, 'ops_write_file', { path: join(fixture.outside, 'x.txt') })
    try {
      await entered
      world.setOpsEnabled(false)
      opsTool(world.ctx, 'ops_read_files', world.captured)
      const second = await call(world, 'ops_read_files', { files: [] })
      release()
      const first = await pending
      expect(second.isError).toBe(false)
      expect(first.isError).toBe(false)
      expect(world.captured.spawned).toHaveLength(2)
      expect(world.captured.spawned[0]!.argv).toEqual(COMMAND)
      expect(world.captured.spawned[1]!.argv.slice(0, 2)).toEqual(['sandbox-exec', '-p'])
    } finally { release(); await pending }
  })
})
