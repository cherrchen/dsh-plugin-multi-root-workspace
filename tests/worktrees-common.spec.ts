/** Phase P8/P9: the A candidate (main checkout root), its modes, confirmation and staleness. */
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
  it('offers the main checkout root of an external linked checkout', async () => {
    const area = fixture('common-external')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(prompt.kind).toBe('main-checkout')
    expect(prompt.path).toBe(realpathSync.native(main))
    expect(prompt.effectiveAccess).toBe('read-write')
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.prompts).toEqual([])
    const rows = stack.stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: realpathSync.native(main), access: 'inherit' })
    // A roots never receive a B cleanup mapping.
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(linked))?.worktreeRoots ?? []).toEqual([])
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('does not offer A when the primary is a default-pool worktree', async () => {
    const area = fixture('common-pool')
    const main = join(area.base, 'main')
    initRepo(main)
    const pool = join(main, '.agents', 'worktrees', 'a')
    git(main, ['worktree', 'add', '-q', pool, '-b', 'a'])
    const stack = await mount(area, pool)
    // The main checkout contains the primary, so the Registry's
    // `primary-overlap` rule refuses it: no A prompt is produced.
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
    expect(stack.stack.registry.list(pool)).toHaveLength(0)
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
    expect(promptOf(await stack.worktrees.wait(stack.sessionId)).kind).toBe('main-checkout')
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
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.resolved).toEqual([])
    expect(answer.skipped).toMatchObject([{ id: prompt.id, code: 'worktree/prompt-stale' }])
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

  it('is not offered when the main checkout is already registered', async () => {
    const area = fixture('common-registered')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    await stack.stack.registry.add(linked, { path: main })
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('is not offered while a legacy .git root still exists', async () => {
    const area = fixture('common-registered-legacy')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const stack = await mount(area, linked)
    // Pre-nineteenth-revision installs registered `<main>/.git`; the main
    // checkout is nested inside it, so the operator must remove the legacy root
    // first (no automatic replacement).
    await stack.stack.registry.add(linked, { path: join(main, '.git') })
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
  })

  it('keeps B visible when the pool primary makes A unavailable', async () => {
    const area = fixture('common-mixed')
    const main = join(area.base, 'main')
    initRepo(main)
    const pool = join(main, '.agents', 'worktrees')
    const a = join(pool, 'a')
    const b = join(pool, 'b')
    git(main, ['worktree', 'add', '-q', a, '-b', 'a'])
    git(main, ['worktree', 'add', '-q', b, '-b', 'b'])

    // A is never offered for a pool primary: `<main>` contains the primary.
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
    expect((await writable.worktrees.wait(writable.sessionId)).status).toBe('timeout')
  })

  it('lists an external sibling and the main checkout, with B before A', async () => {
    const area = fixture('common-external-list')
    const main = join(area.base, 'main')
    initRepo(main)
    const a = join(area.base, 'a')
    const b = join(area.base, 'b')
    git(main, ['worktree', 'add', '-q', a, '-b', 'a'])
    git(main, ['worktree', 'add', '-q', b, '-b', 'b'])
    const stack = await mount(area, a)
    const visible = await stack.worktrees.wait(stack.sessionId)
    expect(visible.status).toBe('prompts')
    if (visible.status !== 'prompts') throw new Error('expected a list')
    expect(visible.prompts.map(prompt => prompt.kind)).toEqual(['worktree', 'main-checkout'])
    expect(visible.prompts[0]?.path).toBe(realpathSync.native(b))
    expect(visible.prompts[1]?.path).toBe(realpathSync.native(main))
    await stack.worktrees.resolve(stack.sessionId, visible.prompts[0]!.id, 'dismiss')
    const aPrompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(aPrompt.kind).toBe('main-checkout')
    expect(aPrompt.path).toBe(realpathSync.native(main))
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
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.resolved).toEqual([])
    expect(answer.skipped).toMatchObject([{ id: prompt.id, code: 'worktree/prompt-stale' }])
    expect(stack.stack.registry.list(linked)).toHaveLength(0)
  })

  it('offers the derivable parent of a separate-git-dir store (documented ambiguity)', async () => {
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
    // `dirname(common)` is the only derivable target. For a separate store that
    // is the store's parent, not the real main checkout; the prompt discloses
    // that ambiguity and the operator confirms the exact path.
    const parent = realpathSync.native(join(area.base, 'unrelated'))
    expect(prompt.kind).toBe('main-checkout')
    expect(prompt.path).toBe(parent)
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    const rows = stack.stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path).toBe(parent)
    const granted = stack.stack.scope.snapshot({ workspaceRoot: linked, mode: 'workspace-write' }).additionalRoots
    expect(granted).toContain(parent)
  })

  // Windows holds a watched directory handle and refuses the rename this setup
  // needs; the lost/recovery behavior itself is covered by the re-mount case.
  it.skipIf(process.platform === 'win32')('drops the A prompt when the linked checkout loses its back-pointer', async () => {
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
