/**
 * Path-location mechanics for the preview navigator's takeover and reveal,
 * ported from upstream's `ui-sidebar-files` navigator internals
 * (`0.2.2-alpha.3`; the package build is byte-identical at `0.2.2-rc.1`):
 * the same `windowsRoot`, `underRoot`, and `locateFile` the native
 * FileNavigator runs against its pane tree, spelled against this fork's
 * `FilesTabState` — the store shape is the same (`root`, `levels` keyed by
 * absolute path, `expanded`), only the `refreshing` flag is absent, so a
 * stale level reports `pending: false` exactly like a settled native one.
 *
 * Everything here is a port or plugin-owned logic on top of it; nothing in
 * this file needs upstream sync beyond the documented provenance.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/locate
 */

import type { RootView, RootsView } from '../../contract.ts'
import { childPath } from './face.ts'
import type { FilesTabState } from './store.ts'

/**
 * Whether a root is a Windows drive or UNC path, in either separator
 * spelling, where names compare regardless of case.
 * @param root - the tree's root, or a prefix built from it.
 * @returns `true` for a drive letter followed by a separator, or a leading
 *   double separator.
 */
export function windowsRoot(root: string): boolean {
  const path = root.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

/**
 * An absolute `/`-separated path relative to a tree's root.
 * @param path - the absolute path, in either separator spelling.
 * @param root - the tree's root, in either separator spelling.
 * @returns the path under the root, or `undefined` outside it.
 */
export function underRoot(path: string, root: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const head = normalized.slice(0, prefix.length)
  return (windowsRoot(prefix) ? head.toLowerCase() === prefix.toLowerCase() : head === prefix)
    ? normalized.slice(prefix.length)
    : undefined
}

/**
 * The workspace-relative path of a file under a tree's root, validated the
 * way upstream's `relativeFileOf` tail validates it: nothing absolute, and
 * no empty or dot segments.
 * @param path - the file's absolute path, in either separator spelling.
 * @param root - the root it must sit under.
 * @returns the `/`-separated relative path, or `undefined` outside the root.
 */
export function relativeUnderRoot(path: string, root: string): string | undefined {
  const normalized = underRoot(path, root)
  if (normalized === undefined || normalized === '' || /^([A-Za-z]:)?\//.test(normalized)) return undefined
  return normalized.split('/').some(part => part === '' || part === '.' || part === '..') ? undefined : normalized
}

/**
 * The additional root that owns one absolute file path: available roots
 * only, the longest matching root path winning when registrations nest.
 * @param view - the session's registry view.
 * @param path - the file's absolute path, in either separator spelling.
 * @returns the owning root, or `undefined` when the file is outside every
 *   available additional root (the primary root included).
 */
export function rootForPath(view: RootsView, path: string): RootView | undefined {
  let best: RootView | undefined
  for (const root of view.roots) {
    // A view that names the primary among its roots must never match it:
    // the primary's files are the native navigator's own job.
    if (root.state !== 'available' || root.path === view.primaryRoot) continue
    if (underRoot(path, root.path) === undefined) continue
    if (best === undefined || root.path.length > best.path.length) best = root
  }
  return best
}

/** What walking the listed levels toward a workspace-relative file found. */
export interface FileLocation {
  /** The directories verified so far, each named by its listing's spelling. */
  readonly ancestors: readonly { readonly parent: string; readonly path: string }[]
  /** The file's tree key once its row exists, `undefined` until or unless it does. */
  readonly current: string | undefined
  /** Whether a level on the way is still pending its listing. */
  readonly pending: boolean
}

/**
 * Walk the listed levels to a workspace-relative file, keeping the listing's
 * spelling of each name; a Windows root also matches names regardless of
 * case. A verbatim port of upstream's navigator helper — the fork's
 * `LevelState` carries no `refreshing` flag, so a stale level reports
 * `pending: false` like a settled native one.
 * @param tree - the tab's tree.
 * @param relativePath - the file's path under the tree's root, `/`-separated.
 * @returns the ancestors found so far, the file's tree key, and whether a
 *   level is pending.
 */
export function locateFile(tree: Pick<FilesTabState, 'root' | 'levels'>, relativePath: string): FileLocation {
  const caseless = windowsRoot(tree.root)
  const parts = relativePath.split('/')
  const ancestors: { readonly parent: string; readonly path: string }[] = []
  let parent = tree.root
  for (const [index, part] of parts.entries()) {
    const level = tree.levels[parent]
    if (level?.kind !== 'ready') {
      return { ancestors, current: undefined, pending: level === undefined || level.kind === 'loading' }
    }
    const type = index === parts.length - 1 ? 'file' : 'directory'
    const candidates = level.level.entries.filter(entry => entry.type === type)
    const entry = candidates.find(candidate => candidate.name === part)
      ?? (caseless ? candidates.find(candidate => candidate.name.toLowerCase() === part.toLowerCase()) : undefined)
    if (entry === undefined) return { ancestors, current: undefined, pending: false }
    const path = childPath(parent, entry.name)
    if (type === 'directory') ancestors.push({ parent, path })
    parent = path
  }
  return { ancestors, current: parent, pending: false }
}
