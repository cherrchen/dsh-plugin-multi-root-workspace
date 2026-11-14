/**
 * The drawing half of the forked Files tree: the row definitions upstream keeps
 * inside `FilesBody.tsx`, plus the two render paths the fork chooses between
 * (the host's `sidebar.files.tree` Factory on newer releases, these rows on
 * older ones).
 *
 * The row bodies are upstream's `Entry`/`Level` definitions with the documented
 * deltas: `highlight` marks search matches in a name, `hiddenOnly` draws the
 * "only hidden entries" line, `unmatched` suppresses the empty line for search
 * selections, and `menu` spreads the host's row trigger props. `FilesTree`
 * draws a listed tree with it; the search results view draws its own selection
 * tree with the same function, which is why the two cannot drift apart. See
 * FORK.md.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/tree-view
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { nativeTreeInput, type NativeTreeEntry, type NativeTreeRenderer } from '../../compat/files-tree.ts'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesMenuSeat } from './context-menu.ts'
import { FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, classifyFileType } from './primitives.ts'
import { matchRanges } from './search-tree.ts'
import type { FilesTabState } from './store.ts'
import css from './FilesBody.module.css.ts'

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/** One entry's name, with the occurrences of the search text marked. */
function Name({ name, highlight }: { name: string; highlight: string | undefined }): ReactNode {
  const ranges = highlight === undefined || highlight === '' ? [] : matchRanges(name, highlight)
  if (ranges.length === 0) return <span className={css.name}>{name}</span>
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(name.slice(at, start))
    parts.push(<mark key={start} className={css.match}>{name.slice(start, end)}</mark>)
    at = end
  }
  if (at < name.length) parts.push(name.slice(at))
  return <span className={css.name}>{parts}</span>
}

/** What every level shares: the drawn state, the two gestures, and the row decorations. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
  /** The revealed file's tree key while its row is the current one. */
  readonly current: string | undefined
  /** Callback ref for the current row's button — the reveal's scroll target. */
  readonly currentRef: ((row: unknown) => void) | undefined
  /** The pane's row context menus, or `undefined` where the host has none. */
  readonly menu: FilesMenuSeat | undefined
  /** Search text whose occurrences inside each name are marked. */
  readonly highlight: string | undefined
  /** Directories that hold only hidden entries, so an empty level says why. */
  readonly hiddenOnly: ReadonlySet<string> | undefined
  /** The entries are a selection (search results): an empty level draws no line. */
  readonly unmatched: boolean
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  const label = <Name name={entry.name} highlight={tree.highlight} />
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onToggle(parent, path) }}
          {...(tree.menu === undefined ? {} : tree.menu.trigger(path, 'directory'))}>
          {expanded
            ? <IconFolderOpenRegular className={css.icon} />
            : <IconFolderCloseRegular className={css.icon} />}
          {label}
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    // The reveal's current row: what the native tree draws as `.current` +
    // `aria-current` — `data-files-current` is the fork's spelling of it, and
    // the button carries the scroll target ref like upstream's `currentRef`.
    const current = tree.current === path
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path}>
        <button
          type="button"
          className={css.row}
          onClick={() => { tree.onOpen(path) }}
          ref={current ? tree.currentRef as ((row: unknown) => void) | undefined : undefined}
          data-files-current={current ? '' : undefined}
          aria-current={current ? true : undefined}
          {...(tree.menu === undefined ? {} : tree.menu.trigger(path, 'file'))}
        >
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
          {label}
        </button>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        {label}
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries)
  const hiddenOnly = tree.hiddenOnly?.has(path) === true
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-files-row="failed">{failureLine(t, level.failure)}</li>}
      {entries.length === 0 && level.failure === undefined && !tree.unmatched && (
        hiddenOnly
          ? <li className={css.note} data-files-row="hidden-only">{t('emptyHidden')}</li>
          : <li className={css.note} data-files-row="empty">{t('empty')}</li>
      )}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** What one drawing needs: the state to draw, the gestures, and the host decorations. */
export interface TreeViewProps {
  /** The drawn tree: root, level states, and expansion. Every entry is already filtered. */
  readonly state: FilesTabState
  readonly t: TranslateNS<'sidebarFiles'>
  /** Session the row addresses belong to. */
  readonly sessionId: SessionId
  /** The host `sidebar.files.tree` Factory, or `undefined` on a release without it. */
  readonly nativeTree: NativeTreeRenderer | undefined
  /** Row context menus, or `undefined` where the host has none. */
  readonly menu: FilesMenuSeat | undefined
  /** Whether a host viewer claims one file address (`0.2.2-alpha.3+`). */
  readonly canOpen: ((address: string) => boolean) | undefined
  /** Search text to mark inside each name. */
  readonly highlight?: string | undefined
  /** The entries are search matches: an empty level draws no line. */
  readonly unmatched?: boolean | undefined
  /** Directories holding only hidden entries, so their empty level says why. */
  readonly hiddenOnly?: ReadonlySet<string> | undefined
  /** The revealed file, marked current and scrolled into view by its ref. */
  readonly current?: { readonly path: string; readonly ref: (row: unknown) => void } | undefined
  /** A directory row asked to open or close. */
  readonly onToggle: (parent: string, path: string) => void
  /** A file row asked to open. */
  readonly onOpen: (path: string) => void
}

/**
 * Draw one tree, through the host Factory when this release has it and through
 * the forked rows otherwise. Both paths receive the same inputs, so a search
 * selection draws exactly like a listed level.
 * @param props - the drawn state, gestures, and host decorations.
 * @returns the tree's rows, or the host Factory's rendering of them.
 */
export function TreeView(props: TreeViewProps): ReactNode {
  const {
    state, t, sessionId, nativeTree, menu, canOpen, highlight, unmatched = false, hiddenOnly, current, onToggle, onOpen,
  } = props
  const tree: TreeContext = {
    state,
    onToggle,
    onOpen,
    t,
    current: current?.path,
    currentRef: current?.ref,
    menu,
    highlight,
    hiddenOnly,
    unmatched,
  }
  const legacy = <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
  if (nativeTree === undefined) return legacy
  const rowTriggerProps = menu === undefined
    ? undefined
    : (entry: NativeTreeEntry, kind: 'file' | 'directory') => menu.trigger(entry.path, kind)
  const canOpenEntry = canOpen === undefined
    ? undefined
    : (entry: NativeTreeEntry) => canOpen(fileAddressFor(sessionId, undefined, entry.path))
  return nativeTree(
    'sidebar.files.tree',
    nativeTreeInput(state, failure => failureLine(t, failure), onToggle, onOpen, {
      ...(current === undefined ? {} : { current }),
      ...(rowTriggerProps === undefined ? {} : { rowTriggerProps }),
      ...(canOpenEntry === undefined ? {} : { canOpen: canOpenEntry }),
      ...(highlight === undefined || highlight === '' ? {} : { highlight }),
      ...(unmatched ? { omitted: 'unmatched' as const } : {}),
      ...(hiddenOnly === undefined || hiddenOnly.size === 0 ? {} : { hiddenOnly }),
    }),
    { fallback: legacy },
  ) as ReactNode
}
