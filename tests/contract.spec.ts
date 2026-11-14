import { describe, expect, it } from 'vitest'
import { parsePanelCall, parseRootsView, parseSearchView } from '../src/contract.ts'

const legacy = {
  primaryRoot: '/primary',
  roots: ['available', 'missing', 'redirected', 'invalid'].map((state, i) => ({
    ordinal: i + 1, id: String(i), path: `/root-${i}`, addedAt: '2026-10-11', state,
  })),
}

describe('roots-view wire compatibility', () => {
  it('preserves host-derived effective permissions and rejects malformed modes', () => {
    const root = { ...legacy.roots[0], access: 'inherit', effectiveAccess: 'full-access' }
    const view = { ...legacy, mode: 'danger-full-access', cappedTools: ['bash'], toolAccessInvalid: false, roots: [root] }
    expect(parseRootsView(view)).toMatchObject({ ok: true, value: {
      mode: 'danger-full-access', cappedTools: ['bash'], toolAccessInvalid: false,
      roots: [{ effectiveAccess: 'full-access' }],
    } })
    expect(parseRootsView({ ...view, mode: 'writable' })).toMatchObject({ ok: false })
    expect(parseRootsView({ ...view, roots: [{ ...root, effectiveAccess: 'system' }] })).toMatchObject({ ok: false })
  })
  it('accepts pre-access/pre-limit hosts without imposing a new client cap', () => {
    const result = parseRootsView(legacy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.count).toBe(4)
    expect(result.value.limit).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.value.roots.map(root => root.access)).toEqual(Array(4).fill('inherit'))
  })

  it('preserves explicit limits, over-limit counts and read-only access', () => {
    const result = parseRootsView({ ...legacy, limit: 2, count: 4,
      roots: legacy.roots.map(root => ({ ...root, access: 'read-only' })),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.limit).toBe(2)
    expect(result.value.count).toBe(4)
    expect(result.value.roots.every(root => root.access === 'read-only')).toBe(true)
  })

  it('defaults each omitted field independently and keeps zero explicit', () => {
    expect(parseRootsView({ ...legacy, limit: 0 })).toMatchObject({ ok: true, value: { limit: 0, count: 4 } })
    expect(parseRootsView({ ...legacy, count: 0 })).toMatchObject({ ok: true, value: { limit: Number.MAX_SAFE_INTEGER, count: 0 } })
  })

  it.each(['limit', 'count'])('rejects malformed supplied %s instead of defaulting it', (field) => {
    for (const value of [null, -1, 1.5, '16', Infinity, NaN]) {
      expect(parseRootsView({ ...legacy, [field]: value })).toMatchObject({ ok: false })
    }
  })
})

describe('search wire contract', () => {
  const answer = {
    root: '/repos/payments',
    matches: [
      { path: 'src/a.ts', type: 'file' },
      { path: 'src', type: 'directory' },
    ],
    truncated: false,
    incomplete: true,
  }

  it('accepts a well-formed answer and keeps future fields ignorable', () => {
    expect(parseSearchView(answer)).toEqual({ ok: true, value: answer })
    // A newer host adding a field must not brick an older panel.
    expect(parseSearchView({ ...answer, generations: 3 })).toEqual({ ok: true, value: answer })
  })

  it('rejects an answer that is not a search view', () => {
    expect(parseSearchView(undefined)).toMatchObject({ ok: false })
    expect(parseSearchView({ ...answer, matches: [{ path: 'a', type: 'blob' }] })).toMatchObject({ ok: false })
    expect(parseSearchView({ ...answer, truncated: 'yes' })).toMatchObject({ ok: false })
    expect(parseSearchView({ ...answer, incomplete: undefined })).toMatchObject({ ok: false })
  })

  it('validates a search request body and rejects fields the host does not know', () => {
    const parsed = parsePanelCall('search', {
      sessionId: 'session-1',
      rootId: 'root-1',
      query: 'a.ts',
      excludedPaths: ['dist', 'build'],
      includeHidden: true,
      respectGitignore: false,
    })
    expect(parsed).toEqual({ ok: true, value: {
      endpoint: 'search',
      sessionId: 'session-1',
      rootId: 'root-1',
      query: 'a.ts',
      excludedPaths: ['dist', 'build'],
      includeHidden: true,
      respectGitignore: false,
    } })
    // A path field would let a client name a directory; the endpoint must take
    // only the registry id, so the strict schema rejects the attempt.
    expect(parsePanelCall('search', { sessionId: 'session-1', rootId: 'r', query: 'a', rootPath: '/x' })).toMatchObject({ ok: false })
    expect(parsePanelCall('search', { sessionId: 'session-1', rootId: '', query: 'a' })).toMatchObject({ ok: false })
    expect(parsePanelCall('search', {})).toMatchObject({ ok: false })
  })
})

