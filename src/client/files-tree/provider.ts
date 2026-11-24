/**
 * The files tree's provider contract: one logical workspace root's browsing
 * capability, spelled against resource references instead of local paths.
 *
 * Identity is a discriminated root reference plus an incarnation, never a
 * display path: the same absolute path under another session, environment,
 * or registration is another tree. A provider's `treeRoot` and the row keys
 * under it are presentation strings only — every I/O port receives the
 * `WorkspaceResourceRef` that {@link WorkspaceFilesProvider.resource} maps a
 * tree key back to, so a synthetic remote tree key can never be mistaken for
 * a local path (ADR-0052).
 *
 * Optional ports ARE the capability contract: a provider without
 * `watchDirectory` opens with an explicit initial read and gets no stream, a
 * provider without `search`/`preview`/`rowMenu`/`openInApp` simply lacks that
 * surface — there are no parallel booleans to disagree.
 *
 * Everything here is browser-safe: no host types, no Node imports.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/provider
 */
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FilesMenuSeat, FilesMenuTriggerProps, FilesRowKind } from './context-menu.ts'
import type { JoinTreeChild } from './resource-path.ts'
import type { WorkspaceSearchAnswer, WorkspaceSearchRequest } from './search-client.ts'
import type { DirLevel } from './store.ts'

/**
 * Which workspace root a provider browses. The discriminant — never the
 * display path — is the identity: `'additional'` is a registered local
 * additional root, `'remote'` a root of a remote environment, `'primary'`
 * the session's own root (the native tree still owns it; the ref completes
 * the union for selection state).
 */
export type WorkspaceRootRef =
  | { readonly kind: 'primary' }
  | { readonly kind: 'additional'; readonly rootId: string }
  | { readonly kind: 'remote'; readonly environmentId: string; readonly rootId: string }

/** One entry inside a root, addressed without any local spelling. */
export interface WorkspaceResourceRef {
  /** The root the entry belongs to. */
  readonly root: WorkspaceRootRef
  /** `/`-separated path under the root; `''` is the root itself. */
  readonly relativePath: string
}

/** A provider instance's identity: session, root, and authorization incarnation. */
export interface FilesProviderIdentity {
  /** The session the provider's ports act for. */
  readonly sessionId: SessionId
  /** The root this provider browses. */
  readonly root: WorkspaceRootRef
  /**
   * The authorization incarnation: the same root re-granted is a different
   * provider (a local root's `addedAt`, a remote record's generation), so an
   * old grant's provider record can never serve the new one's tree.
   */
  readonly incarnation: string
}

/** One directory listing's outcome — a provider does not reject. */
export type DirectoryListing =
  | { readonly ok: true; readonly value: DirLevel }
  | { readonly ok: false; readonly error: RemoteFailure }

/**
 * One workspace root's browsing capability.
 *
 * `treeRoot` is the tree-key spelling of the root resource; `resource` maps
 * any tree key back to its resource reference, returning `undefined` for a
 * key outside the provider's geometry so no foreign key can reach a port.
 */
export interface WorkspaceFilesProvider {
  readonly identity: FilesProviderIdentity
  /** The tree key of the root resource — the store bucket's `root` field. */
  readonly treeRoot: string
  /**
   * The child-key join for this provider's geometry, or `undefined` for the
   * local mixed-separator default ({@link childPath} in resource-path.ts).
   */
  readonly joinChild?: JoinTreeChild | undefined
  /**
   * Map a tree key to its resource reference.
   * @param treePath - a row or level key as the tree stores it.
   * @returns the resource, or `undefined` when the key is outside this root.
   */
  readonly resource: (treePath: string) => WorkspaceResourceRef | undefined
  /**
   * List one directory.
   * @param resource - the directory to list.
   * @param signal - the listing's lifetime.
   * @returns the settled listing; failures are values, never rejections.
   */
  readonly listDirectory: (resource: WorkspaceResourceRef, signal: AbortSignal) => Promise<DirectoryListing>
  /**
   * Observe one directory without recursively watching its descendants.
   * Absent means the level is read explicitly once and never streamed.
   */
  readonly watchDirectory?: ((resource: WorkspaceResourceRef, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>) | undefined
  /** Workspace search over this root; absent means no search surface. */
  readonly search?: ((request: WorkspaceSearchRequest, signal: AbortSignal) => Promise<WorkspaceSearchAnswer>) | undefined
  /**
   * Opening a resource in the host's viewer surface. Absent means rows are
   * not openable: `rowActions` reports `canOpen: false` and yields no `open`.
   */
  readonly preview?: {
    /** Whether some registered viewer claims this resource right now. */
    readonly canOpen: (resource: WorkspaceResourceRef) => boolean
    /** Open the resource; `replaceTab` is the document navigator's route. */
    readonly open: (resource: WorkspaceResourceRef, options?: { readonly replaceTab?: TabId }) => void
  } | undefined
  /** Row context-menu attachment, or `undefined` where this root has none. */
  readonly rowMenu?: ((resource: WorkspaceResourceRef, kind: FilesRowKind) => FilesMenuTriggerProps | undefined) | undefined
  /** The path an open-in-app control should offer for this resource, if any. */
  readonly openInApp?: ((resource: WorkspaceResourceRef) => string | undefined) | undefined
}

/**
 * The canonical key of one root reference — the discriminant and its fields,
 * never a display path.
 * @param root - the root reference.
 * @returns a stable string key.
 */
export function rootKey(root: WorkspaceRootRef): string {
  return JSON.stringify(root.kind === 'primary' ? ['primary'] : root.kind === 'additional' ? ['additional', root.rootId] : ['remote', root.environmentId, root.rootId])
}

/**
 * A provider instance's key: session, root, and incarnation. Identical paths
 * under different sessions, environments, roots, or grants never share it.
 * @param id - the provider identity.
 * @returns the stable provider key.
 */
export const providerKey = (id: FilesProviderIdentity): string => JSON.stringify([id.sessionId, rootKey(id.root), id.incarnation])

/**
 * The store bucket id for one owner's tree of one provider: the owner (a
 * dockkit tab or pane id) plus the provider key, so two owners browsing the
 * same root — or one owner browsing a re-granted root — keep separate
 * buckets. Spelled as a `TabId` because the store, the takeover map, and the
 * search records all key on that type.
 * @param owner - the owner's dockkit identity.
 * @param id - the provider identity.
 * @returns the bucket id to hand the face and the store.
 */
export const treeBucketId = (owner: TabId, id: FilesProviderIdentity): TabId => JSON.stringify([owner, providerKey(id)]) as TabId

/**
 * Whether a `/`-separated relative path is admissible: no empty, dot, or
 * `..` segment and no NUL. `''` is the root itself and always valid.
 * @param path - the relative path to validate.
 * @returns `true` when the path stays inside the root.
 */
export const validRelativePath = (path: string): boolean => path === '' || path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\0'))

/**
 * Whether a resource reference belongs to a provider identity: same root
 * reference, admissible relative path.
 * @param id - the provider identity.
 * @param resource - the resource reference to check.
 * @returns `true` when the provider may act on the resource.
 */
export const belongsTo = (id: FilesProviderIdentity, resource: WorkspaceResourceRef): boolean => rootKey(id.root) === rootKey(resource.root) && validRelativePath(resource.relativePath)

/**
 * The row gestures a renderer dispatches through a provider, resolved per
 * tree path at call time: a stale row whose key no longer maps to a resource
 * — or a record whose signal already ended — is a no-op, never a foreign
 * path handed to a port.
 */
export interface FilesRowActions {
  /**
   * Whether a file row opens at all — the Factory's `canOpen` input. `false`
   * whenever the provider has no preview port, the signal ended, or the path
   * maps to no resource.
   */
  readonly canOpen: (path: string) => boolean
  /**
   * Open a file row. `undefined` when the provider has no preview port:
   * the legacy rows draw the row disabled and the Factory's open is a no-op.
   */
  readonly open: ((path: string) => void) | undefined
  /** Row context-menu attachment, or `undefined` when the provider has none. */
  readonly menu: FilesMenuSeat | undefined
}

/**
 * Derive the renderer's row gestures from a provider.
 *
 * Every gesture resolves `provider.resource(path)` at dispatch: preview and
 * menu ports only ever see `WorkspaceResourceRef`s — a local URI is computed
 * inside the provider, never here — and a dead signal or an unmappable key
 * produces no port call at all.
 * @param provider - the provider whose ports back the gestures.
 * @param signal - the owner record's lifetime.
 * @param replaceTab - the document navigator's replace-tab route, when the
 *   owner is a preview.
 * @returns the path-keyed gestures the renderers consume.
 */
export function rowActions(provider: WorkspaceFilesProvider, signal: AbortSignal, replaceTab?: TabId): FilesRowActions {
  const preview = provider.preview
  const menuPort = provider.rowMenu
  return {
    canOpen: (path) => {
      if (preview === undefined || signal.aborted) return false
      const resource = provider.resource(path)
      return resource !== undefined && preview.canOpen(resource)
    },
    open: preview === undefined ? undefined : (path) => {
      if (signal.aborted) return
      const resource = provider.resource(path)
      if (resource === undefined) return
      preview.open(resource, replaceTab === undefined ? undefined : { replaceTab })
    },
    menu: menuPort === undefined ? undefined : {
      trigger: (path, kind) => {
        if (signal.aborted) return undefined
        const resource = provider.resource(path)
        return resource === undefined ? undefined : menuPort(resource, kind)
      },
    },
  }
}
