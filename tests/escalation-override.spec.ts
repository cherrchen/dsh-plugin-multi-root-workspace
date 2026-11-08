/**
 * The approved one-shot `danger-full-access` escalation override (ADR-0036).
 *
 * Upstream `approveEscalation` resolves the widening request through
 * `ctx.approval.request` and then runs the ONE call under
 * `{...standingPolicy, mode: approvedMode}` — the escalated policy object
 * carries no approval marker, so the plugin learns the grant at the approval
 * seam: the scope wraps `approval.request`, and only an `'allowed-once'`
 * outcome whose request carries the `escalate sandbox to danger-full-access:`
 * reason prefix AND the current dispatch's own callId marks the dispatch's
 * tool-cap store.
 *
 * That mark lifts two negative authorizations for THE CALL ALONE — explicit
 * `read-only` roots (and `inherit` roots that are read-only under the
 * standing mode) and every `toolAccess` cap, including the invalid-config
 * cap-everything case — while `$DSH_HOME` stays denied exactly when the
 * pre-override deny set was non-empty, and an `unavailable` registry
 * authority stays primary-root-only. Nothing else is affected: sibling and
 * nested dispatches get their own store, and a standing `danger-full-access`
 * session can never produce the marker (upstream escalates nothing past
 * full-access).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider, SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import type { Config as ScopeConfig } from '../src/scope.ts'
import * as ProcessFence from '../src/process-fence.ts'
import type { ToolCaller } from '../src/compat/tool-context.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import type { RegistryStack } from './support/registry-stack.ts'
import { sbplSubpath } from './support/sbpl.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
const stacks: RegistryStack[] = []

beforeEach(() => {
  fixture = createFixtureWorkspace('escalation-override')
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  while (stacks.length > 0) await stacks.pop()!.dispose()
  fixture.dispose()
})

const ESCALATION_REASON = 'escalate sandbox to danger-full-access: need host access for this command'

interface ApprovalStub {
  readonly requests: Array<{ readonly callId?: string; readonly reason?: string }>
  readonly service: { request(req: { callId?: string; reason?: string }): Promise<string> }
}

/** Mount a minimal approval service; the scope row wraps its `request`. */
function provideApproval(ctx: Context, outcome = 'allowed-once'): ApprovalStub {
  const requests: Array<{ callId?: string; reason?: string }> = []
  const service = {
    request: async (req: { callId?: string; reason?: string }) => {
      requests.push(req)
      return outcome
    },
  }
  ctx.provide('approval', service as never)
  return { requests, service }
}

function approvalService(ctx: Context): { request(req: { callId?: string; reason?: string }): Promise<string> } {
  return ctx.get('approval') as ApprovalStub['service']
}

/** Drive the REAL `tools/execute` waterfall the way dsh-tools dispatches a tool. */
function dispatch(ctx: Context, name: string, body: () => Promise<unknown>, callId = `call-${name}`, agent?: ToolCaller['agent']): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as (
    event: string,
    exec: ToolCaller,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  return waterfall('tools/execute', { name, callId, ...(agent === undefined ? {} : { agent }) }, body)
}

function policy(mode: SandboxExecutionPolicy['mode'] = 'workspace-write'): SandboxExecutionPolicy {
  return { mode, workspaceRoot: fixture.workspace }
}

function member(path: string, access: 'inherit' | 'read-only' | 'read-write') {
  return { id: `root-${path}`, path, recordedPath: canonicalPath(path), access }
}

/** Mount the scope row alone; `config` carries toolAccess / dshHome. */
async function mountScope(
  scopeConfig: ScopeConfig = {},
  outcome = 'allowed-once',
  standingMode: SandboxExecutionPolicy['mode'] = 'workspace-write',
  mountPolicy = true,
): Promise<{ ctx: Context; approval: ApprovalStub; agent: ToolCaller['agent'] }> {
  const ctx = new Context()
  const approval = provideApproval(ctx, outcome)
  const sessionId = SessionId(`escalation-override-${fixture.base}`)
  const session = Session.create(sessionId, [], {
    id: sessionId,
    cwd: fixture.workspace,
    version: SESSION_FORMAT_VERSION,
    createdAt: 0,
    isSeeded: false,
  })
  if (mountPolicy) {
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: standingMode, workspaceRoot: fixture.workspace }),
    )
  }
  fibers.push(await ctx.plugin(MultiRootScopeService, scopeConfig))
  return { ctx, approval, agent: { session } as ToolCaller['agent'] }
}

describe('the approved-escalation marker', () => {
  it('lifts a read-only root for the one approved call', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      // Before the approval resolves, the same escalated policy still denies.
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
      expect(await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })).toBe('allowed-once')
      const resolved = ctx.multiRootScope.resolve(escalated)
      expect(resolved.additionalRoots).toEqual([canonicalPath(fixture.outside)])
      expect(resolved.writableRoots).toEqual([canonicalPath(fixture.outside)])
      expect(resolved.deniedRoots).toEqual([])
    })
  })

  it('lifts an inherit root refused by the read-only standing mode', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'inherit')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(escalated).writableRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('lifts the per-tool cap for the approved call only', async () => {
    const { ctx, agent } = await mountScope({ toolAccess: { bash: 'read-only' } })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'bash', async () => {
      expect(ctx.multiRootScope.resolve(escalated).writableRoots).toEqual([])
      await approvalService(ctx).request({ agent, callId: 'call-bash', reason: ESCALATION_REASON })
      const resolved = ctx.multiRootScope.resolve(escalated)
      expect(resolved.writableRoots).toEqual([canonicalPath(fixture.outside)])
      expect(resolved.deniedRoots).toEqual([])
    })
  })

  it('lifts the invalid-toolAccess cap-everything refusal for the approved call', async () => {
    const { ctx, agent } = await mountScope({ toolAccess: { bash: 'read-write' } as never })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      expect(ctx.multiRootScope.resolve(escalated).writableRoots).toEqual([])
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      const resolved = ctx.multiRootScope.resolve(escalated)
      expect(resolved.writableRoots).toEqual([canonicalPath(fixture.outside)])
      expect(resolved.deniedRoots).toEqual([])
    })
  })

  it('keeps the protected DSH home denied exactly when the pre-override deny set was non-empty', async () => {
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const { ctx, agent } = await mountScope({ dshHome: home })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      const resolved = ctx.multiRootScope.resolve(escalated)
      // The workspace refusal lifted; the home stayed — it is denied precisely
      // because the pre-override deny set was non-empty.
      expect(resolved.deniedRoots).toEqual([canonicalPath(home)])
      expect(resolved.protectedHome).toBe(canonicalPath(home))
      expect(resolved.writableRoots).toEqual([canonicalPath(fixture.outside)])
    })
    // With no member left to deny there is no home boundary to keep either.
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-write')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      const resolved = ctx.multiRootScope.resolve(escalated)
      expect(resolved.deniedRoots).toEqual([])
      expect(resolved.protectedHome).toBeUndefined()
    })
  })

  it('never lifts the unavailable-authority downgrade, and keeps its known deny boundary', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    ctx.multiRootScope.setRegistryAuthority(false)
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      const resolved = ctx.multiRootScope.resolve(escalated)
      // Primary-root-only, same as today: the recorded deny boundary survives
      // the override because the store this process cannot read stays untrusted.
      expect(resolved.authority).toBe('unavailable')
      expect(resolved.writableRoots).toEqual([])
      expect(resolved.additionalRoots).toEqual([])
      expect(resolved.deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])('ignores the %s outcome', async (outcome) => {
    const { ctx, agent } = await mountScope({}, outcome)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('ignores an approval whose reason names another mode', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: 'escalate sandbox to workspace-write: x' })
      expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('ignores an approval pinned to a different callId', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-other', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('ignores an approval outside any tool dispatch', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
    expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
  })

  it('does not apply the override to a non-full-access call in the same dispatch', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      // The marker is bound to the escalated policy's mode, not the dispatch.
      expect(ctx.multiRootScope.resolve(policy('workspace-write')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
      expect(ctx.multiRootScope.resolve(policy('read-only')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('does not inherit the grant into a nested child dispatch', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'run_code', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-run_code', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([])
      // A tool the approved call dispatches gets a fresh store, approved = false.
      await dispatch(ctx, 'write', async () => {
        expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
      })
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([])
    })
  })

  it('does not leak into a sibling concurrent dispatch', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    const denied: number[] = []
    await Promise.all([
      dispatch(ctx, 'bash', async () => {
        await approvalService(ctx).request({ agent, callId: 'call-bash', reason: ESCALATION_REASON })
        await new Promise(resolve => setTimeout(resolve, 10))
        denied.push(ctx.multiRootScope.resolve(escalated).deniedRoots.length)
      }),
      dispatch(ctx, 'write', async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        denied.push(ctx.multiRootScope.resolve(escalated).deniedRoots.length)
      }),
    ])
    expect(denied.sort()).toEqual([0, 1])
  })

  it('does not carry the grant into the next dispatch', async () => {
    const { ctx, agent } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([])
    })
    await dispatch(ctx, 'write', async () => {
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    }, 'call-write-2')
  })

  it('never produces the marker in a standing danger-full-access session', async () => {
    const { ctx, agent } = await mountScope({}, 'allowed-once', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'bash', async () => {
      // An allowed-once carrying the prefix and this call's id is NOT an
      // escalation grant here: upstream escalates nothing past full-access.
      await approvalService(ctx).request({ agent, callId: 'call-bash', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('never produces the marker without an agent or a sandboxPolicy service', async () => {
    const { ctx, agent } = await mountScope({}, 'allowed-once', 'workspace-write', false)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      // No sandboxPolicy is mounted: the standing mode cannot be proven.
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
    const second = await mountScope({}, 'allowed-once', 'workspace-write', true)
    second.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(second.ctx, 'write', async () => {
      // The same request without an agent is not an escalation grant either.
      await approvalService(second.ctx).request({ callId: 'call-write', reason: ESCALATION_REASON })
      expect(second.ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('noteApproval rejects a full-access or unprovable standing mode', async () => {
    const { ctx } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const escalated = policy('danger-full-access')
    await dispatch(ctx, 'write', async () => {
      ctx.multiRootScope.noteApproval({ callId: 'call-write', reason: ESCALATION_REASON }, 'allowed-once', 'danger-full-access')
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
      ctx.multiRootScope.noteApproval({ callId: 'call-write', reason: ESCALATION_REASON }, 'allowed-once')
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([canonicalPath(fixture.outside)])
      // Positive control: a provable standing workspace-write accepts the grant.
      ctx.multiRootScope.noteApproval({ callId: 'call-write', reason: ESCALATION_REASON }, 'allowed-once', 'workspace-write')
      expect(ctx.multiRootScope.resolve(escalated).deniedRoots).toEqual([])
    })
  })

  it('keeps a plain danger-full-access session refusing — no approval, no override', async () => {
    const { ctx } = await mountScope()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    await dispatch(ctx, 'bash', async () => {
      expect(ctx.multiRootScope.resolve(policy('danger-full-access')).deniedRoots).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('restores the approval service request method on dispose', async () => {
    const ctx = new Context()
    const approval = provideApproval(ctx)
    const original = approval.service.request
    const fiber = await ctx.plugin(MultiRootScopeService)
    await vi.waitFor(() => { expect(approval.service.request).not.toBe(original) })
    await fiber.dispose()
    expect(approval.service.request).toBe(original)
  })
})

describe('the fs fence under an approved escalation', () => {
  async function mountFsWorld(scopeConfig: ScopeConfig = {}): Promise<{ ctx: Context; agent: ToolCaller['agent'] }> {
    const ctx = new Context()
    provideApproval(ctx)
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService, scopeConfig),
    )
    await mountCompat(ctx)
    fibers.push(await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }))
    const sessionId = SessionId(`escalation-fs-${fixture.base}`)
    const session = Session.create(sessionId, [], {
      id: sessionId, cwd: fixture.workspace, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false,
    })
    return { ctx, agent: { session } as ToolCaller['agent'] }
  }

  const escalated = (): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: fixture.workspace })

  it('lets the approved call write a read-only root while unapproved calls stay denied', async () => {
    const { ctx, agent } = await mountFsWorld()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const target = await ctx.fs.resolve(join(fixture.outside, 'unapproved.txt'))
    await expect(ctx.fs.writeText(target, 'x', undefined, undefined, escalated()))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(fixture.outside, 'unapproved.txt'))).toBe(false)
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      await ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'approved.txt')), 'x', undefined, undefined, escalated())
    })
    expect(existsSync(join(fixture.outside, 'approved.txt'))).toBe(true)
    // The next call in the same session is fenced again.
    await expect(ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'next.txt')), 'x', undefined, undefined, escalated()))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('still refuses a write under the DSH home inside the approved call', async () => {
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const { ctx, agent } = await mountFsWorld({ dshHome: home })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await dispatch(ctx, 'write', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-write', reason: ESCALATION_REASON })
      // The workspace refusal is gone; the home boundary is not.
      await ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'approved.txt')), 'x', undefined, undefined, escalated())
      await expect(ctx.fs.writeText(await ctx.fs.resolve(join(home, 'store.json')), 'x', undefined, undefined, escalated()))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED', message: expect.stringContaining('DSH home') })
    })
    expect(existsSync(join(fixture.outside, 'approved.txt'))).toBe(true)
    expect(existsSync(join(home, 'store.json'))).toBe(false)
  })
})

describe('the process fence under an approved escalation', () => {
  const COMMAND = ['bash', '-c', 'echo hi']

  async function mountProcessStack(scopeConfig: ScopeConfig = {}): Promise<{
    ctx: Context
    spawned: SubprocessSpawnSpec[]
  }> {
    const ctx = new Context()
    provideApproval(ctx)
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService, scopeConfig),
    )
    await mountCompat(ctx)
    fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
    ;(ctx.sandbox as LocalSandboxProvider).internals = { chain: ['seatbelt'] } satisfies SandboxInternals
    await mountProviderGate(ctx)
    const spawned: SubprocessSpawnSpec[] = []
    const execute = async () => ctx.subprocess.spawn({ argv: COMMAND, cwd: fixture.workspace })
    await ctx.plugin({
      name: 'escalation-process-surfaces',
      apply(fiber: Context) {
        fiber.provide('subprocess', {
          spawn: (spec: SubprocessSpawnSpec) => { spawned.push(spec); return { pid: 1 } },
          spawnTerminal: async () => ({ pid: 2 }),
        } as never)
        fiber.provide('shell', { execute } as never)
        fiber.provide('ptcRuntime', { run: execute } as never)
      },
    })
    const sessionId = SessionId(`escalation-proc-${fixture.base}`)
    const session = Session.create(sessionId, [], {
      id: sessionId, cwd: fixture.workspace, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false,
    })
    fibers.push(await ctx.plugin(ProcessFence))
    return { ctx, spawned, agent: { session } as ToolCaller['agent'] }
  }

  const escalated = (): SandboxPolicy => ({ mode: 'danger-full-access', workspaceRoot: fixture.workspace })

  it('runs the approved full-access call ambient while an unapproved one gets the restricted prefix', async () => {
    const { ctx, spawned, agent } = await mountProcessStack()
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: escalated() })
    expect(spawned[0]!.argv.join(' ')).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
    await dispatch(ctx, 'bash', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-bash', reason: ESCALATION_REASON })
      await shell.execute({ sandboxPolicy: escalated() })
    })
    expect(spawned[1]!.argv).toEqual(COMMAND)
    // The call after the approved one is restricted again.
    await shell.execute({ sandboxPolicy: escalated() })
    expect(spawned[2]!.argv.join(' ')).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
  })

  it('keeps the restricted runner for an approved call when the home alone is denied', async () => {
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const { ctx, spawned, agent } = await mountProcessStack({ dshHome: home })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await dispatch(ctx, 'bash', async () => {
      await approvalService(ctx).request({ agent, callId: 'call-bash', reason: ESCALATION_REASON })
      await shell.execute({ sandboxPolicy: escalated() })
    })
    const argv = spawned[0]!.argv.join(' ')
    expect(argv).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(home))}`)
    expect(argv).not.toContain(sbplSubpath(canonicalPath(fixture.outside)))
  })
})

describe('the shared Registry under an approved escalation', () => {
  const COMMAND = ['bash', '-c', 'echo hi']

  async function mountShared(scopeConfig: ScopeConfig = {}): Promise<{
    stack: RegistryStack
    ctx: Context
    spawned: SubprocessSpawnSpec[]
    session: Session
  }> {
    const spawned: SubprocessSpawnSpec[] = []
    const sessionId = SessionId('escalation-shared-session')
    const session = Session.create(sessionId, [], {
      id: sessionId,
      cwd: fixture.workspace,
      version: SESSION_FORMAT_VERSION,
      createdAt: 0,
      isSeeded: false,
    })
    const storeRoot = join(fixture.base, 'store')
    const stack = await mountRegistryStack(storeRoot, {}, {
      scopeConfig,
      beforeGate: async ctx => {
        provideApproval(ctx)
        await ctx.plugin(SessionProjectionRegistry)
        await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
        await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
        await ctx.plugin(MultiRootSandboxProvider, {})
        ;(ctx.sandbox as LocalSandboxProvider).internals = { chain: ['seatbelt'] } satisfies SandboxInternals
      },
    })
    stacks.push(stack)
    const ctx = stack.ctx
    const execute = async () => ctx.subprocess.spawn({ argv: COMMAND, cwd: fixture.workspace })
    await ctx.plugin({
      name: 'escalation-shared-surfaces',
      apply(fiber: Context) {
        fiber.provide('subprocess', {
          spawn: (spec: SubprocessSpawnSpec) => { spawned.push(spec); return { pid: 1 } },
          spawnTerminal: async () => ({ pid: 2 }),
        } as never)
        fiber.provide('shell', { execute } as never)
        fiber.provide('sessions', { get: (key: string) => key === sessionId ? session : undefined } as never)
      },
    })
    fibers.push(await ctx.plugin(ProcessFence))
    await stack.registry.refresh(fixture.workspace)
    return { stack, ctx, spawned, session }
  }

  const escalated = (): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: fixture.workspace })

  it('reaches the escalated scope inside a nested admission rather than the clamped outer one', async () => {
    const { stack, ctx, session } = await mountShared()
    await stack.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
    const escalatedPolicy = escalated()
    // The agent is what makes the process fence wrap the dispatch in the
    // OUTER `tools/execute` admission under the STANDING workspace-write
    // policy — the escalated `fs-write` admission then nests inside it.
    await dispatch(ctx, 'write', async () => {
      // Unapproved: the fs fence still refuses through the real admission.
      await expect(ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'before.txt')), 'x', undefined, undefined, escalatedPolicy))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await approvalService(ctx).request({ agent: { session }, callId: 'call-write', reason: ESCALATION_REASON })
      // The escalated policy nests a fresh `fs-write` admission whose scope is
      // computed with mode `danger-full-access` and the approved marker — not
      // clamped by the outer `tools/execute` admission's standing policy.
      await ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'approved.txt')), 'x', undefined, undefined, escalatedPolicy)
    }, 'call-write', { session } as ToolCaller['agent'])
    expect(existsSync(join(fixture.outside, 'approved.txt'))).toBe(true)
  })

  it('spawns ambient inside the approved call and restricted outside it', async () => {
    const { stack, ctx, spawned, session } = await mountShared()
    await stack.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    const spec = { sandboxPolicy: escalated() }
    await shell.execute(spec)
    expect(spawned[0]!.argv.join(' ')).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
    await dispatch(ctx, 'bash', async () => {
      await approvalService(ctx).request({ agent: { session }, callId: 'call-bash', reason: ESCALATION_REASON })
      await shell.execute(spec)
    }, 'call-bash', { session } as ToolCaller['agent'])
    expect(spawned[1]!.argv).toEqual(COMMAND)
  })
})
