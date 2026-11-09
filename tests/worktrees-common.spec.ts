/** Phase P8/P9: the A candidate (shared common git dir), its modes, confirmation and staleness. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountWorktreeStack, readSidecarFile, type WorktreeStack } from './support/worktrees-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import type { WorktreePromptWaitResult } from '../src/worktrees/types.ts'

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr)
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

const fixtures: FixtureWorkspace[] = []
const stacks: WorktreeStack[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.stack.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

function fixture(label: string): FixtureWorkspace {
  const area = createFixtureWorkspace(label)
  fixtures.push(area)
  return area
}

function promptOf(result: WorktreePromptWaitResult) {
  expect(result.status).toBe('prompt')
  if (result.status !== 'prompt') throw new Error('expected a prompt')
  return result.prompt
}

async function mount(area: FixtureWorkspace, primary: string, mode: () => 'read-only' | 'workspace-write' | 'danger-full-access' = () => 'workspace-write', settings = false): Promise<WorktreeStack> {
  const stack = await mountWorktreeStack(join(area.base, 'store'), {
    cwd: primary,
    mode,
    settings,
    config: { waitTimeoutMs: 80 },
  })
  stacks.push(stack)
  return stack
}

describe('A candidate', () => {
  it('offers the canonical common git dir of an external linked checkout', async () => {
    const area = fixture('common-external')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(prompt.kind).toBe('git-common')
    expect(prompt.path).toBe(realpathSync.native(join(main, '.git')))
    expect(prompt.effectiveAccess).toBe('read-write')
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.prompt).toBeUndefined()
    const rows = stack.stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: realpathSync.native(join(main, '.git')), access: 'inherit' })
    // A roots never receive a B cleanup mapping.
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(linked))?.worktreeRoots ?? []).toEqual([])
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('offers the same candidate when the primary is a default-pool worktree', async () => {
    const area = fixture('common-pool')
    const main = join(area.base, 'main')
    initRepo(main)
    const pool = join(main, '.agents', 'worktrees', 'a')
    git(main, ['worktree', 'add', '-q', pool, '-b', 'a'])
    const stack = await mount(area, pool)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(prompt.kind).toBe('git-common')
    expect(prompt.path).toBe(realpathSync.native(join(main, '.git')))
  })

  it('is not offered in read-only or Full-access sessions', async () => {
    const area = fixture('common-modes')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    let mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only'
    const stack = await mount(area, linked, () => mode)
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
    mode = 'workspace-write'
    expect(promptOf(await stack.worktrees.wait(stack.sessionId)).kind).toBe('git-common')
    mode = 'danger-full-access'
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('invalidates an open A prompt when the session mode changes before confirmation', async () => {
    const area = fixture('common-mode-change')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    let mode: 'read-only' | 'workspace-write' = 'workspace-write'
    const stack = await mount(area, linked, () => mode)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    mode = 'read-only'
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(stack.stack.registry.list(linked)).toHaveLength(0)
  })

  it('invalidates an open A prompt when the switch is turned off', async () => {
    const area = fixture('common-settings')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked, () => 'workspace-write', true)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    stack.hooks()!.setSource(() => ({ enabled: false }))
    stack.hooks()!.onChange()
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')).rejects
      .toMatchObject({ code: 'worktree/not-enabled' })
    expect(stack.stack.registry.list(linked)).toHaveLength(0)
  })

  it('is not offered when the common is already registered', async () => {
    const area = fixture('common-registered')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    await stack.stack.registry.add(linked, { path: join(main, '.git') })
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('keeps B visible when the session cannot see A, and queues A after B', async () => {
    const area = fixture('common-mixed')
    const main = join(area.base, 'main')
    initRepo(main)
    const pool = join(main, '.agents', 'worktrees')
    const a = join(pool, 'a')
    const b = join(pool, 'b')
    git(main, ['worktree', 'add', '-q', a, '-b', 'a'])
    git(main, ['worktree', 'add', '-q', b, '-b', 'b'])

    let mode: 'read-only' | 'workspace-write' = 'read-only'
    const readOnly = await mount(area, a, () => mode)
    const first = promptOf(await readOnly.worktrees.wait(readOnly.sessionId))
    expect(first.kind).toBe('worktree')
    expect(first.path).toBe(realpathSync.native(b))
    await readOnly.worktrees.resolve(readOnly.sessionId, first.id, 'dismiss')
    expect((await readOnly.worktrees.wait(readOnly.sessionId)).status).toBe('timeout')
    await readOnly.stack.dispose()
    stacks.splice(stacks.indexOf(readOnly), 1)

    mode = 'workspace-write'
    const writable = await mount(area, a, () => mode)
    const bPrompt = promptOf(await writable.worktrees.wait(writable.sessionId))
    expect(bPrompt.kind).toBe('worktree')
    await writable.worktrees.resolve(writable.sessionId, bPrompt.id, 'dismiss')
    const aPrompt = promptOf(await writable.worktrees.wait(writable.sessionId))
    expect(aPrompt.kind).toBe('git-common')
    expect(aPrompt.path).toBe(realpathSync.native(join(main, '.git')))
  })

  it('refuses an A confirmation whose admin HEAD changed while the prompt was open', async () => {
    const area = fixture('common-stale')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    const repo = resolveRepo(linked)
    if (!repo.ok || repo.repo.adminGitdir === undefined) throw new Error('fixture is not a linked checkout')
    writeFileSync(join(repo.repo.adminGitdir, 'HEAD'), 'definitely-not-a-head\n')
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(stack.stack.registry.list(linked)).toHaveLength(0)
  })

  it('never turns a separate-git-dir common into its parent directory', async () => {
    const area = fixture('common-separate')
    const main = join(area.base, 'main')
    const store = join(area.base, 'unrelated', '.git')
    mkdirSync(main, { recursive: true })
    mkdirSync(join(area.base, 'unrelated'), { recursive: true })
    git(main, ['init', '-q', '-b', 'main', '--separate-git-dir=' + store])
    git(main, ['config', 'user.email', 'fixture@example.invalid'])
    git(main, ['config', 'user.name', 'Fixture'])
    writeFileSync(join(main, 'README.md'), 'x\n')
    git(main, ['add', 'README.md'])
    git(main, ['commit', '-q', '-m', 'initial'])
    const linked = join(area.base, 'linked')
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    // The candidate is the separated common itself, never its parent.
    expect(prompt.kind).toBe('git-common')
    expect(prompt.path).toBe(realpathSync.native(store))
    expect(prompt.path).not.toBe(realpathSync.native(join(area.base, 'unrelated')))
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    const rows = stack.stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path).toBe(realpathSync.native(store))
    const granted = stack.stack.scope.snapshot({ workspaceRoot: linked, mode: 'workspace-write' }).additionalRoots
    expect(granted).toContain(realpathSync.native(store))
    expect(granted).not.toContain(realpathSync.native(join(area.base, 'unrelated')))
  })

  it('drops the A prompt when the linked checkout loses its back-pointer', async () => {
    const area = fixture('common-lost')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    promptOf(await stack.worktrees.wait(stack.sessionId))
    renameSync(join(main, '.git'), join(area.base, 'git-away'))
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('lost')
  })
})
