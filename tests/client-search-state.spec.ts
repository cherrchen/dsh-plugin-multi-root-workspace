// @vitest-environment jsdom
/**
 * The pane search records: request identity, the retained-answer marker, and
 * the write set the results view and the bar share.
 */
import { describe, expect, it } from 'vitest'
import {
  createSearchPaneStore, searchRequestKey, searchStateKey, type SearchRequestKeyInput,
} from '../src/client/files-tree/search-state.ts'
import { buildSearchTree } from '../src/client/files-tree/search-tree.ts'

const ROOT = '/repos/payments'

/** The request identity input a spec starts from. */
function request(patch: Partial<SearchRequestKeyInput> = {}): SearchRequestKeyInput {
  return {
    rootId: 'root-a',
    query: 'config',
    excludedPaths: ['node_modules'],
    includeHidden: false,
    respectGitignore: true,
    attempt: 0,
    ...patch,
  }
}

/** A settled found result for one search. */
function found() {
  return {
    kind: 'found' as const,
    query: 'config',
    tree: buildSearchTree(ROOT, [{ path: 'src/config.ts', type: 'file' as const }]),
    count: 1,
    truncated: false,
    incomplete: false,
    hiddenLeftOut: true,
    excluded: true,
    ignored: true,
  }
}

describe('the search request identity', () => {
  it('is stable for equal requests and distinct for every field', () => {
    const base = searchRequestKey(request())
    expect(searchRequestKey(request())).toBe(base)
    for (const patch of [
      { rootId: 'root-b' },
      { query: 'other' },
      { excludedPaths: ['node_modules', 'dist'] },
      { excludedPaths: [] },
      { includeHidden: true },
      { respectGitignore: false },
      { attempt: 1 },
    ]) {
      expect(searchRequestKey(request(patch))).not.toBe(base)
    }
  })

  it('keeps exclusion order significant so a reordered rule set is a new request', () => {
    expect(searchRequestKey(request({ excludedPaths: ['a', 'b'] })))
      .not.toBe(searchRequestKey(request({ excludedPaths: ['b', 'a'] })))
  })
})

describe('the search pane store', () => {
  it('records the settled request identity and clears it when the query or attempt changes', () => {
    const store = createSearchPaneStore()
    const key = searchStateKey('tab-1', ROOT)
    const settledKey = searchRequestKey(request())
    store.searched(key, found(), settledKey)
    expect(store.state(key).settledKey).toBe(settledKey)

    store.setQuery(key, 'config ')
    expect(store.state(key).settledKey).toBe('')

    store.searched(key, found(), settledKey)
    store.retry(key)
    expect(store.state(key).settledKey).toBe('')
    expect(store.state(key).pending).toBe(true)
    expect(store.state(key).result).toBeUndefined()
  })

  it('keeps expansion and scroll when a retained answer is not replaced', () => {
    const store = createSearchPaneStore()
    const key = searchStateKey('tab-1', ROOT)
    const settledKey = searchRequestKey(request())
    store.searched(key, found(), settledKey)
    const expanded = store.state(key).expanded
    expect(expanded.length).toBeGreaterThan(0)
    store.scrolled(key, 120)
    store.toggled(key, expanded.at(-1)!)
    // Nothing writes the record: the retained answer keeps its position.
    expect(store.state(key).scrollTop).toBe(120)
    expect(store.state(key).expanded.length).toBe(expanded.length - 1)
  })
})
