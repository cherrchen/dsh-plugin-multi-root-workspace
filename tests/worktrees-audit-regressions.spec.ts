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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { mountWorktreeStack, readSidecarFile, type WorktreeStack } from './support/worktrees-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import { canonicalExisting, readRegularFile } from '../src/worktrees/fs-safe.ts'
import * as metadataNative from '../src/worktrees/native-io.ts'
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
    expect(prompt.kind).toBe('main-checkout')
    reads = 0
    liveMode = 'read-only'
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.resolved).toEqual([])
    expect(answer.skipped).toMatchObject([{ id: prompt.id, code: 'worktree/prompt-stale' }])
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
    // The changed expectation replaces the record under the same key: the wait
    // delivers the NEW prompt id instead of reusing the dead one.
    const changed = promptOf(await stack.worktrees.wait(stack.sessionId, { seenViewRevision: first.viewRevision }))
    expect(changed.id).not.toBe(first.id)
    expect(changed.kind).toBe('worktree')
    const refused = await stack.worktrees.resolve(stack.sessionId, first.id, 'add')
    expect(refused.skipped).toMatchObject([{ id: first.id, code: 'worktree/prompt-stale' }])
    expect(storeText(stack.storeFile)).toBe('')
    const second = promptOf(await stack.worktrees.wait(stack.sessionId))
    expect(second.id).not.toBe(first.id)
  })
})

describe('second audit: metadata pathname semantics', () => {
  it.skipIf(process.platform === 'win32')('rejects double-slash primary and pointer spellings before normalization', () => {
    const { main, linked } = pair('audit-double-slash')
    const admin = repoOf(linked).adminGitdir!
    writeFileSync(join(linked, '.git'), 'gitdir: /' + admin + '\n')
    expect(resolveRepo('/' + main)).toMatchObject({ ok: false, reason: 'unsafe-metadata' })
    expect(resolveRepo(linked)).toMatchObject({ ok: false, reason: 'unsafe-metadata' })
  })

  it('rejects a symlink component even when followed by dot-dot', context => {
    const reason = symlinkUnsupportedReason()
    if (reason !== undefined) return context.skip(reason)
    const { area, main, linked } = pair('audit-symlink-dotdot')
    const outside = join(area.outside, 'inner')
    mkdirSync(outside)
    const alias = join(main, 'alias')
    symlinkSync(outside, alias, 'dir')
    const admin = repoOf(linked).adminId!
    // Preserve the on-disk spelling instead of path.join folding out alias/...
    const separator = process.platform === 'win32' ? '\\' : '/'
    writeFileSync(join(linked, '.git'), 'gitdir: ' + alias + separator + '..' + separator + join('.git', 'worktrees', admin) + '\n')
    expect(resolveRepo(linked)).toMatchObject({ ok: false, reason: 'unsafe-metadata' })
  })

  it.skipIf(process.platform === 'win32')('never opens the external leaf after a persistent parent swap', () => {
    const area = fixture('audit-swap-open-parent')
    const parent = join(area.workspace, 'pinned')
    mkdirSync(parent)
    writeFileSync(join(parent, 'HEAD'), 'original')
    writeFileSync(join(area.outside, 'HEAD'), 'external')
    const open = metadataNative.openMetadataRoot
    let swapped = false
    function observe(handle: metadataNative.NativeHandle): metadataNative.NativeHandle {
      return {
        ...handle,
        directory() {
          const directory = handle.directory()
          return {
            ...directory,
            child(name) {
              const child = directory.child(name)
              if (!swapped && name === basename(parent)) {
                swapped = true
                renameSync(parent, join(dirname(parent), 'moved'))
                symlinkSync(area.outside, parent, 'dir')
              }
              return observe(child)
            },
          }
        },
      }
    }
    const spy = vi.spyOn(metadataNative, 'openMetadataRoot').mockImplementation(root => observe(open(root)))
    try {
      expect(readRegularFile(join(parent, 'HEAD'), 16).toString()).toBe('original')
      expect(swapped).toBe(true)
      expect(() => canonicalExisting(join(parent, 'HEAD'))).toThrow(/symlink/)
    } finally { spy.mockRestore() }
  })

  it.runIf(process.platform === 'win32')('refuses a junction in an admin pointer chain', () => {
    const { area, linked } = pair('audit-windows-junction')
    const admin = repoOf(linked).adminGitdir!
    const alias = join(area.base, 'junction')
    symlinkSync(dirname(admin), alias, 'junction')
    writeFileSync(join(linked, '.git'), 'gitdir: ' + join(alias, basename(admin)) + '\n')
    expect(resolveRepo(linked)).toMatchObject({ ok: false, reason: 'unsafe-metadata' })
  })

  it('preserves an initial U+FEFF in the index path of a gitlink', () => {
    const area = fixture('audit-index-bom-name')
    initRepo(area.workspace)
    const name = '\ufeffnested'
    initRepo(join(area.workspace, name))
    git(area.workspace, ['add', '--', name])
    expect(git(area.workspace, ['ls-files', '-s', '-z'])).toContain('160000 ')
    expect(resolveRepo(join(area.workspace, name))).toMatchObject({ ok: false, reason: 'submodule' })
  })
})

describe('second audit: owner commit and lifecycle', () => {
  it.each(['disable', 'replace'] as const)('rechecks after the in-queue read when the caller can %s', async change => {
    const { area, main, linked } = pair('audit-commit-' + change)
    const stack = await mountRegistryStack(join(area.base, 'store'))
    stacks.push(stack)
    const expected = expectation(main, linked)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const internal = stack.registry as unknown as { reclassify(key: string): Promise<unknown> }
    const reclassify = internal.reclassify.bind(internal)
    const spy = vi.spyOn(internal, 'reclassify').mockImplementation(async key => {
      entered.resolve()
      await release.promise
      return await reclassify(key)
    })
    let enabled = true
    stack.registry.setWorktreeGateProvider(() => enabled)
    try {
      const pending = stack.registry.addNew(main, { path: linked, expected })
      await entered.promise
      if (change === 'disable') enabled = false
      else {
        renameSync(linked, linked + '-old')
        mkdirSync(linked)
      }
      release.resolve()
      await expect(pending).rejects.toMatchObject({
        code: change === 'disable' ? 'worktree/not-enabled' : 'worktree/prompt-stale',
      })
      expect(stack.registry.list(main)).toEqual([])
      expect(storeText(stack.storeFile)).toBe('')
    } finally { release.resolve(); spy.mockRestore() }
  })

  it('checks the session again after follower recovery, before sending IPC', async () => {
    const { area, linked } = pair('audit-follower-submit')
    let mode: 'workspace-write' | 'read-only' = 'workspace-write'
    const { stack, worktrees, sessionId } = await worktreesOf(area, linked, { mode: () => mode })
    const prompt = promptOf(await worktrees.wait(sessionId))
    expect(prompt.kind).toBe('main-checkout')
    const internal = stack.registry as unknown as {
      ensureAuthority(): Promise<void>
      client?: { request: () => Promise<unknown> } | undefined
    }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const request = vi.fn(async () => { throw new Error('unexpected submission') })
    const spy = vi.spyOn(internal, 'ensureAuthority').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      internal.client = { request }
    })
    try {
      const pending = worktrees.resolve(sessionId, prompt.id, 'add')
      await entered.promise
      mode = 'read-only'
      release.resolve()
      const answer = await pending
      expect(answer.resolved).toEqual([])
      expect(answer.skipped).toMatchObject([{ id: prompt.id, code: 'worktree/prompt-stale' }])
      expect(request.mock.calls.some(call => call[0] === 'addNew')).toBe(false)
    } finally {
      release.resolve()
      spy.mockRestore()
      internal.client = undefined
    }
  })

  it('cancels a suspended inventory when the setting is disabled', async () => {
    const { area, main } = pair('audit-inflight-inventory')
    const { worktrees, stack, sessionId, hooks } = await worktreesOf(area, main, { settings: true })
    let enabled = true
    hooks()!.setSource(() => ({ enabled }))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = stack.registry.probeAdd.bind(stack.registry)
    const spy = vi.spyOn(stack.registry, 'probeAdd').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return await original(...args)
    })
    try {
      const pending = worktrees.wait(sessionId)
      await entered.promise
      enabled = false
      hooks()!.onChange()
      release.resolve()
      await expect(pending).rejects.toMatchObject({ code: 'worktree/not-enabled' })
      expect(worktrees.activationOf(main)).toMatchObject({ watching: false, candidates: 0 })
    } finally { release.resolve(); spy.mockRestore() }
  })

  it('preserves lost across a switch toggle until a user explicitly detects again', async () => {
    const { area, main } = pair('audit-lost-toggle')
    const { worktrees, sessionId, hooks } = await worktreesOf(area, main, { settings: true })
    let enabled = true
    hooks()!.setSource(() => ({ enabled }))
    const prompt = promptOf(await worktrees.wait(sessionId))
    renameSync(join(main, '.git'), join(area.base, 'git-away'))
    expect((await worktrees.wait(sessionId)).status).toBe('lost')
    renameSync(join(area.base, 'git-away'), join(main, '.git'))
    enabled = false
    hooks()!.onChange()
    enabled = true
    hooks()!.onChange()
    expect((await worktrees.wait(sessionId)).status).toBe('lost')
    expect((await worktrees.prompt(sessionId)).prompt?.id).not.toBe(prompt.id)
    expect((await worktrees.wait(sessionId)).status).toBe('prompt')
  })

  it('keeps the warning after a tracked path is observed missing and then reused', async () => {
    const { area, main, linked } = pair('audit-reused-root')
    const { worktrees, stack, sessionId } = await worktreesOf(area, main)
    const prompt = promptOf(await worktrees.wait(sessionId))
    await worktrees.resolve(sessionId, prompt.id, 'add')
    const [row] = stack.registry.list(main)
    rmSync(linked, { recursive: true, force: true })
    expect((await worktrees.describeRoots(main))?.badges.get(row!.id)).toMatchObject({
      state: 'directory-missing', cleanupEligible: true,
    })
    mkdirSync(linked)
    await stack.registry.refresh(main)
    expect(stack.registry.list(main)[0]?.state).toBe('available')
    expect((await worktrees.describeRoots(main))?.badges.get(row!.id)).toMatchObject({
      state: 'changed', cleanupEligible: false,
    })
  })
})
