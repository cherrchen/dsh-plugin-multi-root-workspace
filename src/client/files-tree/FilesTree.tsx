/**
 * The file tree's body, forked to a caller-supplied root: one additional
 * workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it
 * asks for goes through its injected face. The component itself only decides
 * what to draw for each absolute path and what a click means: a directory
 * toggles, a file opens through the owner's open callback for a `file:`
 * viewer to claim, and anything else is shown but refuses to open.
 *
 * The rows below the exported shell are byte-identical to upstream's
 * `FilesBody.tsx`; the shell is the adaptation — upstream's version derives
 * the root from the session's `cwd`, takes its tab identity and lifetime from
 * `useTabInfo()`, opens resources through `tab.actions.openResource`, and
 * draws the header (PathLabel, auto-refresh, reload, actions slot) that this
 * plugin's switcher already owns. This fork takes all four as props and
 * draws only the body. See FORK.md.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, classifyFileType,
} from './primitives.ts'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import type {} from './locales.ts'
import type { createFilesStore, FilesTabState } from './store.ts'
import css from './FilesBody.module.css.ts'

/**
 * The fork's props: the store/locale shares verbatim from upstream's
 * composed props, `start`/`toggle` from the injected face, and the four
 * seams upstream binds inside `FilesBody` — tab id, lifetime, root, and the
 * resource-opening callback — supplied by the adapter instead.
 */
export type FilesTreeProps =
  & PropsStore<ReturnType<typeof createFilesStore>>
  & Pick<FilesInjected, 'start' | 'toggle'>
  & PropsLocale<'sidebarFiles'>
  & {
    /** The store bucket this tree reads and writes — the pane's own dockkit tab id. */
    readonly tabId: TabId
    /** Session the listing and the resource addresses belong to. */
    readonly sessionId: SessionId
    /** Absolute path of the root this tree lists (the selected additional root). */
    readonly root: string
    /** Takeover lifetime: aborting forgets the bucket and closes the watch tree. */
    readonly signal: AbortSignal
    /** Open one `dsh-resource://file` address (the adapter's sidebarRight route). */
    readonly onOpen: (address: string) => void
  }

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

/** What every level shares: the tab's tree and the two gestures. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onToggle(parent, path) }}>
          {expanded ? <IconFolderOpenRegular className={css.icon} /> : <IconFolderCloseRegular className={css.icon} />}
          <span className={css.name}>{entry.name}</span>
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path}>
        <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }}>
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
          <span className={css.name}>{entry.name}</span>
        </button>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
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
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-files-row="failed">{failureLine(t, level.failure)}</li>}
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/**
 * The additional-root tree's body: the selected root and whatever the reader
 * has opened under it — the upstream body's scroll, seed, and render logic
 * verbatim, with the root arriving as a prop instead of `useSessions(cwd)`.
 */
export function FilesTree({
  tabId, sessionId, root, signal, useStore, actions, start, toggle, onOpen, t,
}: FilesTreeProps): ReactNode {
  const state = useStore(store => store.byTab[tabId])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
    }
  }, [seeded])
  // Scrolling only moves the ref; the store hears about it once, on unmount,
  // so a scroll neither re-renders the tree nor writes after the owner's
  // abort has forgotten the bucket.
  useEffect(() => () => {
    if (seeded && !signal.aborted) actions.scrolled(tabId, scrollTopRef.current)
  }, [seeded, signal, tabId, actions])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || signal.aborted) return
    start(tabId, root, signal)
  }, [state, root, tabId, signal, start])

  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    onToggle: (parent, path) => { toggle(tabId, parent, path, state.expanded, signal) },
    // Every row carries an absolute path; the address leaves cwd undefined so
    // the host resolves the file as written — a cwd here would relativize it
    // against the session's primary root and open the wrong file.
    onOpen: (path) => { onOpen(fileAddressFor(sessionId, undefined, path)) },
    t,
  }
  return (
    <div
      ref={bodyRef}
      className={css.body}
      onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
    >
      <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
    </div>
  )
}
