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
import type { FilesTreeProps } from './FilesTree.tsx'
import type { RootView } from '../../contract.ts'
import { NS } from './locales.ts'

/** The `sidebarRight` face the fork uses to open a file resource. */
interface SidebarRightOpen {
  readonly openResourceIn?: (sessionId: SessionId, address: string) => void
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
export interface FilesTreeTakeover {
  /**
   * The live signal for (tabId, root); reuses the live entry so a remounted
   * body finds its bucket and watches intact. A different root — or an entry
   * already aborted — ends the previous controller before minting the next.
   * @param tabId - the pane's dockkit tab id.
   * @param root - absolute path of the root being browsed.
   * @returns the signal the forked tree lives under.
   */
  readonly signal: (tabId: TabId, root: string) => AbortSignal
  /**
   * Abort and drop one tab's takeover: the reader deselected or switched
   * roots, or the tab record itself went away.
   * @param tabId - the pane's dockkit tab id.
   */
  readonly end: (tabId: TabId) => void
}

/** The inject face the registration composes onto the occupant's props. */
export interface FilesTreeInjected {
  /** The verbatim files face (list/watch bookkeeping included). */
  readonly face: FilesInjected
  /** Open one `dsh-resource://file` address in the host viewer. */
  readonly openFile: (address: string) => void
  /**
   * The reserved inject compartment: the slot renderer binds each source to a
   * `use<Name>` selector hook, so `treeSelection` reaches the component as
   * `useTreeSelection`, never as a prop under its own key.
   */
  readonly hooks: { readonly treeSelection: HostObservable<TreeSelection> }
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

/** Everything `FilesTree` needs that the slot framework does not synthesize. */
export interface FilesTreeSurface {
  readonly sessionId: SessionId
  readonly useStore: FilesTreeProps['useStore']
  readonly actions: FilesTreeProps['actions']
  readonly face: FilesInjected
  readonly openFile: (address: string) => void
  readonly t: FilesTreeProps['t']
  /** Selector hook over this session's per-tab root selections. */
  readonly useTreeSelection: SnapshotSelectorHook<TreeSelection>
  /** The selection's write side; see {@link FilesTreeInjected.selectRoot}. */
  readonly selectRoot: FilesTreeInjected['selectRoot']
  /** The forked tree's lifetimes; see {@link FilesTreeTakeover}. */
  readonly takeover: FilesTreeTakeover
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
 * The inject face nests the verbatim files face under `face` and adds the
 * session-bound `openFile` — keeping `FilesInjected` untouched means the
 * fork's call sites and the sync diff stay upstream-shaped.
 * @param ctx - the client root context (the remote/sidebarRight lookups).
 * @returns the store handle and the inject factory for `register`.
 */
export function createFilesTreeSeats(ctx: ClientContext): {
  readonly store: ReturnType<typeof createFilesStore>
  readonly inject: (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesTreeInjected
} {
  const store = createFilesStore()
  const remote = lazyFilesRemote(ctx)
  const face = filesFace(createList(remote), createWatch(remote))
  const inject = (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>): FilesTreeInjected => {
    // Both live at the inject product's scope — one instance per session — so
    // the selection and the controllers it runs under survive the body remount
    // an opened file causes (the file tab takes the pane, the Files body
    // unmounts, and component state would otherwise reset to 'primary').
    const selection = createSnapshotStore<TreeSelection>({})
    const takeovers = new Map<TabId, { readonly controller: AbortController; readonly root: string }>()
    return {
      face: face(sessionId, actions),
      openFile: (address: string) => {
        const sidebar = (ctx as unknown as { get(key: string): unknown }).get('sidebarRight') as SidebarRightOpen | undefined
        sidebar?.openResourceIn?.(sessionId, address)
      },
      hooks: { treeSelection: selection },
      selectRoot: (tabId, root) => {
        const next: Record<string, RootView> = { ...selection.getSnapshot() }
        if (root === 'primary') delete next[tabId]
        else next[tabId] = root
        selection.set(next)
      },
      takeover: {
        signal: (tabId, root) => {
          let held = takeovers.get(tabId)
          if (held === undefined || held.root !== root || held.controller.signal.aborted) {
            held?.controller.abort()
            held = { controller: new AbortController(), root }
            takeovers.set(tabId, held)
          }
          return held.controller.signal
        },
        end: (tabId) => {
          takeovers.get(tabId)?.controller.abort()
          takeovers.delete(tabId)
        },
      },
    }
  }
  return { store, inject }
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
export function createFilesTreeSurface(
  props: {
    readonly sessionId: SessionId
    readonly useStore: FilesTreeSurface['useStore']
    readonly actions: FilesTreeSurface['actions']
    readonly face: FilesInjected | undefined
    readonly openFile: ((address: string) => void) | undefined
    readonly useTreeSelection: FilesTreeSurface['useTreeSelection'] | undefined
    readonly selectRoot: FilesTreeSurface['selectRoot'] | undefined
    readonly takeover: FilesTreeSurface['takeover'] | undefined
  },
  t: FilesTreeProps['t'],
): FilesTreeSurface | undefined {
  if (!filesTreeSurfaceSupported()) return undefined
  const { sessionId, useStore, actions, face, openFile, useTreeSelection, selectRoot, takeover } = props
  if (face === undefined || openFile === undefined || useStore === undefined || actions === undefined
    || useTreeSelection === undefined || selectRoot === undefined || takeover === undefined) return undefined
  return { sessionId, useStore, actions, face, openFile, useTreeSelection, selectRoot, takeover, t }
}

export { filesTreeSurfaceSupported, NS as FILES_TREE_NS }
export { FilesTree } from './FilesTree.tsx'
