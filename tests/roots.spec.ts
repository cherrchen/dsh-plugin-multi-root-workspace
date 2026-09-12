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
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  expandRootInput,
  isCanonicallyUnder,
  resolveRootRef,
  RootValidationError,
  validateRootCandidate,
  type RegisteredRoot,
} from '../src/roots.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let primary: string
let sibling: string
let nested: string
let alias: string

beforeAll(() => {
  fixture = createFixtureWorkspace('roots')
  primary = canonicalPath(fixture.workspace)
  sibling = join(fixture.base, 'extra')
  nested = join(sibling, 'inner')
  alias = join(fixture.base, 'alias')
  mkdirSync(sibling)
  mkdirSync(nested)
  writeFileSync(join(fixture.base, 'a-file'), 'not a directory')
  symlinkSync(sibling, alias)
})

afterAll(() => { fixture.dispose() })

/** Run one candidate against the primary root and the given existing roots. */
function check(raw: string, existing: readonly string[] = []): string {
  return validateRootCandidate(raw, { primaryRoot: primary, existing })
}

/** Capture the failure code of one candidate. */
function codeOf(raw: string, existing: readonly string[] = []): string {
  try {
    check(raw, existing)
  } catch (error: unknown) {
    if (error instanceof RootValidationError) return error.code
    throw error
  }
  return 'accepted'
}

describe('expandRootInput', () => {
  it('expands a bare tilde and a tilde-prefixed path against the given home', () => {
    expect(expandRootInput('~', '/home/op')).toBe('/home/op')
    expect(expandRootInput('~/projects', '/home/op')).toBe(join('/home/op', 'projects'))
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
    expect(isCanonicallyUnder('/a/b', '/a/b')).toBe(true)
    expect(isCanonicallyUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isCanonicallyUnder('/a/bc', '/a/b')).toBe(false)
    expect(isCanonicallyUnder('/a', '/a/b')).toBe(false)
  })
})

describe('validateRootCandidate', () => {
  it('canonicalizes an accepted candidate', () => {
    expect(check(sibling)).toBe(canonicalPath(sibling))
  })

  it('accepts a `~`-prefixed candidate that resolves to a real directory', () => {
    // The home directory itself exists on every host this suite runs on.
    expect(check('~')).toBe(canonicalPath(homedir()))
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
    expect(codeOf(fixture.base, [sibling])).toBe('nested')
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

  it('treats a symlink alias as the same root', () => {
    expect(codeOf(alias, [canonicalPath(sibling)])).toBe('duplicate')
    expect(check(alias)).toBe(canonicalPath(sibling))
  })
})

describe('classifyStoredRoots', () => {
  const record = (path: string, id = path): RegisteredRoot => ({
    id: additionalRootId(id),
    path,
    addedAt: '2026-09-12T00:00:00.000Z',
  })

  it('marks an existing root available and keeps registry order', () => {
    const statuses = classifyStoredRoots(primary, [record(sibling), record(nested, 'n2')])
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
    expect(statuses[0]?.path).toBe(canonicalPath(sibling))
    expect(availableRoots(statuses)).toEqual([canonicalPath(sibling)])
  })

  it('keeps a registration whose directory vanished, as missing rather than invalid', () => {
    const gone = join(fixture.base, 'vanished')
    const statuses = classifyStoredRoots(primary, [record(gone)])
    expect(statuses[0]?.state).toBe('missing')
    expect(statuses[0]?.path).toBe(gone)
    expect(availableRoots(statuses)).toEqual([])
  })

  it('flags a record equal to the primary root as invalid', () => {
    expect(classifyStoredRoots(primary, [record(primary)])[0]?.state).toBe('invalid')
  })

  it('flags the second of two equal records as invalid (first one wins)', () => {
    const statuses = classifyStoredRoots(primary, [record(sibling), record(join(sibling, '.'), 'other')])
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
  })

  it('flags overlapping records in either direction as invalid', () => {
    const outerFirst = classifyStoredRoots(primary, [record(sibling), record(nested, 'n2')])
    expect(outerFirst[1]?.state).toBe('invalid')
    const innerFirst = classifyStoredRoots(primary, [record(nested), record(sibling, 'n2')])
    expect(innerFirst[1]?.state).toBe('invalid')
  })

  it('flags a relative stored path as invalid', () => {
    expect(classifyStoredRoots(primary, [record('relative/dir')])[0]?.state).toBe('invalid')
  })

  it('flags a record with no usable identity as invalid', () => {
    expect(classifyStoredRoots(primary, [{ ...record(sibling), id: additionalRootId('') }])[0]?.state).toBe('invalid')
  })

  it('canonicalizes a stored symlink spelling', () => {
    expect(classifyStoredRoots(primary, [record(alias)])[0]?.path).toBe(canonicalPath(sibling))
  })
})

describe('resolveRootRef', () => {
  /** Built per test: the fixture tree only exists once `beforeAll` has run. */
  const statusesOf = (): ReturnType<typeof classifyStoredRoots> => classifyStoredRoots(primary, [
    { id: additionalRootId('a'), path: sibling, addedAt: '2026-09-12T00:00:00.000Z' },
    { id: additionalRootId('b'), path: join(fixture.base, 'gone'), addedAt: '2026-09-12T00:00:00.000Z' },
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

describe('canonicalRoot', () => {
  it('returns the input unchanged when the path cannot be resolved', () => {
    const missing = join(fixture.base, 'missing', 'deep')
    expect(canonicalRoot(missing)).toBe(missing)
  })
})
