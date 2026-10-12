/**
 * The fork's compile-time Remote face — the shape the copied `face.ts` was
 * written against, spelled locally because `tsconfig.client.json` maps
 * `@deepseek-ai/dsh-api-remotes/client` here.
 *
 * Why the indirection exists: the generated client declares
 * `workspaceFiles.changes` with two parameters on releases older than
 * `0.2.0-rc.2` (a session-wide watch) and three parameters after (a
 * path-scoped watch). The fork's `face.ts` is byte-identical to the
 * `0.2.1-alpha.2` baseline and spells the three-parameter call, so the
 * installed manifest's declaration cannot typecheck it on the older half of
 * the support matrix. That is safe, not cosmetic: the `files.actions` slot
 * the fork mounts through does not exist on those manifests, so the
 * three-parameter call can never actually run there. On every release that
 * *can* mount the fork, the installed signature is exactly this one — the
 * shape is the fork's pinned baseline, and the FORK.md sync step re-checks
 * it when the dev pin moves.
 *
 * `RemoteResult`/`RemoteFailure` are re-exported from their real home so the
 * verbatim imports keep resolving through this specifier unchanged.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/client-remote
 */
import type { RemoteResult, RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceDirectoryListing,
  WorkspaceFileWatchFrame,
} from '@deepseek-ai/dsh-api-workspace-files/types'

export type { RemoteResult, RemoteFailure }

/** One supervised-stream generation's opener surface, as `$stream` reads it. */
export interface SupervisedStreamOptions<Item> {
  /** Diagnostic owner name. */
  readonly name: string
  /** Open one physical generation; `signal` aborts it. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** The error a generation's normal end amounts to. */
  readonly ended: (accepted: boolean) => Error
}

/** The reconnecting stream the Remote supervisor hands back. */
export interface SupervisedStream<Item> extends AsyncIterable<{
  readonly value: Item
  accept(): void
}> {
  /** Stop the stream for good. */
  dispose(): Promise<void>
}

/** The Client Remote slice the fork calls, pinned to the dev-pin baseline. */
export interface ClientRemote {
  /** The `workspaceFiles` namespace, path-watch era signature. */
  readonly workspaceFiles: {
    readonly changes: (
      workspaceFileScopeId: SessionId,
      path: string,
      signal?: AbortSignal,
    ) => AsyncIterable<WorkspaceFileWatchFrame>
    readonly list: (
      workspaceFileScopeId: SessionId,
      path: string,
      signal?: AbortSignal,
    ) => Promise<RemoteResult<WorkspaceDirectoryListing>>
  }
  /** Create one reconnecting supervised stream. */
  $stream<Item>(options: SupervisedStreamOptions<Item>): SupervisedStream<Item>
}
