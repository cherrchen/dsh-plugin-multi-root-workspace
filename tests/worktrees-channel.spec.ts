/** The worktree endpoints over the real panel channel dispatch. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
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

async function mount(config: { enabled?: boolean } = {}): Promise<{ handler: Handler; area: FixtureWorkspace; main: string; waitTimeoutMs: number }> {
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
  return { handler, area, main, waitTimeoutMs: 100 }
}

describe('worktree panel channel', () => {
  it('serves the prompt and the strict wait union', async () => {
    const { handler } = await mount()
    const immediate = await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)
    expect(immediate).toMatchObject({ ok: true })
    expect((immediate.value as { prompt?: { path: string } }).prompt?.path).toContain('wt')
    const waited = await handler('worktreePromptWait', { sessionId: SESSION }, new AbortController().signal)
    expect(waited.ok).toBe(true)
    expect((waited.value as WorktreeWaitView).status).toBe('prompt')
  })

  it('keeps confirmation and cleanup behind the write gate in this phase', async () => {
    const { handler } = await mount()
    const prompt = (await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as { prompt: { id: string } }
    expect(await handler('worktreePromptResolve', { sessionId: SESSION, promptId: prompt.prompt.id, action: 'add' }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'worktree/not-enabled' } })
    expect(await handler('worktreeRootsCleanup', { sessionId: SESSION, rootIds: ['r1'] }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'worktree/not-enabled' } })
  })

  it('answers stale when the seen prompt is gone and refuses malformed bodies', async () => {
    const { handler } = await mount()
    const stale = await handler('worktreePromptWait', { sessionId: SESSION, seenPromptId: 'not-a-prompt' }, new AbortController().signal)
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

  it('resets through the channel and reports the refreshed prompt', async () => {
    const { handler } = await mount()
    expect(await handler('worktreePromptReset', { sessionId: SESSION }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { cleared: true } })
    expect(((await handler('worktreePrompt', { sessionId: SESSION }, new AbortController().signal)).value as { prompt?: unknown }).prompt).toBeDefined()
  })
})
