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
/**
 * The two things a worktree prompt can offer (ADR-0039 §1): another linked
 * checkout's source root, or the main checkout's source root (which contains
 * the shared `.git`).
 */
export type WorktreePromptKind = 'worktree' | 'main-checkout'

/** The effective authority the panel shows for a prompt. */
export type WorktreeEffectiveAccess = 'read-only' | 'read-write' | 'full-access' | 'unavailable'

/** One prompt as the panel renders it (wire shape lives in the contract module). */
export interface WorktreePrompt {
  readonly id: string
  /** Discovery key: `CandidateKey` for B, `main-checkout\0<common>` for A. */
  readonly key: string
  readonly kind: WorktreePromptKind
  /** The candidate checkout root (B) or the main checkout root (A). */
  readonly path: string
  readonly primaryRoot: string
  /** The persistence policy the registration would carry. */
  readonly access: 'inherit'
  /** `effectiveRootAccess('inherit', session mode)`. */
  readonly effectiveAccess: WorktreeEffectiveAccess
  /** How many candidates this session can still see, including this one. */
  readonly remaining: number
  /** Digest of this session's visible view. */
  readonly viewRevision: string
}

/**
 * The discriminated long-poll answer (ADR-0039 §7).
 *
 * The wire keeps two visible shapes: `prompt` when the session can see exactly
 * one candidate, and `prompts` when it can see several. The client renders the
 * single confirmation for the first and the checkbox list for the second.
 */
export type WorktreePromptWaitResult =
  | { readonly status: 'prompt'; readonly prompt: WorktreePrompt; readonly viewRevision: string }
  | { readonly status: 'prompts'; readonly prompts: readonly WorktreePrompt[]; readonly viewRevision: string }
  | { readonly status: 'timeout'; readonly viewRevision: string }
  | { readonly status: 'unactivated'; readonly viewRevision: string }
  | { readonly status: 'lost'; readonly viewRevision: string }
  | { readonly status: 'stale'; readonly viewRevision: string; readonly reason: string }

/** The primary half of an `addNew` expectation. */
export interface PromptPrimarySnapshot {
  readonly shape: CheckoutShape
  readonly canonical: string
  readonly common: string
  readonly adminId?: string
  readonly adminGitdir?: string
  readonly adminHead?: string
  readonly rootIdentity: FileIdentity
  readonly adminIdentity?: FileIdentity
}

/** The candidate half of an `addNew` expectation. */
export interface PromptCandidateSnapshot {
  readonly kind: WorktreePromptKind
  readonly canonical: string
  readonly common: string
  readonly adminId?: string
  readonly adminGitdir?: string
  readonly adminHead?: string
  readonly rootIdentity: FileIdentity
  readonly adminIdentity?: FileIdentity
}

/** The exact snapshot an owner re-verifies before writing a prompted root. */
export interface PromptExpected {
  readonly primaryKey: string
  readonly primaryRoot: string
  readonly primary: PromptPrimarySnapshot
  readonly candidate: PromptCandidateSnapshot
  readonly promptKey: string
}
