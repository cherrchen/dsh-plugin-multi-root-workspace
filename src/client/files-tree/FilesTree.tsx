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
     * The owner's live scroll mirror — upstream's `scrolled` writing
     * `pane.scrollTop`: fired on every scroll and once more at unmount with
     * the body's final offset (the adapter refuses the write when the owner
     * is already dead, so a normal close keeps its last position while a
     * killed one cannot resurrect). The fork's own store still hears the
     * offset only at unmount through `actions.scrolled`, as upstream.
     */
    readonly onScrollOffset?: ((offset: number) => void) | undefined
    /**
     * The preview navigator's locate-current-file request: expand the file's
     * ancestors, mark its row current, and scroll it into view — what the
     * native navigator's `revealing`/`step()`/`revealed` does with
     * `pane.current` and `scrollToCurrent`. `revealed` is the owner's memory
     * of the last completed walk: a path equal to it suppresses stepping —
     * exactly upstream's `revealing = revealed === address ? undefined :
     * address` on a body mount — while `onSettled` reports each completed
     * walk (found, unreachable, or canceled) so the owner can record it.
     * Absent on the Files page, which has no current file.
     */
    readonly reveal?: {
      readonly path: string
      readonly revealed?: string | undefined
      readonly onSettled?: ((path: string) => void) | undefined
    } | undefined
    /**
     * Expansion, scroll offset, and reveal memory saved while this tree's
     * owner was closed — the pane record's surviving `expanded`/`scrollTop`/
     * `revealed` upstream. `expanded` is replayed through `toggle` (the
     * verbatim face's own restore-preferences channel) right after `start`,
     * so every remembered directory re-expands as its level lands; the
     * scroll offset is deferred until the body overflows, and `revealed`
     * seeds the reveal's suppression.
     */
    readonly saved?: {
      readonly expanded?: readonly string[]
      readonly scrollTop?: number
      readonly revealed?: string
    } | undefined
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
  tabId, sessionId, root, signal, useStore, actions, start, toggle, onOpen, t, nativeTree, reveal, saved, onScrollOffset,
}: FilesTreeProps): ReactNode {
  const state = useStore(store => store.byTab[tabId])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // The reveal's current mark — the row key `locateFile` can name; kept in
  // sync even while stepping so a suppressed or finished walk still marks.
  const [current, setCurrent] = useState<string | undefined>(undefined)
  // The walk state, spelled like upstream's pane record: `key` is the
  // in-flight target (`revealing`), `settled`/`canceled` mark its end, and
  // `seed` is the target's remembered `revealed` — suppressed once, then
  // spent, because upstream's `revealed` is live rather than mount-frozen.
  const walk = useRef<{ key: string | undefined; settled: boolean; canceled: boolean }>({ key: undefined, settled: false, canceled: false })
  const revealSeed = useRef(saved?.revealed)
  // The `(root, reveal path)` identity the seed belongs to. The component
  // outlives a root switch (the tree is re-rooted by props), so a seed read
  // once at mount would replay the first root's memory on every return; a
  // new identity re-reads its own snapshot instead, while store updates
  // under the same identity leave the live seed alone.
  const seededKey = useRef<string | undefined>(undefined)
  // Upstream's `scrollToCurrent`: a settled walk scrolls the row into view
  // the next time it mounts — and only then; unrelated remounts never
  // yank the view.
  const wantScroll = useRef(false)
  const currentRef = useCallback((row: unknown) => {
    if (row instanceof HTMLElement && wantScroll.current) {
      wantScroll.current = false
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [])
  const revealPath = reveal?.path
  const revealSaved = saved?.revealed
  const revealOnSettled = reveal?.onSettled
  // The reveal target's identity for the whole walk — encoded, so a root
  // and a path can never smear into another pair's spelling.
  const revealKey = revealPath === undefined || state === undefined
    ? undefined
    : JSON.stringify([state.root, revealPath])
  // The native navigator's `step()`: while a walk is in flight, expand the
  // first unexpanded ancestor each pass — store updates landing underneath
  // re-run the effect — then settle (`revealing` cleared, `revealed`
  // recorded). Once settled or suppressed there is no walk to step: the
  // mark alone follows the loaded levels.
  useEffect(() => {
    if (revealPath === undefined || revealKey === undefined || state === undefined || signal.aborted) {
      // No live identity: the next one starts from its own snapshot.
      seededKey.current = undefined
      setCurrent(undefined)
      return
    }
    if (walk.current.key !== revealKey || seededKey.current !== revealKey) {
      // A different (root, path) pair — or a fresh bucket for the same one:
      // seed from that pair's snapshot, never from the live seed of the pair
      // this body last walked. Upstream's `revealing = revealed === address
      // ? undefined : address` is the model; this snapshot is per
      // (pane, root), so entering a pair has to re-read it.
      walk.current = { key: revealKey, settled: false, canceled: false }
      revealSeed.current = revealSaved
      seededKey.current = revealKey
      wantScroll.current = false
    }
    const relative = relativeUnderRoot(revealPath, state.root)
    if (relative === undefined) {
      // The preview already names another root and the takeover is about to
      // re-key: settling here would record the other root's address as this
      // root's `revealed`, smearing the two roots' memories.
      setCurrent(undefined)
      return
    }
    const location = locateFile(state, relative)
    if (walk.current.settled || walk.current.canceled || revealSeed.current === revealPath) {
      setCurrent(location?.current)
      return
    }
    const next = location?.ancestors.find(ancestor => !state.expanded.includes(ancestor.path))
    if (location !== undefined && next !== undefined) {
      toggle(tabId, next.parent, next.path, state.expanded, signal)
      setCurrent(undefined)
      return
    }
    if (location?.pending === true) return
    walk.current.settled = true
    revealSeed.current = undefined
    revealOnSettled?.(revealPath)
    if (location?.current !== undefined) wantScroll.current = true
    setCurrent(location?.current)
  }, [revealKey, state, tabId, signal, toggle, revealPath, revealOnSettled, revealSaved])
  const pendingScroll = useRef(0)
  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0. The
  // focus handoff mirrors the native body taking the pane's focus: when the
  // takeover hid a focused native body, the forked one — sitting in the
  // same aside as the body's own parent — takes it over.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
      // The handoff mirrors the native body taking the pane's focus — but
      // only when the takeover's hidden native body was the focused one:
      // the fork's parent can be a whole page (header controls included),
      // which must never lose focus to the fork.
      const nativeBody = body.parentElement?.querySelector('[data-files-body]')
      if (nativeBody?.contains(body.ownerDocument.activeElement) === true) body.focus()
    }
  }, [seeded])
  // The offset a closed owner left behind can only land once the reseeded
  // body overflows — reseeding drops every level, so the first layout is
  // always short. It is declared after the seeded restore so the bucket's
  // own `scrollTop` — 0 on a fresh reseed — never overwrites it when both
  // fire on the same commit. An in-flight walk owns the view instead (its
  // current row wins), matching upstream's restore-then-reveal-scroll
  // ordering. The verdict is read for the identity the commit runs under,
  // the same way the reveal effect will read it after the commit: an
  // identity that has not been seeded yet (a root switch, or a fresh
  // bucket) lets the snapshot decide — a remembered reveal means the saved
  // offset lands, a new walk means it owns the viewport. Reading the
  // previous identity's unsettled refs here would cancel a restore the
  // suppressed new identity should have let through.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || pendingScroll.current <= 0) return
    const seededIdentity = seededKey.current === revealKey
    const seed = seededIdentity ? revealSeed.current : revealSaved
    const inFlight = revealPath !== undefined
      && !(seededIdentity && (walk.current.settled || walk.current.canceled))
      && seed !== revealPath
    if (inFlight || body.scrollHeight > body.clientHeight) {
      if (!inFlight) {
        body.scrollTop = pendingScroll.current
        scrollTopRef.current = body.scrollTop
      }
      pendingScroll.current = 0
    }
  })
  // The scroll mirror is a native listener, not React's onScroll: the body
  // can be portaled outside its React root's container, where delegated
  // events never reach — a listener on the body itself always fires.
  // Scrolling only moves the ref; the store hears about it once, on
  // unmount, so a scroll neither re-renders the tree nor writes after the
  // owner's abort has forgotten the bucket. The owner's live mirror hears
  // it too — and once more at unmount with the final offset, even when the
  // abort already silenced the store write.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const scroll = (): void => {
      // An offset the ref does not know is the reader's own scroll — a
      // deferred restore must not land on top of it. Programmatic writes
      // update the ref synchronously, so their (asynchronous) scroll event
      // never cancels a pending restore.
      if (body.scrollTop !== scrollTopRef.current && pendingScroll.current > 0) pendingScroll.current = 0
      scrollTopRef.current = body.scrollTop
      onScrollOffset?.(scrollTopRef.current)
    }
    body.addEventListener('scroll', scroll, { passive: true })
    return () => { body.removeEventListener('scroll', scroll) }
  }, [seeded, onScrollOffset])
  useEffect(() => () => {
    // The store write stays gated — `scrolled` would reseed the forgotten
    // bucket — but the owner's mirror reports the final offset on every
    // unmount: a closed takeover's last scroll event may never have fired
    // (pending events die with the detached body), and the adapter refuses
    // writes whose owner is already dead, so reporting unconditionally is
    // what keeps a normal close's last offset.
    if (seeded && !signal.aborted) actions.scrolled(tabId, scrollTopRef.current)
    onScrollOffset?.(scrollTopRef.current)
  }, [seeded, signal, tabId, actions, onScrollOffset])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || signal.aborted) return
    start(tabId, root, signal)
    // The owner-closed memory lands behind the seed through the verbatim
    // `toggle` — its `root.setExpanded(next)` is upstream's own
    // restore-preferences channel. Every remembered directory re-expands in
    // saved order (parents always precede their children there), exactly
    // like the `relisting` upstream runs on its kept `expanded`; the nested
    // ones' `toggled` writes land them in `expanded` so the rows draw open.
    if (saved?.expanded !== undefined) {
      for (const path of saved.expanded) {
        if (path === root || relativeUnderRoot(path, root) === undefined) continue
        toggle(tabId, path.slice(0, path.lastIndexOf('/')), path, saved.expanded.filter(value => value !== path), signal)
      }
    }
    if (saved?.scrollTop !== undefined) pendingScroll.current = saved.scrollTop
  }, [state, root, tabId, signal, start, toggle, saved, actions])

  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    onToggle: (parent, path) => {
      // The native navigator settles an in-flight reveal the moment the
      // reader collapses anything (`manual && collapsing → revealed =
      // revealing`): the walk stops wherever it stands instead of
      // re-opening what the reader just closed. A collapse that lands
      // before the reveal effect has run — the request already changed,
      // the ref still names the old key — pre-cancels the walk it would
      // have started, so the effect's key reset cannot resurrect it. The
      // suppression verdict uses the seed the rendered identity carries: a
      // pair already revealed has no walk to cancel.
      const seededIdentity = seededKey.current === revealKey
      const seed = seededIdentity ? revealSeed.current : revealSaved
      if (revealPath !== undefined && revealKey !== undefined && seed !== revealPath
          && state.expanded.includes(path)
          && (!seededIdentity || (!walk.current.settled && !walk.current.canceled))) {
        if (!seededIdentity) walk.current = { key: revealKey, settled: false, canceled: true }
        else walk.current.canceled = true
        revealSeed.current = undefined
        revealOnSettled?.(revealPath)
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
      // The native body is `tabIndex={-1}` — the pane's focus handoff lands
      // on it; the fork keeps the same reachability.
      tabIndex={-1}
    >
      {content}
    </div>
  )
}
