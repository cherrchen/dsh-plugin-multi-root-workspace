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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { nativeTreeInput, type NativeTreeRenderer } from '../../compat/files-tree.ts'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import { locateFile, relativeUnderRoot } from './locate.ts'
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
    /** Optional host-controlled tree Factory, available on the newer Files page. */
    readonly nativeTree?: NativeTreeRenderer | undefined
    /**
     * The preview navigator's locate-current-file request: expand the file's
     * ancestors, mark its row current, and scroll it into view — what the
     * native navigator's `revealing`/`step()` does with `pane.current`. The
     * sequence keys on the absolute path; a new preview of the same path
     * settles the same way, so no revision is needed. Absent on the Files
     * page, which has no current file.
     */
    readonly reveal?: { readonly path: string } | undefined
    /**
     * Expansion and scroll offset saved while this tree's owner was closed
     * — the preview navigator's close/reopen memory, matching the pane
     * record's surviving `expanded`/`scrollTop` upstream. Applied once,
     * right after `start`, while the root's listing is still in flight, so
     * the remembered directories re-expand as their levels land.
     */
    readonly saved?: { readonly expanded?: readonly string[]; readonly scrollTop?: number } | undefined
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

/** What every level shares: the tab's tree, the two gestures, and the reveal's marks. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
  /** The revealed file's tree key while its row is the current one. */
  readonly current: string | undefined
  /** Callback ref for the current row's button — the reveal's scroll target. */
  readonly currentRef: ((row: unknown) => void) | undefined
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
          ref={current ? tree.currentRef : undefined}
          data-files-current={current ? '' : undefined}
          aria-current={current ? true : undefined}
        >
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
  tabId, sessionId, root, signal, useStore, actions, start, toggle, onOpen, t, nativeTree, reveal, saved,
}: FilesTreeProps): ReactNode {
  const state = useStore(store => store.byTab[tabId])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // The reveal's settled mark — the row key `locateFile` reached once every
  // ancestor was expanded; `undefined` while the walk is still underway.
  const [current, setCurrent] = useState<string | undefined>(undefined)
  // Expand requests dispatched for the active reveal target — plus the
  // manual-collapse flag upstream calls the reveal's cancellation — so a
  // store update that left the ancestor unexpanded cannot dispatch it
  // forever, and a reader closing a directory mid-walk stops the walk.
  const requested = useRef<{ key: string | undefined; paths: Set<string>; canceled: boolean }>({ key: undefined, paths: new Set(), canceled: false })
  // The target key the walk last settled on; a manual collapse cancels only
  // an unsettled walk, never a mark already placed.
  const settledKey = useRef<string | undefined>(undefined)
  // The native navigator scrolls the current row into view as its button
  // mounts (`currentRef`); a stable callback means only mounts fire it.
  const currentRef = useCallback((row: unknown) => {
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' })
  }, [])
  const revealPath = reveal?.path
  // The reveal target's identity for the whole walk — encoded, so a root
  // and a path can never smear into another pair's spelling.
  const revealKey = revealPath === undefined || state === undefined
    ? undefined
    : JSON.stringify([state.root, revealPath])
  // The native navigator's `revealing`/`step()`: walk the listed levels
  // toward the previewed file, expanding the first unexpanded ancestor each
  // pass. The store updates landing underneath re-run the effect until
  // every ancestor is open and the walk settles, then the file's row is
  // current. A file outside the root, or a path the walk cannot reach,
  // settles with no mark — the same end the native walk reaches.
  useEffect(() => {
    if (revealPath === undefined || revealKey === undefined || state === undefined || signal.aborted) { setCurrent(undefined); return }
    if (requested.current.key !== revealKey) requested.current = { key: revealKey, paths: new Set(), canceled: false }
    // Upstream marks the target revealed and stops stepping the moment the
    // reader collapses anything mid-walk; the flag lands in `tree.onToggle`.
    if (requested.current.canceled) { settledKey.current = revealKey; return }
    const relative = relativeUnderRoot(revealPath, state.root)
    const location = relative === undefined ? undefined : locateFile(state, relative)
    const next = location?.ancestors.find(ancestor => !state.expanded.includes(ancestor.path))
    if (location !== undefined && next !== undefined && !requested.current.paths.has(next.path)) {
      requested.current.paths.add(next.path)
      toggle(tabId, next.parent, next.path, state.expanded, signal)
      setCurrent(undefined)
      return
    }
    // `pending` means a level on the way is still listing; `next` still
    // unexpanded after its request means the expand was dropped (the parent
    // node is not live) — both end like a directory that failed: no mark.
    const settled = location === undefined || location.pending || next !== undefined ? undefined : location.current
    if (location === undefined || !location.pending) settledKey.current = revealKey
    setCurrent(settled)
  }, [revealKey, state, tabId, signal, toggle])
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
    // The owner-closed memory lands behind the seed through the verbatim
    // `toggle`: each saved root-level directory is re-opened with the whole
    // snapshot as its expansion prefs — the `root.setExpanded(next)` inside
    // `toggle` is upstream's own restore channel, so nested directories
    // follow as their parents' listings land, exactly like the kept
    // `expanded` upstream hands a fresh directory node. The scroll offset
    // waits for the seeded body's first layout to claim it.
    if (saved?.expanded !== undefined) {
      for (const path of saved.expanded) {
        const relative = relativeUnderRoot(path, root)
        if (relative !== undefined && !relative.includes('/')) {
          toggle(tabId, root, path, saved.expanded.filter(value => value !== path), signal)
        }
      }
    }
    if (saved?.scrollTop !== undefined && saved.scrollTop > 0) actions.scrolled(tabId, saved.scrollTop)
  }, [state, root, tabId, signal, start, toggle, saved, actions])

  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    onToggle: (parent, path) => {
      // The native navigator treats any manual collapse during an
      // unsettled reveal as the reveal's cancellation (`revealed =
      // revealing`): the walk stops wherever it stands instead of
      // re-opening what the reader just closed.
      if (revealKey !== undefined && state.expanded.includes(path) && settledKey.current !== revealKey) {
        if (requested.current.key !== revealKey) requested.current = { key: revealKey, paths: new Set(), canceled: true }
        else requested.current.canceled = true
      }
      toggle(tabId, parent, path, state.expanded, signal)
    },
    // Every row carries an absolute path; the address leaves cwd undefined so
    // the host resolves the file as written — a cwd here would relativize it
    // against the session's primary root and open the wrong file.
    onOpen: (path) => { onOpen(fileAddressFor(sessionId, undefined, path)) },
    t,
    current,
    currentRef,
  }
  const legacy = <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
  const content = nativeTree === undefined ? legacy : nativeTree(
    'sidebar.files.tree',
    nativeTreeInput(state, failure => failureLine(t, failure), tree.onToggle, tree.onOpen,
      current === undefined ? undefined : { path: current, ref: currentRef }),
    { fallback: legacy },
  ) as ReactNode
  return (
    <div
      ref={bodyRef}
      className={css.body}
      onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
    >
      {content}
    </div>
  )
}
