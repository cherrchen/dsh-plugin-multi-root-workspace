/**
 * The document-preview navigator's additional-root retarget.
 *
 * Upstream's `sidebar.files.navigator` Factory (`ui-sidebar-files`, added at
 * `0.2.2-alpha.3`) is the Folder-toggle tree the document preview draws
 * beside its body. Its root is hard-wired to the session's `cwd` — the
 * previewed file's absolute path is located against that root, so a file
 * that lives under an additional root lands outside every tree it can draw:
 * the navigator opens on the primary root, unexpanded and unmarked, the
 * primary root it was always going to show.
 *
 * The Factory itself cannot be retargeted — it is a registration upstream
 * already owns, and its root is not an input. What CAN move is what its
 * `aside[data-files-navigator]` draws: this occupant mounts in the preview
 * header's `sidebar.right.tab.document.actions` seat (owner prop
 * `absolutePath` — the previewed file's host path), watches the preview's
 * `[data-textpreview-content]` row for the aside, and when the file sits
 * under an available additional root it lends the aside's body area to the
 * forked tree, the same takeover the Files page's root switcher performs.
 * The aside itself — its width, its push/overlay/fill modes, its resize
 * separator — stays native; only the tree inside is the fork's.
 *
 * Three upstream behaviors are reproduced, not approximated:
 *
 * - **Hold lifetime.** The native navigator holds its pane tree only while
 *   it is open (`hold(paneId, cwd)` gated on `state.open`): closing the
 *   navigator closes the directory node — watches and listings end — while
 *   the pane record keeps `expanded` for the next open. Here the takeover
 *   `signal` is requested when the aside appears and ended when it leaves,
 *   and the occupant — which lives in the header and outlives the aside —
 *   keeps the last `expanded`/`scrollTop` snapshot, handed back to the tree
 *   as `saved` on the next open. Reopening restores expansion through the
 *   same restore-preferences mechanism upstream's `open()` uses.
 * - **Reveal.** The native navigator seeds `pane.revealing` with the drawn
 *   file's address and steps the walk open (ancestors expanded one listing
 *   at a time, then the file's row marked current and scrolled into view).
 *   The forked tree's `reveal` prop drives the same sequence against the
 *   additional root, keyed on `absolutePath`, so navigating the preview to
 *   another file re-reveals exactly like upstream's `answerNavigation`.
 * - **Replace-tab open.** The native navigator's `onOpen` is
 *   `tab.actions.openResource(address, { replaceTab: true })` — the opened
 *   file takes the preview's own tab. The forked tree's opens route through
 *   `openFileIn`, which spells the same intent to `openResourceIn` as
 *   `{ replaceTab: tabId }` against the preview's dockkit tab id.
 *
 * Every step degrades silently: no `[data-textpreview-url]` ancestor, no
 * dockkit tab id, no `panel`, a file outside every available additional
 * root (including the primary root's own files), an address naming another
 * session, or a fork that cannot render — each leaves the native navigator
 * completely untouched. Where the upstream hooks do not exist (a runtime
 * without this navigator), the marker span is the only trace the occupant
 * leaves, and it draws nothing.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/navigator
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { RootView } from '../../contract.ts'
import type { NativeTreeRenderer } from '../../compat/files-tree.ts'
import type { PanelClient } from '../panel-client.ts'
import { FilesTree, type FilesTreeSurface } from './adapter.tsx'
import { rootForPath } from './locate.ts'

/** What the registered document-actions occupant needs beyond the slot owner. */
export interface NavigatorRetargetProps {
  /** The previewed file's absolute host path — the slot owner's `absolutePath`. */
  readonly absolutePath: string
  /** This preview's session — the composed session share; absent without one. */
  readonly sessionId: string | undefined
  /** The channel client; absent when this composition has no host Connection. */
  readonly panel: PanelClient | undefined
  /**
   * The forked tree's shared props, or `undefined` where the fork cannot
   * render — the native navigator then keeps its tree, which is the same
   * behavior an upstream Files page without the fork would produce.
   */
  readonly filesTree: FilesTreeSurface | undefined
  readonly nativeTree?: NativeTreeRenderer | undefined
}

/** The portal's takeover record, mirroring {@link RootSwitcher}'s. */
interface Takeover {
  /** Lifetime handed to the tree's face: aborting forgets the bucket and closes the watch tree. */
  readonly signal: AbortSignal
  /** The store bucket's key — the preview's dockkit tab id where the hook exists, else a generated one. */
  readonly tabId: TabId
  /** The root the tree lists. */
  readonly root: string
}

/** The expansion and scroll memory one closed navigator hands to its next open. */
interface SavedTree {
  /** The root this snapshot belongs to; a stale snapshot never crosses roots. */
  readonly root: string
  /** Expansion preferences at the moment the navigator closed. */
  readonly expanded: readonly string[]
  /** The body's scroll offset at the moment it unmounted. */
  readonly scrollTop: number
}

/** Selector stand-in for a composition without the fork: nothing was ever listed. */
const noFilesStore: NonNullable<NavigatorRetargetProps['filesTree']>['useStore'] = () => undefined as never

/**
 * The marker that lives in the preview header and, while the file it names
 * sits under an additional root, lends the navigator aside to the forked
 * tree. It draws nothing of its own.
 */
export function NavigatorRetarget(props: NavigatorRetargetProps): ReactNode {
  const { absolutePath, sessionId, panel, filesTree } = props
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const fallbackTabId = useRef<TabId | undefined>(undefined)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)
  const savedRef = useRef<SavedTree | undefined>(undefined)
  const [preview, setPreview] = useState<HTMLElement | null>(null)
  const [tabId, setTabId] = useState<TabId | undefined>(undefined)
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const [root, setRoot] = useState<RootView | undefined>(undefined)
  const [takeover, setTakeover] = useState<Takeover | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestEpoch.current += 1
    }
  }, [])

  // Locate the preview root and the dockkit tab once, after mount — the
  // same pair of upstream hooks the Files-page switcher locates, read from
  // the marker's own position inside the preview header. The
  // `[data-textpreview-url]` ancestor also carries the tab's content id, the
  // cross-session check's evidence; no ancestor means this header is not an
  // upstream preview at all, and nothing below ever runs.
  useEffect(() => {
    const anchor = anchorRef.current
    const previewEl = anchor?.closest<HTMLElement>('[data-textpreview-url]') ?? null
    sectionRef.current = anchor?.closest<HTMLElement>('[data-dockkit-content]') ?? null
    const content = sectionRef.current?.dataset.dockkitContent
    setTabId((content !== undefined && content !== ''
      ? content
      : (fallbackTabId.current ??= `mrfw-nav-${Math.random().toString(36).slice(2)}` as TabId)) as TabId)
    setPreview(previewEl)
  }, [])

  // The root the previewed file belongs to: the session's registry view,
  // matched by the same under-root rule the native navigator uses — with
  // two guards on top. A session-scoped content id naming another session
  // never takes over a tree for a file this session cannot open, and a file
  // outside every available additional root — the primary root's own files
  // included — never takes over at all.
  useEffect(() => {
    if (preview === null || sessionId === undefined || sessionId === '' || panel === undefined) {
      setRoot(undefined)
      return
    }
    const address = preview.dataset.textpreviewUrl === undefined
      ? undefined
      : parseFileAddress(preview.dataset.textpreviewUrl)
    if (address?.scope === 'session' && address.sessionId !== sessionId) { setRoot(undefined); return }
    const epoch = ++requestEpoch.current
    let cancelled = false
    void panel.call('list', { sessionId }).then((view) => {
      if (cancelled || !mounted.current || epoch !== requestEpoch.current) return
      setRoot(rootForPath(view, absolutePath))
    }).catch(() => {
      // A failed list degrades to "no additional roots": the native
      // navigator keeps the file's preview exactly as upstream draws it.
      if (cancelled || !mounted.current || epoch !== requestEpoch.current) return
      setRoot(undefined)
    })
    return () => { cancelled = true }
  }, [preview, sessionId, panel, absolutePath])

  // The aside mounts only while the navigator is open, so its presence is
  // observed, not assumed: the content row the NavigatorSeat renders into
  // is watched for `aside[data-files-navigator]`. Mutations inside the
  // preview body re-run a one-selector query — cheap, and the only signal
  // the DOM offers for a Factory-drawn element it never names in a slot.
  useEffect(() => {
    if (preview === null) { setAside(null); return }
    const content = preview.querySelector<HTMLElement>('[data-textpreview-content]') ?? preview
    const query = (): void => { setAside(content.querySelector<HTMLElement>('aside[data-files-navigator]')) }
    query()
    const observer = new MutationObserver(query)
    observer.observe(content, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [preview])

  // The forked bucket's live expansion and scroll offset, kept current in a
  // ref so a navigator close can hand them to the next open. The occupant
  // outlives the aside — it sits in the header — so the memory survives the
  // close the bucket does not.
  const useFilesStore = filesTree?.useStore ?? noFilesStore
  const bucket = useFilesStore(store => (tabId === undefined ? undefined : store.byTab[tabId]))
  useEffect(() => {
    if (bucket !== undefined) savedRef.current = { root: bucket.root, expanded: bucket.expanded, scrollTop: bucket.scrollTop }
  }, [bucket])

  // The hold: while the aside exists AND the file belongs to an additional
  // root, the tree's lifetime is the aside's — exactly upstream's
  // `hold(paneId, cwd)` gated on the open flag. Ending it aborts the signal,
  // which forgets the bucket and closes the watch tree; `savedRef` carries
  // the expansion memory across to the next open, the fork's spelling of
  // `state.tree` surviving `pane.root?.close()`. The aside carries a marker
  // while held so the stylesheet hides only its native body.
  const rootPath = root?.path
  const takeoverCtl = filesTree?.takeover
  useEffect(() => {
    if (aside === null || rootPath === undefined || tabId === undefined || takeoverCtl === undefined) {
      setTakeover(null)
      return
    }
    setTakeover({ signal: takeoverCtl.signal(tabId, rootPath, sectionRef.current ?? undefined), tabId, root: rootPath })
    aside.setAttribute('data-mrfw-navigator', '')
    return () => {
      aside.removeAttribute('data-mrfw-navigator')
      takeoverCtl.end(tabId)
    }
  }, [aside, rootPath, tabId, takeoverCtl])

  return (
    <>
      {/* The anchor: an invisible header element whose position locates the
          preview root and dockkit tab. The document-actions seat wraps each
          occupant in the slot's own anchor, so this span must draw nothing
          and own nothing. */}
      <span ref={anchorRef} data-mrfw-navigator-anchor style={{ display: 'none' }} />
      {aside !== null && takeover !== null && filesTree !== undefined
        ? createPortal(
            <FilesTree
              tabId={takeover.tabId}
              sessionId={filesTree.sessionId}
              root={takeover.root}
              signal={takeover.signal}
              useStore={filesTree.useStore}
              actions={filesTree.actions}
              start={filesTree.face.start}
              toggle={filesTree.face.toggle}
              // The native navigator opens with `replaceTab: true` — the
              // file takes the preview's own tab; `openFileIn` spells the
              // same intent to `openResourceIn`.
              onOpen={address => { filesTree.openFileIn(takeover.tabId, address) }}
              t={filesTree.t}
              nativeTree={props.nativeTree}
              reveal={{ path: absolutePath }}
              saved={savedRef.current?.root === takeover.root ? savedRef.current : undefined}
            />,
            aside,
          )
        : null}
    </>
  )
}
