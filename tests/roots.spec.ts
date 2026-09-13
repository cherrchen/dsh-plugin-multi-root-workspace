/**
 * The root validation rules, exercised directly.
 *
 * These are the rules every write AND every startup re-read passes through, so
 * each one is pinned on its own: the code an operator sees, the canonical
 * spelling that gets stored, and the two "this grants nothing new" cases that
 * M3 rejects on purpose (equal to the primary root, nested either way).
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  expandRootInput,
  indexedStatuses,
  isCanonicallyUnder,
  removeStatusAt,
  entryRootRef,
  resolveRootRef,
  RootValidationError,
  validateRootCandidate,
  type RegisteredRoot,
} from '../src/roots.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let primary: string
let sibling: string
let nested: string
let alias: string
/** Why the symlink cases cannot run here, when the host refuses directory links. */
let symlinkReason: string | undefined

beforeAll(() => {
  fixture = createFixtureWorkspace('roots')
  primary = canonicalPath(fixture.workspace)
  sibling = join(fixture.base, 'extra')
  nested = join(sibling, 'inner')
  alias = join(fixture.base, 'alias')
  mkdirSync(sibling)
  mkdirSync(nested)
  writeFileSync(join(fixture.base, 'a-file'), 'not a directory')
  // Windows refuses a directory symlink without Developer Mode or elevation: the
  // alias cases then skip with the reason instead of failing for a privilege this
  // suite cannot grant itself.
  symlinkReason = symlinkUnsupportedReason()
  if (symlinkReason === undefined) symlinkSync(sibling, alias)
})

afterAll(() => { fixture.dispose() })

/** Run one candidate against the primary root and the given existing roots. */
function check(raw: string, existing: readonly string[] = [], home?: string): string {
  return home === undefined
    ? validateRootCandidate(raw, { primaryRoot: primary, existing })
    : validateRootCandidate(raw, { primaryRoot: primary, existing, home })
}

/** Capture the failure code of one candidate. */
function codeOf(raw: string, existing: readonly string[] = [], home?: string): string {
  try {
    check(raw, existing, home)
  } catch (error: unknown) {
    if (error instanceof RootValidationError) return error.code
    throw error
  }
  return 'accepted'
}

describe('expandRootInput', () => {
  it('expands a bare tilde and a tilde-prefixed path against the given home', () => {
    const home = join(sep, 'home', 'op')
    expect(expandRootInput('~', home)).toBe(home)
    expect(expandRootInput('~/projects', home)).toBe(join(home, 'projects'))
  })

  it('leaves every other spelling untouched, so validation can reject it', () => {
    expect(expandRootInput('  relative/dir  ')).toBe('relative/dir')
    expect(expandRootInput('./here')).toBe('./here')
    expect(expandRootInput('~other/dir')).toBe('~other/dir')
  })

  it('defaults to the process home directory', () => {
    expect(expandRootInput('~')).toBe(homedir())
  })
})

describe('isCanonicallyUnder', () => {
  it('accepts the root itself and its descendants, and nothing spelled alike', () => {
    // Platform separators: the predicate is lexical, so a POSIX literal would ask
    // the wrong question on Windows (where `/a/b/c` is not under `/a/b`).
    const root = ['', 'a', 'b'].join(sep)
    expect(isCanonicallyUnder(root, root)).toBe(true)
    expect(isCanonicallyUnder(join(root, 'c'), root)).toBe(true)
    expect(isCanonicallyUnder(`${root}c`, root)).toBe(false)
    expect(isCanonicallyUnder(['', 'a'].join(sep), root)).toBe(false)
  })
})

describe('validateRootCandidate', () => {
  it('canonicalizes an accepted candidate', () => {
    expect(check(sibling)).toBe(canonicalPath(sibling))
  })

  it('expands `~` against a home directory and accepts it', () => {
    // Run against a home that is plainly a sibling of the fixture. On a CI runner
    // the real home IS an ancestor of the checkout, where the primary-overlap rule
    // correctly refuses the whole home tree — that is the case below, and mixing
    // the two would make this assertion depend on where the runner keeps $HOME.
    const expandedHome = join(fixture.outside, 'home')
    mkdirSync(expandedHome, { recursive: true })
    expect(check('~', [], expandedHome)).toBe(canonicalPath(expandedHome))
  })

  it('rejects a home directory that contains the workspace, with the overlap rule', () => {
    // The other side of the same coin, and the reason the case above takes a home
    // of its own: on a runner whose home holds the checkout, `~` overlaps the
    // primary root and is refused — as a configuration, not as a path bug.
    const ancestor = join(primary, 'ancestor-home')
    mkdirSync(ancestor, { recursive: true })
    expect(() => check('~', [], fixture.base)).toThrow(RootValidationError)
    expect(codeOf(primary, [])).toBe('equals-primary')
    expect(codeOf(ancestor, [])).toBe('primary-overlap')
  })

  it('resolves a spelling with `..` to the same canonical root', () => {
    expect(check(join(sibling, 'inner', '..'))).toBe(canonicalPath(sibling))
  })

  it('rejects a relative path as not-absolute', () => {
    expect(codeOf('relative/dir')).toBe('not-absolute')
    expect(codeOf('./relative')).toBe('not-absolute')
  })

  it('rejects an empty input as not-absolute', () => {
    expect(codeOf('   ')).toBe('not-absolute')
  })

  it('rejects a missing directory', () => {
    expect(codeOf(join(fixture.base, 'nope'))).toBe('missing')
  })

  it('rejects a file', () => {
    expect(codeOf(join(fixture.base, 'a-file'))).toBe('not-a-directory')
  })

  it('rejects the primary root itself', () => {
    expect(codeOf(primary)).toBe('equals-primary')
    expect(codeOf(join(primary, '.'))).toBe('equals-primary')
  })

  it('rejects a candidate that canonicalizes onto an already registered root', () => {
    expect(codeOf(sibling, [sibling])).toBe('duplicate')
    expect(codeOf(join(sibling, 'inner', '..'), [sibling])).toBe('duplicate')
  })

  it('rejects a candidate nested under a registered root', () => {
    expect(codeOf(nested, [sibling])).toBe('nested')
  })

  it('rejects a candidate that contains a registered root', () => {
    // A parent of the workspace root overlaps the primary root first, which is
    // the same refusal for a sharper reason; the pure additional-root case is
    // covered below with a sibling that does not contain the primary root.
    expect(codeOf(fixture.base, [sibling])).toBe('primary-overlap')
    expect(codeOf(join(fixture.base, 'parent'), [canonicalPath(join(fixture.base, 'parent/child'))])).toBe('missing')
  })

  it('rejects a candidate inside the primary root, even with nothing registered', () => {
    // The primary root takes part in the overlap rule like any other root: a
    // child of it adds no writable range. Checking it only against `existing`
    // used to let this through on an empty registration list.
    const sub = join(primary, 'sub')
    mkdirSync(sub)
    expect(codeOf(sub, [])).toBe('primary-overlap')
    expect(codeOf(sub, [sibling])).toBe('primary-overlap')
  })

  it('rejects a candidate that contains the primary root, even with nothing registered', () => {
    expect(codeOf(fixture.base, [])).toBe('primary-overlap')
  })

  it('keeps equals-primary distinct from primary-overlap', () => {
    expect(codeOf(primary)).toBe('equals-primary')
    expect(codeOf(join(primary, '.'))).toBe('equals-primary')
  })

  it('names the primary root in the primary-overlap detail', () => {
    const sub = join(primary, 'sub')
    mkdirSync(sub, { recursive: true })
    try {
      check(sub)
      expect.unreachable('a child of the primary root must be rejected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RootValidationError)
      expect((error as RootValidationError).code).toBe('primary-overlap')
      expect((error as RootValidationError).detail?.conflict).toBe(primary)
    }
  })

  it('still reports a nested additional root as nested, not as a primary overlap', () => {
    const outer = join(fixture.base, 'outer')
    const inner = join(outer, 'inner')
    mkdirSync(inner, { recursive: true })
    expect(codeOf(inner, [outer])).toBe('nested')
    expect(codeOf(outer, [inner])).toBe('nested')
  })

  it('names the conflicting root in the failure detail', () => {
    try {
      check(nested, [sibling])
      expect.unreachable('nested candidate must be rejected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RootValidationError)
      expect((error as RootValidationError).detail?.conflict).toBe(canonicalPath(sibling))
    }
  })

  it('treats a symlink alias as the same root', (context) => {
    if (symlinkReason !== undefined) context.skip(symlinkReason)
    expect(codeOf(alias, [canonicalPath(sibling)])).toBe('duplicate')
    expect(check(alias)).toBe(canonicalPath(sibling))
  })
})

describe('classifyStoredRoots', () => {
  /** One stored record: `path` as spelled, `recordedPath` as granted. */
  const stored = (path: string, id = path, recordedPath = path): RegisteredRoot => ({
    id: additionalRootId(id),
    path,
    recordedPath,
    addedAt: '2026-09-12T00:00:00.000Z',
  })

  it('marks an existing root available and keeps registry order', () => {
    const statuses = classifyStoredRoots(primary, [stored(sibling), stored(nested, 'n2')])
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
    expect(statuses[0]?.path).toBe(canonicalPath(sibling))
    expect(availableRoots(statuses)).toEqual([canonicalPath(sibling)])
  })

  it('keeps a registration whose directory vanished, as missing rather than invalid', () => {
    const gone = join(fixture.base, 'vanished')
    const statuses = classifyStoredRoots(primary, [stored(gone)])
    expect(statuses[0]?.state).toBe('missing')
    expect(statuses[0]?.path).toBe(gone)
    expect(availableRoots(statuses)).toEqual([])
  })

  it('flags a record equal to the primary root as invalid', () => {
    expect(classifyStoredRoots(primary, [stored(primary)])[0]?.state).toBe('invalid')
  })

  it('flags the second of two equal records as invalid (first one wins)', () => {
    const statuses = classifyStoredRoots(primary, [stored(sibling), stored(join(sibling, '.'), 'other')])
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
  })

  it('flags overlapping records in either direction as invalid', () => {
    const outerFirst = classifyStoredRoots(primary, [stored(sibling), stored(nested, 'n2')])
    expect(outerFirst[1]?.state).toBe('invalid')
    const innerFirst = classifyStoredRoots(primary, [stored(nested), stored(sibling, 'n2')])
    expect(innerFirst[1]?.state).toBe('invalid')
  })

  it('flags a relative stored path as invalid', () => {
    expect(classifyStoredRoots(primary, [stored('relative/dir')])[0]?.state).toBe('invalid')
  })

  it('flags a record with no usable identity as invalid', () => {
    expect(classifyStoredRoots(primary, [{ ...stored(sibling), id: additionalRootId('') }])[0]?.state).toBe('invalid')
  })

  it('canonicalizes a stored symlink spelling that was granted as that symlink', (context) => {
    if (symlinkReason !== undefined) context.skip(symlinkReason)
    // The operator registered the alias itself: the recorded directory IS the
    // resolved one, so the record is granted under its canonical spelling.
    const statuses = classifyStoredRoots(primary, [stored(alias, 'alias', canonicalPath(sibling))])
    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.path).toBe(canonicalPath(sibling))
  })

  it('flags a record whose path now resolves elsewhere as redirected, not granted', () => {
    // Granted for `nested` but now resolving to its parent `sibling`: the
    // directory that would be handed to the providers is not the one the
    // record was granted for, so it is withheld and reported.
    const statuses = classifyStoredRoots(primary, [stored(sibling, 'moved', nested)])
    expect(statuses[0]?.state).toBe('redirected')
    expect(statuses[0]?.detail).toContain(canonicalPath(sibling))
    expect(availableRoots(statuses)).toEqual([])
  })

  it('grants a record that is spelled through a symlink but resolves to its recorded directory', (context) => {
    if (symlinkReason !== undefined) context.skip(symlinkReason)
    // The alias resolves to `sibling`, which is the directory this record was
    // granted for. Authorization follows the resolved directory, so the
    // spelling does not matter here.
    const statuses = classifyStoredRoots(primary, [stored(alias, 'alias', canonicalPath(sibling))])
    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.path).toBe(canonicalPath(sibling))
  })

  it('flags a record that does not say what it was granted for as invalid', () => {
    expect(classifyStoredRoots(primary, [stored(sibling, 'legacy', '')])[0]?.state).toBe('invalid')
  })

  it('flags every record of a duplicated id as invalid, and grants none of them', () => {
    const statuses = classifyStoredRoots(primary, [
      stored(sibling, 'shared'),
      stored(join(fixture.base, 'gone'), 'shared'),
    ])
    expect(statuses.map(status => status.state)).toEqual(['invalid', 'invalid'])
    expect(statuses[0]?.detail).toBeDefined()
    expect(availableRoots(statuses)).toEqual([])
  })

  it('flags a record nested under the primary root as invalid', () => {
    const inside = join(primary, 'inside')
    mkdirSync(inside, { recursive: true })
    expect(classifyStoredRoots(primary, [stored(inside)])[0]?.state).toBe('invalid')
  })

  it('flags a record containing the primary root as invalid', () => {
    expect(classifyStoredRoots(primary, [stored(fixture.base)])[0]?.state).toBe('invalid')
  })
})

describe('resolveRootRef', () => {
  /** Built per test: the fixture tree only exists once `beforeAll` has run. */
  const statusesOf = (): ReturnType<typeof classifyStoredRoots> => classifyStoredRoots(primary, [
    { id: additionalRootId('a'), path: sibling, recordedPath: sibling, addedAt: '2026-09-12T00:00:00.000Z' },
    {
      id: additionalRootId('b'),
      path: join(fixture.base, 'gone'),
      recordedPath: join(fixture.base, 'gone'),
      addedAt: '2026-09-12T00:00:00.000Z',
    },
  ])

  it('resolves by id, ordinal, and path spelling', () => {
    const statuses = statusesOf()
    expect(resolveRootRef(statuses, { kind: 'id', id: 'a' }).id).toBe('a')
    expect(resolveRootRef(statuses, { kind: 'ordinal', ordinal: 2 }).id).toBe('b')
    expect(resolveRootRef(statuses, { kind: 'path', path: sibling }).id).toBe('a')
    expect(resolveRootRef(statuses, { kind: 'path', path: join(sibling, '.') }).id).toBe('a')
  })

  it('rejects an out-of-range ordinal and an unknown id', () => {
    const statuses = statusesOf()
    expect(() => resolveRootRef(statuses, { kind: 'ordinal', ordinal: 0 })).toThrow(RootValidationError)
    expect(() => resolveRootRef(statuses, { kind: 'ordinal', ordinal: 3 })).toThrow(RootValidationError)
    expect(() => resolveRootRef(statuses, { kind: 'id', id: 'zzz' })).toThrow(RootValidationError)
  })

  it('reports not-found as the code the surfaces localize', () => {
    try {
      resolveRootRef(statusesOf(), { kind: 'path', path: join(fixture.base, 'other') })
      expect.unreachable('unknown path must not resolve')
    } catch (error: unknown) {
      expect((error as RootValidationError).code).toBe('not-found')
    }
  })
})

describe('indexedStatuses and removeStatusAt', () => {
  /** Two records that share one id — the case a removal by id cannot address. */
  const duplicateId = (): ReturnType<typeof classifyStoredRoots> => classifyStoredRoots(primary, [
    { id: additionalRootId('same'), path: sibling, recordedPath: sibling, addedAt: '2026-09-12T00:00:00.000Z' },
    {
      id: additionalRootId('same'),
      path: join(fixture.base, 'gone'),
      recordedPath: join(fixture.base, 'gone'),
      addedAt: '2026-09-12T00:00:00.000Z',
    },
  ])

  it('numbers the positions from 1, independently of the ids', () => {
    expect(indexedStatuses(duplicateId()).map(entry => entry.ordinal)).toEqual([1, 2])
  })

  it('removes exactly one record by ordinal, even when two share an id', () => {
    const statuses = duplicateId()
    const afterFirst = removeStatusAt(statuses, { kind: 'ordinal', ordinal: 1 })
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.path).toBe(join(fixture.base, 'gone'))
    const afterSecond = removeStatusAt(statuses, { kind: 'ordinal', ordinal: 2 })
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]?.path).toBe(sibling)
  })

  it('rejects an id that matches more than one record', () => {
    expect(() => removeStatusAt(duplicateId(), { kind: 'id', id: 'same' }))
      .toThrowError(/matches more than one/)
  })

  it('rejects an entry snapshot when the stored rows are completely indistinguishable', () => {
    const first = duplicateId()[0]!
    const identical = [first, { ...first }]
    expect(() => removeStatusAt(identical, entryRootRef(first, 1))).toThrowError(/matches more than one/)
  })

  it('removes by canonical path spelling', () => {
    const after = removeStatusAt(duplicateId(), { kind: 'path', path: join(sibling, '.') })
    expect(after).toHaveLength(1)
    expect(after[0]?.path).toBe(join(fixture.base, 'gone'))
  })

  it('reports not-found for an ordinal outside the list', () => {
    expect(() => removeStatusAt(duplicateId(), { kind: 'ordinal', ordinal: 3 })).toThrow(RootValidationError)
  })
})

describe('canonicalRoot', () => {
  it('returns the input unchanged when the path cannot be resolved', () => {
    const missing = join(fixture.base, 'missing', 'deep')
    expect(canonicalRoot(missing)).toBe(missing)
  })
})
