/**
 * The search preferences of every workspace, kept in browser storage and
 * shared by every Session and pane whose workspace root is the same.
 *
 * The storage value maps a normalized workspace root to the fields the reader
 * changed there. A field equal to its default is left out of the entry, a root
 * the reader never changed has no entry, and a change back to the defaults
 * removes its entry, so the defaults of a later build reach every field the
 * reader left alone. Storage holds whatever an earlier build or the reader
 * wrote: each entry is read through `readSearchPreferences` rather than
 * trusted.
 *
 * Sync-bearing copy of upstream `ui-sidebar-files`' `search-preferences.ts`
 * at pin `0.2.2-rc.3`. The persistence seam is plugin-owned: this book takes a
 * storage object directly instead of upstream's persisted client store, so no
 * upstream runtime module is imported and the same localStorage key and stored
 * format are kept. `undefined` storage keeps the book in memory.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/search-preferences
 */
import {
  changedSearchPreferences, defaultSearchPreferences, readSearchPreferences, type WorkspaceSearchPreferences,
} from './search-rules.ts'

/**
 * The localStorage key the preferences of every workspace are stored under.
 *
 * Each entry holds whichever of `rules`, `showHidden`, and `respectGitignore`
 * differ from their defaults. Every field is optional on read:
 * {@link readSearchPreferences} gives a missing or mistyped one its current
 * default and reads the others as usual. A change that an earlier build would
 * misread takes a new key.
 */
export const SEARCH_PREFERENCES_KEY = 'dsh.sidebar-files.workspace-search.v1'

/**
 * The browser storage slice this book writes through.
 *
 * Structurally `localStorage`: the browser half passes the global when the
 * page has one and `undefined` otherwise.
 */
export interface SearchPreferenceStorage {
  /** Read one stored string, or `null` when the key is absent. */
  getItem(key: string): string | null
  /** Store one string under a key. */
  setItem(key: string, value: string): void
}

/**
 * One workspace root's preferences as a subscriber reads them.
 *
 * The same members a Slot-standard observable has, so a pane can pass it to a
 * snapshot hook as it stands.
 */
export interface WorkspaceSearchPreferenceSource {
  /** The root's current preferences; the reference changes only when this root does. */
  getSnapshot(): WorkspaceSearchPreferences
  /**
   * Hear every write to the book, whichever root it changed, as upstream's
   * shared store does; re-read {@link getSnapshot} for this root.
   * @param listener - called after each write.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** The search preferences of every workspace root. */
export interface WorkspaceSearchPreferenceBook {
  /**
   * Observe one root's preferences. The same root, by its {@link workspaceKey},
   * gets the same source.
   * @param cwd - the Session's working directory.
   * @returns the source.
   */
  readonly source: (cwd: string) => WorkspaceSearchPreferenceSource
  /**
   * Change the reader's choice for one root: the fields the patch names
   * replace those of the root's current preferences, read at the call; the
   * entry keeps only the fields that differ from the defaults, and is removed
   * when none does.
   * @param cwd - the Session's working directory.
   * @param patch - any of the exclusion rules, the hidden-entry choice, and the `.gitignore` choice.
   */
  readonly update: (cwd: string, patch: Partial<WorkspaceSearchPreferences>) => void
}

/**
 * The storage key of one workspace root: the root as the Host reports it, with
 * trailing `/` and `\` removed except the one that makes a filesystem root
 * (`/`, `C:\`, `C:/`). Case and separators are otherwise kept, so two
 * spellings of one directory keep separate preferences.
 * @param cwd - the Session's working directory.
 * @returns the key its preferences are stored under.
 */
export function workspaceKey(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (trimmed === '') return cwd.slice(0, 1)
  if (/^[A-Za-z]:$/.test(trimmed) && cwd.length > trimmed.length) return cwd.slice(0, 3)
  return trimmed
}

/**
 * One stored entry, without trusting the stored value's type.
 * @param stored - the storage value, as rehydrated.
 * @param key - a workspace key.
 * @returns the entry's value, or `undefined` when the value is not an object or has no such entry.
 */
function storedEntry(stored: unknown, key: string): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored) || !Object.hasOwn(stored, key)) return undefined
  return Object.getOwnPropertyDescriptor(stored, key)?.value
}

/**
 * Parse one storage value.
 * @param raw - the stored text, or `null` when the key is absent.
 * @returns the parsed value, or `undefined` for malformed JSON, which reads as no stored preferences.
 */
function parseStored(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    // Another build or the reader may have left malformed text; nothing there is trustworthy.
    return undefined
  }
}

/**
 * Keep the preferences of every workspace root in browser storage.
 *
 * The whole map is rewritten on each change, so entries of roots this book did
 * not touch survive as storage returned them. Only this book's own writes are
 * persisted; a write another book or tab makes after this book last read is
 * read back on the next snapshot.
 * @param storage - the browser storage object, or `undefined` to keep the preferences in memory.
 * @returns the preferences by workspace root.
 */
export function createSearchPreferenceBook(storage: SearchPreferenceStorage | undefined): WorkspaceSearchPreferenceBook {
  const sources = new Map<string, WorkspaceSearchPreferenceSource>()
  const listeners = new Set<() => void>()
  /** The entries kept while there is no storage object; unused when there is one. */
  let memory: unknown
  /** The storage text the parsed value came from, so an unchanged value is not parsed again. */
  let readRaw: string | null | undefined
  let readValue: unknown
  const stored = (): unknown => {
    if (storage === undefined) return memory
    const raw = storage.getItem(SEARCH_PREFERENCES_KEY)
    if (raw !== readRaw) {
      readRaw = raw
      readValue = parseStored(raw)
    }
    return readValue
  }
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const source = (cwd: string): WorkspaceSearchPreferenceSource => {
    const key = workspaceKey(cwd)
    const known = sources.get(key)
    if (known !== undefined) return known
    let seen: { readonly text: string | undefined; readonly preferences: WorkspaceSearchPreferences } | undefined
    const created: WorkspaceSearchPreferenceSource = {
      getSnapshot: () => {
        const entry = storedEntry(stored(), key)
        // The entry's own serialization stands in for its identity, so another root's write keeps this snapshot.
        const text = entry === undefined ? undefined : JSON.stringify(entry)
        if (seen === undefined || seen.text !== text) {
          seen = { text, preferences: entry === undefined ? defaultSearchPreferences() : readSearchPreferences(entry) }
        }
        return seen.preferences
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    sources.set(key, created)
    return created
  }
  return {
    source,
    update(cwd, patch) {
      const preferences = { ...source(cwd).getSnapshot(), ...patch }
      const key = workspaceKey(cwd)
      const current = stored()
      const entries: [string, unknown][] = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? Object.entries(current).filter(([name]) => name !== key)
        : []
      const changed = changedSearchPreferences(preferences)
      if (changed !== undefined) entries.push([key, changed])
      const next = Object.fromEntries(entries)
      if (storage === undefined) {
        memory = next
      } else {
        storage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify(next))
      }
      notify()
    },
  }
}
