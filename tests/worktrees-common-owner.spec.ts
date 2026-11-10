/** Phase P9: the A confirmation through the Registry owner, its staleness and its ordinary lifecycle. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { mountWorktreeStack, readSidecarFile, type WorktreeStack } from './support/worktrees-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { directoryIdentity } from '../src/worktrees/fs-safe.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import type { PromptExpected } from '../src/worktrees/types.ts'

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
const stacks: RegistryStack[] = []
const worktreeStacks: WorktreeStack[] = []
afterEach(async () => {
  while (worktreeStacks.length > 0) await worktreeStacks.pop()!.stack.dispose()
  while (stacks.length > 0) await stacks.pop()!.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

function fixture(label: string): FixtureWorkspace {
  const area = createFixtureWorkspace(label)
  fixtures.push(area)
  return area
}

interface Setup {
  readonly area: FixtureWorkspace
  readonly main: string
  readonly linked: string
}

function setup(label: string): Setup {
  const area = fixture(label)
  const main = join(area.base, 'main')
  const linked = join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  return { area, main, linked }
}

async function open(input: Setup): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(input.area.base, 'store'))
  stacks.push(stack)
  return stack
}

function expectedFor(primary: string): PromptExpected {
  const result = resolveRepo(primary)
  if (!result.ok) throw new Error('fixture is not active: ' + result.reason)
  const repo = result.repo
  if (repo.shape !== 'linked' || repo.adminId === undefined || repo.adminGitdir === undefined
    || repo.adminHead === undefined || repo.adminIdentity === undefined) {
    throw new Error('fixture is not a supported linked checkout')
  }
  const mainRoot = dirname(repo.common)
  const identity = directoryIdentity(mainRoot)
  if (identity === undefined) throw new Error('main checkout has no identity')
  return {
    primaryKey: primaryKey(primary),
    primaryRoot: primary,
    primary: {
      shape: repo.shape, canonical: repo.canonical, common: repo.common,
      adminId: repo.adminId, adminGitdir: repo.adminGitdir, adminHead: repo.adminHead,
      rootIdentity: repo.rootIdentity, adminIdentity: repo.adminIdentity,
    },
    candidate: {
      kind: 'main-checkout', canonical: mainRoot, common: repo.common,
      adminId: repo.adminId, adminGitdir: repo.adminGitdir, adminHead: repo.adminHead,
      rootIdentity: identity, adminIdentity: repo.adminIdentity,
    },
    promptKey: 'main-checkout\u0000' + repo.common,
  }
}

function storeText(stack: RegistryStack): string {
  try { return readFileSync(stack.storeFile, 'utf8') } catch { return '' }
}

describe('A owner confirmation', () => {
  it('creates an ordinary inherit registration for the main checkout, with no cleanup mapping', async () => {
    const input = setup('a-owner-add')
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    const added = await stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })
    expect(added.path).toBe(realpathSync.native(input.main))
    const rows = stack.registry.list(input.linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: added.id, path: added.path, access: 'inherit', state: 'available' })
    expect(readSidecarFile(join(input.area.base, 'store', 'worktree-prompts'), primaryKey(input.linked))?.worktreeRoots ?? []).toEqual([])
  })

  it('refuses when the admin HEAD changed while the prompt was open', async () => {
    const input = setup('a-owner-head')
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    writeFileSync(join(expected.primary.adminGitdir!, 'HEAD'), 'definitely-not-a-head\n')
    const before = storeText(stack)
    await expect(stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack)).toBe(before)
  })

  it('refuses when the linked checkout lost its back-pointer', async () => {
    const input = setup('a-owner-back')
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    writeFileSync(join(expected.primary.adminGitdir!, 'gitdir'), join(input.area.base, 'elsewhere'))
    await expect(stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
  })

  it('refuses a candidate that is another checkout common', async () => {
    const input = setup('a-owner-other')
    const second = join(input.area.base, 'second')
    initRepo(second)
    const otherLinked = join(input.area.base, 'other-linked')
    git(second, ['worktree', 'add', '-q', otherLinked, '-b', 'other'])
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    const other = resolveRepo(otherLinked)
    if (!other.ok) throw new Error('second fixture is not active')
    const otherMain = dirname(other.repo.common)
    await expect(stack.registry.addNew(input.linked, {
      path: otherMain,
      expected: { ...expected, candidate: { ...expected.candidate, canonical: otherMain, common: other.repo.common } },
    })).rejects.toMatchObject({ code: 'worktree/prompt-stale' })
  })

  it('refuses a manual duplicate instead of reviving or remapping it', async () => {
    const input = setup('a-owner-duplicate')
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    await stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })
    const before = storeText(stack)
    await expect(stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'duplicate' })
    expect(storeText(stack)).toBe(before)
  })
})

describe('A lifecycle', () => {
  it('leaves the A root to the ordinary Remove and refuses worktree cleanup', async () => {
    const input = setup('a-lifecycle')
    const stack = await mountWorktreeStack(join(input.area.base, 'store'), {
      cwd: input.linked,
      config: { waitTimeoutMs: 80 },
    })
    worktreeStacks.push(stack)
    const prompt = await stack.worktrees.wait(stack.sessionId)
    expect(prompt.status).toBe('prompt')
    if (prompt.status !== 'prompt') return
    await stack.worktrees.resolve(stack.sessionId, prompt.prompt.id, 'add')
    const [row] = stack.stack.registry.list(input.linked)
    expect(row).toBeDefined()
    const cleanup = await stack.worktrees.cleanup(stack.sessionId, [row!.id])
    expect(cleanup.removed).toEqual([])
    expect(cleanup.skipped).toEqual([{ id: row!.id, code: 'worktree/not-eligible' }])
    await stack.stack.registry.removeAt(input.linked, { kind: 'id', id: row!.id })
    expect(stack.stack.registry.list(input.linked)).toHaveLength(0)
  })

  it('keeps an A root registered when the linked checkout is removed', async () => {
    const input = setup('a-lifecycle-removed')
    const stack = await open(input)
    const expected = expectedFor(input.linked)
    await stack.registry.addNew(input.linked, { path: expected.candidate.canonical, expected })
    // The linked checkout is deleted; the common (and therefore the A root)
    // still exists. A never enters the B cleanup lifecycle.
    renameSync(input.linked, join(input.area.base, 'linked-away'))
    await stack.registry.refresh(input.linked)
    expect(stack.registry.list(input.linked)).toHaveLength(1)
    expect(stack.registry.list(input.linked)[0]?.state).toBe('available')
  })
})
