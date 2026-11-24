/**
 * The remote workspace provider: the `WorkspaceFilesProvider` that browses a
 * registered, opted-in remote root through the Host's bounded `remoteFiles`
 * channel (ADR-0052 P4). It is the ONLY remote implementation of the port —
 * the same tree, store and renderer serve it unchanged.
 *
 * Geometry: `treeRoot` is the synthetic key `/mrfw` — a namespace no local
 * path can collide with — and tree keys join with '/' only, since remote
 * names are POSIX bytes (a literal `\` is a name character, never a
 * separator). `resource()` maps a key back to its root-relative path and
 * validates it as a remote relative path, so no key can address outside the
 * grant.
 *
 * Capabilities: listing only. There is no watch (no filesystem stream
 * exists — invalidation is the authorization lease the owner runs), no
 * search, no preview, no menu, no open-in-app; `retainHiddenLevels` is
 * `false` because a hidden owner cannot keep re-proving its authorization.
 *
 * Failures are values: the fixed `remoteFiles` codes map to the upstream
 * `workspace-file` vocabulary where an equivalent exists, and everything
 * else wraps a localized message in `gateway/internal`. Authorization-class
 * failures — the codes after which the whole grant must be re-proved — also
 * notify `invalidated`, which is how a revoked or rebound grant retires the
 * tree instead of drawing it stale.
 *
 * Everything here is browser-safe; the wire client arrives injected.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/providers/ssh
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteFilesClient } from '../../remote-files-client.ts'
import {
  validRemoteRelativePath,
  type RemoteFilesFailureCode,
  type RemoteFilesListing,
} from '../../../remote/files-contract.ts'
import { RemoteFilesError } from '../../../remote/files-contract.ts'
import type { DirLevel } from '../store.ts'
import {
  belongsTo,
  type DirectoryListing,
  type FilesProviderIdentity,
  type WorkspaceFilesProvider,
  type WorkspaceResourceRef,
  type WorkspaceRootRef,
} from '../provider.ts'

/** The synthetic root key — presentation only, never a local or remote path. */
const REMOTE_TREE_ROOT = '/mrfw'
const REMOTE_TREE_PREFIX = `${REMOTE_TREE_ROOT}/`

/**
 * The codes after which the whole GRANT must be re-proved: browsing simply
 * cannot continue under the old authorization, so the owner retires the
 * tree. Per-directory filesystem failures (`permission-denied`,
 * `directory-not-found`, `path-escapes-root`), transient carrier failures
 * (`connection-*`, `timeout`, `resource-budget`) and caller cancels are NOT
 * in this set — those keep the ready tree and let the owner retry.
 */
const INVALIDATING = new Set<RemoteFilesFailureCode>([
  'provider-unavailable',
  'capability-unsupported',
  'session-unavailable',
  'root-unregistered',
  'root-identity-changed',
  'binding-changed',
  'environment-changed',
])

/**
 * The localization groups the UI dictionaries carry: nine buckets covering
 * the whole fixed vocabulary — a remote provider localizes the GROUP, not
 * each code separately.
 */
export type RemoteFilesFailureGroup =
  'unavailable' | 'capability' | 'permission' | 'authorization' | 'connection' | 'timeout' | 'busy' | 'invalid' | 'cancelled'

export const REMOTE_FILES_FAILURE_GROUPS: Record<RemoteFilesFailureCode, RemoteFilesFailureGroup> = {
  'provider-unavailable': 'unavailable',
  'session-unavailable': 'unavailable',
  'capability-unsupported': 'capability',
  'permission-denied': 'permission',
  'directory-not-found': 'permission',
  'not-directory': 'permission',
  'path-escapes-root': 'permission',
  'root-unregistered': 'authorization',
  'root-identity-changed': 'authorization',
  'binding-changed': 'authorization',
  'environment-changed': 'authorization',
  'connection-failed': 'connection',
  'connection-lost': 'connection',
  'timeout': 'timeout',
  'resource-budget': 'busy',
  'invalid-request': 'invalid',
  'invalid-listing': 'invalid',
  'cancelled': 'cancelled',
}

/** The codes with an upstream `workspace-file` equivalent; the rest degrade. */
const WORKSPACE_CODES: Partial<Record<RemoteFilesFailureCode, string>> = {
  'directory-not-found': 'workspace-file/not-found',
  'not-directory': 'workspace-file/not-directory',
  'path-escapes-root': 'workspace-file/outside-workspace',
}

/** The failure an inadmissible resource settles as — never a wire call. */
const outside = (resource: WorkspaceResourceRef): RemoteFailure =>
  new RemoteError('workspace-file/outside-workspace', 'the resource is outside this provider root', { path: resource.relativePath })

/** `remoteFiles` entry kinds into the upstream listing vocabulary: a symlink is an inert `other` row here. */
const levelOf = (listing: RemoteFilesListing): DirLevel => ({
  entries: listing.entries.map(entry => ({
    name: entry.name,
    type: entry.type === 'file' ? 'file' : entry.type === 'directory' ? 'directory' : 'other',
  })),
  truncated: listing.truncated,
})

/**
 * Build the provider that browses one registered remote root over SFTP.
 * @param identity - session, remote root ref, and the browseAuthorization
 *   token as its incarnation — a re-granted or rebound root is a different
 *   provider.
 * @param client - the `remoteFiles` channel client.
 * @param localize - code → display message for the failure the row shows.
 * @param invalidated - the grant lost its authorization: the owner retires
 *   the tree and re-proves. Only called for the invalidating codes.
 * @returns the workspace provider.
 */
export function createSshWorkspaceProvider(
  identity: FilesProviderIdentity & { readonly root: Extract<WorkspaceRootRef, { readonly kind: 'remote' }> },
  client: RemoteFilesClient,
  localize: (code: RemoteFilesFailureCode) => string,
  invalidated: (reason: RemoteFilesFailureCode) => void,
): WorkspaceFilesProvider {
  const { sessionId, root } = identity
  const resource = (treePath: string): WorkspaceResourceRef | undefined => {
    const relativePath = treePath === REMOTE_TREE_ROOT
      ? ''
      : treePath.startsWith(REMOTE_TREE_PREFIX) ? treePath.slice(REMOTE_TREE_PREFIX.length) : undefined
    if (relativePath === undefined || !validRemoteRelativePath(relativePath)) return undefined
    const ref: WorkspaceResourceRef = { root, relativePath }
    return belongsTo(identity, ref) ? ref : undefined
  }
  const cancelled = (): DirectoryListing => ({
    ok: false,
    error: new RemoteError('gateway/internal', localize('cancelled'), {}),
  })
  const failureOf = (error: unknown, ref: WorkspaceResourceRef): RemoteFailure => {
    const code = error instanceof RemoteFilesError ? error.code : undefined
    if (code !== undefined && INVALIDATING.has(code)) invalidated(code)
    if (code !== undefined && code in WORKSPACE_CODES) {
      return new RemoteError(WORKSPACE_CODES[code] as 'workspace-file/not-found', localize(code), { path: ref.relativePath })
    }
    if (code !== undefined) return new RemoteError('gateway/internal', localize(code), {})
    return new RemoteError('gateway/internal', localize('connection-failed'), {})
  }
  return {
    identity,
    treeRoot: REMOTE_TREE_ROOT,
    joinChild: (parent, name) => `${parent}/${name}`,
    retainHiddenLevels: false,
    resource,
    listDirectory: async (ref, signal): Promise<DirectoryListing> => {
      if (!belongsTo(identity, ref) || !validRemoteRelativePath(ref.relativePath)) {
        return { ok: false, error: outside(ref) }
      }
      if (signal.aborted) return cancelled()
      try {
        const listing = await client.list({
          sessionId,
          environmentId: root.environmentId,
          rootId: root.rootId,
          relativePath: ref.relativePath,
          authorization: identity.incarnation,
        }, signal)
        if (signal.aborted) return cancelled()
        return { ok: true, value: levelOf(listing) }
      } catch (error: unknown) {
        // The request was already cancelled before this failure arrived —
        // an old masked invalidator must never evict the current record.
        if (signal.aborted) return cancelled()
        return { ok: false, error: failureOf(error, ref) }
      }
    },
  }
}
