/**
 * The additional-root search's per-pane view state: whether the bar is open,
 * the typed query, the running/settled search, the result tree's own
 * expansion, and the result scroll offset.
 *
 * The state lives beside the forked tree's store rather than inside it: the
 * listing store is a byte-identical copy of upstream's and must stay that way
 * (FORK.md), while this is plugin-owned surface. One record per
 * `(tab, root)` keeps two additional roots in one pane from sharing a query
 * or a result, and the record lives in the inject product, so a body remount
 * (opening a file unmounts the Files page body) keeps it.
 *
 * The shape mirrors upstream's pane search records (`FilesSearchState`) so the
 * same UI rules apply: `pending` keeps the previous result drawn, except a
 * failed one, which the next search replaces with the spinner.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/search-state
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { FilesTabState } from './store.ts'

/** One settled search, as the results view draws it instead of the tree. */
export type SearchResultView =
  | {
    readonly kind: 'found'
    /** The trimmed query the result answers, which the rows highlight. */
    readonly query: string
    /** The matches as a fully expanded tree, keyed by absolute path. */
    readonly tree: FilesTabState
    /** How many entries the search returned (files plus inferred directories). */
    readonly count: number
    readonly truncated: boolean
    readonly incomplete: boolean
    /** The search was asked to leave hidden entries out. */
    readonly hiddenLeftOut: boolean
    /** The search was given at least one enabled exclusion rule. */
    readonly excluded: boolean
    /** The search was asked to honor ignore files. */
    readonly ignored: boolean
  }
  | {
    readonly kind: 'failed'
    /** The trimmed query the search failed for. */
    readonly query: string
    /** The stable failure code and its fallback text, in the pane's own vocabulary. */
    readonly failure: SearchFailureInfo
  }

/** A failed search's stable code and fallback text. */
export interface SearchFailureInfo {
  readonly code: string
  readonly message: string
}

/** One pane root's search state. */
export interface SearchPaneState {
  /** Whether the Files page draws the search bar; hiding retains the query and result. */
  barOpen: boolean
  /** The field's text as typed; whitespace-only text is not a search. */
  query: string
  /** A search is running; the last settled result stays drawn until replaced. */
  pending: boolean
  /** The last settled search, `undefined` before the first one or after a blank query. */
  result: SearchResultView | undefined
  /** The result tree's expansion; a new result starts fully expanded. */
  expanded: readonly string[]
  /** The result body's scroll offset, so a remount comes back where the reader was. */
  scrollTop: number
  /** How many times the same query was asked again after a failure. */
  attempt: number
}

/** Every `(tab, root)` search record. */
export type SearchPaneStates = Readonly<Record<string, SearchPaneState>>

/** The record before anything was typed. */
const EMPTY: SearchPaneState = { barOpen: false, query: '', pending: false, result: undefined, expanded: [], scrollTop: 0, attempt: 0 }

/**
 * The state key of one pane root.
 *
 * The separator cannot appear in a dockkit tab id and is unlikely in a path;
 * even if a path contained it, the key is only ever compared with itself.
 * @param tabId - the pane's dockkit identity.
 * @param root - the absolute additional root being browsed.
 * @returns the record's key.
 */
export function searchStateKey(tabId: TabId, root: string): string {
  return `${tabId}\u0000${root}`
}

/** The write set the results view and the bar share. */
export interface SearchPaneStore {
  /** The observable every consumer reads; one record per pane root. */
  readonly snapshot: SnapshotStore<SearchPaneStates>
  /**
   * One pane root's record, or the blank record before anything was typed.
   * @param key - the record key from {@link searchStateKey}.
   */
  state(key: string): SearchPaneState
  /**
   * Show or hide the search bar without touching the search.
   * @param key - the record key.
   * @param open - whether the bar is drawn.
   */
  barOpen(key: string, open: boolean): void
  /**
   * Record the field's text. A blank query ends the search: its result is
   * dropped, so switching roots never resurrects stale matches.
   * @param key - the record key.
   * @param query - the text as typed.
   */
  setQuery(key: string, query: string): void
  /**
   * Record that a search started, keeping the last result drawn unless it
   * failed (a failure has nothing to keep).
   * @param key - the record key.
   */
  searching(key: string): void
  /**
   * Record a settled search; a found result starts fully expanded at its top.
   * @param key - the record key.
   * @param result - what the search found, or why it failed.
   */
  searched(key: string, result: SearchResultView): void
  /**
   * Open or collapse one directory of the result tree.
   * @param key - the record key.
   * @param path - the directory's absolute tree key.
   */
  toggled(key: string, path: string): void
  /**
   * Record the result body's scroll offset.
   * @param key - the record key.
   * @param scrollTop - the offset in px.
   */
  scrolled(key: string, scrollTop: number): void
  /**
   * Ask the same query again after a failure: the effect re-runs on the
   * changed attempt, and the failed result is dropped for the spinner.
   * @param key - the record key.
   */
  retry(key: string): void
  /**
   * Drop one pane root's record — the pane or the root is gone.
   * @param key - the record key.
   */
  forget(key: string): void
}

/**
 * Create the search pane store for one session's inject product.
 * @returns the observable and the actions that write it.
 */
export function createSearchPaneStore(): SearchPaneStore {
  const snapshot = createSnapshotStore<SearchPaneStates>({})
  const read = (key: string): SearchPaneState => snapshot.getSnapshot()[key] ?? EMPTY
  const write = (key: string, patch: Partial<SearchPaneState>): void => {
    snapshot.set({ ...snapshot.getSnapshot(), [key]: { ...read(key), ...patch } })
  }
  return {
    snapshot,
    state: key => read(key),
    barOpen: (key, open) => { write(key, { barOpen: open }) },
    setQuery: (key, query) => {
      write(key, query.trim() === ''
        ? { query, pending: false, result: undefined, expanded: [], scrollTop: 0 }
        : { query, pending: false })
    },
    searching: key => {
      const result = read(key).result
      write(key, { pending: true, ...(result?.kind === 'failed' ? { result: undefined } : {}) })
    },
    searched: (key, result) => {
      write(key, {
        pending: false,
        result,
        ...(result.kind === 'found' ? { expanded: result.tree.expanded } : { expanded: [] }),
        scrollTop: 0,
      })
    },
    toggled: (key, path) => {
      const expanded = read(key).expanded
      write(key, { expanded: expanded.includes(path) ? expanded.filter(value => value !== path) : [...expanded, path] })
    },
    scrolled: (key, scrollTop) => { write(key, { scrollTop }) },
    retry: key => {
      write(key, { pending: true, result: undefined, expanded: [], scrollTop: 0, attempt: read(key).attempt + 1 })
    },
    forget: key => {
      const { [key]: _dropped, ...rest } = snapshot.getSnapshot()
      snapshot.set(rest)
    },
  }
}
