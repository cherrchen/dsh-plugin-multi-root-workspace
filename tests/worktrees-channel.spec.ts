/** The worktree endpoints over the real panel channel dispatch. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountRegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import MultiRootWorktrees from '../src/worktrees.ts'
import * as CommandModule from '../src/command.ts'
import type { WorktreeWaitView } from '../src/worktrees-contract.ts'

const SESSION = 'session-1'

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr)
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'fixture@example.invalid'])
  git(path, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(path, 'README.md'), 'x\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

type Handler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>
const stacks: Awaited<ReturnType<typeof mountRegistryStack>>[] = []
const fixtures: FixtureWorkspace[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

async function mount(config: { enabled?: boolean } = {}): Promise<{ handler: Handler; area: FixtureWorkspace; main: string; stack: Awaited<ReturnType<typeof mountRegistryStack>> }> {
  const area = createFixtureWorkspace('worktrees-channel')
  fixtures.push(area)
  const main = join(area.base, 'main')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
  const stack = await mountRegistryStack(join(area.base, 'store'))
  stacks.push(stack)
  const ctx = stack.ctx
  let handler: Handler | undefined
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: main }) } as never)
  ctx.provide('sessions', { get: (id: string) => id === SESSION ? { header: { cwd: main } } : undefined } as never)
  ctx.provide('webServer', {} as never)
  ctx.provide('connection', {
    rpc: {
      handle: (channel: string, value: Handler) => { expect(channel).toBe('/multi-root-workspace'); handler = value; return async () => {} },
    },
  } as never)
  await ctx.plugin(MultiRootWorktrees, { enabled: config.enabled ?? true, waitTimeoutMs: 100 })
  await ctx.plugin(CommandModule, {})
  if (handler === undefined) throw new Error('the panel channel was not mounted')
  return { handler, area, main, stack }
}

describe('worktree panel channel', () => {
  it('serves the visible list and the strict wait union', async () => {
    const { handler } = await mount()
    const immediate = await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)
    expect(immediate).toMatchObject({ ok: true })
    const prompts = (immediate.value as { prompts: { path: string }[] }).prompts
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.path).toContain('wt')
    const waited = await handler('worktreePromptWait', { sessionId: SESSION }, new AbortController().signal)
    expect(waited.ok).toBe(true)
    expect((waited.value as WorktreeWaitView).status).toBe('prompt')
  })

  it('confirms through the channel and refuses cleanup eligibility it cannot prove', async () => {
    const { handler } = await mount()
    const prompts = (await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as { prompts: { id: string }[] }
    const resolved = await handler('worktreePromptResolve', { sessionId: SESSION, promptIds: [prompts.prompts[0]!.id], action: 'add' }, new AbortController().signal)
    expect(resolved.ok).toBe(true)
    const cleaned = await handler('worktreeRootsCleanup', { sessionId: SESSION, rootIds: ['r1'] }, new AbortController().signal)
    expect(cleaned).toMatchObject({ ok: true, value: { removed: [], skipped: [{ id: 'r1', code: 'worktree/not-eligible' }] } })
  })

  it('closes with stale after the last candidate is handled and refuses malformed bodies', async () => {
    const { handler } = await mount()
    const prompts = (await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as {
      prompts: { id: string }[]
      viewRevision: string
    }
    const first = prompts.prompts[0]!
    expect((await handler('worktreePromptResolve', { sessionId: SESSION, promptIds: [first.id], action: 'dismiss' }, new AbortController().signal)).ok).toBe(true)
    const stale = await handler('worktreePromptWait', { sessionId: SESSION, seenViewRevision: prompts.viewRevision }, new AbortController().signal)
    expect(stale).toMatchObject({ ok: true, value: { status: 'stale' } })
    expect(await handler('worktreePromptWait', { sessionId: SESSION, retryAfterMs: 1 }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
    expect(await handler('worktreePromptWait', {}, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
    expect(await handler('worktreePromptResolve', { sessionId: SESSION }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
  })

  it('refuses every endpoint while the live switch is off', async () => {
    const { handler } = await mount({ enabled: false })
    for (const [endpoint, payload] of [
      ['worktreePrompt', { sessionId: SESSION }],
      ['worktreePromptWait', { sessionId: SESSION }],
      ['worktreePromptReset', { sessionId: SESSION }],
    ] as const) {
      expect(await handler(endpoint, payload, new AbortController().signal), endpoint)
        .toMatchObject({ ok: false, error: { code: 'worktree/not-enabled' } })
    }
  })

  it('cleans up a confirmed deleted worktree through the channel', async () => {
    const { handler, stack, main, area } = await mount()
    const prompts = (await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as { prompts: { id: string }[] }
    expect((await handler('worktreePromptResolve', { sessionId: SESSION, promptIds: [prompts.prompts[0]!.id], action: 'add' }, new AbortController().signal)).ok).toBe(true)
    const [row] = stack.registry.list(main)
    expect(row).toBeDefined()
    rmSync(join(area.base, 'wt'), { recursive: true, force: true })
    await stack.registry.refresh(main)
    const cleaned = await handler('worktreeRootsCleanup', { sessionId: SESSION, rootIds: [row!.id] }, new AbortController().signal)
    expect(cleaned).toMatchObject({
      ok: true,
      value: { removed: [row!.id], skipped: [], roots: { roots: [] } },
    })
  })

  it('resets through the channel and reports the refreshed prompt', async () => {
    const { handler } = await mount()
    expect(await handler('worktreePromptReset', { sessionId: SESSION }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { cleared: true } })
    expect(((await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as { prompts: unknown[] }).prompts).toHaveLength(1)
  })
})
