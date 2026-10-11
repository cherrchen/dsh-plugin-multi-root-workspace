/**
 * Per-tool write caps: a `toolAccess` row entry makes one tool unable to write
 * ANY additional root while the primary root and every other tool keep their
 * grants. The cap rides the real `tools/execute` waterfall through an
 * AsyncLocalStorage, so it survives awaits, narrows under nesting, and never
 * leaks into a sibling dispatch. Outside a dispatch — where no tool identity
 * exists — a non-empty `toolAccess` is fail-closed; a malformed one caps every
 * call and is logged.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import type { ToolCaller } from '../src/compat/tool-context.ts'
import { mountCompat } from './support/compat.ts'
import { confined } from './support/confine.ts'
import { allowsWrite, parseConfined, runConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('tool-access')
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  fixture.dispose()
})

interface World {
  ctx: Context
  provider: LocalSandboxProvider
  policy: SandboxPolicy
}

/** Mount the fs fence, the kernel provider, and a scope carrying one writable root. */
async function mountWorld(toolAccess?: Record<string, 'read-only'>): Promise<World> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
    await ctx.plugin(MultiRootScopeService, toolAccess === undefined ? {} : { toolAccess }),
  )
  await mountCompat(ctx)
  fibers.push(
    await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }),
    await ctx.plugin(MultiRootSandboxProvider, {}),
  )
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
    { id: 'a', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' },
  ])
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { chain: ['seatbelt'] } satisfies SandboxInternals
  return { ctx, provider, policy: { mode: 'workspace-write', workspaceRoot: fixture.workspace } }
}

/** Drive the REAL `tools/execute` waterfall the way dsh-tools dispatches a tool. */
function dispatch(ctx: Context, name: string, body: () => Promise<unknown>): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as (
    event: string,
    exec: ToolCaller,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  return waterfall('tools/execute', { name, callId: `call-${name}` }, body)
}

const COMMAND = ['bash', '-c', 'true']

function writableInside(world: World): readonly string[] {
  return world.ctx.multiRootScope.resolve(world.policy).writableRoots
}

describe('per-tool write caps', () => {
  it('refuses additional-root writes inside a capped dispatch — fence and kernel agree', async (context) => {
    const world = await mountWorld({ bash: 'read-only' })
    const marker = join(fixture.outside, 'capped.txt')
    const primaryMarker = join(fixture.workspace, 'uncapped.txt')

    // An uncapped tool keeps the additional root on every enforcement surface.
    await dispatch(world.ctx, 'write', async () => {
      expect(writableInside(world)).toEqual([canonicalPath(fixture.outside)])
      const wrapped = await confined(world.provider, COMMAND, world.policy)
      expect(allowsWrite(parseConfined(wrapped.argv, COMMAND), canonicalPath(fixture.outside))).toBe(true)
      await world.ctx.fs.writeText(await world.ctx.fs.resolve(marker), 'uncapped')
      expect(existsSync(marker)).toBe(true)
    })

    // The capped tool: the same provider calls now see no writable root at all.
    await dispatch(world.ctx, 'bash', async () => {
      expect(writableInside(world)).toEqual([])
      expect(world.ctx.multiRootScope.resolve(world.policy).additionalRoots).toEqual([canonicalPath(fixture.outside)])
      const wrapped = await confined(world.provider, COMMAND, world.policy)
      expect(allowsWrite(parseConfined(wrapped.argv, COMMAND), canonicalPath(fixture.outside))).toBe(false)
      await expect(world.ctx.fs.writeText(await world.ctx.fs.resolve(join(fixture.outside, 'denied.txt')), 'x'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

      // Real confined execution: a capped bash write to A dies in the kernel
      // while the primary root still writes.
      const denied = runConfined(
        await confined(world.provider, ['bash', '-c', `echo x > ${JSON.stringify(join(fixture.outside, 'kernel.txt'))}`], world.policy),
        fixture.workspace,
      )
      if (denied.kind === 'unavailable' || denied.kind === 'runner-failed') {
        context.skip(requireKernelRunner('seatbelt', denied.detail))
        return
      }
      expect(denied.kind, `capped kernel write: ${denied.kind === 'denied' ? denied.detail : ''}`).toBe('denied')
      expect(existsSync(join(fixture.outside, 'kernel.txt'))).toBe(false)
      const allowed = runConfined(
        await confined(world.provider, ['bash', '-c', `echo x > ${JSON.stringify(primaryMarker)}`], world.policy),
        fixture.workspace,
      )
      expect(allowed.kind, 'the primary root stays writable for a capped tool').toBe('ok')
      expect(existsSync(primaryMarker)).toBe(true)
    })
  })

  it('only ever narrows under nesting and restores on return', async () => {
    const world = await mountWorld({ bash: 'read-only' })

    await dispatch(world.ctx, 'bash', async () => {
      // Capped outer, uncapped inner: the inner call is still capped.
      await dispatch(world.ctx, 'write', () => {
        expect(writableInside(world)).toEqual([])
        return Promise.resolve()
      })
      expect(writableInside(world)).toEqual([])
    })

    await dispatch(world.ctx, 'write', async () => {
      expect(writableInside(world)).toEqual([canonicalPath(fixture.outside)])
      await dispatch(world.ctx, 'bash', () => {
        expect(writableInside(world)).toEqual([])
        return Promise.resolve()
      })
      // Back in the uncapped frame the grant is whole again.
      expect(writableInside(world)).toEqual([canonicalPath(fixture.outside)])
    })
  })

  it('keeps sibling dispatches on their own cap when their awaits interleave', async () => {
    const world = await mountWorld({ bash: 'read-only' })
    const seen: string[] = []

    const capped = dispatch(world.ctx, 'bash', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      seen.push(`bash:${String(writableInside(world).length)}`)
    })
    const uncapped = dispatch(world.ctx, 'write', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      seen.push(`write:${String(writableInside(world).length)}`)
    })
    await Promise.all([capped, uncapped])
    expect(seen.sort()).toEqual(['bash:0', 'write:1'])
  })

  it('is fail-closed outside any dispatch: a non-empty config caps, an empty one does not', async () => {
    const capped = await mountWorld({ bash: 'read-only' })
    expect(writableInside(capped)).toEqual([])
    // toolCaps feeds the prompt contribution — sorted, read-only.
    expect(capped.ctx.multiRootScope.toolCaps()).toEqual(['bash'])

    const empty = await mountWorld({})
    expect(writableInside(empty)).toEqual([canonicalPath(fixture.outside)])
    expect(empty.ctx.multiRootScope.toolCaps()).toEqual([])

    const absent = await mountWorld()
    expect(writableInside(absent)).toEqual([canonicalPath(fixture.outside)])
  })

  it('fails closed and logs when the row config cannot be parsed', async () => {
    const errors: string[] = []
    const ctx = new Context()
    vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService, { toolAccess: { bash: 'read-write' } as never }),
    )
    await mountCompat(ctx)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { id: 'a', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' },
    ])

    // Even inside an UNCAPPED tool's dispatch the bad config grants nothing.
    await dispatch(ctx, 'write', () => {
      expect(ctx.multiRootScope.resolve({ mode: 'workspace-write', workspaceRoot: fixture.workspace }).writableRoots).toEqual([])
      return Promise.resolve()
    })
    expect(errors.some(line => line.includes('toolAccess'))).toBe(true)
  })
})
