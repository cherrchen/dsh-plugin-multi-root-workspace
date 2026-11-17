/**
 * The workspace search preference book over a storage-like seam: the upstream
 * localStorage key and stored format, changed-fields-only entries, per-field
 * tolerance of what storage holds, the no-storage fallback, and per-root
 * snapshot identity.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createSearchPreferenceBook, SEARCH_PREFERENCES_KEY, workspaceKey, type SearchPreferenceStorage,
} from '../src/client/files-tree/search-preferences.ts'
import { defaultSearchPreferences } from '../src/client/files-tree/search-rules.ts'

/** A storage-like object this spec can read back and rewrite directly. */
interface StorageHarness extends SearchPreferenceStorage {
  readonly values: Map<string, string>
  readonly writes: { readonly key: string; readonly value: string }[]
}

/** One in-memory storage; initial seeds the preferences key with raw text. */
function memoryStorage(initial?: string): StorageHarness {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(SEARCH_PREFERENCES_KEY, initial)
  const writes: { key: string; value: string }[] = []
  return {
    values,
    writes,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
      writes.push({ key, value })
    },
  }
}

/** The stored preference map, as another tab would read it. */
const stored = (storage: StorageHarness): unknown =>
  JSON.parse(storage.values.get(SEARCH_PREFERENCES_KEY) ?? 'null')

describe('workspaceKey', () => {
  it.each([
    ['/work/app', '/work/app'],
    ['/work/app/', '/work/app'],
    ['/work/app//', '/work/app'],
    ['/', '/'],
    ['C:\\work\\', 'C:\\work'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:/'],
    ['C:', 'C:'],
  ])('keys %s as %s', (cwd, key) => {
    expect(workspaceKey(cwd)).toBe(key)
  })
})

describe('createSearchPreferenceBook', () => {
  it('persists under the upstream key with only the fields that differ from the defaults', () => {
    const storage = memoryStorage()
    const book = createSearchPreferenceBook(storage)
    const chosen = { rules: [{ path: 'out', enabled: false }], showHidden: true, respectGitignore: false }
    book.update('/work/app/', chosen)
    const write = storage.writes.at(-1)
    expect(write?.key).toBe(SEARCH_PREFERENCES_KEY)
    expect(write?.value).toBe(JSON.stringify({ '/work/app': chosen }))
    expect(book.source('/work/app').getSnapshot()).toEqual(chosen)
    book.update('/work/lib', { showHidden: true })
    expect(stored(storage)).toEqual({ '/work/app': chosen, '/work/lib': { showHidden: true } })
  })

  it('drops a root changed back to the defaults', () => {
    const storage = memoryStorage()
    const book = createSearchPreferenceBook(storage)
    book.update('/work/app', { showHidden: true })
    expect(stored(storage)).toEqual({ '/work/app': { showHidden: true } })
    book.update('/work/app', defaultSearchPreferences())
    expect(stored(storage)).toEqual({})
    expect(book.source('/work/app').getSnapshot()).toEqual(defaultSearchPreferences())
    expect(book.source('/work/never').getSnapshot()).toEqual(defaultSearchPreferences())
  })

  it('changes only the fields a patch names, over the preferences read at the call', () => {
    const storage = memoryStorage()
    const book = createSearchPreferenceBook(storage)
    book.update('/work/app', { showHidden: true })
    book.update('/work/app', { rules: [{ path: 'out', enabled: true }] })
    expect(book.source('/work/app').getSnapshot()).toEqual({
      rules: [{ path: 'out', enabled: true }], showHidden: true, respectGitignore: true,
    })
    book.update('/work/app', { showHidden: false })
    book.update('/work/app', { respectGitignore: false })
    expect(book.source('/work/app').getSnapshot()).toEqual({
      rules: [{ path: 'out', enabled: true }], showHidden: false, respectGitignore: false,
    })
    // A .gitignore choice alone differs from the defaults, so only it is stored.
    book.update('/work/app', { rules: defaultSearchPreferences().rules })
    expect(stored(storage)).toEqual({ '/work/app': { respectGitignore: false } })
  })

  it('leaves the rules out of an entry whose rules the reader did not change', () => {
    const storage = memoryStorage()
    createSearchPreferenceBook(storage).update('/work/app', { showHidden: true })
    expect(stored(storage)).toEqual({ '/work/app': { showHidden: true } })
    // An entry another build stored without rules reads the default list of this build.
    storage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify({ '/work/app': { showHidden: true, respectGitignore: false } }))
    expect(createSearchPreferenceBook(storage).source('/work/app').getSnapshot())
      .toEqual({ ...defaultSearchPreferences(), showHidden: true, respectGitignore: false })
  })

  it('reads back what an earlier session stored, each invalid field alone falling back to its default', () => {
    const storage = memoryStorage(JSON.stringify({
      '/work/app': { rules: [{ path: 'out', enabled: true }, { path: '../x', enabled: true }], showHidden: true },
      '/work/lib': { rules: [], showHidden: false, respectGitignore: false },
      '/work/full': { ...defaultSearchPreferences(), showHidden: true },
      '/work/bad': { rules: 'dist', showHidden: true },
      '/work/odd': 7,
    }))
    const book = createSearchPreferenceBook(storage)
    expect(book.source('/work/app').getSnapshot()).toEqual({
      rules: [{ path: 'out', enabled: true }], showHidden: true, respectGitignore: true,
    })
    expect(book.source('/work/lib').getSnapshot()).toEqual({ rules: [], showHidden: false, respectGitignore: false })
    expect(book.source('/work/bad').getSnapshot()).toEqual({ ...defaultSearchPreferences(), showHidden: true })
    expect(book.source('/work/odd').getSnapshot()).toEqual(defaultSearchPreferences())
    // Saving an entry that stored every field keeps only those that differ from the defaults.
    book.update('/work/full', { showHidden: true })
    expect(stored(storage)).toMatchObject({ '/work/full': { showHidden: true } })
  })

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"oops"'],
    ['a JSON null', 'null'],
    ['malformed JSON', '{nope'],
  ])('reads %s as no preferences and replaces it on the first change', (_label, raw) => {
    const storage = memoryStorage(raw)
    const book = createSearchPreferenceBook(storage)
    expect(book.source('/work/app').getSnapshot()).toEqual(defaultSearchPreferences())
    book.update('/work/app', { rules: [], showHidden: false })
    expect(stored(storage)).toEqual({ '/work/app': { rules: [] } })
  })

  it('keeps preferences in memory without a storage object', () => {
    const book = createSearchPreferenceBook(undefined)
    const app = book.source('/work/app')
    expect(app.getSnapshot()).toEqual(defaultSearchPreferences())
    book.update('/work/app', { showHidden: true })
    expect(app.getSnapshot()).toEqual({ ...defaultSearchPreferences(), showHidden: true })
    expect(book.source('/work/app')).toBe(app)
    book.update('/work/app', defaultSearchPreferences())
    expect(app.getSnapshot()).toEqual(defaultSearchPreferences())
  })

  it('keeps one source per workspace key and one snapshot until that root changes', () => {
    const book = createSearchPreferenceBook(memoryStorage())
    const app = book.source('/work/app/')
    expect(book.source('/work/app')).toBe(app)
    expect(book.source('/work/app//')).toBe(app)
    expect(book.source('/work/other')).not.toBe(app)
    const first = app.getSnapshot()
    expect(app.getSnapshot()).toBe(first)
    book.update('/work/other', { showHidden: true })
    expect(app.getSnapshot()).toBe(first)
    book.update('/work/app', { showHidden: true })
    expect(app.getSnapshot()).not.toBe(first)
  })

  it('isolates roots from each other in both storage and snapshots', () => {
    const storage = memoryStorage()
    const book = createSearchPreferenceBook(storage)
    const app = book.source('/work/app')
    book.update('/work/app', { showHidden: true })
    const appSnapshot = app.getSnapshot()
    book.update('/work/lib', { rules: [] })
    expect(app.getSnapshot()).toBe(appSnapshot)
    expect(app.getSnapshot().showHidden).toBe(true)
    expect(book.source('/work/lib').getSnapshot()).toEqual({ rules: [], showHidden: false, respectGitignore: true })
    expect(stored(storage)).toEqual({ '/work/app': { showHidden: true }, '/work/lib': { rules: [] } })
  })

  it('notifies every subscriber on any write, and stops after unsubscribe', () => {
    const book = createSearchPreferenceBook(memoryStorage())
    const app = book.source('/work/app')
    const heard = vi.fn()
    const stop = app.subscribe(heard)
    book.update('/work/other', { rules: [], showHidden: false })
    expect(heard).toHaveBeenCalledTimes(1)
    book.update('/work/app', { rules: [], showHidden: false })
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    book.update('/work/app', { showHidden: true })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('reads a write another book made after this one was created', () => {
    const storage = memoryStorage()
    const early = createSearchPreferenceBook(storage)
    expect(early.source('/work/app').getSnapshot()).toEqual(defaultSearchPreferences())
    createSearchPreferenceBook(storage).update('/work/app', { respectGitignore: false })
    expect(early.source('/work/app').getSnapshot()).toEqual({ ...defaultSearchPreferences(), respectGitignore: false })
  })
})
