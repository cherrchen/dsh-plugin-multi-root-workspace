/** G0: public out-of-tree tool seams, without creating any remote backend. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { aroundTool } from '../src/compat/tool-context.ts'
import type { ToolCaller } from '../src/compat/tool-context.ts'
import { mountCompat } from './support/compat.ts'
import { executeTool, installToolExecutor } from './support/tool-executor.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'

const NAME = 'g0_local_probe'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function world(capped = false) {
  const fixture = createFixtureWorkspace('multi-environment-baseline')
  const ctx = new Context()
  cleanup.push(async () => { try { await ctx.fiber.dispose() } finally { fixture.dispose() } })
  await ctx.plugin(Projections)
  await ctx.plugin(Sessions)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
  await ctx.plugin(MultiRootScopeService, capped ? { toolAccess: { [NAME]: 'read-only' } } : {})
  await mountCompat(ctx)
  await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await installToolExecutor(ctx)
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{
    id: 'local-extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'inherit',
  }])
  const session = ctx.sessions.create(SessionId('g0-owner'), { meta: { cwd: fixture.workspace } })
  // Real event-sourced Session; the carrier is deliberately not a model turn.
  // The existing web/headless journey covers the actual Agent loop.
  const agent = { id: session.id, session } as Agent
  const run = (args: unknown = {}, signal = new AbortController().signal, owner = agent) => executeTool(ctx, {
    callId: 'g0-call', name: NAME, args, signal, agent: owner,
  }) as Promise<{ isError?: boolean; error?: { message?: string; info?: { code?: string } } }>
  return { ctx, fixture, session, agent, run }
}

async function register(ctx: Context, body: (exec: ToolCaller) => Promise<void>, enabled = true) {
  return await ctx.plugin({
    name: 'g0-experimental-tool', inject: ['tools'],
    apply(fiber: Context) {
      if (!enabled) return
      fiber.tools.register({
        name: NAME, description: 'Local G0 seam probe (test composition only).',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', properties: { status: { type: 'string' } } }, render: () => [{ type: 'text', text: 'ok' }] },
        execute: async (_args: unknown, exec: ToolCaller) => { await body(exec); return { status: 'ok' } },
      } as never)
    },
  })
}

it('registers only in the enabled composition and withdraws dispatch on disposal', async () => {
  const { ctx, run } = await world()
  let calls = 0
  const disabled = await register(ctx, async () => { calls++ }, false)
  expect((await run()).isError).toBe(true)
  expect(calls).toBe(0)
  await disabled.dispose()
  const enabled = await register(ctx, async () => { calls++ })
  expect((await run()).isError).toBe(false)
  expect(calls).toBe(1)
  await enabled.dispose()
  expect((await run()).isError).toBe(true)
  expect(calls).toBe(1)
})

it('takes Session and tool identity from dispatch, ignoring forged model fields', async () => {
  const { ctx, fixture, session, run } = await world(true)
  const path = join(fixture.outside, 'sentinel.txt')
  writeFileSync(path, 'before')
  const observed: ToolCaller[] = []
  aroundTool(ctx, async (exec, next) => { observed.push(exec); return await next() })
  await register(ctx, async exec => {
    expect(exec.name).toBe(NAME)
    expect(exec.agent?.session).toBe(session)
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent!.session })
    expect(policy.workspaceRoot).toBe(fixture.workspace)
    expect(ctx.multiRootScope.resolve(policy).writableRoots).toEqual([])
    await ctx.fs.writeText(await ctx.fs.resolve(path), 'bad', undefined, undefined, policy)
  })
  const result = await run({ name: 'write', mode: 'danger-full-access', sessionId: 'forged' })
  expect(result.isError).toBe(true)
  expect(result.error?.info?.code).toBe('FS_SANDBOX_DENIED')
  expect(observed).toHaveLength(1)
  expect(readFileSync(path, 'utf8')).toBe('before')
})

it('honors pre-execute refusal before the around-dispatch hook or body', async () => {
  const { ctx, run } = await world()
  let calls = 0
  let dispatched = 0
  await register(ctx, async () => { calls++ })
  aroundTool(ctx, async (_exec, next) => { dispatched++; return await next() })
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === NAME
    ? { kind: 'deny' as const, reason: 'G0 permission refusal' } : await next(), { global: true })
  const result = await run()
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain('G0 permission refusal')
  expect(calls).toBe(0)
  expect(dispatched).toBe(0)
})

it('resolves per-Session mode at each call without changing the shared default', async () => {
  const { ctx, fixture, session, run } = await world()
  const other = ctx.sessions.create(SessionId('g0-other'), { meta: { cwd: fixture.workspace } })
  const path = join(fixture.outside, 'sentinel.txt')
  writeFileSync(path, 'before')
  await register(ctx, async exec => {
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent!.session })
    await ctx.fs.writeText(await ctx.fs.resolve(path), 'after', undefined, undefined, policy)
  })
  session.append('sandbox/mode', { mode: 'read-only' })
  expect((await run()).isError).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('before')
  expect((await run({}, undefined, { id: other.id, session: other } as Agent)).isError).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('after')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  expect(ctx.sandboxPolicy.resolve({ session: other }).mode).toBe('workspace-write')
  session.append('sandbox/mode', { mode: 'workspace-write' })
  expect((await run()).isError).toBe(false)
})

it('forwards caller cancellation to cooperative tool work', async () => {
  const { ctx, run } = await world()
  const started = Promise.withResolvers<void>()
  let stopped = false
  await register(ctx, async exec => {
    expect(exec.signal).toBeDefined()
    started.resolve()
    await new Promise<void>(resolve => {
      const stop = () => { stopped = true; resolve() }
      if (exec.signal!.aborted) stop()
      else exec.signal!.addEventListener('abort', stop, { once: true })
    })
  })
  const controller = new AbortController()
  const pending = run({}, controller.signal)
  await started.promise
  controller.abort(new Error('G0 turn cancelled'))
  await pending
  expect(stopped).toBe(true)
})
