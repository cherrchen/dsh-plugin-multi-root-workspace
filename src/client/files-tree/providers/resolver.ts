/**
 * The provider composition slot: which provider a selected root resolves to.
 *
 * A selection carries the discriminated ref, the authorization incarnation,
 * and the display metadata (`path`, the live `RootView`) separately: the
 * first two are identity, the rest is presentation. `resolveWorkspaceFilesProvider`
 * is the single point a later remote branch joins — P4 switches on
 * `root.ref.kind` here while the owners keep asking for "the provider of
 * this selection".
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/providers/resolver
 */
import type { RootView } from '../../../contract.ts'
import type { WorkspaceFilesProvider, WorkspaceRootRef } from '../provider.ts'

/**
 * One pane's selected root: the identity (`ref` + `incarnation`) plus the
 * display metadata the switcher labels and the local provider's geometry
 * need. A re-registered root carries a new `addedAt`, so its incarnation —
 * and with it the provider key — changes, which is exactly how a revoked
 * grant stops serving its old tree.
 */
export interface FilesRootSelection {
  /** The discriminated root reference; only `'additional'` resolves today. */
  readonly ref: Extract<WorkspaceRootRef, { readonly kind: 'additional' }>
  /** The authorization incarnation — the registration's `addedAt`. */
  readonly incarnation: string
  /** The absolute root path — display text and the local provider's `treeRoot`. */
  readonly path: string
  /** The registry row this selection was minted from (name, state, access). */
  readonly view: RootView
}

/**
 * The selection of one additional root.
 * @param view - the registry row the reader picked.
 * @returns the selection carrying identity and display metadata.
 */
export function localRootSelection(view: RootView): FilesRootSelection {
  return { ref: { kind: 'additional', rootId: view.id }, incarnation: view.addedAt, path: view.path, view }
}

/**
 * Resolve the provider one selection browses with — the composition slot a
 * remote branch plugs into later. Today every selection is a local
 * additional root, so it delegates straight to the local factory.
 * @param root - the selected root.
 * @param createLocal - the local provider factory bound to the session's ports.
 * @returns the provider the tree browses with.
 */
export function resolveWorkspaceFilesProvider(
  root: FilesRootSelection,
  createLocal: (root: FilesRootSelection) => WorkspaceFilesProvider,
): WorkspaceFilesProvider {
  return createLocal(root)
}
