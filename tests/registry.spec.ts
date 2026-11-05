/**
 * The registry service over a REAL storage stack: the JSON backend, the domain
 * form, the scope service, and the registry, assembled the way a profile
 * assembles them.
 *
 * A restart is a second context over the same store root, which is the only
 * way to prove the durability claim the M3 journey rests on: roots survive a
 * process, and a registration whose directory vanished is withheld rather than
 * handed to the kernel dialects.
 */

import { renameSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMAIN_NAME, MAX_ALIAS_LENGTH } from '../src/registry.ts'
import { entryRootRef, primaryKey, RootValidationError } from '../src/roots.ts'
import { mountRegistryStack, type RegistryStack, type RegistryStackOptions } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let storeRoot: string
let storeFile: string
let primary: string
let stacks: RegistryStack[] = []

/**
 * The `path` values one primary root's records hold, read back from the store.
 *
 * Read as JSON rather than matched as text: a Windows path is written with
 * escaped separators, so a substring test asks about the JSON encoding instead of
 * about what the registry stored.
 */
function storedPaths(root: string = primary): string[] {
  const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
    tables: { roots: Record<string, { roots: { path: string }[] } | undefined> }
  }
  return (document.tables.roots[primaryKey(root)]?.roots ?? []).map(entry => entry.path)
}

/** Create a sibling directory usable as an additional root. */
function makeRoot(name: string): string {
  const path = join(fixture.base, name)
  mkdirSync(path, { recursive: true })
  return canonicalPath(path)
}

/** Mount the shared stack over this test's private store root. */
async function mount(config: { maxAdditionalRoots?: number } = {}, options: RegistryStackOptions = {}): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot, config, options)
  stacks.push(stack)
  return stack
}

/** Dispose every stack this test created, newest first. */
async function disposeAll(): Promise<void> {
  const pending = stacks
  stacks = []
  for (const stack of pending.reverse()) await stack.dispose()
}

beforeEach(() => {
  fixture = createFixtureWorkspace('registry')
  storeRoot = join(fixture.base, 'storages')
  storeFile = join(storeRoot, `${DOMAIN_NAME}.json`)
  mkdirSync(storeRoot)
  primary = canonicalPath(fixture.workspace)
})

afterEach(async () => {
  await disposeAll()
  fixture.dispose()
})

describe('registration lifecycle', () => {
  it('rejects Windows network/device candidates before revive matching can resolve them', async () => {
    const { registry } = await mount()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const realpath = vi.spyOn(realpathSync, 'native')
    try {
      for (const path of ['//server/share', '\\\\server\\share', '//?/C:/x', '//./pipe/x']) {
        await expect(registry.add(primary, { path })).rejects.toMatchObject({ code: 'unsupported-path' })
        expect(realpath.mock.calls.some(([candidate]) => String(candidate) === path)).toBe(false)
      }
      expect(registry.list(primary)).toEqual([])
    } finally {
      realpath.mockRestore()
      platform.mockRestore()
    }
  })

  it('grants a newly registered root, persists it, and reports it available', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')

    const statuses = await registry.add(primary, { path: extra })

    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.path).toBe(extra)
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(registry.granted(primary)).toEqual([extra])
    expect(storedPaths()).toEqual([extra])
  })

  it('keeps registry order and reorders on move', async () => {
    const { registry, scope } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    const third = makeRoot('third')

    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })
    await registry.add(primary, { path: third })
    expect(registry.granted(primary)).toEqual([first, second, third])

    // Move the last one in front of the first (what the panel's ↑ action does).
    await registry.move(primary, { kind: 'ordinal', ordinal: 3 }, { kind: 'ordinal', ordinal: 1 })
    expect(registry.granted(primary)).toEqual([third, first, second])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([third, first, second])
    expect(storedPaths()).toEqual([third, first, second])

    await disposeAll()
    const restarted = await mount()
    expect(restarted.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([third, first, second])

    // No anchor moves it to the end.
    await restarted.registry.move(primary, { kind: 'ordinal', ordinal: 1 })
    expect(restarted.registry.granted(primary)).toEqual([first, second, third])
    expect(restarted.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([first, second, third])
    expect(storedPaths()).toEqual([first, second, third])
  })

  it('sets and clears a display alias without touching the path', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    const aliased = await registry.setAlias(primary, { kind: 'path', path: extra }, '  payments  ')
    expect(aliased[0]?.alias).toBe('payments')
    expect(aliased[0]?.path).toBe(extra)

    const cleared = await registry.setAlias(primary, { kind: 'id', id: aliased[0]!.id }, '   ')
    expect(cleared[0]?.alias).toBeUndefined()
    expect(cleared[0]?.path).toBe(extra)
  })

  it('rejects an alias the panel could not render safely', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    await expect(registry.setAlias(primary, { kind: 'path', path: extra }, 'a\nb')).rejects.toThrow(RootValidationError)
    await expect(registry.setAlias(primary, { kind: 'path', path: extra }, 'x'.repeat(MAX_ALIAS_LENGTH + 1)))
      .rejects.toThrow(RootValidationError)
  })

  it('revokes the grant when a root is removed, and keeps an empty root list after the last one', async () => {
    const { registry, scope } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })

    const afterFirst = await registry.remove(primary, { kind: 'path', path: first })
    expect(afterFirst.map(status => status.path)).toEqual([second])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([second])

    const empty = await registry.remove(primary, { kind: 'id', id: afterFirst[0]!.id })
    expect(empty).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    expect(storedPaths()).toEqual([])
  })

  it('refuses a duplicate, the primary root itself, a nested root, and a relative path', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    const inner = makeRoot('extra/inner')
    const inside = makeRoot(join('ws', 'inside-the-workspace'))
    const notADirectory = join(fixture.base, 'a-file')
    writeFileSync(notADirectory, 'not a directory')
    await registry.add(primary, { path: extra })

    const codeOf = async (path: string): Promise<string> => {
      try {
        await registry.add(primary, { path })
      } catch (error: unknown) {
        return error instanceof RootValidationError ? error.code : 'other'
      }
      return 'accepted'
    }

    expect(await codeOf(extra)).toBe('duplicate')
    expect(await codeOf(primary)).toBe('equals-primary')
    expect(await codeOf(inner)).toBe('nested')
    // fixture.base CONTAINS the store's lease directory (`storages/`), so the
    // protected-directory rule — judged before the primary-root rules —
    // refuses it before the primary-overlap question is ever reached.
    expect(await codeOf(fixture.base)).toBe('protected-path')
    // The primary root takes part in the overlap rule on its own: a child of the
    // workspace root is refused even before anything is registered.
    expect(await codeOf(join(primary, 'not-created'))).toBe('missing')
    expect(await codeOf(inside)).toBe('primary-overlap')
    expect(await codeOf('relative/path')).toBe('not-absolute')
    expect(await codeOf(join(fixture.base, 'missing'))).toBe('missing')
    expect(await codeOf(notADirectory)).toBe('not-a-directory')
  })

  it('notifies observers after each durable change', async () => {
    const { registry } = await mount()
    const seen: string[] = []
    const dispose = registry.onChange(root => { seen.push(root) })
    const extra = makeRoot('extra')

    await registry.add(primary, { path: extra })
    await registry.remove(primary, { kind: 'path', path: extra })
    dispose()
    await registry.add(primary, { path: extra })

    expect(seen).toEqual([primaryKey(primary), primaryKey(primary)])
  })
})

describe('durability across a restart', () => {
  it('restores the registered roots, their order, and their aliases', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    const other = makeRoot('other')
    await first.registry.add(primary, { path: extra, alias: 'payments' })
    await first.registry.add(primary, { path: other })
    const originalId = first.registry.list(primary)[0]?.id
    await disposeAll()

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.path)).toEqual([extra, other])
    expect(statuses.map(status => status.state)).toEqual(['available', 'available'])
    expect(statuses[0]?.alias).toBe('payments')
    expect(statuses[0]?.id).toBe(originalId)
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra, other])
  })

  it('withholds a registration whose directory is gone, and restores it on recheck', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    rmSync(extra, { recursive: true, force: true })

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.state).toBe('missing')
    expect(status?.detail).toBeDefined()
    expect(second.registry.granted(primary)).toEqual([])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    mkdirSync(extra)
    const rechecked = await second.registry.recheck(primary)
    expect(rechecked[0]?.state).toBe('available')
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
  })

  it('re-registering a withheld root revives it instead of reporting a duplicate', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    rmSync(extra, { recursive: true, force: true })

    const second = await mount()
    expect(second.registry.list(primary)[0]?.state).toBe('missing')

    mkdirSync(extra)
    const revived = await second.registry.add(primary, { path: extra, alias: 'back' })
    expect(revived).toHaveLength(1)
    expect(revived[0]?.state).toBe('available')
    expect(revived[0]?.alias).toBe('back')
    expect(second.registry.granted(primary)).toEqual([canonicalPath(extra)])
  })
})

describe('concurrent operations', () => {
  it('keeps every root of two adds that overlap in time', async () => {
    // Both reads used to start from the same snapshot, so the later write
    // dropped the earlier registration even though both calls reported success.
    const { registry, scope } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')

    const [firstResult, secondResult] = await Promise.all([
      registry.add(primary, { path: first }),
      registry.add(primary, { path: second }),
    ])

    expect(firstResult).toHaveLength(1)
    expect(secondResult).toHaveLength(2)
    expect(registry.granted(primary)).toEqual([first, second])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([first, second])
    const stored = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { path: string }[] }> }
    }
    expect(stored.tables.roots[primaryKey(primary)]?.roots.map(entry => entry.path)).toEqual([first, second])
  })

  it('does not resurrect a root that a concurrent removal deleted', async () => {
    const { registry, scope } = await mount()
    const doomed = makeRoot('doomed')
    const fresh = makeRoot('fresh')
    await registry.add(primary, { path: doomed })
    const [target] = registry.list(primary)

    await Promise.all([
      registry.remove(primary, { kind: 'id', id: target!.id }),
      registry.add(primary, { path: fresh }),
    ])

    expect(registry.list(primary).map(status => status.path)).toEqual([fresh])
    expect(registry.granted(primary)).toEqual([fresh])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([fresh])
    expect(storedPaths()).toEqual([fresh])
  })

  it('applies a burst of concurrent mutations in order, losing none of them', async () => {
    const { registry } = await mount()
    const roots = ['one', 'two', 'three', 'four'].map(name => makeRoot(name))

    await Promise.all(roots.map(path => registry.add(primary, { path })))

    expect(registry.granted(primary)).toEqual(roots)
  })

  it('keeps serving after an operation in the queue fails', async () => {
    const { registry } = await mount()
    const good = makeRoot('good')
    const notADirectory = join(fixture.base, 'a-file')
    writeFileSync(notADirectory, 'not a directory')

    const failed = registry.add(primary, { path: notADirectory })
    const added = registry.add(primary, { path: good })
    await expect(failed).rejects.toThrow(RootValidationError)

    expect((await added).map(status => status.path)).toEqual([good])
  })
})

describe('revalidation without a restart', () => {
  it('withholds a root whose directory disappeared, and grants it again when it comes back', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    rmSync(extra, { recursive: true, force: true })
    const gone = await registry.refresh(primary)
    expect(gone[0]?.state).toBe('missing')
    expect(registry.granted(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    mkdirSync(extra)
    const back = await registry.refresh(primary)
    expect(back[0]?.state).toBe('available')
    expect(registry.granted(primary)).toEqual([canonicalPath(extra)])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(extra)])
  })

  it('never rewrites the store on a read-path refresh', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    const before = readFileSync(storeFile, 'utf8')
    const stamp = statSync(storeFile).mtimeMs

    await registry.refresh(primary)
    await registry.refresh(primary)

    expect(readFileSync(storeFile, 'utf8')).toBe(before)
    expect(statSync(storeFile).mtimeMs).toBe(stamp)
  })

  it('withholds a root whose directory was replaced, then restores it the same way', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry, scope } = await mount()
    const granted = makeRoot('granted')
    const elsewhere = makeRoot('elsewhere')
    await registry.add(primary, { path: granted })

    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)
    const replaced = await registry.refresh(primary)
    expect(replaced[0]?.state).toBe('redirected')
    expect(registry.granted(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    // The dangerous outcome would be the OTHER directory showing up here.
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).not.toContain(canonicalPath(elsewhere))

    unlinkSync(granted)
    mkdirSync(granted)
    const restored = await registry.refresh(primary)
    expect(restored[0]?.state).toBe('available')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(granted)])
  })

  it('refuses re-registering a path that now resolves elsewhere — revive never changes the target', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry, scope } = await mount()
    const granted = makeRoot('granted')
    const elsewhere = makeRoot('elsewhere')
    await registry.add(primary, { path: granted })
    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)
    expect((await registry.refresh(primary))[0]?.state).toBe('redirected')
    const before = readFileSync(storeFile, 'utf8')

    // Re-resolving is not re-authorizing: the re-add names the moved record
    // but the grant may not follow it to `elsewhere`. The refusal changes
    // nothing — one redirected record, the store byte-identical.
    await expect(registry.add(primary, { path: granted })).rejects.toMatchObject({ code: 'revive-target-changed' })
    expect(readFileSync(storeFile, 'utf8')).toBe(before)
    expect(registry.list(primary)).toHaveLength(1)
    expect(registry.list(primary)[0]?.state).toBe('redirected')
    expect(registry.granted(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
  })

  it('judges a moved grant from the fresh classification, not the stale cache', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry, scope } = await mount()
    const granted = makeRoot('granted')
    const elsewhere = makeRoot('elsewhere')
    await registry.add(primary, { path: granted })
    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)
    // No refresh in between: the cache still reports `available`. Judging
    // from that stale state would admit a plain add and write a SECOND
    // record for the same path; the fresh re-classification the mutation
    // just performed sees `redirected`, matches the one record — and refuses
    // the revive because the target moved.
    await expect(registry.add(primary, { path: granted })).rejects.toMatchObject({ code: 'revive-target-changed' })
    expect(registry.list(primary)).toHaveLength(1)
    expect(storedPaths()).toEqual([granted])
    expect(registry.granted(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
  })

  it('tells observers only when the effective grant changed', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    const seen: string[] = []
    registry.onChange(root => { seen.push(root) })
    await registry.add(primary, { path: extra })
    await registry.refresh(primary)
    await registry.refresh(primary)
    rmSync(extra, { recursive: true, force: true })
    await registry.refresh(primary)

    // One change per real transition: registration, disappearance.
    expect(seen).toEqual([primaryKey(primary), primaryKey(primary)])
  })
})

describe('a store with records that cannot be told apart', () => {
  /** Rewrite the store so two records claim the same id. */
  const writeDuplicateIds = (): { id: string; first: string; second: string } => {
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; recordedPath: string; addedAt: string }[] }> }
    }
    const record = document.tables.roots[primaryKey(primary)]!
    const [entry] = record.roots
    const second = canonicalPath(join(fixture.base, 'twinned'))
    record.roots.push({ ...entry!, path: second, recordedPath: second })
    writeFileSync(storeFile, JSON.stringify(document))
    return { id: entry!.id, first: entry!.path, second }
  }

  it('reports every record of a duplicated id as invalid and grants none of them', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    makeRoot('twinned')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    const { id, first: firstPath, second } = writeDuplicateIds()

    const second_ = await mount()
    const statuses = second_.registry.list(primary)
    expect(statuses.map(status => status.state)).toEqual(['invalid', 'invalid'])
    expect(statuses.map(status => status.id)).toEqual([id, id])
    expect(second_.registry.granted(primary)).toEqual([])
    expect(second_.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    // Alias and move address one exact row as well; neither may fan out by id
    // or make sorting double as implicit data cleanup.
    const aliased = await second_.registry.setAlias(primary, entryRootRef(statuses[1]!, 2), 'twin')
    expect(aliased.map(status => status.alias)).toEqual([undefined, 'twin'])
    const moved = await second_.registry.move(
      primary,
      entryRootRef(aliased[1]!, 2),
      entryRootRef(aliased[0]!, 1),
    )
    expect(moved).toHaveLength(2)
    expect(moved.map(status => status.path)).toEqual([second, firstPath])

    // One record at a time: a removal by id would have taken both.
    const afterOne = await second_.registry.removeAt(primary, { kind: 'ordinal', ordinal: 1 })
    expect(afterOne).toHaveLength(1)
    expect(afterOne[0]?.path).toBe(firstPath)
    const afterTwo = await second_.registry.removeAt(primary, { kind: 'path', path: firstPath })
    expect(afterTwo).toEqual([])
    expect(afterTwo.map(status => status.path)).not.toContain(second)
  })

  it('reports a record that predates the granted-directory field as invalid', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    for (const entry of document.tables.roots[primaryKey(primary)]!.roots) delete entry.recordedPath
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.state).toBe('invalid')
    expect(status?.detail).toBeDefined()
    expect(second.registry.granted(primary)).toEqual([])
    // It is NOT deleted for the operator: it stays until they remove it.
    expect(second.registry.list(primary)).toHaveLength(1)
    expect(await second.registry.removeAt(primary, { kind: 'ordinal', ordinal: 1 })).toEqual([])
  })

  it('preserves a legacy missing field through an unrelated write and restart', async () => {
    const first = await mount()
    const legacy = makeRoot('legacy')
    await first.registry.add(primary, { path: legacy })
    await disposeAll()
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    delete document.tables.roots[primaryKey(primary)]!.roots[0]!.recordedPath
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const healthy = makeRoot('healthy')
    const afterAdd = await second.registry.add(primary, { path: healthy })
    expect(afterAdd.map(status => status.state)).toEqual(['invalid', 'available'])
    await disposeAll()

    const third = await mount()
    expect(third.registry.unavailable).toBeUndefined()
    expect(third.registry.list(primary).map(status => status.state)).toEqual(['invalid', 'available'])
    expect(third.registry.granted(primary)).toEqual([healthy])
  })
})

describe('fresh classification inside every mutation', () => {
  it('rejects an add that only passed because a restored root was still cached as missing', async () => {
    const { registry, scope } = await mount()
    const outer = makeRoot('outer')
    await registry.add(primary, { path: outer })
    rmSync(outer, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    // The directory came back, with a child inside it. A mutation must judge
    // against THAT state, not the cached `missing`: the child is nested under
    // the restored root, so the add is refused and nothing is written.
    mkdirSync(join(outer, 'inner'), { recursive: true })
    const inner = canonicalPath(join(outer, 'inner'))
    await expect(registry.add(primary, { path: inner })).rejects.toMatchObject({ code: 'nested' })
    expect(storedPaths()).toEqual([outer])
    expect(registry.list(primary)[0]?.state).toBe('available')
    expect(registry.granted(primary)).toEqual([outer])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([outer])
  })

  it('judges a nested add against the restored root even while the cache still says missing', async () => {
    const { registry, scope } = await mount()
    const outer = makeRoot('outer')
    await registry.add(primary, { path: outer })
    rmSync(outer, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    // Only the child is recreated (with its parent), so the stored root is
    // usable again the moment the mutation runs — no refresh in between.
    const inner = canonicalPath(join(outer, 'inner'))
    mkdirSync(inner, { recursive: true })
    await expect(registry.add(primary, { path: inner })).rejects.toMatchObject({ code: 'nested' })
    expect(storedPaths()).toEqual([outer])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([outer])
  })

  it('revives a redirected registration against the fresh resolution when the original directory is back', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry, scope } = await mount()
    const granted = makeRoot('granted')
    const elsewhere = makeRoot('elsewhere')
    await registry.add(primary, { path: granted })

    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)
    expect((await registry.refresh(primary))[0]?.state).toBe('redirected')

    // The original directory is back, but no refresh ran: the mutation itself
    // must re-resolve and re-record against what is there NOW.
    unlinkSync(granted)
    mkdirSync(granted)
    const statuses = await registry.add(primary, { path: granted })
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.path).toBe(canonicalPath(granted))
    expect(registry.granted(primary)).toEqual([canonicalPath(granted)])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([canonicalPath(granted)])
  })

  it('publishes the restored grant exactly once when an alias lands on a root that came back', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    rmSync(extra, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    let publications = 0
    const unsubscribe = scope.subscribe(() => { publications += 1 })
    mkdirSync(extra)
    const statuses = await registry.setAlias(primary, { kind: 'path', path: extra }, 'back')
    unsubscribe()

    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.alias).toBe('back')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(publications).toBe(1)
  })

  it('publishes changed root order once but stays silent for alias, refresh and a no-op move', async () => {
    const { registry, scope } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })

    let publications = 0
    const unsubscribe = scope.subscribe(() => { publications += 1 })
    await registry.setAlias(primary, { kind: 'ordinal', ordinal: 1 }, 'one')
    await registry.refresh(primary)
    await registry.move(primary, { kind: 'ordinal', ordinal: 2 })
    expect(publications).toBe(0)
    await registry.move(primary, { kind: 'ordinal', ordinal: 2 }, { kind: 'ordinal', ordinal: 1 })
    expect(publications).toBe(1)
    await registry.refresh(primary)
    await registry.move(primary, { kind: 'ordinal', ordinal: 2 })
    unsubscribe()

    expect(publications).toBe(1)
    expect(registry.granted(primary)).toEqual([second, first])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([second, first])
  })

  it('serializes a concurrent add/remove/alias/move burst with no lost write', async () => {
    const { registry } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    const third = makeRoot('third')
    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })

    await Promise.all([
      registry.add(primary, { path: third }),
      registry.setAlias(primary, { kind: 'ordinal', ordinal: 1 }, 'alpha'),
      registry.move(primary, { kind: 'path', path: third }, { kind: 'ordinal', ordinal: 1 }),
      registry.remove(primary, { kind: 'path', path: second }),
    ])

    const statuses = registry.list(primary)
    expect(statuses.map(status => status.path)).toEqual([third, first])
    expect(statuses[1]?.alias).toBe('alpha')
    expect(storedPaths()).toEqual([third, first])
  })

  it('leaves the scope equal to the persisted state when the durable write fails', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    const doomed = makeRoot('doomed')

    const internal = registry as unknown as {
      table: { put: (key: string, value: unknown) => Promise<void> }
    }
    const table = internal.table
    const realPut = table.put.bind(table)
    table.put = async () => { throw new Error('disk full') }
    await expect(registry.add(primary, { path: doomed })).rejects.toThrow('disk full')
    table.put = realPut

    // Memory and disk agree: the failed mutation wrote nothing and granted
    // nothing beyond what the store still holds.
    expect(storedPaths()).toEqual([extra])
    expect(registry.list(primary).map(status => status.path)).toEqual([extra])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])

    // The queue is not poisoned: a later mutation proceeds normally.
    expect(await registry.remove(primary, { kind: 'path', path: extra })).toEqual([])
  })
})

describe('lease authority', () => {
  it('mounts a second Host as a follower whose mutations reach the owner', async () => {
    await mount()
    const second = await mount()
    // Shared mode (the only mode now): a second mount is a follower — its
    // mutations travel to the owner over IPC instead of being refused.
    expect(second.registry.authority.kind).toBe('follower')

    const extra = makeRoot('extra')
    const statuses = await second.registry.add(primary, { path: extra })
    expect(statuses[0]?.state).toBe('available')
    expect(storedPaths()).toEqual([extra])
  })

  it('takes over through refresh after the holder exits, then mutates normally', async () => {
    const first = await mount()
    const second = await mount()
    expect(second.registry.authority.kind).toBe('follower')

    await first.dispose()
    stacks = stacks.filter(stack => stack !== first)
    const extra = makeRoot('extra')

    await second.registry.refresh(primary)
    expect(second.registry.authority.kind).toBe('active')
    const statuses = await second.registry.add(primary, { path: extra })
    expect(statuses[0]?.state).toBe('available')
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
  })
})

describe('the additional-root limit', () => {
  it('refuses a NEW registration at the limit and leaves the store unchanged', async () => {
    const { registry } = await mount({ maxAdditionalRoots: 1 })
    const first = makeRoot('first')
    const second = makeRoot('second')
    await registry.add(primary, { path: first })

    await expect(registry.add(primary, { path: second })).rejects.toMatchObject({
      code: 'root-limit-reached',
      detail: { reference: '1' },
    })
    expect(storedPaths()).toEqual([first])
    expect(registry.list(primary)).toHaveLength(1)
    expect(registry.limit).toBe(1)
    expect(registry.overLimit(primary)).toBe(false)
  })

  it('accepts exactly the configured number of roots and refuses one more', async () => {
    const { registry } = await mount({ maxAdditionalRoots: 2 })
    const roots = ['first', 'second'].map(name => makeRoot(name))
    for (const path of roots) await registry.add(primary, { path })

    expect(registry.granted(primary)).toEqual(roots)
    await expect(registry.add(primary, { path: makeRoot('third') })).rejects.toMatchObject({
      code: 'root-limit-reached',
    })
    expect(storedPaths()).toEqual(roots)
  })

  it('lets a withheld record revive past the limit, because it is not a new record', async () => {
    const { registry } = await mount({ maxAdditionalRoots: 1 })
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    rmSync(extra, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    mkdirSync(extra)
    const revived = await registry.add(primary, { path: extra })
    expect(revived).toHaveLength(1)
    expect(revived[0]?.state).toBe('available')
  })

  it.each([0, -3, 1.5, 65, null])('fails closed on the invalid limit %s and grants nothing', async (bad) => {
    const { registry, scope } = await mount({ maxAdditionalRoots: bad as number })
    const extra = makeRoot('extra')

    expect(registry.authority.kind).toBe('config-invalid')
    expect(registry.unavailable).toContain('maxAdditionalRoots')
    expect(registry.unavailable).toContain(String(bad))
    expect(registry.list(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    await expect(registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'config-invalid' })
    await expect(registry.removeAt(primary, { kind: 'ordinal', ordinal: 1 })).rejects.toMatchObject({ code: 'config-invalid' })
    // The domain was never opened, so the store file may not exist at all.
    expect(existsSync(storeFile) ? storedPaths() : []).toEqual([])
  })

  it('keeps a historical over-limit store fully classified and granted, refusing only new adds', async () => {
    const first = await mount({ maxAdditionalRoots: 64 })
    const roots = Array.from({ length: 20 }, (_unused, index) => makeRoot(`r${index}`))
    for (const path of roots) await first.registry.add(primary, { path })
    await first.dispose()
    stacks = stacks.filter(stack => stack !== first)

    const second = await mount({ maxAdditionalRoots: 16 })
    expect(second.registry.limit).toBe(16)
    expect(second.registry.overLimit(primary)).toBe(true)
    const statuses = second.registry.list(primary)
    expect(statuses).toHaveLength(20)
    expect(statuses.every(status => status.state === 'available')).toBe(true)
    expect(second.registry.granted(primary)).toHaveLength(20)
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toHaveLength(20)

    await expect(second.registry.add(primary, { path: makeRoot('fresh') })).rejects.toMatchObject({
      code: 'root-limit-reached',
    })
    expect(storedPaths()).toHaveLength(20)

    // Removal still works and the count drops.
    const after = await second.registry.removeAt(primary, { kind: 'ordinal', ordinal: 1 })
    expect(after).toHaveLength(19)
    expect(storedPaths()).toHaveLength(19)
  })
})

describe('store that this build cannot read', () => {
  it('reports an unusable record as invalid and never grants it', async () => {
    const first = await mount()
    const outer = makeRoot('outer')
    const inner = makeRoot('outer/inner')
    await first.registry.add(primary, { path: outer })
    await disposeAll()

    // Rewrite the stored record so the second entry is nested inside the first.
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; addedAt: string }[] }> }
    }
    const record = document.tables.roots[primaryKey(primary)]!
    record.roots.push({ id: 'hand-written', path: inner, addedAt: '2026-09-12T00:00:00.000Z' })
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
    expect(statuses[1]?.path).toBe(inner)
    expect(second.registry.granted(primary)).toEqual([outer])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([outer])
  })

  it('degrades to an empty root set instead of failing activation when the store is corrupt', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    writeFileSync(storeFile, '{ this is not the document this build writes')

    const second = await mount()
    expect(second.registry.list(primary)).toEqual([])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    expect(second.registry.unavailable).toContain('multi_root_workspace')
    await expect(second.registry.add(primary, { path: extra })).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
  })
})

describe('per-root access', () => {
  /** Read the raw persisted records of the test primary root. */
  const storedRecords = (): Record<string, unknown>[] => {
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] } | undefined> }
    }
    return document.tables.roots[primaryKey(primary)]?.roots ?? []
  }

  it('reads a legacy record — recordedPath only — as the inherit grant it now means', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    const [status] = registry.list(primary)
    expect(status?.access).toBe('inherit')
    expect(storedRecords()).toEqual([expect.objectContaining({ recordedPath: extra })])
    expect(storedRecords()[0]).not.toHaveProperty('readOnlyRecordedPath')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([extra])
  })

  it('round-trips a read-only registration as readOnlyRecordedPath, never recordedPath', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    const statuses = await first.registry.add(primary, { path: extra, access: 'read-only' })
    expect(statuses[0]?.access).toBe('read-only')
    // A read-only root stays a workspace member but leaves the writable set.
    expect(first.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(first.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
    expect(storedRecords()).toEqual([expect.objectContaining({ readOnlyRecordedPath: extra })])
    expect(storedRecords()[0]).not.toHaveProperty('recordedPath')
    await disposeAll()

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.access).toBe('read-only')
    expect(status?.state).toBe('available')
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
  })

  it('round-trips a fixed read-write registration as readWriteRecordedPath, never recordedPath', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    const statuses = await first.registry.add(primary, { path: extra, access: 'read-write' })
    expect(statuses[0]?.access).toBe('read-write')
    expect(storedRecords()).toEqual([expect.objectContaining({ readWriteRecordedPath: extra })])
    // The fixed grant must never write `recordedPath`: an older plugin would
    // read that legacy field and grant it as the session-following write.
    expect(storedRecords()[0]).not.toHaveProperty('recordedPath')
    expect(storedRecords()[0]).not.toHaveProperty('readOnlyRecordedPath')
    await disposeAll()

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.access).toBe('read-write')
    expect(status?.state).toBe('available')
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([extra])
  })

  it('reports a record carrying more than one grant field as invalid (ambiguous access)', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    document.tables.roots[primaryKey(primary)]!.roots[0]!.readOnlyRecordedPath = extra
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.state).toBe('invalid')
    expect(status?.detail).toContain('ambiguous access')
    // The ambiguity grants neither level: no member, nothing writable.
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
  })

  it('cannot be escalated by a downgrade: the old schema reads a read-only record as ungrantable', async () => {
    // The persisted shape a pre-access plugin version parsed: zod strips the
    // unknown `readOnlyRecordedPath` key, leaving NO `recordedPath` — which the
    // old classification reports `invalid` (exactly the "missing recordedPath"
    // rule the suite above already pins). Replicated here against a new-format
    // record so the property is pinned on the real wire bytes.
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra, access: 'read-only' })
    const [record] = storedRecords()

    const { z } = await import('zod')
    const oldPersistedRoot = z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      recordedPath: z.string().min(1).optional(),
      alias: z.string().optional(),
      addedAt: z.string().min(1),
    })
    const parsed = oldPersistedRoot.parse(record)
    // What the old build sees: no granted directory recorded, hence invalid,
    // hence nothing granted — never a read-write root.
    expect(parsed.recordedPath).toBeUndefined()
    expect(parsed).not.toHaveProperty('readOnlyRecordedPath')
  })

  it('cannot be escalated by a downgrade: a fixed read-write record is ungrantable to every older schema', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra, access: 'read-write' })
    const [record] = storedRecords()

    const { z } = await import('zod')
    // The pre-access schema (only `recordedPath` existed) …
    const oldestPersistedRoot = z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      recordedPath: z.string().min(1).optional(),
      alias: z.string().optional(),
      addedAt: z.string().min(1),
    })
    // … and the two-level schema (`readOnlyRecordedPath` added) both strip the
    // unknown grant field and find NO `recordedPath`: invalid, never granted.
    const twoLevelPersistedRoot = z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      recordedPath: z.string().min(1).optional(),
      readOnlyRecordedPath: z.string().min(1).optional(),
      alias: z.string().optional(),
      addedAt: z.string().min(1),
    })
    for (const schema of [oldestPersistedRoot, twoLevelPersistedRoot]) {
      const parsed = schema.parse(record)
      expect(parsed.recordedPath).toBeUndefined()
      expect(parsed).not.toHaveProperty('readWriteRecordedPath')
    }
  })

  it('upgrades and downgrades access without re-recording the grant', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    const ro = await registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'read-only')
    expect(ro[0]?.access).toBe('read-only')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
    // Not re-recorded: the granted directory moved fields, verbatim.
    expect(storedRecords()[0]).toMatchObject({ readOnlyRecordedPath: extra })
    expect(storedRecords()[0]).not.toHaveProperty('recordedPath')

    const rw = await registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'read-write')
    expect(rw[0]?.access).toBe('read-write')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([extra])
    expect(storedRecords()[0]).toMatchObject({ readWriteRecordedPath: extra })
    expect(storedRecords()[0]).not.toHaveProperty('recordedPath')
    expect(storedRecords()[0]).not.toHaveProperty('readOnlyRecordedPath')
  })

  it('refuses to upgrade a withheld root, but always allows a downgrade', async () => {
    const { registry } = await mount()
    const restricted = makeRoot('restricted')
    const writable = makeRoot('writable')
    await registry.add(primary, { path: restricted, access: 'read-only' })
    await registry.add(primary, { path: writable })
    rmSync(restricted, { recursive: true, force: true })
    rmSync(writable, { recursive: true, force: true })

    // Upgrading requires the FRESH classification to grant the root: a record
    // that is `missing` (or any withheld state) cannot be made writable.
    await expect(registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'read-write'))
      .rejects.toMatchObject({ code: 'root-unavailable' })
    // `inherit` can widen authority too (Full-access and workspace-write), so
    // it is gated the same way; only `read-only` is always allowed.
    await expect(registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'inherit'))
      .rejects.toMatchObject({ code: 'root-unavailable' })
    // Downgrading is always allowed, even for a withheld root.
    const downgraded = await registry.setAccess(primary, { kind: 'ordinal', ordinal: 2 }, 'read-only')
    expect(downgraded[1]?.access).toBe('read-only')
    expect(downgraded[1]?.state).toBe('missing')
  })

  it('republishes when access changes and stays silent when only metadata does', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    let publications = 0
    const unsubscribe = scope.subscribe(() => { publications += 1 })

    await registry.setAlias(primary, { kind: 'ordinal', ordinal: 1 }, 'renamed')
    expect(publications, 'alias must not republish an unchanged grant').toBe(0)

    await registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'read-only')
    expect(publications, 'an access change IS a grant change').toBe(1)

    // Setting the same access again is a no-op and must not republish either.
    await registry.setAccess(primary, { kind: 'ordinal', ordinal: 1 }, 'read-only')
    expect(publications).toBe(1)
    unsubscribe()
  })

  it('persists the negative boundary across refresh and restart of a missing read-only registration', async () => {
    const extra = makeRoot('missing-readonly')
    const first = await mount()
    await first.registry.add(primary, { path: extra, access: 'read-only' })
    rmSync(extra, { recursive: true })
    await first.registry.refresh(primary)
    const policy = { mode: 'danger-full-access' as const, workspaceRoot: primary }
    expect(first.scope.snapshot(policy).additionalRoots).toEqual([])
    expect(first.scope.snapshot(policy).deniedRoots).toEqual([extra])
    await disposeAll()
    const second = await mount()
    expect(second.scope.snapshot(policy).deniedRoots).toEqual([extra])
    await second.registry.removeAt(primary, entryRootRef(second.registry.list(primary)[0]!, 1))
    expect(second.scope.snapshot(policy).deniedRoots).toEqual([])
  })

  it('keeps the existing access on revive, and honors an explicit one', async () => {
    const { registry } = await mount()
    const granted = makeRoot('granted')
    await registry.add(primary, { path: granted, access: 'read-only' })
    rmSync(granted, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    // Same target: the revive restores the record AND keeps read-only.
    mkdirSync(granted)
    const revived = await registry.add(primary, { path: granted })
    expect(revived).toHaveLength(1)
    expect(revived[0]?.state).toBe('available')
    expect(revived[0]?.access).toBe('read-only')
    expect(storedRecords()[0]).toMatchObject({ readOnlyRecordedPath: canonicalPath(granted) })

    // Withhold the record again, then re-add WITH an explicit access: the
    // revive is also the operator naming a new grant level — on the SAME
    // target, never on a moved one.
    rmSync(granted, { recursive: true, force: true })
    await registry.refresh(primary)
    mkdirSync(granted)
    const upgraded = await registry.add(primary, { path: granted, access: 'read-write' })
    expect(upgraded).toHaveLength(1)
    expect(upgraded[0]?.access).toBe('read-write')
    expect(storedRecords()[0]).toMatchObject({ readWriteRecordedPath: canonicalPath(granted) })
    expect(storedRecords()[0]).not.toHaveProperty('recordedPath')
    expect(storedRecords()[0]).not.toHaveProperty('readOnlyRecordedPath')
  })

  it('leaves access alone on alias and move', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    const other = makeRoot('other')
    await registry.add(primary, { path: extra, access: 'read-only' })
    await registry.add(primary, { path: other })

    await registry.setAlias(primary, { kind: 'ordinal', ordinal: 1 }, 'docs')
    await registry.move(primary, { kind: 'ordinal', ordinal: 2 }, { kind: 'ordinal', ordinal: 1 })
    const statuses = registry.list(primary)
    expect(statuses.map(status => status.access)).toEqual(['inherit', 'read-only'])
    expect(statuses[1]?.alias).toBe('docs')
  })
})

describe('a withheld root still reserves its recorded boundary', () => {
  it('refuses to register the parent of a missing read-only root — and lets the exact row revive', async () => {
    const { registry } = await mount()
    const denied = makeRoot('cage/denied')
    await registry.add(primary, { path: denied, access: 'read-only' })
    rmSync(denied, { recursive: true, force: true })
    expect((await registry.refresh(primary))[0]?.state).toBe('missing')

    // The withheld record's recorded boundary still reserves its tree: a
    // covering parent would grant writes through the very path the operator
    // marked read-only — refused as `nested`, the same refusal as for an
    // available one.
    const cage = canonicalPath(join(fixture.base, 'cage'))
    await expect(registry.add(primary, { path: cage })).rejects.toMatchObject({ code: 'nested' })
    expect(storedPaths()).toEqual([denied])

    // The reservation is by ROW, not by path: re-creating and re-adding the
    // exact directory is the revive the exemption exists for, and it keeps
    // the recorded access.
    mkdirSync(denied, { recursive: true })
    const revived = await registry.add(primary, { path: denied })
    expect(revived).toHaveLength(1)
    expect(revived[0]?.state).toBe('available')
    expect(revived[0]?.access).toBe('read-only')
  })

  it('reserves the recorded boundary of a redirected registration, never its current resolution', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry } = await mount()
    const group = makeRoot('group')
    const cage = makeRoot('group/cage')
    const elsewhere = makeRoot('elsewhere')
    await registry.add(primary, { path: cage, access: 'read-only' })

    rmSync(cage, { recursive: true, force: true })
    symlinkSync(elsewhere, cage)
    expect((await registry.refresh(primary))[0]?.state).toBe('redirected')

    // The reserved boundary is the RECORDED grant: a candidate containing it
    // is refused even though `cage` currently resolves elsewhere.
    await expect(registry.add(primary, { path: group })).rejects.toMatchObject({ code: 'nested' })
    expect(storedPaths()).toEqual([cage])

    // The mirror image: a candidate under where `cage` NOW resolves is an
    // ordinary add — its canonical form never touches the reserved boundary,
    // because the boundary is never re-resolved.
    const inner = makeRoot('elsewhere/inner')
    const accepted = await registry.add(primary, { path: join(cage, 'inner') })
    expect(accepted).toHaveLength(2)
    expect(accepted[1]?.path).toBe(canonicalPath(inner))
  })

  it('exempts only the exact revived row — a twin boundary still refuses the re-add', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()

    // A store may carry TWO records for one boundary: both classify as a
    // membership conflict and both keep their reservation.
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    const entry = document.tables.roots[primaryKey(primary)]!.roots[0]!
    document.tables.roots[primaryKey(primary)]!.roots.push({ ...entry, id: 'twin' })
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.state)).toEqual(['invalid', 'invalid'])
    expect(statuses.every(status => status.invalidReason === 'membership-conflict')).toBe(true)
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])

    // Re-adding the path revives only the FIRST matching row: the twin's
    // reservation survives, so the add is refused and the pair must be
    // repaired by removal — never by silently healing into one grant.
    await expect(second.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'duplicate' })
    expect(second.registry.list(primary)).toHaveLength(2)
    const after = await second.registry.removeAt(primary, { kind: 'ordinal', ordinal: 2 })
    expect(after[0]?.state).toBe('available')
    expect(after[0]?.invalidReason).toBeUndefined()
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
  })
})

describe('a legacy overlapping store (membership-conflict)', () => {
  /**
   * Persist the state the pre-fix registry could produce — a read-only child
   * went missing and a covering fixed read-write parent was then admitted
   * against the available-only overlap check — by seeding the parent record
   * into the store document between two mounts.
   */
  async function seedOverlap(order: 'child-first' | 'parent-first'): Promise<{ cage: string; denied: string }> {
    const first = await mount()
    const cage = makeRoot('cage')
    const denied = makeRoot('cage/denied')
    await first.registry.add(primary, { path: denied, access: 'read-only' })
    await disposeAll()
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    const parent = { id: 'legacy-parent', path: cage, readWriteRecordedPath: cage, addedAt: '2026-09-12T00:00:00.000Z' }
    const roots = document.tables.roots[primaryKey(primary)]!.roots
    if (order === 'parent-first') roots.unshift(parent)
    else roots.push(parent)
    writeFileSync(storeFile, JSON.stringify(document))
    return { cage, denied }
  }

  /** Both records are `membership-conflict` invalid — regardless of order. */
  const expectConflicted = (statuses: readonly { state: string; invalidReason?: string; detail?: string }[]): void => {
    expect(statuses.map(status => status.state)).toEqual(['invalid', 'invalid'])
    expect(statuses.every(status => status.invalidReason === 'membership-conflict')).toBe(true)
    expect(statuses.every(status => status.detail?.includes('overlaps') === true)).toBe(true)
    expect(statuses.every(status => status.detail?.includes('remains in force') === true)).toBe(true)
  }

  for (const order of ['child-first', 'parent-first'] as const) {
    it(`withholds both sides and keeps the read-only boundary denied (${order})`, async () => {
      const { denied } = await seedOverlap(order)
      const stack = await mount()

      expectConflicted(stack.registry.list(primary))
      // Neither membership is granted; the read-only boundary still denies
      // under every mode, including Full-access.
      expect(stack.registry.granted(primary)).toEqual([])
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
      expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).writableRoots).toEqual([])
      for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
        expect(stack.scope.snapshot({ mode, workspaceRoot: primary }).deniedRoots, mode).toEqual([denied])
      }
    })
  }

  it('keeps the pair withheld through move, alias, refresh and a restart', async () => {
    const { cage, denied } = await seedOverlap('child-first')
    const stack = await mount()

    // A cosmetic move must never decide which side of the overlap is granted:
    // BOTH directions keep both records unusable, and the deny survives each.
    expectConflicted(await stack.registry.move(primary, { kind: 'ordinal', ordinal: 2 }, { kind: 'ordinal', ordinal: 1 }))
    expectConflicted(await stack.registry.move(primary, { kind: 'ordinal', ordinal: 1 }))
    await stack.registry.setAlias(primary, { kind: 'ordinal', ordinal: 2 }, 'still-conflicted')
    expectConflicted(await stack.registry.refresh(primary))

    // The reserved boundaries still block new registrations in BOTH
    // containment directions — inside the child's tree and on the parent's
    // own boundary. They also block a REVIVE of either side: the exemption is
    // by row index only, so the still-standing twin boundary keeps refusing.
    const deeper = makeRoot('cage/denied/deeper')
    await expect(stack.registry.add(primary, { path: deeper })).rejects.toMatchObject({ code: 'nested' })
    await expect(stack.registry.add(primary, { path: cage })).rejects.toMatchObject({ code: 'nested' })
    await expect(stack.registry.add(primary, { path: denied })).rejects.toMatchObject({ code: 'nested' })
    expect(storedPaths()).toEqual([denied, cage])

    await disposeAll()
    const reopened = await mount()
    expectConflicted(reopened.registry.list(primary))
    expect(reopened.scope.snapshot({ mode: 'danger-full-access', workspaceRoot: primary }).deniedRoots)
      .toEqual([denied])
  })

  it('keeps a record that claims two grants out of the conflict — and out of the deny set', async () => {
    const first = await mount()
    const healthy = makeRoot('healthy')
    await first.registry.add(primary, { path: healthy })
    await disposeAll()

    // A corrupt record that declares two access levels at once AND overlaps
    // the healthy root: it can state no trustworthy boundary, so it neither
    // conflicts with the healthy root nor denies through it.
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    const inner = canonicalPath(join(healthy, 'inner'))
    document.tables.roots[primaryKey(primary)]!.roots.push({
      id: 'corrupt', path: inner, recordedPath: inner, readOnlyRecordedPath: inner,
      addedAt: '2026-09-12T00:00:00.000Z',
    })
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
    expect(statuses[1]?.invalidReason).toBeUndefined()
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([healthy])
    expect(second.scope.snapshot({ mode: 'danger-full-access', workspaceRoot: primary }).deniedRoots).toEqual([])
  })
})

describe('revive never changes the grant target (F2)', () => {
  /** The raw persisted records of the test primary root. */
  const records = (): Record<string, unknown>[] => {
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] } | undefined> }
    }
    return document.tables.roots[primaryKey(primary)]?.roots ?? []
  }

  it('refuses a redirected revive at every grant encoding, leaving store bytes and grant fields untouched', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry } = await mount()
    for (const [access, field] of [
      ['inherit', 'recordedPath'],
      ['read-only', 'readOnlyRecordedPath'],
      ['read-write', 'readWriteRecordedPath'],
    ] as const) {
      const granted = makeRoot(`g-${access}`)
      const elsewhere = makeRoot(`e-${access}`)
      await registry.add(primary, { path: granted, access })
      rmSync(granted, { recursive: true, force: true })
      symlinkSync(elsewhere, granted)
      const before = readFileSync(storeFile, 'utf8')

      await expect(registry.add(primary, { path: granted })).rejects.toMatchObject({ code: 'revive-target-changed' })
      expect(readFileSync(storeFile, 'utf8')).toBe(before)
      expect(records().find(record => record.path === granted)?.[field]).toBe(granted)
      expect(registry.list(primary).find(status => status.path === granted)?.state).toBe('redirected')
    }
  })

  it('refuses a redirected revive even when the new target is a protected directory', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const { registry } = await mount({}, { scopeConfig: { dshHome: home } })
    const granted = makeRoot('granted')
    await registry.add(primary, { path: granted })
    rmSync(granted, { recursive: true, force: true })
    symlinkSync(home, granted)

    // F2 fires first: the record's target moved, so the re-add is refused as
    // a changed target — before the protected-directory verdict the new
    // target would also earn.
    await expect(registry.add(primary, { path: granted })).rejects.toMatchObject({ code: 'revive-target-changed' })
    expect(registry.list(primary)[0]?.state).toBe('redirected')
  })

  it('refuses a revive a corrupt record cannot name one grant for', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    // A record declaring two grant fields at once classifies invalid — and a
    // re-add matching it must refuse rather than heal it into a real grant.
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: Record<string, unknown>[] }> }
    }
    document.tables.roots[primaryKey(primary)]!.roots[0]!.readOnlyRecordedPath = extra
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    expect(second.registry.list(primary)[0]?.state).toBe('invalid')
    const before = readFileSync(storeFile, 'utf8')
    await expect(second.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'revive-target-changed' })
    expect(readFileSync(storeFile, 'utf8')).toBe(before)
    expect(second.registry.list(primary)).toHaveLength(1)
  })
})

describe('the protected DSH directories (F4)', () => {
  /** A directory the scope row would report as `$DSH_HOME`. */
  const dshHome = (): string => join(fixture.base, 'dsh-home')

  it('refuses the home, a descendant, and an ancestor at every access level, leaving the store untouched', async () => {
    const home = dshHome()
    mkdirSync(join(home, 'inner'), { recursive: true })
    const { registry } = await mount({}, { scopeConfig: { dshHome: home } })
    for (const access of ['inherit', 'read-only', 'read-write'] as const) {
      for (const path of [home, join(home, 'inner'), fixture.base]) {
        await expect(registry.add(primary, { path, access })).rejects.toMatchObject({ code: 'protected-path' })
      }
    }
    expect(existsSync(storeFile) ? storedPaths() : []).toEqual([])
  })

  it('still accepts an ordinary sibling of the home', async () => {
    const home = dshHome()
    mkdirSync(home)
    const { registry, scope } = await mount({}, { scopeConfig: { dshHome: home } })
    const extra = makeRoot('extra')
    const statuses = await registry.add(primary, { path: extra })
    expect(statuses[0]?.state).toBe('available')
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra])
  })

  it('refuses the lease/medium directory and any directory containing it, outside the home too', async () => {
    const home = dshHome()
    mkdirSync(home)
    const { registry } = await mount({}, { scopeConfig: { dshHome: home } })
    // storeRoot hosts the JSON document and the lease; it sits OUTSIDE the
    // configured home and is still protected as `registry-lease`.
    await expect(registry.add(primary, { path: storeRoot })).rejects.toMatchObject({ code: 'protected-path' })
    await expect(registry.add(primary, { path: fixture.base })).rejects.toMatchObject({ code: 'protected-path' })
  })

  it('refuses the realpath target of a storages symlink that leaves the home', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const home = dshHome()
    mkdirSync(home)
    const real = join(fixture.base, 'real-storages')
    const link = join(fixture.base, 'linked-storages')
    mkdirSync(real)
    symlinkSync(real, link)
    // The JSON document and the lease land at the real target through the link.
    const stack = await mountRegistryStack(link, {}, { scopeConfig: { dshHome: home } })
    stacks.push(stack)
    await expect(stack.registry.add(primary, { path: real })).rejects.toMatchObject({ code: 'protected-path' })
    await expect(stack.registry.add(primary, { path: link })).rejects.toMatchObject({ code: 'protected-path' })
    const inside = join(real, 'inner')
    mkdirSync(inside, { recursive: true })
    await expect(stack.registry.add(primary, { path: inside })).rejects.toMatchObject({ code: 'protected-path' })
  })

  it('withholds a stored record inside the home and keeps its deny boundary, without deleting it', async () => {
    const home = dshHome()
    const inside = join(home, 'registered')
    mkdirSync(inside, { recursive: true })
    // The record predates the boundary: it was registered while no home was
    // configured, so the store may legitimately hold it.
    const first = await mount()
    await first.registry.add(primary, { path: inside, access: 'read-only' })
    await disposeAll()

    const second = await mount({}, { scopeConfig: { dshHome: home } })
    const [status] = second.registry.list(primary)
    expect(status?.state).toBe('invalid')
    expect(status?.invalidReason).toBe('protected-path')
    // Still in the store — withheld, never deleted, never re-granted — and
    // the recorded read-only restriction stays in force.
    expect(storedPaths()).toEqual([canonicalPath(inside)])
    const denied = second.scope.snapshot({ mode: 'danger-full-access', workspaceRoot: primary }).deniedRoots
    expect(denied).toContain(canonicalPath(inside))
    expect(denied).toContain(canonicalPath(home))
    // A re-add names the same record: the grant is untouched, and the
    // protected-directory verdict refuses the revive outright.
    await expect(second.registry.add(primary, { path: inside })).rejects.toMatchObject({ code: 'protected-path' })
  })

  it('refuses every new grant while the home boundary cannot be proven', async () => {
    const extra = makeRoot('extra')
    // An invalid dshHome config proves no boundary.
    const invalid = await mount({}, { scopeConfig: { dshHome: 'relative/home' } })
    await expect(invalid.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'protected-boundary-unknown' })
    await invalid.dispose()
    stacks = stacks.filter(stack => stack !== invalid)
    // A configured home that is not a directory right now proves none either.
    const missing = await mount({}, { scopeConfig: { dshHome: join(fixture.base, 'gone-home') } })
    await expect(missing.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'protected-boundary-unknown' })
  })

  it('keeps the pinned home boundary after the home spelling is retargeted', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const realHome = join(fixture.base, 'real-home')
    const link = join(fixture.base, 'home-link')
    mkdirSync(realHome)
    symlinkSync(realHome, link)
    const { registry } = await mount({}, { scopeConfig: { dshHome: link } })
    // The first computation pins the canonical the home spelling resolved to.
    await registry.add(primary, { path: makeRoot('extra') })
    // Retarget the spelling: a different directory answers for it now.
    const other = join(fixture.base, 'other-home')
    mkdirSync(other)
    unlinkSync(link)
    symlinkSync(other, link)
    // The PINNED boundary still refuses the original canonical target, and
    // the current canonical refuses the new one.
    await expect(registry.add(primary, { path: realHome })).rejects.toMatchObject({ code: 'protected-path' })
    await expect(registry.add(primary, { path: other })).rejects.toMatchObject({ code: 'protected-path' })
  })
})

describe('the upstream primary spelling (F3/MRW-01)', () => {
  it('fails closed config-invalid without sharedStorageRoot', async () => {
    const stack = await mountRegistryStack(storeRoot, { sharedStorageRoot: '' })
    stacks.push(stack)
    expect(stack.registry.authority).toMatchObject({ kind: 'config-invalid' })
    expect(stack.registry.unavailable).toContain('sharedStorageRoot')
    await expect(stack.registry.add(primary, { path: makeRoot('extra') })).rejects.toMatchObject({ code: 'config-invalid' })
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).authority).toBe('unavailable')
  })

  it('keeps the deny of a read-only root a retargeted primary now covers', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const home = join(fixture.base, 'dsh-home'); mkdirSync(home)
    const { registry, scope } = await mount({}, { scopeConfig: { dshHome: home } })
    const denied = makeRoot('denied')
    await registry.add(primary, { path: denied, access: 'read-only' })

    // Swap the workspace: the spelling now resolves to a directory that
    // CONTAINS the recorded grant.
    const renamed = join(fixture.base, 'ws-renamed')
    renameSync(primary, renamed)
    // fixture.workspace was a real dir; the spelling now resolves to a
    // directory that CONTAINS the recorded grant — the boundary must not vanish.
    symlinkSync(fixture.base, primary)
    const statuses = await registry.refresh(primary)
    expect(statuses[0]?.invalidReason).toBe('primary-overlap')
    expect(statuses[0]?.state).toBe('invalid')
    const deniedRoots = scope.snapshot({ mode: 'danger-full-access', workspaceRoot: primary }).deniedRoots
    expect(deniedRoots).toContain(canonicalPath(denied))
    expect(deniedRoots).toContain(canonicalPath(home))
  })

  it('keeps a read-only grant denied when the primary retargets onto an unrelated directory', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry, scope } = await mount()
    const denied = makeRoot('denied')
    await registry.add(primary, { path: denied, access: 'read-only' })
    const renamed = join(fixture.base, 'ws-renamed')
    const empty = join(fixture.base, 'ws-empty')
    mkdirSync(empty)
    renameSync(primary, renamed)
    symlinkSync(empty, primary)
    const statuses = await registry.refresh(primary)
    // The grant still resolves — the record stays available — yet its
    // recorded read-only restriction must outlive the primary retarget.
    expect(statuses[0]?.state).toBe('available')
    const deniedRoots = scope.snapshot({ mode: 'danger-full-access', workspaceRoot: primary }).deniedRoots
    expect(deniedRoots).toContain(canonicalPath(denied))
  })

  it('treats a symlinked workspace and its realpath as distinct primaries', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const { registry } = await mount()
    const extra = makeRoot('extra')
    const real = join(fixture.base, 'ws-real')
    mkdirSync(real)
    const spelling = join(fixture.base, 'ws-link')
    symlinkSync(real, spelling)
    await registry.add(spelling, { path: extra })
    expect(registry.list(spelling)).toHaveLength(1)
    expect(registry.list(real)).toEqual([])
    expect(registry.list(spelling)[0]?.state).toBe('available')
  })

  it('migrates a canonical-keyed store forward on first serialized access', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const first = await mount()
    const real = join(fixture.base, 'ws-real')
    mkdirSync(real)
    const spelling = join(fixture.base, 'ws-link')
    symlinkSync(real, spelling)
    // Seed as the legacy writer did: the record under the CANONICAL key.
    const extra = makeRoot('extra')
    // `real` is canonical: `add(real)` lands under the same key a legacy
    // writer produced for the symlinked cwd — `canonicalPath(spelling)`.
    await first.registry.add(real, { path: extra })
    await disposeAll()
    // v0.1.14 wrote the exact `canonicalPath()` spelling — not case-folded —
    // so re-key the seed to that legacy format (a no-op off Windows).
    const legacyKey = canonicalPath(real)
    const seeded = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, unknown> }
    }
    const record = seeded.tables.roots[primaryKey(real)]
    delete seeded.tables.roots[primaryKey(real)]
    seeded.tables.roots[legacyKey] = record
    writeFileSync(storeFile, JSON.stringify(seeded))

    const second = await mount()
    expect(second.registry.list(spelling)).toHaveLength(1)
    await second.registry.refresh(spelling)
    const after = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: unknown[] }> }
    }
    expect(Object.keys(after.tables.roots).sort()).toEqual([legacyKey, primaryKey(spelling)].sort())
    expect(after.tables.roots[primaryKey(spelling)]).toEqual(after.tables.roots[legacyKey])
  })

  it('keeps a migrated primary empty after its last root is removed, including after restart', async (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const real = makeRoot('ws-real'), spelling = join(fixture.base, 'ws-link')
    symlinkSync(real, spelling)
    const extra = makeRoot('extra'), first = await mount()
    await first.registry.add(real, { path: extra })
    await disposeAll()
    // Seed the exact canonical spelling used by the legacy writer, including
    // its case on Windows. The old entry must remain usable by that primary.
    const legacyKey = canonicalPath(real)
    const seeded = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, unknown> }
    }
    const record = seeded.tables.roots[primaryKey(real)]
    delete seeded.tables.roots[primaryKey(real)]
    seeded.tables.roots[legacyKey] = record
    writeFileSync(storeFile, JSON.stringify(seeded))

    const second = await mount()
    // Operation admission itself may be the first serialized migration.
    const policy = { mode: 'workspace-write' as const, workspaceRoot: spelling }
    await second.registry.withOperation(policy, 'fs-write', operation => {
      expect(operation.scope.writableRoots).toContain(extra)
    })
    expect(await second.registry.remove(spelling, { kind: 'path', path: extra })).toEqual([])
    expect(await second.registry.refresh(spelling)).toEqual([])
    await second.registry.withOperation(policy, 'process', operation => {
      expect(operation.scope.additionalRoots).toEqual([])
      expect(operation.scope.writableRoots).not.toContain(extra)
    })
    const cleared = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, unknown> }
    }
    expect(cleared.tables.roots[primaryKey(spelling)]).toEqual({ roots: [] })
    expect(cleared.tables.roots[legacyKey]).toEqual(record)
    await disposeAll()

    const third = await mount()
    expect(await third.registry.refresh(spelling)).toEqual([])
    await third.registry.withOperation(policy, 'fs-write', operation => {
      expect(operation.scope.writableRoots).not.toContain(extra)
    })
    // Clearing the symlink spelling does not revoke the realpath primary.
    expect(await third.registry.refresh(real)).toHaveLength(1)
    expect(third.registry.granted(real)).toEqual([extra])
  })
})
