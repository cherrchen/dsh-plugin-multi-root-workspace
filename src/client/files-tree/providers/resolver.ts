/**
 * The provider composition slot: which provider a selected root resolves to.
 *
 * A selection carries the discriminated ref, the authorization incarnation,
 * and the display metadata (`path`, the live view it was minted from)
 * separately: the first two are identity, the rest is presentation.
 * `resolveWorkspaceFilesProvider` is the single point the remote branch
 * joins — it switches on the selection's own top-level `kind` while the
 * owners keep asking for "the provider of this selection".
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/providers/resolver
 */
import type { RootView } from '../../../contract.ts'
import type { RemoteEndpointView } from '../../../remote/panel-contract.ts'
import type { WorkspaceFilesProvider, WorkspaceRootRef } from '../provider.ts'

/**
 * One pane's selected local root: the identity (`ref` + `incarnation`) plus
 * the display metadata the switcher labels and the local provider's geometry
 * need. A re-registered root carries a new `addedAt`, so its incarnation —
 * and with it the provider key — changes, which is exactly how a revoked
 * grant stops serving its old tree.
 */
export interface LocalRootSelection {
  readonly kind: 'additional'
  /** The discriminated root reference. */
  readonly ref: Extract<WorkspaceRootRef, { readonly kind: 'additional' }>
  /** The authorization incarnation — the registration's `addedAt`. */
  readonly incarnation: string
  /** The absolute root path — display text and the local provider's `treeRoot`. */
  readonly path: string
  /** The registry row this selection was minted from (name, state, access). */
  readonly view: RootView
}

/**
 * One pane's selected remote root: the identity is the remote ref plus the
 * `browseAuthorization` token as the incarnation — a re-grant mints a new
 * token, so the old selection's provider can never serve the new grant's
 * tree. `path` and `view` are display metadata, never identity.
 */
export interface RemoteRootSelection {
  readonly kind: 'remote'
  /** The discriminated root reference. */
  readonly ref: Extract<WorkspaceRootRef, { readonly kind: 'remote' }>
  /** The authorization incarnation — the view's `browseAuthorization`. */
  readonly incarnation: string
  /** The remote binding path — display text only. */
  readonly path: string
  /** The endpoint row this selection was minted from. */
  readonly view: RemoteEndpointView
}

/** One pane's selected non-primary root. */
export type FilesRootSelection = LocalRootSelection | RemoteRootSelection

/**
 * The selection of one additional root.
 * @param view - the registry row the reader picked.
 * @returns the selection carrying identity and display metadata.
 */
export function localRootSelection(view: RootView): LocalRootSelection {
  return { kind: 'additional', ref: { kind: 'additional', rootId: view.id }, incarnation: view.addedAt, path: view.path, view }
}

const BROWSE_TOKEN = /^[0-9a-f]{64}$/

/**
 * The selection of one remote root — only while the endpoint is registered,
 * read-capable and carries a well-formed browse token. Every other state
 * yields `undefined`: a root that cannot be authorized cannot be selected.
 * @param view - the endpoint row the reader picked.
 * @returns the selection, or `undefined` when the endpoint is not browsable.
 */
export function remoteRootSelection(view: RemoteEndpointView): RemoteRootSelection | undefined {
  if (view.state !== 'registered' || !view.capabilities.read
    || view.browseAuthorization === undefined || !BROWSE_TOKEN.test(view.browseAuthorization)) return undefined
  return {
    kind: 'remote',
    ref: { kind: 'remote', environmentId: view.environmentId, rootId: view.rootId },
    incarnation: view.browseAuthorization,
    path: view.path,
    view,
  }
}

/**
 * Resolve the provider one selection browses with — the single composition
 * slot. The remote factory is optional: a composition without the
 * `remoteFiles` channel resolves remote selections to `undefined`, which
 * the owners treat as "cannot take over" rather than a phantom provider.
 * @param root - the selected root.
 * @param factories - the per-kind provider factories bound to the session's ports.
 * @returns the provider the tree browses with, or `undefined`.
 */
export function resolveWorkspaceFilesProvider(
  root: FilesRootSelection,
  factories: {
    readonly local: (root: LocalRootSelection) => WorkspaceFilesProvider
    readonly ssh?: ((root: RemoteRootSelection) => WorkspaceFilesProvider) | undefined
  },
): WorkspaceFilesProvider | undefined {
  return root.kind === 'remote' ? factories.ssh?.(root) : factories.local(root)
}
