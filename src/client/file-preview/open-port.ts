/**
 * The Files-row → remote preview port (ADR-0053 P6): the `preview` field one
 * SSH workspace provider advertises. Every gesture is fenced through
 * `belongsTo` + the remote relative-path vocabulary, so a stale or foreign
 * row can never name a record the integration did not mint.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/open-port
 */
import { validRemoteRelativePath } from '../../remote/files-contract.ts'
import { belongsTo, type WorkspaceFilesProvider, type WorkspaceResourceRef } from '../files-tree/provider.ts'
import type { SshFilesIdentity } from './authorization.ts'
import type { RemotePreviewIntegration } from './install.tsx'

/**
 * The provider's preview port for one remote grant: rows may open only
 * while they belong to THIS identity, spell an admissible remote relative
 * path, and the integration can still route for the selection's session.
 */
export function createRemotePreviewPort(identity: SshFilesIdentity, label: string, preview: RemotePreviewIntegration): NonNullable<WorkspaceFilesProvider['preview']> {
  const canOpen = (resource: WorkspaceResourceRef): boolean => belongsTo(identity, resource)
    && resource.relativePath !== '' && validRemoteRelativePath(resource.relativePath) && preview.canRoute(identity.sessionId)
  return {
    canOpen,
    open(resource, options) {
      if (canOpen(resource)) preview.open(identity, resource.relativePath, label, options?.replaceTab)
    },
  }
}
