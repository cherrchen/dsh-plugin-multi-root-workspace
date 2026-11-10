/** Phase P5: the owner-side expectation, identity checks and cleanup re-verification. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import { readSidecarFile } from './support/worktrees-stack.ts'
import type { FileIdentity, PromptExpected, RepoSnapshot } from '../src/worktrees/types.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr)
  return result.stdout
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

const stacks: RegistryStack[] = []
const fixtures: FixtureWorkspace[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.dispose()
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

function identity(value: FileIdentity | undefined): FileIdentity {
  if (value === undefined) throw new Error('fixture has no file identity')
  return value
}

function directoryIdentityOf(path: string): FileIdentity {
  const repo = resolveRepo(path)
  if (!repo.ok) throw new Error('cannot read identity of ' + path)
  return identity(repo.repo.adminIdentity ?? repo.repo.rootIdentity)
}

function expectation(primary: string, candidate: string, kind: 'worktree' | 'main-checkout' = 'worktree'): PromptExpected {
  const p = repoOf(primary)
  const c = kind === 'worktree' ? repoOf(candidate) : undefined
  const canonical = kind === 'worktree' ? c!.canonical : p.common
  return {
    primaryKey: primaryKey(primary),
    primaryRoot: primary,
    primary: {
      shape: p.shape, canonical: p.canonical, common: p.common,
      ...(p.adminId === undefined ? {} : { adminId: p.adminId }),
      ...(p.adminGitdir === undefined ? {} : { adminGitdir: p.adminGitdir }),
      ...(p.adminHead === undefined ? {} : { adminHead: p.adminHead }),
      rootIdentity: identity(p.rootIdentity),
      ...(p.adminIdentity === undefined ? {} : { adminIdentity: p.adminIdentity }),
    },
    candidate: {
      kind,
      canonical,
      common: p.common,
      ...(c?.adminId === undefined ? {} : { adminId: c.adminId }),
      ...(c?.adminGitdir === undefined ? {} : { adminGitdir: c.adminGitdir }),
      ...(c?.adminHead === undefined ? {} : { adminHead: c.adminHead }),
      rootIdentity: kind === 'worktree' ? identity(c!.rootIdentity) : directoryIdentityOf(p.common),
      ...(c?.adminIdentity === undefined ? {} : { adminIdentity: c.adminIdentity }),
    },
    promptKey: kind + '\u0000' + canonical,
  }
}

function storeText(stack: RegistryStack): string {
  try { return readFileSync(stack.storeFile, 'utf8') } catch { return '' }
}

async function mount(area: FixtureWorkspace): Promise<{ stack: RegistryStack; main: string; linked: string }> {
  const main = join(area.base, 'main')
  const linked = join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  const stack = await mountRegistryStack(join(area.base, 'store'))
  stacks.push(stack)
  return { stack, main, linked }
}

function trackOf(candidate: string) {
  const repo = repoOf(candidate)
  return { adminId: repo.adminId!, common: repo.common }
}

describe('addNew owner verification', () => {
  it('creates only the inherit record the expectation describes, with its B mapping', async () => {
    const area = fixture('owner-add')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    const added = await stack.registry.addNew(main, { path: expected.candidate.canonical, access: 'inherit', expected, track: trackOf(linked) })
    expect(added).toMatchObject({ path: realpathSync.native(linked), registryEpoch: expect.any(String), registryRevision: expect.any(Number) })
    const rows = stack.registry.list(main)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: added.id, path: realpathSync.native(linked), access: 'inherit', recordedPath: realpathSync.native(linked), addedAt: added.addedAt })
    const sidecar = readSidecarFile(join(area.base, 'store', 'worktree-prompts'), primaryKey(main))
    expect(sidecar!.worktreeRoots).toMatchObject([{ rootId: added.id, rootAddedAt: added.addedAt, adminId: trackOf(linked).adminId }])
    const view = await stack.registry.snapshotView(main)
    expect(view).toMatchObject({ available: true, roots: [{ id: added.id }], revision: expect.any(Number) })
  })

  it('refuses when the live worktree switch is off', async () => {
    const area = fixture('owner-gate')
    const { stack, main, linked } = await mount(area)
    stack.registry.setWorktreeGateProvider(() => false)
    const expected = expectation(main, linked)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/not-enabled' })
    expect(stack.registry.list(main)).toHaveLength(0)
  })

  it('refuses when the primary checkout moved after the expectation was captured', async () => {
    const area = fixture('owner-primary-moved')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    renameSync(join(main, '.git'), join(area.base, 'git-away'))
    const before = storeText(stack)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack)).toBe(before)
    expect(stack.registry.list(main)).toHaveLength(0)
  })

  it('refuses when the candidate admin HEAD changed', async () => {
    const area = fixture('owner-head')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    writeFileSync(join(repoOf(linked).adminGitdir!, 'HEAD'), 'definitely-not-a-head\n')
    const before = storeText(stack)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack)).toBe(before)
  })

  it('refuses a same-path delete-and-rebuild (same admin, new directory identity)', async () => {
    const area = fixture('owner-rebuild')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    const pointer = readFileSync(join(linked, '.git'), 'utf8')
    rmSync(linked, { recursive: true, force: true })
    mkdirSync(linked)
    writeFileSync(join(linked, '.git'), pointer)
    // The snapshot is still structurally valid, but the root directory is a
    // different file-system object, which the identity check must catch.
    expect(repoOf(linked).canonical).toBe(expected.candidate.canonical)
    const before = storeText(stack)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack)).toBe(before)
  })

  it('refuses when an ancestor registered the candidate as a gitlink while the prompt was open', async () => {
    const area = fixture('owner-ancestor')
    const outer = join(area.base, 'outer')
    initRepo(outer)
    const nested = join(outer, 'nested')
    initRepo(nested)
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    const expected = expectation(nested, nested)
    git(outer, ['add', 'nested'])
    git(outer, ['commit', '-q', '-m', 'register gitlink'])
    await expect(stack.registry.addNew(nested, { path: nested, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
  })

  it('refuses a candidate replaced by a symlink', async () => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return
    const area = fixture('owner-symlink')
    const { stack, main, linked } = await mount(area)
    const other = join(area.base, 'other')
    git(main, ['worktree', 'add', '-q', other, '-b', 'other'])
    const expected = expectation(main, linked)
    rmSync(linked, { recursive: true, force: true })
    symlinkSync(other, linked, 'dir')
    const before = storeText(stack)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack)).toBe(before)
  })

  it('reports duplicate instead of reviving or rewriting an existing record', async () => {
    const area = fixture('owner-duplicate')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    const first = await stack.registry.addNew(main, { path: expected.candidate.canonical, expected })
    const before = storeText(stack)
    await expect(stack.registry.addNew(main, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'duplicate' })
    expect(stack.registry.list(main)).toHaveLength(1)
    expect(stack.registry.list(main)[0]!.id).toBe(first.id)
    expect(storeText(stack)).toBe(before)
  })

  it('refuses an expectation captured for another workspace', async () => {
    const area = fixture('owner-workspace')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    await expect(stack.registry.addNew(area.base, { path: expected.candidate.canonical, expected })).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
  })
})

describe('removeForDeletedWorktree owner verification', () => {
  it('binds rootId, path and addedAt, and deletes only a confirmed-missing path', async () => {
    const area = fixture('owner-cleanup')
    const { stack, main, linked } = await mount(area)
    const expected = expectation(main, linked)
    const added = await stack.registry.addNew(main, { path: expected.candidate.canonical, expected, track: trackOf(linked) })
    // A different addedAt is a different authorization generation.
    await expect(stack.registry.removeForDeletedWorktree(main, { rootId: added.id, expectedPath: added.path, expectedAddedAt: '1999-01-01T00:00:00.000Z' })).rejects
      .toMatchObject({ code: 'worktree/not-eligible' })
    // An existing (even empty) path is still a path.
    await expect(stack.registry.removeForDeletedWorktree(main, { rootId: added.id, expectedPath: added.path, expectedAddedAt: added.addedAt })).rejects
      .toMatchObject({ code: 'worktree/not-eligible' })
    // An ignore of the same path is cleared together with the mapping.
    await stack.registry.worktreeSidecar(main, { op: 'ignore', key: 'worktree\u0000' + added.path, kind: 'worktree', path: added.path })
    rmSync(linked, { recursive: true, force: true })
    await expect(stack.registry.removeForDeletedWorktree(main, { rootId: added.id, expectedPath: added.path, expectedAddedAt: added.addedAt }))
      .resolves.toEqual({ removed: true })
    expect(stack.registry.list(main)).toHaveLength(0)
    const sidecar = readSidecarFile(join(area.base, 'store', 'worktree-prompts'), primaryKey(main))
    expect(sidecar!.worktreeRoots).toEqual([])
    expect(sidecar!.ignored).toEqual([])
  })
})

describe('owner snapshot envelope', () => {
  it('exposes one complete owner snapshot for mapping reconciliation', async () => {
    const area = fixture('owner-snapshot')
    const { stack, main } = await mount(area)
    expect(await stack.registry.snapshotView(main)).toMatchObject({ available: true, roots: [], epoch: expect.any(String), revision: expect.any(Number) })
  })

  it('keeps mappings when reconciliation cannot prove a complete snapshot', async () => {
    const area = fixture('owner-sidecar')
    const { stack, main } = await mount(area)
    const before = await stack.registry.worktreeSidecar(main, { op: 'read' })
    expect(before).toMatchObject({ available: true, revision: 0, worktreeRoots: [] })
    expect(await stack.registry.worktreeSidecar(main, { op: 'reconcile' })).toMatchObject({ available: true })
  })
})
