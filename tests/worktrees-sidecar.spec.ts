/** Phase P6: sidecar ownership, cross-epoch reconciliation and empty-snapshot semantics. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import { readSidecarFile } from './support/worktrees-stack.ts'
import { sidecarPath } from '../src/worktrees/sidecar.ts'
import type { PromptExpected, RepoSnapshot } from '../src/worktrees/types.ts'

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
  if (!result.ok) throw new Error('fixture is not active: ' + result.reason)
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

interface Fixture { readonly area: FixtureWorkspace; readonly main: string; readonly linked: string }
async function setup(label: string): Promise<Fixture> {
  const area = fixture(label)
  const main = join(area.base, 'main')
  const linked = join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  return { area, main, linked }
}

async function open(fixture: Fixture, config: Parameters<typeof mountRegistryStack>[1] = {}): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.area.base, 'store'), config)
  stacks.push(stack)
  return stack
}

describe('sidecar cross-epoch reconciliation', () => {
  it('rebinds a mapping to the new owner epoch and keeps it while the record matches', async () => {
    const fixture = await setup('sidecar-epoch')
    const first = await open(fixture)
    const expected = expectation(fixture.main, fixture.linked)
    const repo = repoOf(fixture.linked)
    const added = await first.registry.addNew(fixture.main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: repo.adminId!, common: repo.common },
    })
    const firstEpoch = first.registry.epoch
    await first.dispose()

    const second = await open(fixture)
    const read = await second.registry.worktreeSidecar(fixture.main, { op: 'read' })
    expect(read).toMatchObject({ available: true, worktreeRoots: [{ rootId: added.id, path: realpathSync.native(fixture.linked) }] })
    expect(read.epoch).not.toBe(firstEpoch)
    const reconciled = await second.registry.worktreeSidecar(fixture.main, { op: 'reconcile' })
    expect(reconciled.worktreeRoots).toHaveLength(1)
    expect(reconciled.worktreeRoots[0]!.registryEpoch).toBe(reconciled.epoch)
    expect(second.registry.list(fixture.main)).toHaveLength(1)
  })

  it('prunes a mapping only when the full owner snapshot no longer matches it', async () => {
    const fixture = await setup('sidecar-prune')
    const stack = await open(fixture)
    const expected = expectation(fixture.main, fixture.linked)
    const repo = repoOf(fixture.linked)
    const added = await stack.registry.addNew(fixture.main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: repo.adminId!, common: repo.common },
    })
    // A manual removal is the operator's act, never this feature's.
    await stack.registry.removeAt(fixture.main, { kind: 'id', id: added.id })
    expect(stack.registry.list(fixture.main)).toHaveLength(0)
    const pruned = await stack.registry.worktreeSidecar(fixture.main, { op: 'reconcile' })
    expect(pruned.worktreeRoots).toEqual([])
    // The Registry record itself was NOT recreated or touched.
    expect(stack.registry.list(fixture.main)).toHaveLength(0)
  })

  it('drops a mapping when a revive changed the record addedAt binding', async () => {
    const fixture = await setup('sidecar-revive')
    const stack = await open(fixture)
    const expected = expectation(fixture.main, fixture.linked)
    const repo = repoOf(fixture.linked)
    const added = await stack.registry.addNew(fixture.main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: repo.adminId!, common: repo.common },
    })
    // Withhold then revive the SAME record: a revive rewrites addedAt, which is
    // exactly the binding a cleanup mapping is tied to.
    rmSync(fixture.linked, { recursive: true, force: true })
    await stack.registry.refresh(fixture.main)
    mkdirSync(fixture.linked)
    writeFileSync(join(fixture.linked, 'README.md'), 'back\n')
    // The original worktree record is withheld, so a re-registration revives it.
    await stack.registry.add(fixture.main, { path: fixture.linked })
    const revived = stack.registry.list(fixture.main)
    expect(revived).toHaveLength(1)
    expect(revived[0]!.id).toBe(added.id)
    expect(revived[0]!.addedAt).not.toBe(added.addedAt)
    const pruned = await stack.registry.worktreeSidecar(fixture.main, { op: 'reconcile' })
    expect(pruned.worktreeRoots).toEqual([])
  })
})

describe('sidecar availability semantics', () => {
  it('answers an unavailable read with empty lists and refuses writes', async () => {
    const fixture = await setup('sidecar-unavailable')
    const stack = await open(fixture, { sharedStorageRoot: '' })
    const read = await stack.registry.worktreeSidecar(fixture.main, { op: 'read' })
    expect(read).toMatchObject({ available: false, ignored: [], worktreeRoots: [] })
    await expect(stack.registry.worktreeSidecar(fixture.main, {
      op: 'ignore', key: 'worktree\u0000/x', kind: 'worktree', path: '/x',
    })).rejects.toMatchObject({ code: 'worktree/registry-unavailable' })
  })

  it('deduplicates ignores, bumps the revision once, and resets explicitly', async () => {
    const fixture = await setup('sidecar-ignore')
    const stack = await open(fixture)
    const entry = { op: 'ignore' as const, key: 'worktree\u0000/x', kind: 'worktree' as const, path: '/x' }
    const first = await stack.registry.worktreeSidecar(fixture.main, entry)
    const second = await stack.registry.worktreeSidecar(fixture.main, entry)
    expect(second.revision).toBe(first.revision)
    expect(second.ignored).toHaveLength(1)
    const reset = await stack.registry.worktreeSidecar(fixture.main, { op: 'reset' })
    expect(reset.ignored).toEqual([])
    expect(reset.revision).toBeGreaterThan(second.revision)
    const file = readSidecarFile(join(fixture.area.base, 'store', 'worktree-prompts'), primaryKey(fixture.main))
    expect(file!.ignored).toEqual([])
  })

  it('serializes concurrent ignore writes without losing an entry', async () => {
    const fixture = await setup('sidecar-concurrent')
    const stack = await open(fixture)
    await Promise.all([
      stack.registry.worktreeSidecar(fixture.main, { op: 'ignore', key: 'worktree\u0000/a', kind: 'worktree', path: '/a' }),
      stack.registry.worktreeSidecar(fixture.main, { op: 'ignore', key: 'worktree\u0000/b', kind: 'worktree', path: '/b' }),
      stack.registry.worktreeSidecar(fixture.main, { op: 'read' }),
    ])
    const view = await stack.registry.worktreeSidecar(fixture.main, { op: 'read' })
    expect(view.ignored.map(entry => entry.key).sort()).toEqual(['worktree\u0000/a', 'worktree\u0000/b'])
  })
})

describe('sidecar snooze', () => {
  const record = (mode: 'until-new-worktree' | 'until' = 'until-new-worktree') => ({
    mode,
    ...(mode === 'until' ? { until: new Date(Date.now() + 86_400_000).toISOString() } : {}),
    keys: ['worktree\u0000/x'],
    at: new Date().toISOString(),
  })

  it('round-trips one snooze and preserves ignores and mappings', async () => {
    const fixture = await setup('snooze-roundtrip')
    const stack = await open(fixture)
    const expected = expectation(fixture.main, fixture.linked)
    const repo = repoOf(fixture.linked)
    const added = await stack.registry.addNew(fixture.main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: repo.adminId!, common: repo.common },
    })
    await stack.registry.worktreeSidecar(fixture.main, { op: 'ignore', key: 'worktree\u0000/ignored', kind: 'worktree', path: '/ignored' })
    const snooze = record('until')
    const view = await stack.registry.worktreeSidecar(fixture.main, { op: 'snooze', snooze })
    expect(view.snooze).toEqual(snooze)
    expect(view.ignored.map(entry => entry.key)).toEqual(['worktree\u0000/ignored'])
    expect(view.worktreeRoots.map(mapping => mapping.rootId)).toEqual([added.id])
    const file = readSidecarFile(join(fixture.area.base, 'store', 'worktree-prompts'), primaryKey(fixture.main))
    expect(file!.snooze).toEqual(snooze)
    // Another operation that rewrites the document (a reconcile) keeps it.
    const reconciled = await stack.registry.worktreeSidecar(fixture.main, { op: 'reconcile' })
    expect(reconciled.snooze).toEqual(snooze)
    expect(reconciled.worktreeRoots.map(mapping => mapping.rootId)).toEqual([added.id])
  })

  it('does not let a corrupt snooze take the ignores and mappings down', async () => {
    const fixture = await setup('snooze-corrupt')
    const first = await open(fixture)
    const expected = expectation(fixture.main, fixture.linked)
    const repo = repoOf(fixture.linked)
    await first.registry.addNew(fixture.main, {
      path: expected.candidate.canonical,
      expected,
      track: { adminId: repo.adminId!, common: repo.common },
    })
    await first.registry.worktreeSidecar(fixture.main, { op: 'ignore', key: 'worktree\u0000/ignored', kind: 'worktree', path: '/ignored' })
    const promptsRoot = join(fixture.area.base, 'store', 'worktree-prompts')
    const file = sidecarPath(promptsRoot, primaryKey(fixture.main))
    // Valid rows, a broken UI-only field: this must stay readable.
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.snooze = { mode: 'soon', keys: 'not-a-list', at: 42 }
    writeFileSync(file, JSON.stringify(raw))
    await first.dispose()
    stacks.splice(stacks.indexOf(first), 1)
    const second = await open(fixture)
    const read = await second.registry.worktreeSidecar(fixture.main, { op: 'read' })
    expect(read).toMatchObject({ available: true })
    expect(read.snooze).toBeUndefined()
    expect(read.ignored).toHaveLength(1)
    expect(read.worktreeRoots).toHaveLength(1)
  })

  it('clears the snooze on reset together with the ignores, without a second revision', async () => {
    const fixture = await setup('snooze-reset')
    const stack = await open(fixture)
    await stack.registry.worktreeSidecar(fixture.main, { op: 'ignore', key: 'worktree\u0000/ignored', kind: 'worktree', path: '/ignored' })
    const snoozed = await stack.registry.worktreeSidecar(fixture.main, { op: 'snooze', snooze: record() })
    const reset = await stack.registry.worktreeSidecar(fixture.main, { op: 'reset' })
    expect(reset.ignored).toEqual([])
    expect(reset.snooze).toBeUndefined()
    expect(reset.revision).toBe(snoozed.revision + 1)
    // Nothing left to clear is not a write.
    const again = await stack.registry.worktreeSidecar(fixture.main, { op: 'reset' })
    expect(again.revision).toBe(reset.revision)
    const file = readSidecarFile(join(fixture.area.base, 'store', 'worktree-prompts'), primaryKey(fixture.main))
    expect(file!.snooze).toBeUndefined()
  })

  it('clears a snooze that has no ignores and persists the cleared document', async () => {
    const fixture = await setup('snooze-reset-only')
    const stack = await open(fixture)
    const snoozed = await stack.registry.worktreeSidecar(fixture.main, { op: 'snooze', snooze: record('until') })
    expect(snoozed.snooze).toBeDefined()
    const reset = await stack.registry.worktreeSidecar(fixture.main, { op: 'reset' })
    expect(reset.ignored).toEqual([])
    expect(reset.snooze).toBeUndefined()
    expect(reset.revision).toBe(snoozed.revision + 1)
    // A snooze-only reset must reach the file: a restarted owner reading the
    // same store must not restore the cleared delay.
    await stack.dispose()
    stacks.splice(stacks.indexOf(stack), 1)
    const second = await open(fixture)
    const reread = await second.registry.worktreeSidecar(fixture.main, { op: 'read' })
    expect(reread.snooze).toBeUndefined()
    expect(reread.revision).toBe(reset.revision)
    // Nothing left to clear is not a write.
    const again = await second.registry.worktreeSidecar(fixture.main, { op: 'reset' })
    expect(again.revision).toBe(reset.revision)
  })

  it('refuses the write while the worktree gate is off, the workspace is inactive, or the authority is unavailable', async () => {
    const fixture = await setup('snooze-refusals')
    const stack = await open(fixture)
    const snooze = record()
    const promptsRoot = join(fixture.area.base, 'store', 'worktree-prompts')
    stack.registry.setWorktreeGateProvider(() => false)
    await expect(stack.registry.worktreeSidecar(fixture.main, { op: 'snooze', snooze }))
      .rejects.toMatchObject({ code: 'worktree/not-enabled' })
    expect(readSidecarFile(promptsRoot, primaryKey(fixture.main))).toBeUndefined()
    stack.registry.setWorktreeGateProvider(() => true)
    // A directory that is not a checkout has no active workspace to snooze for.
    const plain = join(fixture.area.base, 'plain')
    mkdirSync(plain, { recursive: true })
    await expect(stack.registry.worktreeSidecar(plain, { op: 'snooze', snooze }))
      .rejects.toMatchObject({ code: 'worktree/inactive' })
    const unresolvable = await open(fixture, { sharedStorageRoot: '' })
    await expect(unresolvable.registry.worktreeSidecar(fixture.main, { op: 'snooze', snooze }))
      .rejects.toMatchObject({ code: 'worktree/registry-unavailable' })
  })
})

describe('deferred workspace forget', () => {
  it('has no forget endpoint or command verb in this release', async () => {
    const { parseFoldersCommand } = await import('../src/command.ts')
    expect(() => parseFoldersCommand('forget-workspace')).toThrow()
    const contract = await import('../src/contract.ts')
    expect(contract.PANEL_ENDPOINTS).not.toContain('workspaceForget')
    expect(contract.WORKTREE_ENDPOINTS).not.toContain('workspaceForget')
  })
})
