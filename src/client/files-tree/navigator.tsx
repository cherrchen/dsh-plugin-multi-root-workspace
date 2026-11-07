/**
 * The document-preview navigator's additional-root retarget.
 *
 * Upstream's `sidebar.files.navigator` Factory (`ui-sidebar-files`, added at
 * `0.2.2-alpha.3`) is the Folder-toggle tree the document preview draws
 * beside its body. Its root is hard-wired to the session's `cwd` — the
 * previewed file's absolute path is located against that root, so a file
 * that lives under an additional root lands outside every tree it can draw:
 * the navigator opens on the primary root, unexpanded and unmarked.
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
 * Everything is keyed by the dockkit PANE id (`data-files-navigator` on the
 * aside, `data-dockkit-pane` on the content section), never by the preview
 * tab: upstream's navigator records live in `store.byPane`, and the pane
 * survives what the tab does not — `replaceTab` mints a fresh tab id, so
 * opening a file from the retargeted tree destroys the preview tab that
 * opened it. The inject-side takeover map holds the pane-record memory
 * (`expanded`/`scrollTop`/`revealed`) across that death; the component's
 * own refs only ever carry the live copy.
 *
 * Three upstream behaviors are reproduced, not approximated:
 *
 * - **Hold lifetime.** The native navigator holds its pane tree only while
 *   it is open (`hold(paneId, cwd)` gated on `state.open`): closing the
 *   navigator closes the directory node — watches and listings end — while
 *   the pane record keeps `expanded`/`scrollTop`/`revealed` for the next
 *   open. Here the takeover `signal` is requested when the aside appears
 *   and ended when it leaves. The saved snapshot is written into the
 *   inject-side map continuously — the bucket's expansion set mirrors into
 *   it, the forked body reports its live scroll offset, and a settled
 *   reveal records its file — so no cleanup ordering ever decides what is
 *   remembered. A dockkit pane has no stable element (a non-empty pane's
 *   id rides on its selected tab's host, which `replaceTab` swaps out), so
 *   the owner's death is checked by query: the pane lives while some
 *   connected element still carries its id, and the watch that drops the
 *   memory outlives every `end` because the body's cleanup always wins
 *   the unmount race.
 * - **Reveal.** The native navigator seeds `pane.revealing` with the drawn
 *   file's address — unless `pane.revealed` already names it — and steps
 *   the walk open (ancestors expanded one listing at a time, then the
 *   file's row marked current and scrolled into view). The forked tree's
 *   `reveal` prop drives the same sequence against the additional root,
 *   with the saved `revealed` suppressing a repeat of a completed walk, so
 *   collapsing a directory and reopening the navigator keeps the reader's
 *   collapse exactly as upstream's pane record does.
 * - **Replace-tab open.** The native navigator's `onOpen` is
 *   `tab.actions.openResource(address, { replaceTab: true })` — the opened
 *   file takes the preview's own tab. The forked tree's opens route through
 *   `openFileIn`, which spells the same intent to `openResourceIn` as
 *   `{ replaceTab: tabId }` against the preview's dockkit tab id.
 *
 * Every step degrades silently: no `[data-textpreview-url]` ancestor, no
 * dockkit pane id, no `panel`, an address that is not a session file of
 * THIS session, a file outside every available additional root (the
 * primary root's own files included), or a fork that cannot render — each
 * leaves the native navigator completely untouched. Where the upstream
 * hooks do not exist (a runtime without this navigator), the marker span
 * is the only trace the occupant leaves, and it draws nothing.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/navigator
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
   * The forked tree's shared props; the registration gates on it, so the
   * occupant only renders where the fork can — the native navigator keeping
   * its tree is the same behavior an upstream Files page without the fork
   * would produce.
   */
  readonly filesTree: FilesTreeSurface
  readonly nativeTree?: NativeTreeRenderer | undefined
}

/** The portal's takeover record, mirroring {@link RootSwitcher}'s. */
interface Takeover {
  /** Lifetime handed to the tree's face: aborting forgets the bucket and closes the watch tree. */
  readonly signal: AbortSignal
  /** The store bucket's key — the dockkit pane id where the hook exists, else a generated one. */
  readonly paneId: TabId
  /** The root the tree lists. */
  readonly root: string
}

/**
 * The marker that lives in the preview header and, while the file it names
 * sits under an additional root, lends the navigator aside to the forked
 * tree. It draws nothing of its own.
 */
/**
 * A dockkit pane has no stable element: a non-empty pane's id rides on its
 * SELECTED tab's host (`data-dockkit-pane`), an empty pane's on its
 * `TabPanel`, and a floating pane's host carries `data-dockkit-float` —
 * `replaceTab` swaps the host while the pane lives on. The owner is
 * therefore alive while some connected element still carries its id.
 * @param id - the dockkit pane id the aside announced.
 * @returns whether the document still contains a carrier of the id.
 */
function paneAlive(id: string): boolean {
  for (const element of document.querySelectorAll<HTMLElement>('[data-dockkit-pane],[data-dockkit-float]')) {
    if (element.dataset.dockkitPane === id || element.dataset.dockkitFloat === id) return true
  }
  return false
}

export function NavigatorRetarget(props: NavigatorRetargetProps): ReactNode {
  const { absolutePath, sessionId, panel, filesTree } = props
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const fallbackPaneId = useRef<TabId | undefined>(undefined)
  // Whether the pane id came from a real carrier attribute — the generated
  // fallback names a pane no element can carry, so arming the death watch
  // on it would drop the takeover the moment it was born.
  const paneIdentified = useRef(false)
  const mounted = useRef(true)
  const [preview, setPreview] = useState<HTMLElement | null>(null)
  const [tabId, setTabId] = useState<TabId | undefined>(undefined)
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const [paneId, setPaneId] = useState<TabId | undefined>(undefined)
  const [root, setRoot] = useState<RootView | undefined>(undefined)
  const [takeover, setTakeover] = useState<Takeover | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Locate the preview root, the dockkit tab, and the pane once, after
  // mount — the upstream hooks the Files-page switcher locates, read from
  // the marker's own position inside the preview header. The
  // `[data-textpreview-url]` ancestor also carries the address the
  // cross-session check reads; no ancestor means this header is not an
  // upstream preview at all, and nothing below ever runs.
  useEffect(() => {
    const anchor = anchorRef.current
    const previewEl = anchor?.closest<HTMLElement>('[data-textpreview-url]') ?? null
    sectionRef.current = anchor?.closest<HTMLElement>('[data-dockkit-content]') ?? null
    const content = sectionRef.current?.dataset.dockkitContent
    setTabId((content !== undefined && content !== ''
      ? content
      : (fallbackPaneId.current ??= `mrfw-nav-${Math.random().toString(36).slice(2)}` as TabId)) as TabId)
    setPreview(previewEl)
  }, [])

  // The aside mounts only while the navigator is open, so its presence is
  // observed, not assumed: the content row the NavigatorSeat renders into
  // is watched for `aside[data-files-navigator]`. A live aside skips the
  // re-query — the forked rows mounting inside it would otherwise re-run a
  // selector on every level.
  const asideRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (preview === null) { setAside(null); return }
    const content = preview.querySelector<HTMLElement>('[data-textpreview-content]') ?? preview
    const query = (): void => {
      const current = asideRef.current
      if (current !== null && current.isConnected) return
      const found = content.querySelector<HTMLElement>('aside[data-files-navigator]')
      if (found !== current) {
        asideRef.current = found
        setAside(found)
      }
    }
    query()
    const observer = new MutationObserver(query)
    observer.observe(content, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      asideRef.current = null
    }
  }, [preview])

  // The pane id arrives with the aside (upstream writes it unconditionally);
  // the content section's own `data-dockkit-pane` is the backup, present
  // while this tab is the pane's selected one — the only state an occupant
  // can observe from. A generated fallback still keys correctly, just
  // without cross-tab continuity. Both attributes are mutable IN PLACE —
  // dragging the preview tab to another pane rewrites them on the same
  // elements — so they are observed, not read once: a change re-keys the
  // takeover, the bucket, and the saved memory under the new pane while the
  // old pane keeps whatever it had saved for itself.
  useEffect(() => {
    if (aside === null) return
    const read = (): void => {
      const identified = aside.dataset.filesNavigator ?? sectionRef.current?.dataset.dockkitPane
      paneIdentified.current = identified !== undefined && identified !== ''
      setPaneId((identified !== undefined && identified !== ''
        ? identified
        : (fallbackPaneId.current ??= `mrfw-nav-${Math.random().toString(36).slice(2)}` as TabId)) as TabId)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(aside, { attributes: true, attributeFilter: ['data-files-navigator'] })
    const section = sectionRef.current
    if (section !== null) observer.observe(section, { attributes: true, attributeFilter: ['data-dockkit-pane'] })
    return () => { observer.disconnect() }
  }, [aside])

  // The root the previewed file belongs to: the session's registry view,
  // matched by the same under-root rule the native navigator uses. The
  // address is required to be a session file of THIS session — the same
  // gate upstream's `relativeFileOf` runs — and the list is re-asked each
  // time the aside opens and each time the previewed file changes while
  // it is open, so a root added or removed between opens never feeds a
  // stale match. No aside means no takeover is possible, so no list is
  // asked either.
  useEffect(() => {
    if (preview === null || aside === null || sessionId === undefined || sessionId === '' || panel === undefined) {
      setRoot(undefined)
      return
    }
    const address = preview.dataset.textpreviewUrl === undefined
      ? undefined
      : parseFileAddress(preview.dataset.textpreviewUrl)
    if (address?.scope !== 'session' || address.sessionId !== sessionId) { setRoot(undefined); return }
    const controller = new AbortController()
    void panel.call('list', { sessionId }, controller.signal).then((view) => {
      if (controller.signal.aborted || !mounted.current) return
      setRoot(rootForPath(view, absolutePath))
    }).catch(() => {
      // A failed list degrades to "no additional roots": the native
      // navigator keeps the file's preview exactly as upstream draws it.
      if (controller.signal.aborted || !mounted.current) return
      setRoot(undefined)
    })
    return () => { controller.abort() }
  }, [preview, aside, sessionId, panel, absolutePath])

  // The pane-record memory is written continuously, not at cleanup: the
  // bucket's expansion set mirrors into the inject-side map on every
  // update — gated on the live takeover's root so the window between a
  // root switch and the new hold cannot stamp the old root's set under
  // the new one — and the forked body reports its live scroll offset as
  // upstream's `scrolled` keeps `pane.scrollTop`. What the map holds is
  // therefore always the live value; ending the hold only ends the hold,
  // and nothing a cleanup writes can resurrect a dropped record.
  const rootPath = root?.path
  const takeoverCtl = filesTree.takeover
  const bucket = filesTree.useStore(store => (paneId === undefined ? undefined : store.byTab[paneId]))
  useEffect(() => {
    if (bucket !== undefined && takeover !== null && paneId !== undefined && takeover.paneId === paneId && takeover.root === rootPath) {
      takeoverCtl.save(paneId, { root: takeover.root, expanded: bucket.expanded })
    }
  }, [bucket, takeover, paneId, rootPath, takeoverCtl])

  // The body's live scroll offset, reported by the fork itself through
  // `onScrollOffset` — the fork's store only hears the offset on body
  // unmount, but the pane record wants the value at close time, the same
  // live `pane.scrollTop` upstream's `scrolled` maintains.
  const onScrollOffset = useCallback((offset: number): void => {
    if (paneId !== undefined && rootPath !== undefined) {
      takeoverCtl.save(paneId, { root: rootPath, scrollTop: offset })
    }
  }, [takeoverCtl, paneId, rootPath])

  // The hold: while the aside exists AND the file belongs to an additional
  // root, the tree's lifetime is the aside's — exactly upstream's
  // `hold(paneId, cwd)` gated on the open flag. Ending it aborts the
  // signal, which forgets the bucket and closes the watch tree; the saved
  // memory was written continuously, so the `end` carries no snapshot and
  // the death watch — armed on the pane-carrier query, not on any element
  // — owns the only drop. The aside carries a marker while held so the
  // stylesheet hides only its native body.
  const savedTree = paneId === undefined || rootPath === undefined ? undefined : takeoverCtl.saved(paneId, rootPath)
  useEffect(() => {
    if (aside === null || rootPath === undefined || paneId === undefined || takeoverCtl === undefined) {
      setTakeover(null)
      return
    }
    setTakeover({
      signal: takeoverCtl.signal(paneId, rootPath, paneIdentified.current ? () => paneAlive(paneId) : undefined),
      paneId,
      root: rootPath,
    })
    aside.setAttribute('data-mrfw-navigator', '')
    const capturedPaneId = paneId
    return () => {
      aside.removeAttribute('data-mrfw-navigator')
      takeoverCtl.end(capturedPaneId)
    }
  }, [aside, rootPath, paneId, takeoverCtl])

  const onRevealSettled = useCallback((path: string): void => {
    if (paneId !== undefined && rootPath !== undefined) {
      takeoverCtl.save(paneId, { root: rootPath, revealed: path })
    }
  }, [takeoverCtl, paneId, rootPath])

  return (
    <>
      {/* The anchor: an invisible header element whose position locates the
          preview root, the dockkit tab, and the pane. The document-actions
          seat wraps each occupant in the slot's own anchor, so this span
          must draw nothing and own nothing. */}
      <span ref={anchorRef} data-mrfw-navigator-anchor style={{ display: 'none' }} />
      {aside !== null && takeover !== null
        ? createPortal(
            <FilesTree
              tabId={takeover.paneId}
              sessionId={filesTree.sessionId}
              root={takeover.root}
              signal={takeover.signal}
              useStore={filesTree.useStore}
              actions={filesTree.actions}
              start={filesTree.face.start}
              toggle={filesTree.face.toggle}
              // The native navigator opens with `replaceTab: true` — the
              // file takes the preview's own tab; `openFileIn` spells the
              // same intent to `openResourceIn`. A composition without the
              // dockkit content hook has no tab to replace, so the row
              // degrades to the plain open route like any other consumer.
              onOpen={address => {
                if (tabId === undefined) filesTree.openFile(address)
                else filesTree.openFileIn(tabId, address)
              }}
              t={filesTree.t}
              nativeTree={props.nativeTree}
              onScrollOffset={onScrollOffset}
              reveal={{ path: absolutePath, revealed: savedTree?.revealed, onSettled: onRevealSettled }}
              saved={savedTree}
            />,
            aside,
          )
        : null}
    </>
  )
}
