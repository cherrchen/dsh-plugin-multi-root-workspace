/**
 * Regressions for the audit of the worktree B/A batch.
 *
 * Each case reproduces one reported defect against the production stack:
 * cross-common candidates, symlinked pointer targets, POSIX backslash names,
 * the commit boundary (owner queue and live session), cleanup eligibility and
 * stale prompt identities. The fixtures are real Git repositories; Git is only
 * used to build them, never by the feature under test.
 *
 * @module tests/worktrees-audit-regressions
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { mountWorktreeStack, readSidecarFile, type WorktreeStack } from './support/worktrees-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import { inventoryWorktrees } from '../src/worktrees/inventory.ts'
import type { PromptExpected, RepoSnapshot, WorktreePromptWaitResult } from '../src/worktrees/types.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + result.stderr)
  return result.stdout
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'fixture@example.invalid'])
  git(path, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

const fixtures: FixtureWorkspace[] = []
const stacks: Array<RegistryStack | WorktreeStack> = []
afterEach(async () => {
  while (stacks.length > 0) {
    const stack = stacks.pop()!
    await ('stack' in stack ? stack.stack.dispose() : stack.dispose())
  }
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

function fixture(label: string): FixtureWorkspace {
  const area = createFixtureWorkspace(label)
  fixtures.push(area)
  return area
}

function repoOf(path: string): RepoSnapshot {
  const result = resolveRepo(path)
  if (!result.ok) throw new Error('fixture is not an active checkout: ' + result.reason + ': ' + result.detail)
  return result.repo
}

function expectation(primary: string, candidate: string): PromptExpected {
  const p = repoOf(primary)
  const c = repoOf(candidate)
  return {
    primaryKey: primaryKey(primary),
    primaryRoot: primary,
    primary: {
      shape: p.shape, canonical: p.canonical, common: p.common,
      ...(p.adminId === undefined ? {} : { adminId: p.adminId }),
      ...(p.adminGitdir === undefined ? {} : { adminGitdir: p.adminGitdir }),
      ...(p.adminHead === undefined ? {} : { adminHead: p.adminHead }),
      rootIdentity: p.rootIdentity,
      ...(p.adminIdentity === undefined ? {} : { adminIdentity: p.adminIdentity }),
    },
    candidate: {
      kind: 'worktree', canonical: c.canonical, common: c.common,
      ...(c.adminId === undefined ? {} : { adminId: c.adminId }),
      ...(c.adminGitdir === undefined ? {} : { adminGitdir: c.adminGitdir }),
      ...(c.adminHead === undefined ? {} : { adminHead: c.adminHead }),
      rootIdentity: c.rootIdentity,
      ...(c.adminIdentity === undefined ? {} : { adminIdentity: c.adminIdentity }),
    },
    promptKey: 'worktree\u0000' + c.canonical,
  }
}

function promptOf(result: WorktreePromptWaitResult) {
  expect(result.status).toBe('prompt')
  if (result.status !== 'prompt') throw new Error('expected a prompt, got ' + result.status)
  return result.prompt
}

function storeText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** Enqueue one blocking job on the Registry owner's serialized queue. */
function holdOwnerQueue(registry: RegistryStack['registry'], key: string): { entered: Promise<void>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = Promise.withResolvers<void>()
  const internal = registry as unknown as { serialize<T>(key: string, job: () => Promise<T>): Promise<T> }
  void internal.serialize(key, async () => {
    entered.resolve()
    await gate
  })
  return { entered: entered.promise, release }
}

interface RepoPair { readonly area: FixtureWorkspace; readonly main: string; readonly linked: string }

function pair(label: string): RepoPair {
  const area = fixture(label)
  const main = join(area.base, 'main')
  const linked = join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  return { area, main, linked }
}

async function worktreesOf(area: FixtureWorkspace, cwd: string, options: Parameters<typeof mountWorktreeStack>[1] = {}): Promise<WorktreeStack> {
  const stack = await mountWorktreeStack(join(area.base, 'store'), { cwd, ...options })
  stacks.push(stack)
  return stack
}

describe('candidate binding (audit 1)', () => {
  it('ignores an admin entry whose same-named gitdir points at another repository', async () => {
    const area = fixture('audit-inventory-cross-common')
    const mainA = join(area.base, 'main-a')
    const mainB = join(area.base, 'main-b')
    const linkedB = join(area.base, 'linked-b')
    initRepo(mainA)
    initRepo(mainB)
    git(mainB, ['worktree', 'add', '-q', linkedB, '-b', 'b'])
    const b = repoOf(linkedB)
    // Plant A's `<common>/worktrees/<same name>` and point its `gitdir` at B's
    // real linked checkout. Every per-repository check of B passes; only the
    // common/admin binding can tell that it does not belong to A.
    const planted = join(mainA, '.git', 'worktrees', b.adminId!)
    mkdirSync(planted, { recursive: true })
    writeFileSync(join(planted, 'gitdir'), join(linkedB, '.git') + '\n')
    expect(inventoryWorktrees(realpathSync.native(join(mainA, '.git'))).candidates).toEqual([])

    const stack = await worktreesOf(area, mainA, { config: { waitTimeoutMs: 80 } })
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
    expect(resolveRepo(mainA).ok).toBe(true)
  })

  it('refuses an addNew expectation whose candidate belongs to another common', async () => {
    const area = fixture('audit-owner-cross-common')
    const mainA = join(area.base, 'main-a')
    const mainB = join(area.base, 'main-b')
    const linkedB = join(area.base, 'linked-b')
    initRepo(mainA)
    initRepo(mainB)
    git(mainB, ['worktree', 'add', '-q', linkedB, '-b', 'b'])
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    const expected = expectation(mainA, linkedB)
    const before = storeText(stack.storeFile)
    await expect(stack.registry.addNew(mainA, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: expected.candidate.adminId!, common: expected.candidate.common },
    })).rejects.toMatchObject({ code: 'worktree/prompt-stale' })
    expect(stack.registry.list(mainA)).toHaveLength(0)
    expect(storeText(stack.storeFile)).toBe(before)
  })
})

describe('metadata no-follow and separators (audit 2)', () => {
  it('refuses a .git pointer whose admin target is a directory symlink', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const { area, linked } = pair('audit-symlink-admin')
    const admin = repoOf(linked).adminGitdir!
    const link = join(area.base, 'admin-link')
    symlinkSync(admin, link, 'dir')
    writeFileSync(join(linked, '.git'), 'gitdir: ' + link + '\n')
    expect(resolveRepo(linked).ok).toBe(false)
  })

  it('refuses a commondir target that is a directory symlink', () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const { area, linked } = pair('audit-symlink-common')
    const repo = repoOf(linked)
    const link = join(area.base, 'common-link')
    symlinkSync(repo.common, link, 'dir')
    writeFileSync(join(repo.adminGitdir!, 'commondir'), link + '\n')
    expect(resolveRepo(linked).ok).toBe(false)
  })

  it('keeps a literal backslash in a checkout path', () => {
    if (process.platform === 'win32') return
    const area = fixture('audit-backslash-root')
    const root = join(area.base, 'repo\\one')
    initRepo(root)
    const result = resolveRepo(root)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (result.ok) expect(result.repo.shape).toBe('main')
  })

  it('finds an ancestor gitlink whose path contains a literal backslash', () => {
    if (process.platform === 'win32') return
    const area = fixture('audit-backslash-gitlink')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const nested = join(outer, 'vendor\\lib')
    initRepo(nested)
    git(outer, ['add', 'vendor\\lib'])
    git(outer, ['commit', '-q', '-m', 'register literal backslash gitlink'])
    // The index entry is the literal one-component name `vendor\lib`; turning
    // the backslash into a separator would look up `vendor/lib` and miss it.
    expect(git(outer, ['ls-files', '-s', '-z'])).toContain('vendor\\lib')
    const result = resolveRepo(nested)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('submodule')
  })
})

describe('commit boundary (audit 3)', () => {
  it('re-reads the owner switch inside the serialized queue before persisting', async () => {
    const { area, main, linked } = pair('audit-owner-gate')
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    const expected = expectation(main, linked)
    const hold = holdOwnerQueue(stack.registry, primaryKey(main))
    await hold.entered
    const pending = stack.registry.addNew(main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: expected.candidate.adminId!, common: expected.candidate.common },
    })
    // Let `addNew` pass its pre-queue checks and line up behind the barrier.
    await new Promise(resolve => setTimeout(resolve, 20))
    stack.registry.setWorktreeGateProvider(() => false)
    hold.release()
    await expect(pending).rejects.toMatchObject({ code: 'worktree/not-enabled' })
    expect(stack.registry.list(main)).toHaveLength(0)
  })

  it('re-reads the live session mode immediately before sending the confirmation', async () => {
    const { area, linked } = pair('audit-host-mode')
    let liveMode: 'workspace-write' | 'read-only' = 'workspace-write'
    let reads = 0
    const stack = await worktreesOf(area, linked, {
      mode: () => (reads++ === 0 ? 'workspace-write' : liveMode),
      config: { waitTimeoutMs: 80 },
    })
    // The first read is the one `resolve` starts with; every later read is the
    // post-await refresh the audit requires. A is only eligible in
    // `workspace-write`, so the live re-read must retire the prompt.
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(prompt.kind).toBe('git-common')
    reads = 0
    liveMode = 'read-only'
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add'))
      .rejects.toMatchObject({ code: 'worktree/prompt-stale' })
    expect(stack.stack.registry.list(linked)).toHaveLength(0)
  })
})

describe('cleanup eligibility (audit 4)', () => {
  it('refuses to delete an untracked manual root that happens to be missing', async () => {
    const { area, main, linked } = pair('audit-cleanup-manual')
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    await stack.registry.add(main, { path: linked })
    const [row] = stack.registry.list(main)
    rmSync(linked, { recursive: true, force: true })
    await stack.registry.refresh(main)
    await expect(stack.registry.removeForDeletedWorktree(main, {
      rootId: row!.id, expectedPath: row!.path, expectedAddedAt: row!.addedAt,
    })).rejects.toMatchObject({ code: 'worktree/not-eligible' })
    expect(stack.registry.list(main)).toHaveLength(1)
  })

  it('re-verifies the primary activation before a tracked cleanup', async () => {
    const { area, main, linked } = pair('audit-cleanup-lost')
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    const expected = expectation(main, linked)
    const added = await stack.registry.addNew(main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: expected.candidate.adminId!, common: expected.candidate.common },
    })
    rmSync(linked, { recursive: true, force: true })
    renameSync(join(main, '.git'), join(area.base, 'git-away'))
    await expect(stack.registry.removeForDeletedWorktree(main, {
      rootId: added.id, expectedPath: added.path, expectedAddedAt: added.addedAt,
    })).rejects.toMatchObject({ code: 'worktree/not-eligible' })
    expect(stack.registry.list(main)).toHaveLength(1)
  })

  it('does not write a sidecar revision for an inactive reset', async () => {
    const area = fixture('audit-reset-inactive')
    const stack = await worktreesOf(area, area.outside, { config: { waitTimeoutMs: 50 } })
    expect(await stack.worktrees.reset(stack.sessionId)).toEqual({ cleared: false })
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(area.outside))).toBeUndefined()
  })

  it('does not bump the sidecar revision when there is nothing to reset', async () => {
    const { area, main } = pair('audit-reset-empty')
    const stack = await worktreesOf(area, main, { config: { waitTimeoutMs: 50 } })
    expect(await stack.worktrees.reset(stack.sessionId)).toEqual({ cleared: true })
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(main))).toBeUndefined()
  })
})

describe('stale prompt identity (audit 5)', () => {
  it('issues a new prompt id when the candidate expectation changed under the same key', async () => {
    const { area, main, linked } = pair('audit-stale-id')
    const stack = await worktreesOf(area, main, { config: { waitTimeoutMs: 60 } })
    const first = promptOf(await stack.worktrees.wait(stack.sessionId))
    // A valid new HEAD: the checkout stays active, only the admin snapshot moves.
    git(linked, ['checkout', '-q', '-b', 'another'])
    const stale = await stack.worktrees.wait(stack.sessionId, { seenPromptId: first.id, seenViewRevision: first.viewRevision })
    expect(stale.status).toBe('stale')
    await expect(stack.worktrees.resolve(stack.sessionId, first.id, 'add'))
      .rejects.toMatchObject({ code: 'worktree/prompt-stale' })
    const second = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(second.id).not.toBe(first.id)
    expect(second.kind).toBe('worktree')
    expect(storeText(stack.storeFile)).toBe('')
  })
})
