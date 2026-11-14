/**
 * The plugin-owned wiring around the verbatim files-tree fork.
 *
 * Upstream wires its store and face inside `apply` over `ctx.remote`, and the
 * slot framework resolves the session and hands the face its bound actions.
 * This plugin registers onto `sidebar.right.tab.files.actions` — a
 * session-scoped list slot — so the same `store`/`inject` declaration gives
 * the fork the same props; what differs is only *which* remote and *which*
 * open-route the fork sees:
 *
 * - `remote` is an optional service here (upstream injects it unconditionally),
 *   so {@link lazyFilesRemote} resolves `remote` / `remote.workspaceFiles` per
 *   call through `ctx.get` — the inject-free lookup, since a declaration would
 *   gate this whole row on an optional service — and folds absence into the
 *   same `gateway/internal` failure a carrier error would produce;
 * - opening a file goes through `sidebarRight.openResourceIn`, bound with the
 *   session inside the `inject` factory so the component never resolves one;
 * - the primitives the forked rows spell are runtime-probed (pixel-era
 *   manifests lack the `*Regular` names), and the gate's `false` means the
 *   caller simply never mounts the tree — upstream's own absence shape.
 *
 * Everything here is ours; nothing in this file needs upstream sync.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/adapter
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type BoundActions, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { createList, createWatch, filesFace, type FilesInjected } from './face.ts'
import { createFilesStore } from './store.ts'
import { filesTreeSurfaceSupported } from './primitives.ts'
import { filesMenuHookOf, filesMenuSeat, type FilesMenuKinds, type FilesMenuSeat } from './context-menu.ts'
import type { PanelClient } from '../panel-client.ts'
import type { FilesSearchRun } from './search-client.ts'
import type { WorkspaceSearchPreferenceBook } from './search-preferences.ts'
import { createSearchPaneStore, type SearchPaneStates, type SearchPaneStore } from './search-state.ts'
import type { FilesTreeProps } from './FilesTree.tsx'
import type { RootView } from '../../contract.ts'
import { NS } from './locales.ts'

/** The `sidebarRight` face the fork uses to open a file resource. */
interface SidebarRightOpen {
  readonly openResourceIn?: (sessionId: SessionId, address: string, options?: { readonly replaceTab?: TabId }) => void
}

/**
 * The slice of the right-sidebar tab registry the tree reads: whether some
 * registered viewer claims a resource address, and its change notification
 * (`0.2.2-alpha.3+`; the service is absent before the Factory exists).
 */
interface ClientViewerRegistry {
  candidates(address: string): readonly object[]
  subscribe(listener: () => void): () => void
}

/** The slice of the host context-menu registry the row binding reads (`registeredKinds`, `0.2.2-rc.2+`). */
interface ClientMenuRegistry {
  readonly registeredKinds?: { readonly getSnapshot?: () => readonly string[] | undefined } | undefined
}

/**
 * One session's per-tab additional-root selections, keyed by the pane's
 * dockkit tab id. An absent entry means the primary root.
 */
export type TreeSelection = Readonly<Record<string, RootView>>

/**
 * The lifetimes a selection runs under, keyed by tab like the store bucket:
 * while an entry's signal is live the tree keeps its loaded levels, watches,
 * expansion, and scroll — exactly what upstream's tab-record signal gives the
 * native tree across a body remount (opening a file deactivates this tab,
 * unmounting its body without ending the record).
 */
/**
 * The tree-view memory one closed owner keeps for its next open — the
 * fork's spelling of upstream's pane record: `expanded`/`scrollTop` survive
 * the hold's end, and `revealed` is the last previewed file the reveal
 * walk completed (upstream's `pane.revealed`). Entries live per
 * (key, root), so one pane previewing files of different roots keeps each
 * root's memory apart.
 */
export interface FilesTreeSaved {
  /** The root this snapshot belongs to; a stale snapshot never crosses roots. */
  readonly root: string
  /** Expansion preferences at the moment the owner closed. */
  readonly expanded?: readonly string[]
  /** The body's scroll offset at the moment it closed. */
  readonly scrollTop?: number
  /** The last previewed file whose reveal completed — suppresses re-stepping. */
  readonly revealed?: string
}

export interface FilesTreeTakeover {
  /**
   * The record signal for (key, root); reuses the live entry so a remounted
   * body finds its tree bucket and resumes it. Only the record's end — the
   * owner dying, or a different root superseding it — aborts the controller;
   * a navigator closing is a hold ending and leaves this signal live.
   * @param key - the owner's dockkit identity: the Files pane's tab id, or
   *   the preview navigator's pane id.
   * @param root - absolute path of the root being browsed.
   * @param section - how the owner's survival is checked: an Element (kept
   *   while `isConnected`) or a predicate (kept while it returns true —
   *   the preview navigator's "some connected element still carries this
   *   pane id" query, since a dockkit pane has no stable element across a
   *   `replaceTab`). The watch lives at this scope and outlives `end()`:
   *   ending the hold never disarms it, so the owner's real death drops
   *   the saved memory even after the body that mounted it is gone.
   * @returns the signal the forked tree lives under.
   */
  readonly signal: (key: TabId, root: string, section?: Element | (() => boolean)) => AbortSignal
  /**
   * Abort and drop one owner's record: the owner died, the selection moved to
   * another root, or a body with no pane carrier closed. A normal navigator
   * close is not a record end — the body release keeps the bucket. The saved
   * memory survives here because the death watch owns the only real drop;
   * this method only guarantees a superseded record stops writing.
   * @param key - the owner's dockkit identity.
   */
  readonly end: (key: TabId) => void
  /**
   * The tree-view memory kept for (key, root) — `undefined` before the
   * first close or after the owner's section died.
   * @param key - the owner's dockkit identity.
   * @param root - absolute path of the root the memory belongs to.
   */
  readonly saved: (key: TabId, root: string) => FilesTreeSaved | undefined
  /**
   * Merge memory for (key, snapshot.root): fields present in the snapshot
   * overwrite, fields absent keep what was saved before — so a settle-time
   * `revealed` write survives the close-time `expanded`/`scrollTop` write.
   * @param key - the owner's dockkit identity.
   * @param snapshot - the memory fields to record.
   */
  readonly save: (key: TabId, snapshot: FilesTreeSaved) => void
}

/** The inject face the registration composes onto the occupant's props. */
export interface FilesTreeInjected {
  /** The verbatim files face (list/watch bookkeeping included). */
  readonly face: FilesInjected
  /** Open one `dsh-resource://file` address in the host viewer. */
  readonly openFile: (address: string) => void
  /**
   * Open one `dsh-resource://file` address replacing the given tab — the
   * document-preview navigator's open route, where the native navigator's
   * `onOpen` is `tab.actions.openResource(address, { replaceTab: true })`.
   * @param tabId - the preview tab the opened file replaces.
   * @param address - the file's `dsh-resource://file` address.
   */
  readonly openFileIn: (tabId: TabId, address: string) => void
  /**
   * The pane search state and its write set. The observable also rides the
   * `hooks` compartment as `useSearchState`; the actions travel beside it
   * because a component reads them by name.
   */
  readonly search: SearchPaneStore
  /** Run one additional-root search through the plugin's host endpoint. */
  readonly searchFiles: FilesSearchRun
  /** The workspace search preferences, one source per workspace root. */
  readonly searchPreferences: WorkspaceSearchPreferenceBook
  /**
   * The reserved inject compartment: the slot renderer binds each source to a
   * `use<Name>` selector hook, so `treeSelection` reaches the component as
   * `useTreeSelection`, never as a prop under its own key.
   */
  readonly hooks: {
    readonly treeSelection: HostObservable<TreeSelection>
    /**
     * The viewer registry's change counter (`0.2.2-alpha.3+`): increments
     * whenever the right-sidebar tab types change, so a pane re-reads its rows'
     * `canOpen` verdicts. Constant in a composition without the registry.
     */
    readonly canOpen: HostObservable<number>
    /** The per-pane-root search records; the component reads it as `useSearchState`. */
    readonly searchState: HostObservable<SearchPaneStates>
  }
  /**
   * Persist one pane's selected root; `'primary'` drops its entry. The
   * session-scoped snapshot survives the body remount a file open causes.
   * @param tabId - the pane's dockkit tab id.
   * @param root - the selected root, or `'primary'` to browse the session root.
   */
  readonly selectRoot: (tabId: TabId, root: RootView | 'primary') => void
  /** The forked tree's lifetimes; see {@link FilesTreeTakeover}. */
  readonly takeover: FilesTreeTakeover
}

/**
 * The pane's search capability, present only where the host exposes the
 * upstream workspace search the endpoint wraps (`0.2.2-rc.2+`) and the plugin's
 * channel exists. Absence keeps the search toggle out of the Files header
 * entirely — the same absence a host older than the feature shows.
 */
export interface FilesTreeSearchSeat {
  /** Selector hook over every pane root's record. */
  readonly useSearchState: SnapshotSelectorHook<SearchPaneStates>
  /** The records' write set. */
  readonly store: SearchPaneStore
  /** The workspace's preferences (exclusion rules, hidden entries, ignore files). */
  readonly preferences: WorkspaceSearchPreferenceBook
  /** The host call: search one additional root by registry id. */
  readonly run: FilesSearchRun
}

/** Everything `FilesTree` needs that the slot framework does not synthesize. */
export interface FilesTreeSurface {
  readonly sessionId: SessionId
  readonly useStore: FilesTreeProps['useStore']
  readonly actions: FilesTreeProps['actions']
  readonly face: FilesInjected
  readonly openFile: (address: string) => void
  /** The preview navigator's replace-tab open route; see {@link FilesTreeInjected.openFileIn}. */
  readonly openFileIn: FilesTreeInjected['openFileIn']
  readonly t: FilesTreeProps['t']
  /** Selector hook over this session's per-tab root selections. */
  readonly useTreeSelection: SnapshotSelectorHook<TreeSelection>
  /** The selection's write side; see {@link FilesTreeInjected.selectRoot}. */
  readonly selectRoot: FilesTreeInjected['selectRoot']
  /** The forked tree's lifetimes; see {@link FilesTreeTakeover}. */
  readonly takeover: FilesTreeTakeover
  /**
   * Row context menus for this pane, pre-bound to the Session. `undefined`
   * where the host has no context-menu service (before `0.2.2-alpha.3`, or a
   * trimmed composition): rows then keep the native browser menu, exactly the
   * native tree's absence there.
   */
  readonly menu: FilesMenuSeat | undefined
  /**
   * Whether the host's registered viewers can open one file address, or
   * `undefined` where the right-sidebar viewer registry does not exist (every
   * release before the `sidebar.files.tree` Factory, which is also every
   * release whose tree cannot consume the input).
   */
  readonly canOpen: ((address: string) => boolean) | undefined
  /** Selector hook over the viewer registry's change counter; a constant without the registry. */
  readonly useCanOpen: SnapshotSelectorHook<number>
  /** The workspace search seat, or `undefined` where this host has no search. */
  readonly search: FilesTreeSearchSeat | undefined
}

/** The failure every lazy-remote path reports when the carrier is absent. */
const unavailable = (): RemoteError<'gateway/internal'> =>
  new RemoteError('gateway/internal', 'the remote service is not available in this composition', {})

/**
 * Fold an unexpected exception into the Remote failure a dead carrier would
 * produce. A generated Remote call cannot reject — but the lazy indirection
 * can (a `remote` whose `workspaceFiles` namespace is not mounted leaves
 * `.list` throwing a TypeError). The verbatim `load` awaits `list` through
 * `.then` without `.catch`, so an escaped rejection would die inside
 * `DirectoryNode.task` and pin the level at `loading` forever; folding it
 * here keeps the failure a settled Remote result — the visible failure row.
 */
const failureOf = (error: unknown): RemoteFailure =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error as RemoteFailure
    : new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})

/** An AsyncIterable whose first read throws the absent-carrier failure. */
const deadStream = (error: unknown = unavailable()): AsyncIterable<never> & { dispose(): Promise<void> } => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failureOf(error)) }),
  dispose: () => Promise.resolve(),
})

/**
 * A `ClientRemote` stand-in that resolves the real service per call.
 *
 * The verbatim `createList`/`createWatch` hold one remote face for the
 * session's life; resolving lazily keeps the fork correct on compositions
 * that acquire `remote` after this plugin activates, and a composition that
 * never acquires it still answers every call — with the same failure kind a
 * dead carrier returns — instead of crashing the slot. Every method upholds
 * the Remote contract the face relies on: `list` resolves a `RemoteResult`
 * and never rejects; `changes`/`$stream` surface synchronous lookup failures
 * through the stream's own failure path.
 */
export function lazyFilesRemote(ctx: ClientContext): ClientRemote {
  const get = (name: string): unknown =>
    (ctx as unknown as { get(key: string): unknown }).get(name)
  // `remote.workspaceFiles` is a *nested service*, so `remote.workspaceFiles`
  // on the traceable resolves through the inject-guarded context proxy and
  // throws "without inject" for any fiber that never declared it — which no
  // fiber of ours may do, since this cordis treats every inject entry as
  // required and a declaration would gate the whole row on an optional
  // service. `ctx.get` reads the service store with no inject requirement —
  // exactly the lazy-optional semantics this adapter exists for.
  const namespace = (): ClientRemote['workspaceFiles'] | undefined =>
    get('remote.workspaceFiles') as ClientRemote['workspaceFiles'] | undefined
  return {
    workspaceFiles: {
      list: (sessionId: SessionId, path: string, signal?: AbortSignal) => {
        try {
          const ns = namespace()
          if (ns === undefined) return Promise.resolve({ ok: false as const, error: unavailable() })
          return Promise.resolve(ns.list(sessionId, path, signal))
            .catch((error: unknown) => ({ ok: false as const, error: failureOf(error) }))
        } catch (error) {
          return Promise.resolve({ ok: false as const, error: failureOf(error) })
        }
      },
      changes: (sessionId: SessionId, path: string, signal?: AbortSignal) => {
        try {
          const ns = namespace()
          return ns === undefined ? deadStream() : ns.changes(sessionId, path, signal)
        } catch (error) {
          return deadStream(error)
        }
      },
    },
    $stream: ((options: Parameters<ClientRemote['$stream']>[0]) => {
      try {
        const remote = get('remote') as ClientRemote | undefined
        return remote === undefined ? deadStream() : remote.$stream(options)
      } catch (error) {
        return deadStream(error)
      }
    }) as ClientRemote['$stream'],
  } as unknown as ClientRemote
}

/**
 * The registration's `store`/`inject` declarations, built once in `apply`.
 *
 * The inject face nests the files face under `face` and adds the
 * session-bound `openFile`; the fork's call sites stay upstream-shaped, the
 * one lifecycle delta being the hold/release pair the preview navigator needs
 * (see FORK.md).
 * @param ctx - the client root context (the remote/sidebarRight lookups).
 * @returns the store handle and the inject factory for `register`.
 */
export function createFilesTreeSeats(
  ctx: ClientContext,
  deps: {
    /** The plugin's channel client; absent when this composition has no host Connection. */
    readonly panel?: PanelClient | undefined
    /** The workspace search preferences, shared by every pane and session. */
    readonly preferences: WorkspaceSearchPreferenceBook
  },
): {
  readonly store: ReturnType<typeof createFilesStore>
  readonly inject: (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesTreeInjected
  /** Reads the host menu registry's registered target kinds; `undefined` where it has no such snapshot. */
  readonly menuKinds: FilesMenuKinds
  /** The live viewer predicate, re-read after every registry change. */
  readonly canOpenViewer: () => ((address: string) => boolean) | undefined
  /** Whether this host exposes the search the endpoint wraps (`0.2.2-rc.2+`). */
  readonly searchSupported: () => boolean
} {
  const store = createFilesStore()
  const remote = lazyFilesRemote(ctx)
  const face = filesFace(createList(remote), createWatch(remote))
  // The two optional host registries behind the tree-parity inputs. Both are
  // read through `ctx.get` because neither may gate this row: the tree exists
  // (legacy rows) on hosts that never had them.
  // `<T,>` because this is a TSX module: a bare `<T>` starts a JSX element.
  const readService = <T,>(name: string): T | undefined =>
    (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined
  const menuKinds: FilesMenuKinds = () => readService<ClientMenuRegistry>('contextMenus')?.registeredKinds?.getSnapshot?.()
  // The search records are pane state, not listing state: they live beside the
  // forked store (which stays byte-identical to upstream) and survive a body
  // remount through the inject product's lifetime.
  const searchStore = createSearchPaneStore()
  // The host's own search call is the structural probe for the whole feature:
  // the endpoint exists in this same package, so a host that lacks the Remote
  // method lacks the feature rather than answering a failure.
  const searchSupported = (): boolean =>
    typeof readService<{ readonly search?: unknown }>('remote.workspaceFiles')?.search === 'function'
    && deps.panel !== undefined
  // The viewer registry may activate after this plugin; the nested injection
  // waits for it without gating the row, and the counter it feeds lets every
  // drawn pane re-read its rows' `canOpen` verdicts when tab types change.
  const canOpenEpoch = createSnapshotStore(0)
  let canOpenViewer: ((address: string) => boolean) | undefined
  const readViewer = (service: ClientViewerRegistry | undefined): void => {
    canOpenViewer = service === undefined || typeof service.candidates !== 'function'
      ? undefined
      : address => service.candidates(address).length > 0
  }
  readViewer(readService<ClientViewerRegistry>('sidebarRightTabs'))
  ;(ctx as unknown as { inject(names: readonly string[], callback: (scope: ClientContext) => void): void })
    .inject(['sidebarRightTabs'], (scope) => {
      const service = (scope as unknown as { get(key: string): unknown }).get('sidebarRightTabs') as ClientViewerRegistry | undefined
      readViewer(service)
      if (service === undefined || typeof service.subscribe !== 'function') return
      ;(scope as unknown as { effect(body: () => () => void, label: string): void }).effect(() => {
        const unsubscribe = service.subscribe(() => { canOpenEpoch.set(canOpenEpoch.getSnapshot() + 1) })
        return () => { unsubscribe(); readViewer(undefined) }
      }, 'multi-root workspace: sidebar viewer registry')
    })
  const inject = (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>): FilesTreeInjected => {
    // Both live at the inject product's scope — one instance per session — so
    // the selection and the controllers it runs under survive the body remount
    // an opened file causes (the file tab takes the pane, the Files body
    // unmounts, and component state would otherwise reset to 'primary').
    const selection = createSnapshotStore<TreeSelection>({})
    interface Held {
      readonly controller: AbortController
      readonly root: string
    }
    const takeovers = new Map<TabId, Held>()
    // The pane-record memory: a hold ending keeps it, the owner dying drops
    // it. The death watch is keyed apart from the hold itself — an `end()`
    // that disconnects it would make the drop unreachable: the owner's
    // death and the body's unmount land in the same upstream commit, and
    // the cleanup's `end` always wins that race. One shared observer serves
    // every armed owner: pane carriers come and go through childList records
    // AND through in-place `data-dockkit-*` rewrites (a selection change
    // moves the id between hosts without touching any node), so both record
    // kinds are observed and verdicts run only on batches that could change
    // them. When no owner is left to watch the observer disconnects itself —
    // it never outlives its own DOM.
    const savedTrees = new Map<TabId, Map<string, FilesTreeSaved>>()
    const watchers = new Map<TabId, () => boolean>()
    let watcherObserver: MutationObserver | undefined
    const endTakeover = (key: TabId, dropSaved = false): void => {
      const held = takeovers.get(key)
      held?.controller.abort()
      takeovers.delete(key)
      if (dropSaved) savedTrees.delete(key)
    }
    const dropDeadOwners = (): void => {
      for (const [key, alive] of watchers) {
        if (!alive()) {
          watchers.delete(key)
          endTakeover(key, true)
        }
      }
      if (watchers.size === 0) {
        watcherObserver?.disconnect()
        watcherObserver = undefined
      }
    }
    const armDeathWatch = (key: TabId, alive: () => boolean): void => {
      watchers.set(key, alive)
      if (watcherObserver === undefined) {
        watcherObserver = new MutationObserver((mutations) => {
          const relevant = mutations.some(mutation =>
            mutation.type === 'attributes' || mutation.addedNodes.length !== 0 || mutation.removedNodes.length !== 0)
          if (relevant) dropDeadOwners()
        })
        watcherObserver.observe(document, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-dockkit-pane', 'data-dockkit-float'],
        })
      }
      dropDeadOwners()
    }
    return {
      face: face(sessionId, actions),
      openFile: (address: string) => {
        const sidebar = (ctx as unknown as { get(key: string): unknown }).get('sidebarRight') as SidebarRightOpen | undefined
        sidebar?.openResourceIn?.(sessionId, address)
      },
      openFileIn: (tabId: TabId, address: string) => {
        const sidebar = (ctx as unknown as { get(key: string): unknown }).get('sidebarRight') as SidebarRightOpen | undefined
        sidebar?.openResourceIn?.(sessionId, address, { replaceTab: tabId })
      },
      search: searchStore,
      searchFiles: (rootId, request, signal) => {
        const panel = deps.panel
        if (panel === undefined) {
          return Promise.reject(new Error('multi-root workspace: the panel channel is not mounted'))
        }
        return panel.call('search', {
          sessionId,
          rootId,
          query: request.query,
          excludedPaths: [...request.excludedPaths],
          includeHidden: request.includeHidden,
          respectGitignore: request.respectGitignore,
        }, signal).then(view => ({
          root: view.root,
          matches: view.matches,
          truncated: view.truncated,
          incomplete: view.incomplete,
        }))
      },
      searchPreferences: deps.preferences,
      hooks: { treeSelection: selection, canOpen: canOpenEpoch, searchState: searchStore.snapshot },
      selectRoot: (tabId, root) => {
        const next: Record<string, RootView> = { ...selection.getSnapshot() }
        if (root === 'primary') delete next[tabId]
        else next[tabId] = root
        selection.set(next)
      },
      takeover: {
        signal: (key, root, section) => {
          let held = takeovers.get(key)
          if (held === undefined || held.root !== root || held.controller.signal.aborted) {
            held?.controller.abort()
            held = { controller: new AbortController(), root }
            takeovers.set(key, held)
          }
          if (section !== undefined) {
            // Normalize the two caller shapes into one survival predicate.
            // The watch outlives `end`: an owner dying drops its memory even
            // though the body's cleanup — which always wins the unmount race
            // — already ended the hold.
            const alive = typeof section === 'function' ? section : () => section.isConnected
            armDeathWatch(key, alive)
          }
          return held.controller.signal
        },
        end: key => { endTakeover(key) },
        saved: (key, root) => savedTrees.get(key)?.get(root),
        save: (key, snapshot) => {
          // A dead owner takes no writes: once the hold AND the watch are
          // both gone, nothing live remains that could still report a value,
          // and a cleanup racing the drop must not resurrect the record.
          if (!takeovers.has(key) && !watchers.has(key)) return
          let perRoot = savedTrees.get(key)
          if (perRoot === undefined) savedTrees.set(key, perRoot = new Map())
          const previous = perRoot.get(snapshot.root)
          const merged: { -readonly [P in keyof FilesTreeSaved]: FilesTreeSaved[P] } = { root: snapshot.root }
          const expanded = snapshot.expanded ?? previous?.expanded
          const scrollTop = snapshot.scrollTop ?? previous?.scrollTop
          const revealed = snapshot.revealed ?? previous?.revealed
          if (expanded !== undefined) merged.expanded = expanded
          if (scrollTop !== undefined) merged.scrollTop = scrollTop
          if (revealed !== undefined) merged.revealed = revealed
          perRoot.set(snapshot.root, merged)
        },
      },
    }
  }
  return { store, inject, menuKinds, canOpenViewer: () => canOpenViewer, searchSupported }
}

/**
 * Assemble the props `RootSwitcher` portals into `FilesTree`, or `undefined`
 * when this composition cannot render the fork — the caller then keeps the
 * additional-root rows out of the menu entirely, which is the same absence
 * upstream produces when its own tree cannot draw.
 * @param props - the occupant's composed props (store, inject, session shares).
 * @param t - the `sidebarFiles`-bound translate.
 * @returns the stable surface, or `undefined` when the fork cannot mount.
 */
/** The optional host seats the surface reads; absent members keep the native absence. */
export interface FilesTreeSurfaceDeps {
  /** Reads the menu registry's registered target kinds (`registeredKinds`, `0.2.2-rc.2+`). */
  readonly menuKinds: FilesMenuKinds
  /** The live viewer predicate, or `undefined` where the host has no viewer registry. */
  readonly canOpenViewer: () => ((address: string) => boolean) | undefined
  /** Whether this host exposes the workspace search the endpoint wraps. */
  readonly searchSupported: () => boolean
}

/** Selector hook stand-in for a composition without the viewer registry: a constant zero. */
const noViewerSource: SnapshotSelectorHook<number> = selector => selector(0)

export function createFilesTreeSurface(
  props: {
    readonly sessionId: SessionId
    readonly useStore: FilesTreeSurface['useStore']
    readonly actions: FilesTreeSurface['actions']
    readonly face: FilesInjected | undefined
    readonly openFile: ((address: string) => void) | undefined
    readonly openFileIn: FilesTreeInjected['openFileIn'] | undefined
    readonly useTreeSelection: FilesTreeSurface['useTreeSelection'] | undefined
    readonly selectRoot: FilesTreeSurface['selectRoot'] | undefined
    readonly takeover: FilesTreeSurface['takeover'] | undefined
    readonly useCanOpen?: SnapshotSelectorHook<number> | undefined
    /** The occupant's composed props, read structurally for `useContextMenu`. */
    readonly useContextMenu?: unknown
    /** The search seat's parts, all composed from the inject product when the plan supports them. */
    readonly useSearchState?: SnapshotSelectorHook<SearchPaneStates> | undefined
    readonly search?: SearchPaneStore | undefined
    readonly searchFiles?: FilesSearchRun | undefined
    readonly searchPreferences?: WorkspaceSearchPreferenceBook | undefined
  },
  t: FilesTreeProps['t'],
  deps: FilesTreeSurfaceDeps,
): FilesTreeSurface | undefined {
  if (!filesTreeSurfaceSupported()) return undefined
  const { sessionId, useStore, actions, face, openFile, openFileIn, useTreeSelection, selectRoot, takeover } = props
  if (face === undefined || openFile === undefined || openFileIn === undefined || useStore === undefined || actions === undefined
    || useTreeSelection === undefined || selectRoot === undefined || takeover === undefined) return undefined
  const search = deps.searchSupported()
    && props.useSearchState !== undefined && props.search !== undefined
    && props.searchFiles !== undefined && props.searchPreferences !== undefined
    ? {
      useSearchState: props.useSearchState,
      store: props.search,
      preferences: props.searchPreferences,
      run: props.searchFiles,
    } satisfies FilesTreeSearchSeat
    : undefined
  return {
    sessionId, useStore, actions, face, openFile, openFileIn, useTreeSelection, selectRoot, takeover, t,
    menu: filesMenuSeat(filesMenuHookOf(props), sessionId, deps.menuKinds),
    canOpen: deps.canOpenViewer(),
    useCanOpen: props.useCanOpen ?? noViewerSource,
    search,
  }
}

export { filesTreeSurfaceSupported, NS as FILES_TREE_NS }
export { FilesTree } from './FilesTree.tsx'
