/**
 * Shared vocabulary of the worktree feature: filesystem identity, the metadata
 * snapshot of one checkout, and the inactive reasons an activation can end in.
 *
 * Everything here is plain data. The snapshot is produced by
 * `src/worktrees/repository.ts` from metadata the plugin opened and parsed
 * itself — no Git subprocess is ever started (ADR-0039 §2.4).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/types
 */

/** Stable identity of one directory, as observed through a trusted descriptor. */
export interface FileIdentity {
  /** Device id, decimal bigint spelling so it survives JSON. */
  readonly dev: string
  /** Inode / native file id, decimal bigint spelling so it survives JSON. */
  readonly ino: string
  /** Birth time in milliseconds when the platform reports one. */
  readonly birthtimeMs?: number
}

/** Which checkout shape the activation found. */
export type CheckoutShape = 'main' | 'linked'

/** The reason a workspace or candidate is NOT a supported checkout. */
export type ActivationFailure =
  | 'not-a-checkout'
  | 'missing'
  | 'inaccessible'
  | 'unsafe-metadata'
  | 'unsupported-layout'
  | 'unsupported-config'
  | 'invalid-head'
  | 'submodule'
  | 'unprovable-ancestor'
  | 'unstable-identity'

/** The relevant subset of the repository configuration snapshot. */
export interface ConfigSnapshot {
  /** Always 0: version 1 / relative worktrees are refused outright. */
  readonly repositoryFormatVersion: number
  /** Always 'sha1'. */
  readonly objectFormat: 'sha1'
  /** `core.bare`; true makes the layout inactive. */
  readonly bare: boolean
  /** `core.ignorecase`; widens index path equivalence. */
  readonly ignoreCase: boolean
  /** `core.precomposeUnicode`; macOS defaults to true. */
  readonly precomposeUnicode: boolean
  /** Whether `extensions.worktreeConfig` was enabled (never accepted). */
  readonly worktreeConfig: boolean
  /** Whether `extensions.relativeWorktrees` was enabled (never accepted). */
  readonly relativeWorktrees: boolean
  /** Whether `core.splitIndex` was enabled (never accepted). */
  readonly splitIndex: boolean
  /** Whether `core.sparseCheckout` was enabled (never accepted). */
  readonly sparseCheckout: boolean
  /** Whether `index.sparse` was enabled (never accepted). */
  readonly indexSparse: boolean
}

/** One resolved, supported checkout. */
export interface RepoSnapshot {
  readonly shape: CheckoutShape
  /** Canonical checkout root (the directory the metadata describes). */
  readonly canonical: string
  /** Canonical common git dir — the directory linked worktrees share. */
  readonly common: string
  /** The primary git dir: the main `.git` directory, or the admin directory. */
  readonly gitDir: string
  /** The `worktrees/<id>` name, linked checkouts only. */
  readonly adminId?: string
  /** Canonical admin directory, linked checkouts only. */
  readonly adminGitdir?: string
  /** The admin `HEAD` content without its trailing newline, linked only. */
  readonly adminHead?: string
  /** The primary `HEAD` content without its trailing newline. */
  readonly head: string
  /** The parsed common configuration. */
  readonly config: ConfigSnapshot
  /** Identity of the checkout root directory. */
  readonly rootIdentity: FileIdentity
  /** Identity of the admin directory, linked checkouts only. */
  readonly adminIdentity?: FileIdentity
}

/** One activation verdict. */
export type ActivationResult =
  | { readonly ok: true; readonly repo: RepoSnapshot }
  | { readonly ok: false; readonly reason: ActivationFailure; readonly detail: string }

/** One index entry as parsed from the checkout's own index snapshot. */
export interface IndexEntry {
  readonly path: string
  readonly pathBytes: Buffer
  readonly mode: number
}
