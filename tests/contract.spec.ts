import { describe, expect, it } from 'vitest'
import { parseRootsView } from '../src/contract.ts'

const legacy = {
  primaryRoot: '/primary',
  roots: ['available', 'missing', 'redirected', 'invalid'].map((state, i) => ({
    ordinal: i + 1, id: String(i), path: `/root-${i}`, addedAt: '2026-10-11', state,
  })),
}

describe('roots-view wire compatibility', () => {
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
