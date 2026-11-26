/**
 * The Files-tab root switcher — the entry that took over the header position
 * the P1 gear launcher first claimed. It poses as the pane's path label: a
 * trigger that opens a menu of this session's roots (primary first, the
 * registered additional roots next, and the Workspace Folders manager last),
 * followed by a `PathLabel` of the selected root's full path — the same
 * component upstream draws in that spot, so both primary and additional
 * selections read exactly like the native header. For the primary selection
 * that path is the Files pane's own directory — the slot owner's
 * `absolutePath`, which upstream resolves from the Session's effective
 * directory — not the Registry identity: once the Session moves into a
 * worktree, the tree browses the moved directory while the registry stays
 * keyed on the Session origin. While an additional root is selected it also
 * lends the pane's body area to this plugin's verbatim fork of the native
 * Files tree (`files-tree/`), so an additional root reads and behaves
 * exactly like the primary one.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { IconChevronDown, IconFolderClose, IconFolderOpen, IconRefresh, IconSettings, maybeComponent, maybeIcon } from '../compat/client-icons.ts'
import { providerKey, treeBucketId, type WorkspaceFilesProvider } from './files-tree/provider.ts'
import { localRootSelection, remoteRootSelection, type FilesRootSelection } from './files-tree/providers/resolver.ts'
import type { RemoteEndpointView, RemotesView } from '../remote/panel-contract.ts'
import { searchStateKey, type SearchPaneStates } from './files-tree/search-state.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { createSearchFailureDescriber } from './files-tree/describe-failure.ts'
import { fitRootName, ROOT_NAME_FIT_SLACK_PX, type RootNameForm } from './root-name-fit.ts'
import { createLabelMeasurer, ROOT_NAME_PROBE_CLASS, rootNameLabelBudget } from './root-name-room.ts'
import type { RootsView } from '../contract.ts'
import type { NativeTreeRenderer } from '../compat/files-tree.ts'
import { type FilesTreeSurface } from './files-tree/adapter.tsx'
import { FilesPane } from './files-tree/pane.tsx'
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
  /**
   * The directory this pane browses, carried by the slot owner's
   * `absolutePath`. Upstream passes the Session's effective directory (the
   * projected `workingDirectory` ?? the header cwd), so after the Session
   * moves into a worktree this differs from the Registry identity
   * (`view.primaryRoot`, the Session origin); the header follows this value,
   * never the registry one.
   */
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
  readonly nativeTree?: NativeTreeRenderer | undefined
}

/**
 * The takeover's portal + lifetime, created while an additional root browses.
 *
 * The record carries the root's registry id beside its path, and both land in
 * one state commit: the pane's search record key and the id its requests name
 * must never come from different states, or a root switch would send the
 * outgoing root's query under the incoming root's id.
 */
interface Takeover {
  /** Lifetime handed to the tree's face: aborting forgets the store bucket and closes the watches. */
  readonly signal: AbortSignal
  /** The owner — the dockkit tab id where the hook exists, else a generated one. */
  readonly owner: TabId
  /** The store bucket's key — `treeBucketId(owner, provider.identity)`. */
  readonly bucketId: TabId
  /** The provider the tree browses with, snapshotted with the signal. */
  readonly provider: WorkspaceFilesProvider
  /** `providerKey(provider.identity)` — what the portal gate compares. */
  readonly providerKey: string
}

/**
 * The subdued full-path label upstream's Files header draws — it exists from
 * `0.1.7-alpha.1` on. A pixel-era runtime has no such export, so the probe
 * returns `undefined` and the header falls back to a plain titled span: the
 * path stays readable and hoverable, only the dir/file typography differs.
 */
const PathLabel = maybeComponent<(props: { path: string; className?: string | undefined }) => ReactNode>(['PathLabel'])

/**
 * The header search toggle's glyph. It exists from the Regular weight family
 * on, and the toggle itself renders only where the host has workspace search
 * (`0.2.2-rc.2+`), so a missing glyph can only mean a composition that would
 * not draw the button at all.
 */
const IconSearch = maybeIcon(['IconSearchOutlineRegular'])

/** The selector hook a composition without the search seat reads: always "nothing". */
const NO_SEARCH_STATES: SnapshotSelectorHook<SearchPaneStates> = selector => selector({})

/** Selector hook for a composition without the fork: nothing was ever selectable. */
const noTreeSelection: NonNullable<RootSwitcherProps['filesTree']>['useTreeSelection'] = () => undefined as never

/**
 * The trigger label as the header width allowed it, tagged with the name it was
 * fitted for: a selection change must never leave one root's truncated text on
 * the next root's trigger, not even for the commit before the measurement runs.
 */
interface FittedName {
  /** The display name this fit belongs to. */
  readonly name: string
  /** Which tier the measured width allowed. */
  readonly form: RootNameForm
  /** The label text for that tier. */
  readonly text: string
}

/**
 * The menu label for one remote endpoint: `rootId · environment display name`,
 * plus the environment id in parentheses when the name differs from it. The
 * credential target is never shown — the path label carries the location.
 */
const remoteLabel = (endpoint: RemoteEndpointView): string => {
  const name = endpoint.displayName ?? endpoint.environmentId
  const qualified = name === endpoint.environmentId ? name : `${name} (${endpoint.environmentId})`
  return `${endpoint.rootId} · ${qualified}`
}

/** The Files-header switcher: root menu, dialog entry, and the portal tree. */
export function RootSwitcher(props: RootSwitcherProps): ReactNode {
  const { panel, t, primaryPath, filesTree } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [view, setView] = useState<RootsView | undefined>(undefined)
  const [remoteView, setRemoteView] = useState<RemotesView | undefined>(undefined)
  const [takeover, setTakeover] = useState<Takeover | null>(null)
  const [fitted, setFitted] = useState<FittedName | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const openAnchorRef = useRef<HTMLSpanElement | null>(null)
  const fallbackTabId = useRef<TabId | undefined>(undefined)
  const sectionRef = useRef<HTMLElement | null>(null)
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const [tabId, setTabId] = useState<TabId | undefined>(undefined)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)
  // The latest selection/takeover, read by callbacks that outlive a render.
  const selectedRef = useRef<FilesRootSelection | 'primary'>('primary')
  const takeoverRef = useRef<Takeover | null>(null)
  // The in-flight remotes discovery: replaced and aborted per refresh so a
  // late answer from a superseded call can never land in the view.
  const remoteDiscovery = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestEpoch.current += 1
      remoteDiscovery.current?.abort()
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
    setPane(wrapper?.closest<HTMLElement>('[data-files-page]') ?? wrapper?.closest<HTMLElement>('[data-files-root]') ?? null)
  }, [])

  // The persisted selection, keyed by this pane's tab id; an absent entry is
  // the primary root. The bound hook is stable across renders, so the
  // filesTree gate only ever picks the noop stand-in where the fork cannot
  // mount at all — and no additional root can be selected there anyway.
  const useTreeSelection = filesTree?.useTreeSelection ?? noTreeSelection
  const stored = useTreeSelection(selection => (tabId === undefined ? undefined : selection[tabId]))
  const selected: FilesRootSelection | 'primary' = stored ?? 'primary'
  const selectRoot = filesTree?.selectRoot
  // The stable seats effects and callbacks depend on — never the surface
  // wrapper itself, so a same-surface re-render cannot restart a lease or
  // a discovery that did not change.
  const takeoverCtl = filesTree?.takeover
  const observeAuthority = filesTree?.observeAuthority
  const treeSession = filesTree?.sessionId
  const setSelected = useCallback((next: FilesRootSelection | 'primary'): void => {
    if (selectRoot === undefined || tabId === undefined) return
    // Commit synchronously: a stale callback that reads selectedRef between
    // this call and the selection store's notify must already see the new
    // choice, never the record it is about to retire.
    selectedRef.current = next
    selectRoot(tabId, next)
  }, [selectRoot, tabId])
  // Layout effect: selectedRef must track a store-driven selection change
  // before any normal effect (lease, reconciliation) can read it.
  useLayoutEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { takeoverRef.current = takeover }, [takeover])

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

  const refreshRemotes = useCallback(async (): Promise<void> => {
    // A newer refresh supersedes the last one: its answer and its abort
    // are dead the moment this call starts.
    remoteDiscovery.current?.abort()
    const client = props.remotes
    const session = props.sessionId?.()
    if (client === undefined || session === undefined || session === '') {
      setRemoteView(undefined)
      return
    }
    const controller = new AbortController()
    remoteDiscovery.current = controller
    try {
      const next = await client.list(session, controller.signal)
      if (!mounted.current || controller.signal.aborted || props.sessionId?.() !== session) return
      setRemoteView(next)
    } catch {
      // A failed remote list resets the remote view AND an active remote
      // browse — a stale grant must never keep drawing. Local selections
      // are independent of this channel and stay untouched.
      if (!mounted.current || controller.signal.aborted || props.sessionId?.() !== session) return
      setRemoteView(undefined)
      const sel = selectedRef.current
      const active = takeoverRef.current
      // The same key-match invalidateNow applies: only the takeover that
      // still proves THIS remote selection is retired — an unrelated live
      // record (e.g. a local takeover mounted meanwhile) is never touched.
      if (sel !== 'primary' && sel.kind === 'remote' && active !== null && treeSession !== undefined
        && !active.signal.aborted
        && active.providerKey === providerKey({ sessionId: treeSession, root: sel.ref, incarnation: sel.incarnation })) {
        takeoverCtl?.invalidate(active.owner, active.providerKey)
        setSelected('primary')
      }
    }
  }, [props.remotes, props.sessionId, treeSession, takeoverCtl, setSelected])

  useEffect(() => { void refreshRemotes() }, [refreshRemotes])

  // Remote-tools settings changes (the switch, custody form) re-prove every
  // remote row: the fresh view re-evaluates state, token and capabilities.
  useEffect(() => props.subscribeRemoteSettings?.(() => { void refreshRemotes() }),
    [props.subscribeRemoteSettings, refreshRemotes])

  /**
   * Retire the active remote browse: abort the hold (releasing its store
   * bucket and every cached listing), drop search and saved memory, fall
   * back to primary and re-prove the remote view. The callback may arrive
   * from a superseded provider or render, so it must carry the key the
   * caller saw and match BOTH the live takeover and the CURRENT selection's
   * own key — anything else is somebody else's record and must not switch
   * away the newer selection.
   */
  const invalidateNow = useCallback((owner: TabId, key: string): void => {
    const active = takeoverRef.current
    if (active?.owner !== owner || active.providerKey !== key || active.signal.aborted) return
    const sel = selectedRef.current
    if (sel === 'primary' || treeSession === undefined || takeoverCtl === undefined) return
    if (providerKey({ sessionId: treeSession, root: sel.ref, incarnation: sel.incarnation }) !== key) return
    takeoverCtl.invalidate(owner, key)
    setSelected('primary')
    void refreshRemotes()
  }, [treeSession, takeoverCtl, setSelected, refreshRemotes])

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
      remoteDiscovery.current?.abort()
      setSelected('primary')
      setView(undefined)
      setRemoteView(undefined)
      void refresh()
      void refreshRemotes()
    })
  }, [props.subscribeSession, props.sessionId, refresh, refreshRemotes, setSelected])

  // A refresh that reports the selected root gone or withheld sends the
  // selection back to the primary root instead of browsing a stale grant.
  // Only an answered view may evict it: while the list is still pending — or
  // a refresh failed — the persisted choice stands, the trigger keeps naming
  // it, and the forked tree's own rows surface whatever the host reports.
  // Treating an unanswered list as eviction would drop the selection on every
  // remount's first pending moment and on any transient failure.
  useEffect(() => {
    if (selected === 'primary' || selected.kind !== 'additional' || view === undefined) return
    const current = view.roots.find(root => root.id === selected.ref.rootId)
    if (current === undefined || current.state !== 'available') { setSelected('primary'); return }
    // The match can carry a newer alias, access, or path than the row
    // `onSelect` captured; adopt the refreshed object so the trigger label,
    // the path label, and the tree entry stop rendering the stale snapshot.
    if (current !== selected.view) setSelected(localRootSelection(current))
  }, [view, selected, setSelected])

  const roots = useMemo(() => view?.roots ?? [], [view])
  // The primary row's label is the workspace title the host resolved when it
  // has one; otherwise it names the directory being browsed. The browsing
  // path, its tooltip, and the open-in-app target are always the Files slot's
  // directory (`primaryPath`), never `view.primaryRoot`: the latter is the
  // Registry identity, keyed on the Session origin, and a Session moving into
  // a worktree makes the two diverge. `view.primaryRoot` remains the Registry
  // identity that the management dialog and other Registry-facing data are
  // keyed on, never the header's path.
  const primaryLabel = view?.primaryName ?? basename(primaryPath)
  const triggerLabel = selected === 'primary'
    ? primaryLabel
    : selected.kind === 'remote' ? remoteLabel(selected.view) : displayNameOf(selected.view)
  const triggerPath = selected === 'primary' ? primaryPath : selected.path
  // The selection's provider, cached by its identity key: the surface is
  // rebuilt every render, so a plain memo would hand the takeover effect a
  // fresh provider each pass — one slot suffices because only the current
  // selection's provider is ever live, and a key change replaces it whole.
  const providerCache = useRef<{ readonly key: string; readonly provider: WorkspaceFilesProvider } | undefined>(undefined)
  const selectedProvider = useMemo(() => {
    if (selected === 'primary' || filesTree === undefined || tabId === undefined) return undefined
    if (selected.kind === 'remote') {
      // A remote provider exists only while the FRESH view still mints the
      // selection's exact incarnation — the proof runs BEFORE any cache hit,
      // so a remount with unanswered or mismatched metadata draws nothing
      // (never a cached provider, never a cached row). Same posture as the
      // local branch's portal gate: no pane or no live session, no provider.
      const session = props.sessionId?.()
      if (session === undefined || session === '' || pane === null) return undefined
      const endpoint = remoteView?.endpoints.find(entry =>
        entry.environmentId === selected.ref.environmentId && entry.rootId === selected.ref.rootId)
      if (endpoint === undefined || remoteRootSelection(endpoint)?.incarnation !== selected.incarnation) return undefined
    }
    const key = providerKey({ sessionId: filesTree.sessionId, root: selected.ref, incarnation: selected.incarnation })
    if (providerCache.current?.key === key) return providerCache.current.provider
    const provider = filesTree.resolveProvider(selected, () => {
      invalidateNow(tabId, key)
    })
    providerCache.current = provider === undefined ? undefined : { key, provider }
    return provider
  }, [selected, filesTree, remoteView, tabId, pane, props.sessionId, invalidateNow])
  // Exactly the portal condition: the forked tree — and the header reload
  // that refreshes it — exist together or not at all. A missing fork keeps
  // every native piece visible and the menu's additional rows unlisted, so
  // data-root-kind never hides controls the takeover did not replace.
  const treeVisible = selected !== 'primary' && selectedProvider !== undefined && panel !== undefined && pane !== null && filesTree !== undefined

  // The remote selection's reconciliation: ONLY a fresh RemotesView from
  // this session may evict or refresh it, and only an endpoint whose
  // browseAuthorization still equals the selection's incarnation proves the
  // grant. A view that shows the grant gone, re-minted, unregistered or
  // unbrowsable retires the whole record and falls back to primary — it
  // never auto-upgrades onto the replacement token. While the remote view
  // is still pending or failed, the stored selection stands but no remote
  // tree may draw (the provider gate above refuses it anyway).
  useEffect(() => {
    if (selected === 'primary' || selected.kind !== 'remote' || remoteView === undefined || treeSession === undefined) return
    const endpoint = remoteView.endpoints.find(entry =>
      entry.environmentId === selected.ref.environmentId && entry.rootId === selected.ref.rootId)
    const next = endpoint === undefined ? undefined : remoteRootSelection(endpoint)
    if (next === undefined || next.incarnation !== selected.incarnation || selectedProvider === undefined) {
      // Retire only the takeover this selection still keys — the same
      // key-match every other eviction path applies.
      const key = providerKey({ sessionId: treeSession, root: selected.ref, incarnation: selected.incarnation })
      const active = takeoverRef.current
      if (active !== null && active.providerKey === key && !active.signal.aborted) {
        takeoverCtl?.invalidate(active.owner, key)
      }
      setSelected('primary')
      return
    }
    // Same incarnation, fresher row: adopt the metadata (display name,
    // path, capabilities) without disturbing the provider or the takeover.
    if (endpoint !== selected.view) setSelected(next)
  }, [selected, remoteView, selectedProvider, treeSession, takeoverCtl, setSelected])

  // The authorization lease loop (ADR-0052 P4): while a remote takeover is
  // live, chained `remoteFiles.wait` leases watch the grant's identity —
  // an authenticated metadata wait, NEVER a filesystem watch, poll or
  // auto-relist. A rejection means the authorization is gone: the keyed
  // invalidate retires the record and the view re-proves. The lease dies
  // with the takeover (hide, switch, owner death) via the combined signal.
  useEffect(() => {
    if (takeover === null || observeAuthority === undefined || treeSession === undefined) return undefined
    const seed = selectedRef.current
    if (seed === 'primary' || seed.kind !== 'remote') return undefined
    const owner = takeover.owner
    const key = takeover.providerKey
    // The lease installs only for the takeover the CURRENT selection still
    // keys — a takeover about to be replaced by a new selection's provider
    // gets no lease of its own.
    if (providerKey({ sessionId: treeSession, root: seed.ref, incarnation: seed.incarnation }) !== key) return undefined
    const controller = new AbortController()
    const combined = AbortSignal.any([takeover.signal, controller.signal])
    if (combined.aborted) return undefined
    const loop = async (): Promise<void> => {
      while (!combined.aborted) {
        // Always observe the SEED selection: a same-incarnation metadata
        // adopt hands `selected` a new object for the same token, and a
        // switch away must simply end this loop — never let it pass a
        // different root's incarnation to this takeover's authority port.
        const current = selectedRef.current
        if (current === 'primary' || current.kind !== 'remote'
          || providerKey({ sessionId: treeSession, root: current.ref, incarnation: current.incarnation }) !== key) return
        try {
          await observeAuthority(seed, combined)
        } catch {
          if (combined.aborted) return
          invalidateNow(owner, key)
          return
        }
      }
    }
    void loop()
    return () => { controller.abort() }
  }, [takeover, observeAuthority, treeSession, invalidateNow])

  // The search bar's open state for this pane root: the header toggle and the
  // pane read the same record, so the toggle's aria-expanded cannot drift.
  // The hook itself always reads the filesTree seat — never the capability
  // gate — so hook order cannot change across a capability flip; the seat
  // and the key follow the selected provider's `search` capability.
  const useSearchState = filesTree?.search?.useSearchState ?? NO_SEARCH_STATES
  const searchSeat = selectedProvider?.search === undefined ? undefined : filesTree?.search
  const searchKey = takeover === null || searchSeat === undefined ? undefined : searchStateKey(takeover.owner, takeover.providerKey)
  const searchBarOpen = useSearchState(states => searchKey !== undefined && states[searchKey]?.barOpen === true)
  /** Localize a failed search's panel code; the tree's own codes keep its vocabulary. */
  const describeSearchFailure = useMemo(() => createSearchFailureDescriber(t), [t])

  // The trigger label is fitted to the width the header leaves for it: the whole
  // name when it fits, head and tail when both ends fit, the head alone at the
  // last. The switcher's own width is the budget input (it does not depend on
  // the label text, so the chosen form never feeds back into its own budget).
  // The fit is redone when the name changes, when the selected root's kind adds
  // or removes the controls inside the row, and whenever the row is resized.
  const fitTriggerLabel = useCallback((): void => {
    const switcher = wrapperRef.current
    const button = triggerRef.current
    const label = labelRef.current
    const probe = probeRef.current
    if (switcher === null || button === null || label === null || probe === null) return
    const width = rootNameLabelBudget(switcher, button, label)
    // No measurable room (the pane is hidden, or the test DOM has no layout):
    // keep the whole name and let the stylesheet's ellipsis handle the visual.
    if (width <= ROOT_NAME_FIT_SLACK_PX) { setFitted(null); return }
    const measure = createLabelMeasurer(label, probe)
    const next = fitRootName(triggerLabel, width - ROOT_NAME_FIT_SLACK_PX, measure)
    setFitted(previous => previous !== null && previous.name === triggerLabel
      && previous.form === next.form && previous.text === next.text
      ? previous
      : { name: triggerLabel, form: next.form, text: next.text })
  }, [triggerLabel])
  useLayoutEffect(() => {
    fitTriggerLabel()
  }, [fitTriggerLabel, treeVisible, searchSeat !== undefined, props.openInApp !== undefined])
  // The row's own width is not the only thing that can shrink the budget: the
  // open-in-app split button only appears once the application catalog loads,
  // and it is then inserted into this row without resizing the switcher. The
  // seat is therefore observed as well — a 0 → measured transition re-fits the
  // name that the new control just crowded out. (The reload and search buttons
  // render synchronously with the additional-root takeover; the deps above
  // already cover that branch.)
  useLayoutEffect(() => {
    const targets = [wrapperRef.current, openAnchorRef.current]
      .filter((element): element is HTMLElement => element !== null)
    if (targets.length === 0 || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { fitTriggerLabel() })
    for (const target of targets) observer.observe(target)
    return () => { observer.disconnect() }
  }, [fitTriggerLabel, treeVisible])
  // While an additional root is selected the pane's body area belongs to the
  // forked tree: the takeover keeps one controller per (tab, root) in the
  // inject product, and the dockkit tabHost's data-dockkit-content supplies
  // the same tab id the native tree uses — so the fork's store bucket, scroll
  // memory, expansion state, and watches are keyed exactly like a real Files
  // tab and survive the body unmount an opened file causes, mirroring what
  // upstream's tab-record signal does for the native tree. Deselecting or
  // switching roots ends the entry at once; a body unmount leaves it to the
  // inject-side observer, which ends it whenever the tabHost section leaves
  // the document — the record's real end, even long after this body is gone.
  useEffect(() => {
    if (!treeVisible || selectedProvider === undefined || tabId === undefined || takeoverCtl === undefined) { setTakeover(null); return }
    const key = providerKey(selectedProvider.identity)
    setTakeover({
      signal: takeoverCtl.signal(tabId, key, sectionRef.current ?? undefined),
      owner: tabId,
      bucketId: treeBucketId(tabId, selectedProvider.identity),
      provider: selectedProvider,
      providerKey: key,
    })
    return () => {
      // The mounted flag settles the branch: a deps change ends the entry
      // now, while an unmount is a hide — upstream's occurrence signal never
      // aborts on hide either — and the armed section observer owns the real
      // end. No section hook means the fallback tabId, which cannot rejoin
      // anything, so the old abort-on-unmount bound stands there. A provider
      // declaring `retainHiddenLevels: false` (the remote root) overrides the
      // hide retention: its hold ends at once, so a hidden remote tree runs
      // no listing I/O, no authorization lease, and keeps no cached rows a
      // remount could paint before the grant is re-proven. What survives the
      // `end` is only the bounded (expanded, scrollTop) memory — metadata,
      // never listing data; a keyed invalidate or the death watch drops that
      // too. Remote expansion/scroll therefore survive a manual refresh or a
      // remount under the same grant, never a re-grant.
      if (mounted.current || sectionRef.current === null || selectedProvider.retainHiddenLevels === false) takeoverCtl.end(tabId)
    }
  }, [treeVisible, selectedProvider, tabId, takeoverCtl])

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
    // Remote endpoints appear as their own rows whenever the channel exists
    // (an unreachable view simply shows none — the label contract never
    // leaks a stale entry). A row is browsable only while the fresh view
    // mints a browseAuthorization; every other state draws disabled with an
    // explicit reason so the menu never offers a grant it cannot mount.
    ...(filesTree === undefined || observeAuthority === undefined ? [] : remoteView?.endpoints ?? []).map((endpoint): MenuEntry => {
      const browsable = remoteRootSelection(endpoint) !== undefined
      const label = `${remoteLabel(endpoint)} · ${endpoint.path} · SSH`
      return {
        id: `remote:${endpoint.environmentId}:${endpoint.rootId}`,
        label: browsable ? label : `${label} · ${t('switcher.remoteDisabled')}`,
        icon: <IconFolderClose />,
        disabled: !browsable,
      }
    }),
  ], [roots, remoteView, primaryLabel, t, filesTree])

  const onSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'manage') { setDialogOpen(true); return }
    if (id === 'primary') { setSelected('primary'); return }
    if (id.startsWith('remote:')) {
      const endpoint = remoteView?.endpoints.find(candidate =>
        `remote:${candidate.environmentId}:${candidate.rootId}` === id)
      const selection = endpoint === undefined ? undefined : remoteRootSelection(endpoint)
      if (selection !== undefined) setSelected(selection)
      return
    }
    const root = roots.find(candidate => `root:${candidate.id}` === id)
    if (root !== undefined) setSelected(localRootSelection(root))
  }
  // The open-in-app path comes from the provider's port over the root
  // resource — the trusted local spelling, never the trigger's display path.
  const rootResource = selectedProvider === undefined ? undefined : selectedProvider.resource(selectedProvider.treeRoot)
  const openInAppPath = rootResource === undefined ? undefined : selectedProvider?.openInApp?.(rootResource)

  // A name that changed since the last measurement renders whole until the fit
  // lands; the previous root's truncated text is never shown on the next one.
  const shownName = fitted !== null && fitted.name === triggerLabel ? fitted : null

  return (
    <>
      <span
        ref={wrapperRef}
        className="mrfw-rootSwitcher"
        data-root-kind={treeVisible ? 'additional' : 'primary'}
        data-name-form={shownName?.form ?? 'full'}
      >
        <Menu
          // The stylesheet's shrink hook. Menu renders className on the anchor
          // wrapper span — the flex item the header row actually sizes — so the
          // trigger can ellipsize instead of overflowing over the next controls.
          className="mrfw-rootSwitchAnchor"
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={items}
          // The manager entry pins below the scrolling roots list — it is
          // chrome, not a root, and a long registry must not scroll it away.
          footer={[{ id: 'manage', label: t('switcher.manage'), icon: <IconSettings /> }]}
          selectedId={selected === 'primary'
            ? 'primary'
            : selected.kind === 'remote'
              ? `remote:${selected.ref.environmentId}:${selected.ref.rootId}`
              : `root:${selected.ref.rootId}`}
          onSelect={onSelect}
          portal
          align="start"
          anchor={(
            <button
              ref={triggerRef}
              type="button"
              className="mrfw-rootSwitchBtn"
              title={triggerPath}
              // The visible text is truncated on narrow headers; the button keeps
              // the whole root name as its accessible name either way.
              aria-label={triggerLabel}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                const opening = !menuOpen
                setMenuOpen(opening)
                // States change between opens; the menu always lists a fresh
                // view rather than the snapshot from the previous visit.
                if (opening) { void refresh(); void refreshRemotes() }
              }}
            >
              <span className="mrfw-triggerIcon" aria-hidden="true"><IconFolderClose size={16} /></span>
              <span ref={labelRef} className="mrfw-rootSwitchLabel">{shownName?.text ?? triggerLabel}</span>
              <span className="mrfw-triggerIcon mrfw-rootSwitchChevron" aria-hidden="true"><IconChevronDown size={14} /></span>
              {/* The off-flow text probe the no-canvas measurer renders candidates into. */}
              <span ref={probeRef} className={ROOT_NAME_PROBE_CLASS} aria-hidden="true" />
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
            onClick={() => {
              if (takeover === null) return
              // The drawn tree is refreshed in place first; when search results
              // replace the tree there is no directory node to relist, so the
              // active search request is re-run instead — otherwise a settled
              // answer keeps its identity and stale matches survive the reload.
              filesTree.face.refresh(takeover.bucketId)
              if (searchKey !== undefined && searchSeat !== undefined) searchSeat.store.refresh(searchKey)
            }}
          >
            <IconRefresh size={15} />
          </button>
        ) : null}
        {/* The header's search toggle, in the position the native one occupies
            (after the reload). It toggles THIS pane root's bar, whose query and
            results live in the inject product; the native toggle stays hidden
            because its own search is rooted at the Session cwd. */}
        {treeVisible && searchSeat !== undefined && IconSearch !== undefined ? (
          <button
            type="button"
            className="mrfw-switcherSearch"
            aria-label={filesTree.t('search.placeholder')}
            aria-expanded={searchBarOpen}
            title={filesTree.t('search.placeholder')}
            data-mrfw-files-search-toggle
            onClick={() => {
              if (searchKey === undefined) return
              searchSeat.store.barOpen(searchKey, !searchBarOpen)
            }}
          >
            <IconSearch size={15} />
          </button>
        ) : null}
        {/* The takeover hides the native open-in-app split button (its slot
            props only ever carry the primary root), so the header gets the
            plugin's verbatim fork of that same control, pointed at the
            selected additional root — same component, same dictionary, same
            persisted app choice, same routes. Rendered under exactly the
            hide rule's condition; undefined adapter means no button, just
            like upstream's own "no apps" absence. */}
        {treeVisible && props.openInApp !== undefined && openInAppPath !== undefined ? (
          // The seat keeps the row's child list stable while the fork itself
          // renders nothing until the catalog resolves; its own box is what the
          // resize observer watches for the arrival.
          <span ref={openAnchorRef} className="mrfw-switcherOpen">
            <OpenInAppAction {...props.openInApp} absolutePath={openInAppPath} />
          </span>
        ) : null}
      </span>
      {treeVisible && takeover !== null && selectedProvider !== undefined
          && providerKey(selectedProvider.identity) === takeover.providerKey && filesTree !== undefined
        ? createPortal(
            <FilesPane
              filesTree={filesTree}
              stateKey={searchKey ?? ''}
              provider={takeover.provider}
              tabId={takeover.bucketId}
              signal={takeover.signal}
              useStore={filesTree.useStore}
              actions={filesTree.actions}
              nativeTree={pane.hasAttribute('data-files-page') ? props.nativeTree : undefined}
              describeFailure={describeSearchFailure}
            />,
            pane,
          )
        : null}
      {dialogOpen ? (
        <WorkspaceFoldersDialog
          {...props}
          onClose={() => {
            setDialogOpen(false)
            // The manager may have removed or invalidated the selected root;
            // those mutations live in the dialog's own state and never reach
            // this snapshot, so closing re-lists and lets the reconciliation
            // above drop a selection the registry revoked.
            void refresh()
            void refreshRemotes()
          }}
        />
      ) : null}
    </>
  )
}
