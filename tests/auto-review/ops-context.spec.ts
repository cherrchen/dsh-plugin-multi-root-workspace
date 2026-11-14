import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Tools from '@deepseek-ai/dsh-tools'
import { MultiRootFileSystem } from '../../src/fs.ts'
import * as Instructions from '../../src/instructions.ts'
import ReviewContextService from '../../src/review-context.ts'
import { mountRegistryStack } from '../support/registry-stack.ts'
import { MultiRootOpsCompatibility } from '../../src/ops-compatibility.ts'
import { createFixtureWorkspace } from '../support/temp-workspace.ts'
import { installOpsSetting } from '../support/ops-settings.ts'
import { executeTool, installToolExecutor } from '../support/tool-executor.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

const REV = 'ab'.repeat(32)
const fileReceipt = (path: string) => ({
  bytes: 4, changed: 0, complete: true, failed: 0,
  items: [{ line: 1, path, text: 'text' }], lineCount: 1, matched: 1,
  nextOffset: 2, omitted: 0, path, phase: 'verify', revision: REV,
  skipped: 0, status: 'completed', total: 1, truncated: false,
})
const readFilesReceipt = (items: readonly unknown[]) => ({
  changed: 0, complete: true, failed: 0, items, matched: items.length,
  nextIndex: items.length, pending: 0, phase: 'verify', status: 'completed',
  total: items.length, truncated: false,
})

async function world(enabled = true) {
  const f = createFixtureWorkspace('ops-review')
  const ro = join(f.base, 'readonly'); mkdirSync(ro)
  const stack = await mountRegistryStack(join(f.base, 'store'), {}, { beforeGate: async ctx => {
    await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(SystemPrompt)
    await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: f.workspace })
    await ctx.plugin(MultiRootFileSystem, { cwd: f.workspace })
  } })
  cleanup.push(async () => { await stack.dispose(); f.dispose() })
  const setOpsEnabled = installOpsSetting(stack.ctx, enabled)
  await stack.ctx.plugin(MultiRootOpsCompatibility, { enabled })
  const ctx = stack.ctx
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(Instructions, {})
  await ctx.plugin(ReviewContextService)
  await ctx.plugin(Tools, {})
  // 0.2.2 dispatches through a mounted executor; earlier releases execute natively.
  await installToolExecutor(ctx)
  const session = ctx.sessions.create(SessionId('ops-review-session'), { meta: { cwd: f.workspace } })
  const agent = { id: session.id, session, ctx, options: {}, inject() {} } as unknown as Agent
  const outside = f.outside
  mkdirSync(join(outside, 'sub'), { recursive: true })
  mkdirSync(join(outside, 'other'), { recursive: true })
  writeFileSync(join(outside, 'AGENTS.md'), 'ROOT-RULES')
  writeFileSync(join(outside, 'sub', 'AGENTS.md'), 'NESTED-RULES')
  writeFileSync(join(outside, 'other', 'AGENTS.md'), 'OTHER-RULES')
  writeFileSync(join(outside, 'sub', 'a.txt'), 'A')
  writeFileSync(join(outside, 'other', 'f.txt'), 'F')
  await stack.registry.add(f.workspace, { path: outside, access: 'read-write' })
  const opsTool = (name: string, value: unknown, observe: readonly string[] = []) => {
    ctx.tools.register({
      name, description: `spec tool ${name}`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => name },
      execute: async (_args: unknown, exec: { name: string }) => {
        for (const path of observe) {
          const resolved = await ctx.fs.resolve(path)
          ctx.emit('fs/observed' as never, resolved, {}, exec)
        }
        return typeof value === 'function' ? (value as () => unknown)() : value
      },
    } as never)
  }
  let n = 0
  const run = async (name: string, args: unknown) => {
    const id = ToolCallId(`call-${++n}`)
    session.append('tool/call', { turn: n, step: 1, callId: id, name, arguments: JSON.stringify(args) })
    const result = await executeTool(ctx, { callId: id, name, args, agent, signal: new AbortController().signal })
    session.append('tool/result', { turn: n, step: 1, message: { source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [], isError: result.isError === true }] } }, { surfaceOp: 'append' })
    return result as { isError?: boolean; value?: unknown }
  }
  const build = (name: string, args: unknown, callId?: string, parent?: unknown) =>
    ctx.multiRootReviewContext.build({ agent, callId, name, arguments: args, parent }, new AbortController().signal)
  return { f, ctx, stack, session, agent, outside, opsTool, run, build, setOpsEnabled }
}

const constraintText = (context: { constraints: readonly { path: string; text: string }[] }) =>
  context.constraints.map(item => `${item.path}:${item.text}`).join('|')

describe('OPS pending and durable activity in the review context', () => {
  it('collects every pending read_files target chain', async () => {
    const w = await world()
    const a = join(w.outside, 'sub', 'a.txt')
    const b = join(w.outside, 'other', 'f.txt')
    const context = await w.build('ops_read_files', { files: [{ path: a }, { path: b }] })
    const text = constraintText(context)
    expect(text).toContain('NESTED-RULES')
    expect(text).toContain('OTHER-RULES')
    expect(text).toContain('ROOT-RULES')
  })

  it('collects copy and move source+destination chains', async () => {
    const w = await world()
    const context = await w.build('ops_move', { path: join(w.outside, 'sub', 'a.txt'), to: join(w.outside, 'other', 'g.txt') })
    const text = constraintText(context)
    expect(text).toContain('NESTED-RULES')
    expect(text).toContain('OTHER-RULES')
  })

  it('fails before any review request for dynamic OPS names', async () => {
    const w = await world()
    for (const name of ['ops_replace', 'ops_batch', 'ops_result', 'ops_bash', 'ops_status', 'ops_mystery']) {
      await expect(w.build(name, { path: w.outside })).rejects.toThrow('review-context')
    }
    await expect(w.build('ops_read_files', { files: [] })).rejects.toThrow('review-context')
  })

  it('merges a live-evidenced history pair into the snapshot', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.opsTool('ops_read_files', readFilesReceipt([fileReceipt(sub)]), [sub])
    const result = await w.run('ops_read_files', { files: [{ path: sub }] })
    expect(result.isError).toBeFalsy()
    const context = await w.build('bash', {})
    expect(constraintText(context)).toContain('NESTED-RULES')
  })

  it('refuses OPS history that lacks live evidence or carries an incomplete entry', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.session.append('tool/call', { turn: 1, step: 1, callId: 'ghost', name: 'ops_read_files', arguments: JSON.stringify({ files: [{ path: sub }] }) })
    w.session.append('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'ghost' }, content: [{ type: 'tool-result', toolCallId: 'ghost', content: [], isError: false }] } }, { surfaceOp: 'append' })
    await expect(w.build('bash', {})).rejects.toThrow('review-context')
  })

  it('refuses unsettled OPS calls unless they are the exact pending exec', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.session.append('tool/call', { turn: 1, step: 1, callId: 'cur', name: 'ops_read_files', arguments: JSON.stringify({ files: [{ path: sub }] }) })
    const context = await w.build('ops_read_files', { files: [{ path: sub }] }, 'cur')
    expect(constraintText(context)).toContain('NESTED-RULES')
    await expect(w.build('ops_read_files', { files: [{ path: sub }] }, 'other')).rejects.toThrow('review-context')
    await expect(w.build('bash', {})).rejects.toThrow('review-context')
  })

  it('distinguishes PTC subcall identity from the native call', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.session.append('tool/ptc-dispatch-start', { subCallId: 'sub9', name: 'ops_read_files', arguments: { files: [{ path: sub }] } })
    w.session.append('tool/ptc-dispatch', { subCallId: 'sub9', isError: false })
    w.session.append('tool/call', { turn: 1, step: 1, callId: 'sub9', name: 'ops_read_files', arguments: JSON.stringify({ files: [{ path: sub }] }) })
    w.session.append('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'sub9' }, content: [{ type: 'tool-result', toolCallId: 'sub9', content: [], isError: false }] } }, { surfaceOp: 'append' })
    await expect(w.build('bash', {})).rejects.toThrow('review-context')
  })

  it('refuses a PTC start with no end rather than faking completeness', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.session.append('tool/ptc-dispatch-start', { subCallId: 'sub9', name: 'ops_read_files', arguments: { files: [{ path: sub }] } })
    await expect(w.build('bash', {})).rejects.toThrow('review-context')
  })

  it('refuses OPS history on a resumed session that shares events but has no live evidence', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    w.opsTool('ops_read_files', readFilesReceipt([fileReceipt(sub)]), [sub])
    await w.run('ops_read_files', { files: [{ path: sub }] })
    const resumed = w.ctx.sessions.create(SessionId('ops-review-resumed'), { meta: { cwd: w.f.workspace } })
    for (const event of w.session.snapshotEvents()) {
      const { type, data } = event as { type: string; data: unknown }
      if (type === 'tool/call') resumed.append(type as never, data as never)
      if (type === 'tool/result') resumed.append(type as never, data as never, { surfaceOp: 'append' })
    }
    const agent = { id: resumed.id, session: resumed, ctx: w.ctx, options: {}, inject() {} } as unknown as Agent
    await expect(w.ctx.multiRootReviewContext.build({ agent, name: 'bash', arguments: {} }, new AbortController().signal))
      .rejects.toThrow('review-context')
  })

  it('invalidates the fingerprint on different pending args and on root revocation', async () => {
    const w = await world()
    const a = join(w.outside, 'sub', 'a.txt')
    const b = join(w.outside, 'other', 'f.txt')
    const before = await w.build('ops_read_files', { files: [{ path: a }] })
    await expect(w.ctx.multiRootReviewContext.assertCurrent(
      { agent: w.agent, name: 'ops_read_files', arguments: { files: [{ path: a }, { path: b }] } }, before, new AbortController().signal))
      .rejects.toThrow('changed')
    writeFileSync(join(w.outside, 'sub', 'b.txt'), 'B')
    await expect(w.ctx.multiRootReviewContext.assertCurrent(
      { agent: w.agent, name: 'ops_read_files', arguments: { files: [{ path: join(w.outside, 'sub', 'b.txt') }] } }, before, new AbortController().signal))
      .rejects.toThrow('changed')
    const second = await w.build('ops_read_files', { files: [{ path: a }] })
    writeFileSync(join(w.outside, 'sub', 'AGENTS.md'), 'NESTED-RULES-V2')
    await expect(w.ctx.multiRootReviewContext.assertCurrent(
      { agent: w.agent, name: 'ops_read_files', arguments: { files: [{ path: a }] } }, second, new AbortController().signal))
      .rejects.toThrow('changed')
    const third = await w.build('ops_read_files', { files: [{ path: a }] })
    const record = w.stack.registry.list(w.f.workspace).find(root => root.path === w.outside)!
    await w.stack.registry.remove(w.f.workspace, { kind: 'id', id: record.id })
    await w.stack.registry.refresh(w.f.workspace)
    await expect(w.ctx.multiRootReviewContext.assertCurrent(
      { agent: w.agent, name: 'ops_read_files', arguments: { files: [{ path: a }] } }, third, new AbortController().signal))
      .rejects.toThrow('changed')
  })

  it('keeps pending targets out of delivery state', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    const first = await w.build('ops_read_files', { files: [{ path: sub }] })
    const second = await w.build('bash', {})
    expect(second.constraints.some(item => item.text.includes('NESTED-RULES'))).toBe(false)
    expect(first.constraints.some(item => item.text.includes('NESTED-RULES'))).toBe(true)
  })

  it('invalidates the snapshot fingerprint when the pending arguments change', async () => {
    const w = await world()
    const sub = join(w.outside, 'sub', 'a.txt')
    const other = join(w.outside, 'other', 'f.txt')
    const before = await w.build('ops_read_files', { files: [{ path: sub }] })
    const exec = { agent: w.agent, name: 'ops_read_files', arguments: { files: [{ path: other }] } }
    await expect(w.ctx.multiRootReviewContext.assertCurrent(exec, before, new AbortController().signal)).rejects.toThrow('changed')
  })
})

describe('OPS compatibility mode off', () => {
  it.each([false, true])('rejects a snapshot interrupted by a mode change (roots: %s)', async includeRoots => {
    const w = await world()
    const pending = w.ctx.multiRootInstructions.snapshot(w.agent, includeRoots ? [w.outside] : [], undefined, new AbortController().signal)
    w.setOpsEnabled(false)
    await expect(pending).rejects.toThrow('OPS compatibility changed')
  })

  it('invalidates approval after disabling and after re-enabling the mode', async () => {
    const w = await world()
    const exec = { agent: w.agent, name: 'bash', arguments: {} }
    const snapshot = await w.build(exec.name, exec.arguments)
    w.setOpsEnabled(false)
    await expect(w.ctx.multiRootReviewContext.assertCurrent(exec, snapshot, new AbortController().signal)).rejects.toThrow('changed')
    w.setOpsEnabled(true)
    await expect(w.ctx.multiRootReviewContext.assertCurrent(exec, snapshot, new AbortController().signal)).rejects.toThrow('changed')
  })

  it('ignores the OPS incomplete flag for an ordinary review after disabling the mode', async () => {
    const w = await world()
    const path = join(w.outside, 'sub', 'a.txt')
    w.opsTool('ops_read_files', { status: 'completed' }, [path])
    await w.run('ops_read_files', { files: [{ path }] })
    await expect(w.build('bash', {})).rejects.toThrow('incomplete OPS')
    w.setOpsEnabled(false)
    expect((await w.build('bash', {})).completeness).toBe('complete')
  })

  it('ignores dynamic pending targets and OPS history when explicitly disabled', async () => {
    const w = await world(false)
    w.session.append('tool/call', { turn: 1, step: 1, callId: 'off-ghost', name: 'ops_read_files', arguments: '{}' })
    expect((await w.build('ops_replace', {})).completeness).toBe('complete')
    expect((await w.build('ops_status', {})).completeness).toBe('complete')
  })

  it('does not refuse OPS pending or history while the service is absent', async () => {
    const f = createFixtureWorkspace('ops-review-off')
    const stack = await mountRegistryStack(join(f.base, 'store'), {}, { beforeGate: async ctx => {
      await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(SystemPrompt)
      await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: f.workspace })
      await ctx.plugin(MultiRootFileSystem, { cwd: f.workspace })
    } })
    try {
      const ctx = stack.ctx
      await ctx.plugin(WorkingDirectory)
      await ctx.plugin(Instructions, {})
      await ctx.plugin(ReviewContextService)
      const session = ctx.sessions.create(SessionId('ops-review-off-session'), { meta: { cwd: f.workspace } })
      const agent = { id: session.id, session, ctx, options: {}, inject() {} } as unknown as Agent
      mkdirSync(join(f.outside, 'sub'), { recursive: true })
      writeFileSync(join(f.outside, 'AGENTS.md'), 'ROOT-RULES')
      writeFileSync(join(f.outside, 'sub', 'AGENTS.md'), 'NESTED-RULES')
      await stack.registry.add(f.workspace, { path: f.outside, access: 'read-write' })
      session.append('tool/call', { turn: 1, step: 1, callId: 'ghost', name: 'ops_read_files', arguments: '{}' })
      const context = await ctx.multiRootReviewContext.build({ agent, name: 'ops_replace', arguments: { path: f.outside } }, new AbortController().signal)
      expect(context.constraints.map(item => item.text).join('|')).not.toContain('NESTED-RULES')
      session.append('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'ghost' }, content: [{ type: 'tool-result', toolCallId: 'ghost', content: [], isError: false }] } }, { surfaceOp: 'append' })
      const second = await ctx.multiRootReviewContext.build({ agent, name: 'ops_replace', arguments: { path: f.outside } }, new AbortController().signal)
      expect(second).toBeDefined()
    } finally { await stack.dispose(); f.dispose() }
  })
})
