/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `hold` / `release` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the write set stays the store's.
 *
 * The listing itself is provider-bound: `hold`/`start` receive the
 * `WorkspaceFilesProvider` the owner resolved, the store bucket is seeded at
 * `provider.treeRoot`, and every level key is mapped through
 * `provider.resource(...)` before any port sees it — a tree key is never a
 * path a port consumes.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 *
 * A hold can end without its record ending: `release` closes the hold's
 * directory node and watches but keeps the listed levels and expansion, and
 * the next `hold` reopens them. That is upstream's `hold(paneId, cwd)` —
 * closing a navigator is not closing its pane, so reopening draws the kept
 * rows instead of falling back to a loading row.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { DirLevel, createFilesStore } from './store.ts'
import { DirectoryNode } from './directory-node.ts'
import { providerKey, type WorkspaceFilesProvider } from './provider.ts'

export { childPath } from './resource-path.ts'

/** Fold an unexpected provider exception into a settled Remote failure. */
const failureOf = (error: unknown): RemoteFailure =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error as RemoteFailure
    : new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})

/**
 * A watch that can never produce a frame — parked on its signal for a tree
 * key whose resource mapping failed, so the level neither lists nor hangs
 * the node's task on an iterable that already ended.
 */
const parkedWatch = (signal: AbortSignal): AsyncIterable<'ready' | 'change'> =>
  (async function* (): AsyncGenerator<'ready' | 'change'> {
    if (!signal.aborted) {
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }
  })()

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tree bucket. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tree bucket. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this bucket's tree and list its root. This is the record's first open:
   * it always reseeds the store at the provider's `treeRoot`, so use
   * {@link hold} for later holds.
   * @param tabId - the tree bucket being drawn (`treeBucketId(owner, identity)`).
   * @param provider - the provider the tree lists through.
   * @param signal - the record's lifetime.
   */
  readonly start: (tabId: TabId, provider: WorkspaceFilesProvider, signal: AbortSignal) => void
  /**
   * Open one hold on this bucket's tree and list its root.
   *
   * The store bucket is reused when it already belongs to this provider; its
   * listed levels stay drawn while the reopened node's listings settle, so a
   * navigator closed and reopened by the reader never flashes a loading row
   * over rows it already had. A different provider — a different root, or the
   * same root re-granted — reseeds the bucket, exactly like `start`.
   * @param tabId - the tree bucket being drawn.
   * @param provider - the provider the tree lists through.
   * @param signal - the record's lifetime; aborting it still forgets the
   *   bucket and closes the node.
   * @param restore - expanded directories to reopen as their parent listing
   *   returns (the kept tree's expansion preferences).
   */
  readonly hold: (tabId: TabId, provider: WorkspaceFilesProvider, signal: AbortSignal, restore?: readonly string[]) => void
  /**
   * End one hold: close its directory node and watches while keeping the store
   * bucket and expansion for the next `hold`. The record's `signal` still owns
   * the bucket; aborting it forgets the tree.
   * @param tabId - the bucket whose hold ends.
   */
  readonly release: (tabId: TabId) => void
  /**
   * List one directory into the store.
   * @param tabId - the tree bucket being drawn.
   * @param path - the directory's tree key.
   * @param signal - the record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tree bucket being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - the directory's tree key.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/**
 * Bind the tree's face to the store's bound actions.
 *
 * The listing and watching ports arrive per hold through the provider; the
 * face only owns the bookkeeping — one pending-request token per
 * (bucket, level), one directory node per hold, one provider per bound
 * bucket.
 * @param actions - the store's bound actions for this session.
 * @returns the face the slot's `inject` product exposes.
 */
export function filesFace(
  actions: BoundActions<ReturnType<typeof createFilesStore>>,
): FilesInjected {
  /** Per bucket, per tree key: the request token a settlement must match; the latest request wins. */
  const tokens = new Map<TabId, Map<string, symbol>>()
  const roots = new Map<TabId, DirectoryNode>()
  /** The provider key each bucket's store bucket belongs to; kept while a hold is released. */
  const buckets = new Map<TabId, string>()
  /** The provider each bucket's requests dispatch through. */
  const providers = new Map<TabId, WorkspaceFilesProvider>()
  /** The record signal each bucket's store answers to. */
  const bindings = new Map<TabId, AbortSignal>()
  const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
    if (signal.aborted) return
    // A unique token per request: a counter could repeat after a release
    // wiped the bookkeeping and let a stale settlement write again.
    const token = Symbol()
    const byPath = tokens.get(tabId) ?? new Map<string, symbol>()
    tokens.set(tabId, byPath)
    byPath.set(path, token)
    const provider = providers.get(tabId)
    const resource = provider?.resource(path)
    const stale = (): boolean => signal.aborted || tokens.get(tabId)?.get(path) !== token
    if (provider === undefined || resource === undefined) {
      // A key outside the provider's geometry never reaches a port — it
      // settles as a failure instead of hanging the level at `loading`.
      actions.failed(tabId, path, new RemoteError('workspace-file/outside-workspace', `the tree key "${path}" is outside the provider root`, { path }))
      return
    }
    actions.loading(tabId, path)
    return provider.listDirectory(resource, signal).then((result) => {
      // A newer listing of this level was asked for since, or the record is
      // gone and its bookkeeping with it: nothing left for this one to write.
      if (stale()) return
      if (result.ok) actions.loaded(tabId, path, result.value, provider.joinChild)
      else actions.failed(tabId, path, result.error)
      return result.ok ? result.value : undefined
    }, (error: unknown) => {
      // A provider must not reject — but an adapter that does folds into the
      // settled failure row rather than dying inside the node's task.
      if (stale()) return
      actions.failed(tabId, path, failureOf(error))
      return undefined
    })
  }
  // One hold's node: the store bucket is separate, so closing a node must not
  // touch the levels the next hold resumes from.
  const closeNode = (tabId: TabId): void => {
    const root = roots.get(tabId)
    roots.delete(tabId)
    tokens.delete(tabId)
    void root?.close()
  }
  // The record's death: close the hold and drop everything the record owned.
  const forget = (tabId: TabId): void => {
    closeNode(tabId)
    buckets.delete(tabId)
    providers.delete(tabId)
    bindings.delete(tabId)
    actions.forget(tabId)
  }
  // One listener per record signal; a superseded binding is inert.
  const bindRecord = (tabId: TabId, signal: AbortSignal): void => {
    if (bindings.get(tabId) === signal) return
    bindings.set(tabId, signal)
    signal.addEventListener('abort', () => {
      if (bindings.get(tabId) !== signal) return
      forget(tabId)
    }, { once: true })
  }
  // `reset` is `start`: a fresh store bucket even for a kept provider. `hold`
  // reuses the same provider's bucket and reopens its expanded levels in place.
  const open = (tabId: TabId, provider: WorkspaceFilesProvider, signal: AbortSignal, restore: readonly string[], reset: boolean): void => {
    if (signal.aborted) return
    closeNode(tabId)
    bindRecord(tabId, signal)
    const key = providerKey(provider.identity)
    if (reset || buckets.get(tabId) !== key) {
      actions.start(tabId, provider.treeRoot)
      buckets.set(tabId, key)
      restore = []
    }
    providers.set(tabId, provider)
    const watch = provider.watchDirectory
    roots.set(tabId, new DirectoryNode(
      provider.treeRoot,
      (path, lifetime) => load(tabId, path, lifetime),
      watch === undefined
        ? undefined
        : (path, lifetime) => {
            if (lifetime.aborted) return parkedWatch(lifetime)
            const resource = provider.resource(path)
            return resource === undefined ? parkedWatch(lifetime) : watch(resource, lifetime)
          },
      (path, error) => {
        if (!signal.aborted) actions.failed(tabId, path, failureOf(error))
      },
      signal, restore, provider.joinChild,
    ).open())
  }
  return {
    refresh: (tabId) => { void roots.get(tabId)?.refreshTree() },
    setAutoRefresh: (tabId, enabled) => {
      actions.autoRefresh(tabId, enabled)
      roots.get(tabId)?.setAutomatic(enabled)
    },
    start: (tabId, provider, signal) => { open(tabId, provider, signal, [], true) },
    hold: (tabId, provider, signal, restore = []) => { open(tabId, provider, signal, restore, false) },
    release: (tabId) => { closeNode(tabId) },
    load: (tabId, path, signal) => { void load(tabId, path, signal) },
    toggle(tabId, parentPath, path, expanded, signal) {
      if (signal.aborted) return
      const root = roots.get(tabId)
      if (root === undefined) return
      const parent = root.find(parentPath)
      if (parent === undefined && !expanded.includes(parentPath)) return
      const collapsing = expanded.includes(path)
      const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
      root.setExpanded(next)
      if (collapsing) void parent?.collapse(path)
      else parent?.expand(path, next)
      actions.toggled(tabId, path)
    },
  }
}
