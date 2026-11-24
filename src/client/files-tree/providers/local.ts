/**
 * The local workspace provider: the `WorkspaceFilesProvider` that browses a
 * registered additional root through the session's `workspaceFiles` remote.
 *
 * This is the one place the tree's local geometry lives: `treeRoot` is the
 * absolute root path as the Host reports it, tree keys keep the existing
 * mixed-separator spelling, and every port converts a
 * `WorkspaceResourceRef` back to the local absolute spelling the wire
 * methods, the viewer registry, the menu seat, and the file-address encoder
 * already consume. Only this adapter spells `fileAddressFor` for the tree —
 * the renderers dispatch resources, never addresses.
 *
 * Everything here is browser-safe; the wire ports arrive injected so tests
 * can bind stubs without a remote.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/providers/local
 */
import type { ClientRemote, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { FilesMenuSeat, FilesRowKind } from '../context-menu.ts'
import { windowsRoot } from '../locate.ts'
import { childPath } from '../resource-path.ts'
import type { FilesSearchRun, WorkspaceSearchAnswer, WorkspaceSearchRequest } from '../search-client.ts'
import type { DirLevel } from '../store.ts'
import {
  belongsTo,
  validRelativePath,
  type DirectoryListing,
  type FilesProviderIdentity,
  type WorkspaceFilesProvider,
  type WorkspaceResourceRef,
  type WorkspaceRootRef,
} from '../provider.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/** The injected local ports a provider's capabilities bind to. */
export interface LocalWorkspacePorts {
  /** The bound `workspaceFiles.list` call. */
  readonly list: ListWorkspaceDirectory
  /** The bound `workspaceFiles.changes` stream supervisor. */
  readonly watch: WatchWorkspaceDirectory
  /**
   * The plugin channel's additional-root search, bound by registry root id —
   * present only where the host exposes workspace search and the panel
   * channel exists (`0.2.2-rc.2+`).
   */
  readonly search?: FilesSearchRun | undefined
  /**
   * Open one `dsh-resource://file` address — the session-bound
   * `sidebarRight.openResourceIn` route, `replaceTab` included.
   */
  readonly open: (address: string, options?: { readonly replaceTab?: TabId }) => void
  /**
   * Whether a registered viewer claims one file address (`0.2.2-alpha.3+`).
   * Absent leaves every file openable, the pre-registry native behavior.
   */
  readonly canOpen?: ((address: string) => boolean) | undefined
  /** The pane's row context menus, pre-bound to the session. */
  readonly menu?: FilesMenuSeat | undefined
}

/** The failure an inadmissible resource settles as — never a wire call. */
const outside = (resource: WorkspaceResourceRef): RemoteFailure =>
  new RemoteError('workspace-file/outside-workspace', 'the resource is outside this provider root', { path: resource.relativePath })

/**
 * Build the provider that browses one registered additional root locally.
 *
 * Geometry: `treeRoot` is `absoluteRoot`; `resource()` accepts the exact
 * spelling plus the normalized (and, on a Windows root, case-insensitive)
 * spelling a search answer may carry, keeps the tail's original bytes — a
 * POSIX name's literal `\` survives — and validates it as a relative path
 * before any port sees it. A Windows root additionally refuses a `\` inside
 * the tail, so a resource can never cross the root through the other
 * separator.
 * @param identity - session, additional root ref, and registration incarnation.
 * @param absoluteRoot - the root's absolute path as the Host reports it.
 * @param ports - the session-bound wire and host ports.
 * @returns the workspace provider.
 */
export function createLocalWorkspaceProvider(
  identity: FilesProviderIdentity & { readonly root: Extract<WorkspaceRootRef, { readonly kind: 'additional' }> },
  absoluteRoot: string,
  ports: LocalWorkspacePorts,
): WorkspaceFilesProvider {
  const sessionId = identity.sessionId
  const trimmedRoot = absoluteRoot.replace(/[/\\]+$/, '')
  const normalizedRoot = trimmedRoot.replace(/\\/g, '/')
  const caseless = windowsRoot(absoluteRoot)
  // The alternate spellings a resource key may arrive in: the root's own
  // string plus the separator/case-normalized form a host search answer may
  // carry. On POSIX a `\` is a filename byte, never a separator, so the
  // normalized match only applies where the root itself is Windows-shaped.
  const alternate = caseless || absoluteRoot.includes('\\')
  const sameRoot = (head: string, root: string): boolean =>
    caseless ? head.toLowerCase() === root.toLowerCase() : head === root
  /**
   * The `/`-separated tail one tree key names under the root, or `undefined`
   * when the key is outside the root's geometry.
   */
  const tailOf = (treePath: string): string | undefined => {
    if (treePath === absoluteRoot || treePath === trimmedRoot) return ''
    if (treePath.startsWith(`${trimmedRoot}/`)) return treePath.slice(trimmedRoot.length + 1)
    if (!alternate) return undefined
    const normalized = treePath.replace(/\\/g, '/')
    if (sameRoot(normalized, normalizedRoot)) return ''
    const prefix = `${normalizedRoot}/`
    const head = normalized.slice(0, prefix.length)
    return sameRoot(head, prefix) ? normalized.slice(prefix.length) : undefined
  }
  const resource = (treePath: string): WorkspaceResourceRef | undefined => {
    const tail = tailOf(treePath)
    if (tail === undefined) return undefined
    const ref: WorkspaceResourceRef = { root: identity.root, relativePath: tail }
    return admitted(ref) ? ref : undefined
  }
  /**
   * Whether a resource reference may reach a port: same root, a valid
   * relative path, and — under a Windows root, where `\` is a separator —
   * no `\` inside the tail (POSIX keeps the byte: it is a legal name there).
   */
  const admitted = (ref: WorkspaceResourceRef): boolean =>
    belongsTo(identity, ref) && !(caseless && ref.relativePath.includes('\\'))
  /**
   * The local absolute spelling of one resource: the existing mixed-separator
   * convention, `''` mapping to the root itself.
   */
  const absolute = (ref: WorkspaceResourceRef): string =>
    ref.relativePath === '' ? absoluteRoot : childPath(absoluteRoot, ref.relativePath)
  const preview = {
    canOpen: (ref: WorkspaceResourceRef): boolean =>
      admitted(ref) && (ports.canOpen === undefined || ports.canOpen(fileAddressFor(sessionId, undefined, absolute(ref)))),
    open: (ref: WorkspaceResourceRef, options?: { readonly replaceTab?: TabId }): void => {
      if (!admitted(ref)) return
      ports.open(fileAddressFor(sessionId, undefined, absolute(ref)), options)
    },
  }
  return {
    identity,
    treeRoot: absoluteRoot,
    resource,
    listDirectory: (ref, signal) => {
      if (!admitted(ref)) return Promise.resolve({ ok: false as const, error: outside(ref) })
      return ports.list(sessionId, absolute(ref), signal).then((result): DirectoryListing =>
        result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error })
    },
    watchDirectory: (ref, signal) => {
      if (!admitted(ref)) {
        // An inadmissible watch parks instead of ending: a watch that returns
        // early would leave the level's first read unanswered forever.
        return (async function* (): AsyncGenerator<'ready' | 'change'> {
          if (!signal.aborted) {
            await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
          }
        })()
      }
      return ports.watch(sessionId, absolute(ref), signal)
    },
    ...(ports.search === undefined ? {} : {
      search: (request: WorkspaceSearchRequest, signal: AbortSignal): Promise<WorkspaceSearchAnswer> =>
        ports.search!(identity.root.rootId, request, signal).then((answer) => {
          // The answer's root must be this root's directory: an endpoint that
          // answers for another root would draw its rows under this tree's
          // keys. The comparison is normalized so a Windows spelling that
          // differs only in case or separators still counts as the same root.
          const claimed = answer.root.replace(/[/\\]+$/, '').replace(/\\/g, '/')
          if (!sameRoot(claimed, normalizedRoot)) {
            throw new RemoteError('gateway/internal', 'the search answer names a different workspace root', {})
          }
          return answer
        }),
    }),
    preview,
    ...(ports.menu === undefined ? {} : {
      rowMenu: (ref: WorkspaceResourceRef, kind: FilesRowKind) =>
        admitted(ref) ? ports.menu!.trigger(absolute(ref), kind) : undefined,
    }),
    openInApp: (ref) => (admitted(ref) ? absolute(ref) : undefined),
  }
}
