/**
 * Hidden-entry filtering for the drawn tree.
 *
 * The native navigator lists every entry and filters at draw time
 * (`workspaceEntries(levels, showHidden)` / `workspaceDirectories(..., showHidden)`),
 * because the eye toggle must bring hidden entries back without re-listing the
 * workspace. The fork keeps the same split: the store keeps the listing whole,
 * and this module derives the drawn tree plus the directories whose only
 * entries were hidden.
 *
 * The rules are upstream's: an entry is hidden when its name starts with `.`;
 * a hidden directory's kept level is left out together with it; and a level
 * that held entries but none are drawn says so instead of claiming emptiness.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/hidden
 */
import { childPath } from './face.ts'
import { isHiddenEntry } from './search-rules.ts'
import type { FilesTabState } from './store.ts'

/** One tree as it is drawn: the filtered state and the directories with only hidden entries. */
export interface DrawnTree {
  /** The tree with hidden entries — and the kept levels below hidden directories — removed. */
  readonly state: FilesTabState
  /** Absolute paths of directories whose listing held entries but none are drawn. */
  readonly hiddenOnly: ReadonlySet<string>
}

/**
 * Derive the drawn tree from a listed one.
 *
 * A hidden directory's own listing may already be in the store (the reader
 * expanded it while hidden entries were shown); those kept levels are dropped
 * with their directory, exactly like upstream's hidden-prefix rule, so a
 * reopened tree cannot draw them through a hidden ancestor.
 * @param state - the tab's listed tree.
 * @param showHidden - whether hidden entries are drawn unchanged.
 * @returns the tree to draw and the directories whose entries are all hidden.
 */
export function drawnTree(state: FilesTabState, showHidden: boolean): DrawnTree {
  if (showHidden) return { state, hiddenOnly: new Set() }
  const hiddenPrefixes: string[] = []
  for (const [path, level] of Object.entries(state.levels)) {
    if (level.kind !== 'ready') continue
    for (const entry of level.level.entries) {
      if (entry.type === 'directory' && isHiddenEntry(entry)) {
        hiddenPrefixes.push(childPath(childPath(path, entry.name), ''))
      }
    }
  }
  const underHidden = (path: string): boolean => hiddenPrefixes.some(prefix => `${path}/`.startsWith(prefix))
  const levels: FilesTabState['levels'] = {}
  const hiddenOnly = new Set<string>()
  for (const [path, level] of Object.entries(state.levels)) {
    if (underHidden(path)) continue
    if (level.kind !== 'ready') { levels[path] = level; continue }
    const entries = level.level.entries.filter(entry => !isHiddenEntry(entry))
    if (entries.length === 0 && level.level.entries.length > 0) hiddenOnly.add(path)
    levels[path] = { ...level, level: { ...level.level, entries } }
  }
  return {
    state: { ...state, levels, expanded: state.expanded.filter(path => !underHidden(path)) },
    hiddenOnly,
  }
}
