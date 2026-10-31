/**
 * The Files-tab root switcher — the entry that took over the header position
 * the P1 gear launcher first claimed. It poses as the pane's path label: a
 * trigger that opens a menu of this session's roots (primary first, the
 * registered additional roots next, and the Workspace Folders manager last),
 * followed by a `PathLabel` of the selected root's full path — the same
 * component upstream draws in that spot, so both primary and additional
 * selections read exactly like the native header. While an additional root
 * is selected it also lends the pane's body area to this plugin's verbatim
 * fork of the native Files tree (`files-tree/`), so an additional root reads
 * and behaves exactly like the primary one.
 *
 * Two upstream DOM hooks make the takeover work, and both degrade silently:
 *
 * - The stylesheet rules: while `.mrfw-rootSwitcher` exists inside a
 *   `[data-files-root]` pane the upstream `data-files-path` is hidden and the
 *   switcher takes its flex position; while the switcher carries
 *   `data-root-kind="additional"` the native `data-files-body`,
 *   `data-files-reload`, and `data-open-target="directory"` split button
 *   hide too (the reload refreshes the very tree that is no longer
 *   visible, and the native open-in-app button only ever receives the
 *   primary root through its slot props — the header gets a
 *   `.mrfw-switcherReload` replacement and the plugin's verbatim fork of
 *   the open-in-app control, pointed at the selected root). Upstream
 *   changing that DOM shape simply stops the selectors from matching — the
 *   native header keeps working and the switcher is just another actions
 *   occupant.
 * - `closest('[data-files-root]')` from the switcher's own element locates
 *   the pane the forked Files tree is portaled into, as a sibling of
 *   `data-files-body`. No match → no portal: the component keeps working as
 *   a menu and the native tree keeps its area. The tree's tab id comes from
 *   the same element's `closest('[data-dockkit-content]')` — the dockkit
 *   tabHost section — with a generated fallback where the hook is absent.
 *
 * The selected root lives in the inject product's session-scoped snapshot,
 * keyed by that dockkit tab id — component state could not survive the
 * remount every file open causes (the opened tab takes the pane, the Files
 * body unmounts with the whole occupant subtree). One selection per tab;
 * session switches mint a fresh inject product, so no selection crosses
 * sessions, and a registry eviction reconciles it back to primary.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/RootSwitcher
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { IconChevronDown, IconFolderClose, IconFolderOpen, IconRefresh, IconSettings, maybeComponent } from '../compat/client-icons.ts'
import type { RootsView, RootView } from '../contract.ts'
import { FilesTree, type FilesTreeSurface } from './files-tree/adapter.tsx'
import { OpenInAppAction, type OpenInAppAdapter } from './open-in-app/adapter.tsx'
import {
  basename,
  displayNameOf,
  stateKey,
  WorkspaceFoldersDialog,
  type WorkspaceFoldersActionProps,
} from './WorkspaceFoldersAction.tsx'

/** What the registered Files-actions occupant needs beyond the slot owner. */
export interface RootSwitcherProps extends Omit<WorkspaceFoldersActionProps, 'compact' | 'wide'> {
  /** This pane's workspace root, carried by the slot owner's `absolutePath`. */
  readonly primaryPath: string
  /**
   * The forked open-in-app control's shared props, or `undefined` where the
   * fork cannot render (an undefined adapter is upstream's own "no button"
   * state, so the switcher just draws nothing there too).
   */
  readonly openInApp?: OpenInAppAdapter | undefined
  /**
   * The forked Files tree's shared props, or `undefined` where the fork
   * cannot render — the additional-root rows then stay out of the menu at
   * all, which is the same absence upstream's own tree produces.
   */
  readonly filesTree?: FilesTreeSurface | undefined
}

/** The takeover's portal + lifetime, created while an additional root browses. */
interface Takeover {
  /** Lifetime handed to the tree's face: aborting forgets the store bucket and closes the watches. */
  readonly signal: AbortSignal
  /** The store bucket's key — the dockkit tab id where the hook exists, else a generated one. */
  readonly tabId: TabId
  /** The root the tree lists. */
  readonly root: string
}

/**
 * The subdued full-path label upstream's Files header draws — it exists from
 * `0.1.7-alpha.1` on. A pixel-era runtime has no such export, so the probe
 * returns `undefined` and the header falls back to a plain titled span: the
 * path stays readable and hoverable, only the dir/file typography differs.
 */
const PathLabel = maybeComponent<(props: { path: string; className?: string | undefined }) => ReactNode>(['PathLabel'])

/** Selector hook for a composition without the fork: nothing was ever selectable. */
const noTreeSelection: NonNullable<RootSwitcherProps['filesTree']>['useTreeSelection'] = () => undefined as never

/** The Files-header switcher: root menu, dialog entry, and the portal tree. */
export function RootSwitcher(props: RootSwitcherProps): ReactNode {
  const { panel, t, primaryPath, filesTree } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [view, setView] = useState<RootsView | undefined>(undefined)
  const [takeover, setTakeover] = useState<Takeover | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const fallbackTabId = useRef<TabId | undefined>(undefined)
  const sectionRef = useRef<HTMLElement | null>(null)
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const [tabId, setTabId] = useState<TabId | undefined>(undefined)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestEpoch.current += 1
    }
  }, [])

  // Locate the pane and the dockkit tab once, after mount. The
  // `[data-dockkit-content]` section outlives every hide/remount cycle of the
  // body — only the tab record's end removes it — so it keys the persisted
  // selection and answers the takeover's deferred end check. Finding no
  // `[data-files-root]` ancestor is the supported degradation: nothing is
  // portaled, and the stylesheet rules that would hide the native body match
  // nothing either.
  useEffect(() => {
    const wrapper = wrapperRef.current
    sectionRef.current = wrapper?.closest<HTMLElement>('[data-dockkit-content]') ?? null
    const content = sectionRef.current?.dataset.dockkitContent
    setTabId((content !== undefined && content !== ''
      ? content
      : (fallbackTabId.current ??= `mrfw-${Math.random().toString(36).slice(2)}` as TabId)) as TabId)
    setPane(wrapper?.closest<HTMLElement>('[data-files-root]') ?? null)
  }, [])

  // The persisted selection, keyed by this pane's tab id; an absent entry is
  // the primary root. The bound hook is stable across renders, so the
  // filesTree gate only ever picks the noop stand-in where the fork cannot
  // mount at all — and no additional root can be selected there anyway.
  const useTreeSelection = filesTree?.useTreeSelection ?? noTreeSelection
  const stored = useTreeSelection(selection => (tabId === undefined ? undefined : selection[tabId]))
  const selected: RootView | 'primary' = stored ?? 'primary'
  const selectRoot = filesTree?.selectRoot
  const setSelected = useCallback((next: RootView | 'primary'): void => {
    if (selectRoot === undefined || tabId === undefined) return
    selectRoot(tabId, next)
  }, [selectRoot, tabId])

  const refresh = useCallback(async (): Promise<void> => {
    if (panel === undefined) { setView(undefined); return }
    const session = props.sessionId?.()
    if (session === undefined || session === '') { setView(undefined); return }
    const epoch = ++requestEpoch.current
    try {
      const next = await panel.call('list', { sessionId: session })
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== session) return
      setView(next)
    } catch {
      // A failed list degrades to "primary only": the menu keeps working and
      // the trigger still mirrors the pane path. The dialog reports channel
      // failures itself, so the switcher stays silent here on purpose.
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== session) return
      setView(undefined)
    }
  }, [panel, props.sessionId])

  useEffect(() => { void refresh() }, [refresh])

  // A session change makes the whole view — and any selected root — stale:
  // the registry is keyed by the session's primary root, so the selection
  // falls back to primary and the list reloads.
  useEffect(() => {
    let previous = props.sessionId?.()
    return props.subscribeSession?.(() => {
      const current = props.sessionId?.()
      if (current === previous) return
      previous = current
      requestEpoch.current += 1
      setSelected('primary')
      setView(undefined)
      void refresh()
    })
  }, [props.subscribeSession, props.sessionId, refresh, setSelected])

  // A refresh that reports the selected root gone or withheld sends the
  // selection back to the primary root instead of browsing a stale grant.
  // Only an answered view may evict it: while the list is still pending — or
  // a refresh failed — the persisted choice stands, the trigger keeps naming
  // it, and the forked tree's own rows surface whatever the host reports.
  // Treating an unanswered list as eviction would drop the selection on every
  // remount's first pending moment and on any transient failure.
  useEffect(() => {
    if (selected === 'primary' || view === undefined) return
    const current = view.roots.find(root => root.id === selected.id)
    if (current === undefined || current.state !== 'available') { setSelected('primary'); return }
    // The match can carry a newer alias, access, or path than the row
    // `onSelect` captured; adopt the refreshed object so the trigger label,
    // the path label, and the tree entry stop rendering the stale snapshot.
    if (current !== selected) setSelected(current)
  }, [view, selected, setSelected])

  const roots = useMemo(() => view?.roots ?? [], [view])
  const primaryLabel = view?.primaryName ?? basename(view?.primaryRoot ?? primaryPath)
  const triggerLabel = selected === 'primary' ? primaryLabel : displayNameOf(selected)
  const triggerPath = selected === 'primary' ? (view?.primaryRoot ?? primaryPath) : selected.path
  // Exactly the portal condition: the forked tree — and the header reload
  // that refreshes it — exist together or not at all. A missing fork keeps
  // every native piece visible and the menu's additional rows unlisted, so
  // data-root-kind never hides controls the takeover did not replace.
  const treeVisible = selected !== 'primary' && panel !== undefined && pane !== null && filesTree !== undefined
  const selectedPath = selected === 'primary' ? undefined : selected.path

  const takeoverCtl = filesTree?.takeover
  // While an additional root is selected the pane's body area belongs to the
  // forked tree: the takeover keeps one controller per (tab, root) in the
  // inject product, and the dockkit tabHost's data-dockkit-content supplies
  // the same tab id the native tree uses — so the fork's store bucket, scroll
  // memory, expansion state, and watches are keyed exactly like a real Files
  // tab and survive the body unmount an opened file causes, mirroring what
  // upstream's tab-record signal does for the native tree. Deselecting or
  // switching roots ends the entry at once; an unmount ends it only if the
  // tabHost section left the document — the tab record itself is gone — which
  // the deferred check sees after the commit finishes.
  useEffect(() => {
    if (!treeVisible || selectedPath === undefined || tabId === undefined || takeoverCtl === undefined) { setTakeover(null); return }
    setTakeover({ signal: takeoverCtl.signal(tabId, selectedPath), tabId, root: selectedPath })
    return () => {
      // The mounted flag settles the branch: a deps change ends the entry now,
      // while an unmount defers to the section's attachment — still connected
      // means a hide, not an end (upstream's occurrence signal never aborts on
      // hide either). No section hook means the fallback tabId, which cannot
      // rejoin anything, so the old abort-on-unmount bound stands there.
      if (mounted.current || sectionRef.current === null) { takeoverCtl.end(tabId); return }
      queueMicrotask(() => {
        if (sectionRef.current !== null && !sectionRef.current.isConnected) takeoverCtl.end(tabId)
      })
    }
  }, [treeVisible, selectedPath, tabId, takeoverCtl])

  const items = useMemo((): MenuEntry[] => [
    { id: 'primary', label: `${primaryLabel} · ${t('panel.primary')}`, icon: <IconFolderOpen /> },
    // Where the fork cannot render, the additional rows stay out of the menu
    // entirely: offering a root the body cannot browse would desynchronize
    // the label from the pane. The primary row and the manager stay.
    ...(filesTree === undefined ? [] : roots).map((root): MenuEntry => ({
      id: `root:${root.id}`,
      label: root.state === 'available' ? displayNameOf(root) : `${displayNameOf(root)} · ${t(stateKey(root.state))}`,
      icon: <IconFolderClose />,
      disabled: root.state !== 'available',
    })),
  ], [roots, primaryLabel, t, filesTree])

  const onSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'manage') { setDialogOpen(true); return }
    if (id === 'primary') { setSelected('primary'); return }
    const root = roots.find(candidate => `root:${candidate.id}` === id)
    if (root !== undefined) setSelected(root)
  }

  return (
    <>
      <span
        ref={wrapperRef}
        className="mrfw-rootSwitcher"
        data-root-kind={treeVisible ? 'additional' : 'primary'}
      >
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={items}
          // The manager entry pins below the scrolling roots list — it is
          // chrome, not a root, and a long registry must not scroll it away.
          footer={[{ id: 'manage', label: t('switcher.manage'), icon: <IconSettings /> }]}
          selectedId={selected === 'primary' ? 'primary' : `root:${selected.id}`}
          onSelect={onSelect}
          portal
          align="start"
          anchor={(
            <button
              type="button"
              className="mrfw-rootSwitchBtn"
              title={triggerPath}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                const opening = !menuOpen
                setMenuOpen(opening)
                // States change between opens; the menu always lists a fresh
                // view rather than the snapshot from the previous visit.
                if (opening) void refresh()
              }}
            >
              <span className="mrfw-triggerIcon" aria-hidden="true"><IconFolderClose size={16} /></span>
              <span className="mrfw-rootSwitchLabel">{triggerLabel}</span>
              <span className="mrfw-triggerIcon mrfw-rootSwitchChevron" aria-hidden="true"><IconChevronDown size={14} /></span>
            </button>
          )}
        />
        {/* The selected root's full path, between the trigger and the reload:
            the same PathLabel upstream puts in this spot, so the header reads
            exactly as before except the label now follows the selection. On a
            runtime that does not export PathLabel a plain span carries the
            same class and title instead. */}
        {PathLabel === undefined
          ? <span className="mrfw-switcherPath" title={triggerPath}>{triggerPath}</span>
          : <PathLabel path={triggerPath} className="mrfw-switcherPath" />}
        {/* The takeover hides the native reload (it refreshes the hidden
            tree), so the header gets a replacement of its own — same position,
            same icon-button recipe as the upstream `.tool`, and upstream's own
            `reload` string through the fork's bound namespace. It calls the
            face's refresh: every mounted directory re-lists under its current
            rows, so a refresh never blanks to a loading note. Rendered under
            exactly the portal condition, so a menu-only switcher never shows
            a dead button. */}
        {treeVisible && filesTree !== undefined ? (
          <button
            type="button"
            className="mrfw-switcherReload"
            aria-label={filesTree.t('reload')}
            title={filesTree.t('reload')}
            onClick={() => { if (takeover !== null) filesTree.face.refresh(takeover.tabId) }}
          >
            <IconRefresh size={15} />
          </button>
        ) : null}
        {/* The takeover hides the native open-in-app split button (its slot
            props only ever carry the primary root), so the header gets the
            plugin's verbatim fork of that same control, pointed at the
            selected additional root — same component, same dictionary, same
            persisted app choice, same routes. Rendered under exactly the
            hide rule's condition; undefined adapter means no button, just
            like upstream's own "no apps" absence. */}
        {treeVisible && props.openInApp !== undefined ? (
          <OpenInAppAction {...props.openInApp} absolutePath={triggerPath} />
        ) : null}
      </span>
      {treeVisible && takeover !== null && filesTree !== undefined
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
              onOpen={filesTree.openFile}
              t={filesTree.t}
            />,
            pane,
          )
        : null}
      {dialogOpen ? (
        <WorkspaceFoldersDialog
          panel={props.panel}
          pickDirectory={props.pickDirectory}
          {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
          {...(props.subscribeSession === undefined ? {} : { subscribeSession: props.subscribeSession })}
          t={t}
          onClose={() => {
            setDialogOpen(false)
            // The manager may have removed or invalidated the selected root;
            // those mutations live in the dialog's own state and never reach
            // this snapshot, so closing re-lists and lets the reconciliation
            // above drop a selection the registry revoked.
            void refresh()
          }}
        />
      ) : null}
    </>
  )
}
