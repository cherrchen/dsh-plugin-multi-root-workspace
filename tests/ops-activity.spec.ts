import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { type UserMessage } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import * as LlmMessage from '../src/compat/llm-message.ts'
import * as Instructions from '../src/instructions.ts'
import { replayedInstructionTargets } from '../src/compat/instruction-activity.ts'
import { mountCompat } from './support/compat.ts'
import { MultiRootOpsCompatibility } from '../src/ops-compatibility.ts'
import { mountProviderGate } from './support/providers.ts'
import { installToolExecutor, executeTool } from './support/tool-executor.ts'
import { opsCompatibilityRelease } from '../src/compat/ops-settings.ts'
import { readInstalledVersion } from '../src/compat/dsh-version.ts'
import { installOpsSetting } from './support/ops-settings.ts'

let base: string
let workspace: string
let root: string
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
let counter = 0

const REV = 'ab'.repeat(32)
const fileReceipt = (path: string) => ({
  bytes: 4, changed: 0, complete: true, failed: 0,
  items: [{ line: 1, path, text: 'text' }], lineCount: 1, matched: 1,
  nextOffset: 2, omitted: 0, path, phase: 'verify', revision: REV,
  skipped: 0, status: 'completed', total: 1, truncated: false,
})
const readFilesReceipt = (items: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  changed: 0, complete: true, failed: 0, items, matched: items.length,
  nextIndex: items.length, pending: 0, phase: 'verify', status: 'completed',
  total: items.length, truncated: false, ...extra,
})

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ops-activity-'))
  workspace = join(base, 'workspace')
  root = join(base, 'root')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(join(root, 'other'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'ROOT-RULES')
  writeFileSync(join(root, 'sub', 'AGENTS.md'), 'NESTED-SENTINEL')
  writeFileSync(join(root, 'other', 'AGENTS.md'), 'OTHER-SENTINEL')
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(root, 'sub', 'a.txt'), 'SUB')
  writeFileSync(join(root, 'other', 'f.txt'), 'F')
})

afterEach(async () => {
  vi.restoreAllMocks()
  while (fibers.length > 0) await fibers.pop()?.dispose()
  rmSync(base, { recursive: true, force: true })
})

interface World {
  readonly ctx: Context
  readonly session: InstanceType<typeof Session>
  readonly agent: Agent
  readonly setOpsEnabled: (value: boolean) => void
  readonly step: () => Promise<string>
  readonly call: (name: string, args: unknown, options?: { signal?: AbortSignal; session?: Session.Session }) => Promise<{ isError?: boolean; value?: unknown }>
}

async function mountWorld(options: { mode?: string; enabled?: boolean } = {}): Promise<World> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode: (options.mode ?? 'workspace-write') as never, workspaceRoot: workspace }),
    await ctx.plugin(MultiRootScopeService),
  )
  await mountCompat(ctx)
  const setOpsEnabled = installOpsSetting(ctx, options.enabled !== false)
  fibers.push(await ctx.plugin(MultiRootOpsCompatibility, { enabled: options.enabled !== false }))
  fibers.push(await ctx.plugin(MultiRootFileSystem, { cwd: workspace }))
  await mountProviderGate(ctx)
  fibers.push(await ctx.plugin(SystemPrompt, {}))
  fibers.push(await ctx.plugin(Tools, {}))
  fibers.push(await ctx.plugin(Instructions, {}))
  await installToolExecutor(ctx)
  ctx.multiRootScope.setAdditionalRoots(workspace, [{ id: 'r1', path: root, recordedPath: canonicalPath(root), access: options.mode === 'danger-full-access' ? 'read-only' : 'read-write' }])
  const sessionId = SessionId(`sess-ops-activity-${counter += 1}`)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: workspace,
  })
  const agent = { session } as unknown as Agent
  return {
    ctx, session, agent, setOpsEnabled,
    step: async () => {
      const decision = await ctx.waterfall('agent/pre-step' as never,
        { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal } as never,
        async () => ({ kind: 'enter', messages: [createUserMessage({ content: [{ type: 'text', text: 'u' }], source: { kind: 'user' } })] }) as never)
      const messages = (decision as { messages?: UserMessage[] }).messages ?? []
      const kind = LlmMessage.instructionSourceKind(SESSION_FORMAT_VERSION)
      const injected = messages.find(message => message.source.kind === kind)
      return (injected?.content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
    },
    call: async (name, args, options = {}) => {
      const targetAgent = options.session === undefined ? agent : { session: options.session } as unknown as Agent
      return await executeTool(ctx, {
        callId: `call-${counter += 1}`, name, args, agent: targetAgent,
        signal: options.signal ?? new AbortController().signal,
      }) as { isError?: boolean; value?: unknown }
    },
  }
}

function opsTool(ctx: Context, name: string, value: unknown, hooks: { observe?: readonly string[]; run?: (exec: unknown) => unknown } = {}): void {
  ctx.tools.register({
    name, description: `spec tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: () => name },
    execute: async (_args: unknown, exec: { name: string }) => {
      for (const path of hooks.observe ?? []) {
        const resolved = await ctx.fs.resolve(path)
        ctx.emit('fs/observed' as never, resolved, {}, exec)
      }
      await hooks.run?.(exec)
      if (value instanceof Error) throw value
      return typeof value === 'function' ? (value as () => unknown)() : value
    },
  } as never)
}

describe.skipIf(!opsCompatibilityRelease(readInstalledVersion('@deepseek-ai/dsh')))('live OPS file activity index', () => {
  it('delivers only the proven nested chain on the next pre-step', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]), { observe: [sub] })
    await world.call('ops_read_files', { files: [{ path: sub }] })
    const seeded = await world.step()
    expect(seeded).toContain('NESTED-SENTINEL')
    expect(seeded).toContain('ROOT-RULES')
    expect(seeded).not.toContain('OTHER-SENTINEL')
  })

  it('keeps a failed sibling unproven while the successful one records', async () => {
    const world = await mountWorld()
    const good = join(root, 'sub', 'a.txt')
    const bad = join(root, 'other', 'f.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt(
      [fileReceipt(good), { ...fileReceipt(bad), status: 'error', error: { code: 'X' } }],
      { complete: false, failed: 1 },
    ), { observe: [good, bad] })
    await world.call('ops_read_files', { files: [{ path: good }, { path: bad }] })
    const seeded = await world.step()
    expect(seeded).toContain('NESTED-SENTINEL')
    expect(seeded).not.toContain('OTHER-SENTINEL')
  })

  it('records the second distinct path after a duplicate', async () => {
    const world = await mountWorld()
    const first = join(root, 'a.txt')
    const second = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt(
      [fileReceipt(first), fileReceipt(first), fileReceipt(second)], { total: 3, matched: 3 },
    ), { observe: [first, second] })
    await world.call('ops_read_files', { files: [{ path: first }, { path: first }, { path: second }] })
    const seeded = await world.step()
    expect(seeded).toContain('ROOT-RULES')
    expect(seeded).toContain('NESTED-SENTINEL')
  })

  it('accepts a real PTC wrapper outcome', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', { status: 'completed', data: readFilesReceipt([fileReceipt(sub)]) }, { observe: [sub] })
    await world.call('ops_read_files', { files: [{ path: sub }] })
    const seeded = await world.step()
    expect(seeded).toContain('NESTED-SENTINEL')
  })

  it('does not record when post-execute replaces the value', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]), { observe: [sub] })
    const on = world.ctx.on as unknown as (name: string, callback: (exec: unknown, result: unknown, next: () => Promise<unknown>) => unknown, options?: { global?: boolean }) => unknown
    on.call(world.ctx, 'tools/post-execute', async (_exec, _result, next) => {
      const decision = await next() as { kind: string }
      return { ...decision, value: { status: 'completed', data: { injected: true } } }
    }, { global: true })
    const result = await world.call('ops_read_files', { files: [{ path: sub }] })
    expect((result.value as { status?: string })?.status).toBe('completed')
    expect((result.value as { data?: { injected?: boolean } })?.data?.injected).toBe(true)
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })

  it('does not record when the body throws or the call is cancelled', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', new Error('boom'), { observe: [sub] })
    await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
    const controller = new AbortController()
    opsTool(world.ctx, 'ops_read_files2', () => { controller.abort(); return readFilesReceipt([fileReceipt(sub)]) }, { observe: [sub] })
    await world.call('ops_read_files2', { files: [{ path: sub }] }, { signal: controller.signal })
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })

  it('does not record without a matching fs/observed actor event', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]))
    await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })

  it('keeps sessions isolated', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    const otherId = SessionId(`sess-ops-activity-${counter += 1}`)
    const other = Session.create(otherId, undefined, {
      version: SESSION_FORMAT_VERSION, id: otherId, createdAt: 0, isSeeded: false, cwd: workspace,
    })
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]), { observe: [sub] })
    await world.call('ops_read_files', { files: [{ path: sub }] }, { session: other })
    const seeded = await world.step()
    expect(seeded).not.toContain('NESTED-SENTINEL')
  })

  it('does not record a rejected PTC wrapper outcome', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', { status: 'rejected', data: readFilesReceipt([fileReceipt(sub)]) }, { observe: [sub] })
    await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })

  it('keeps business results intact while the index evicts past 128 pending calls', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    opsTool(world.ctx, 'ops_read_files', () => readFilesReceipt([fileReceipt(sub)]), {
      observe: [sub], run: async () => { await gate },
    })
    const controllers = Array.from({ length: 140 }, () => new AbortController())
    const calls = controllers.map((controller) => world.call('ops_read_files', { files: [{ path: sub }] }, { signal: controller.signal }))
    for (const controller of controllers.slice(0, 140)) controller.abort()
    release?.()
    const results = await Promise.all(calls)
    expect(results.length).toBe(140)
    const seeded = await world.step()
    expect(seeded).not.toContain('NESTED-SENTINEL')
  })

  it('does not alter the business result when the fingerprint budget is exceeded', async () => {
    const world = await mountWorld()
    const big = 'x'.repeat(3 * 1024 * 1024)
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)], { blob: big }), { observe: [sub] })
    const result = await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(result.isError).toBeFalsy()
    expect((result.value as { status?: string })?.status).toBe('completed')
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })
})

describe.skipIf(!opsCompatibilityRelease(readInstalledVersion('@deepseek-ai/dsh')))('OPS compatibility mode off', () => {
  it.each([false, true])('does not commit an old result across a mode change (re-enable: %s)', async reOn => {
    const world = await mountWorld()
    const path = join(root, 'sub', 'a.txt')
    const receipt = readFilesReceipt([fileReceipt(path)])
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    opsTool(world.ctx, 'ops_read_files', receipt, {
      observe: [path], run: () => { started(); return gate },
    })
    await world.step()
    const pending = world.call('ops_read_files', { files: [{ path }] })
    try {
      await entered
      world.setOpsEnabled(false)
      if (reOn) world.setOpsEnabled(true)
      release()
      expect((await pending).value).toEqual(receipt)
      expect(await world.step()).not.toContain('NESTED-SENTINEL')
      if (!reOn) world.setOpsEnabled(true)
      expect(await world.step()).not.toContain('NESTED-SENTINEL')
    } finally { release(); await pending }
  })

  it('lets an OPS call run through the generic dispatch without new refusals', async () => {
    const world = await mountWorld({ mode: 'danger-full-access', enabled: false })
    let bodies = 0
    opsTool(world.ctx, 'ops_write_file', { status: 'completed' }, { run: () => { bodies += 1 } })
    const result = await world.call('ops_write_file', { path: join(root, 'sub', 'a.txt') })
    expect(bodies).toBe(1)
    expect(result.isError).not.toBe(true)
  })

  it('refuses the same call once the mode is enabled', async () => {
    const world = await mountWorld({ mode: 'danger-full-access', enabled: true })
    let bodies = 0
    opsTool(world.ctx, 'ops_write_file', { status: 'completed' }, { run: () => { bodies += 1 } })
    const result = await world.call('ops_write_file', { path: join(root, 'sub', 'a.txt') })
    expect(result.isError).toBe(true)
  })

  it('does not inject nested instructions for OPS activity while off', async () => {
    const world = await mountWorld({ enabled: false })
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]), { observe: [sub] })
    await world.step()
    await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(await world.step()).not.toContain('NESTED-SENTINEL')
  })

  it('injects the nested chain when the mode is enabled', async () => {
    const world = await mountWorld()
    const sub = join(root, 'sub', 'a.txt')
    opsTool(world.ctx, 'ops_read_files', readFilesReceipt([fileReceipt(sub)]), { observe: [sub] })
    await world.step()
    await world.call('ops_read_files', { files: [{ path: sub }] })
    expect(await world.step()).toContain('NESTED-SENTINEL')
  })

  it('does not refuse replay for OPS history lacking live evidence while off', () => {
    const events = [
      { type: 'tool/call', data: { callId: 'ghost', name: 'ops_read_files', arguments: '{}' } },
      { type: 'tool/result', data: { message: { source: { callId: 'ghost' }, isError: false } } },
      { type: 'tool/call', data: { callId: 'unsettled', name: 'ops_write_file', arguments: '{}' } },
    ]
    expect(replayedInstructionTargets(events, undefined)).toEqual([])
    expect(replayedInstructionTargets(events, undefined, undefined, undefined, { opsCompatibility: false })).toEqual([])
  })
})
