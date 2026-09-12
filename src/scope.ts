/**
 * The multi-root workspace scope: the plugin's single home for the question
 * "which directories belong to this workspace".
 *
 * The primary root is never stored here — it is the session's immutable cwd as
 * resolved by the upstream `ctx.sandboxPolicy` service. This service owns only
 * the additional roots and the canonical key that indexes them, so every
 * enforcing provider (fs fence, kernel-sandbox dialects) resolves the same
 * scope exactly once per confined call.
 *
 * M1 ships the resolution path with an empty root table: additional roots
 * arrive in M2 (static injection) and M3 (plugin storage). Keeping the empty
 * case on the same code path is deliberate — the pass-through safety net must
 * exercise the real provider wiring, not a stub that later gets replaced.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/scope
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootScope: MultiRootScopeService
  }
}

/** One configured additional root, as the registry will persist it in M3. */
export interface AdditionalWorkspaceRoot {
  /** Stable registry identity (opaque; M3 brands it). */
  id: string
  /** Canonical absolute directory. */
  path: string
  /** Optional display alias. */
  alias?: string
}

/**
 * The resolved scope of one confined call. `primaryRoot` equals the policy's
 * workspace root; `additionalRoots` are canonical, deduplicated, never equal to
 * the primary root, and empty in M1.
 */
export interface FilesystemScope {
  /** The session's workspace root (`session.header.cwd`, canonical). */
  primaryRoot: string
  /** Extra writable roots granted inside the same sandbox mechanism. */
  additionalRoots: readonly string[]
}

/**
 * Canonicalize and sanitize one root list against a primary root: drop the
 * primary itself, drop duplicates, and preserve registry order.
 * @param primaryRoot - the canonical primary root to exclude.
 * @param roots - candidate roots, in registry order.
 * @returns the sanitized additional roots.
 */
export function sanitizeAdditionalRoots(
  primaryRoot: string,
  roots: readonly AdditionalWorkspaceRoot[],
): string[] {
  const seen = new Set<string>([primaryRoot])
  const result: string[] = []
  for (const root of roots) {
    const canonical = canonicalPath(root.path)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return result
}

/**
 * The `ctx.multiRootScope` service. Providers ask it — never the filesystem —
 * what the current scope is, which is what keeps the fs fence and every kernel
 * dialect on one permission world (requirement §13).
 */
export class MultiRootScopeService extends Service {
  /** Additional roots keyed by canonical primary root; empty in M1. */
  private readonly rootsByPrimary = new Map<string, readonly AdditionalWorkspaceRoot[]>()

  constructor(ctx: Context) {
    super(ctx, 'multiRootScope')
  }

  /**
   * Resolve the scope of one confined call.
   * @param policy - the upstream policy whose workspace root is the primary root.
   * @returns the canonical scope; `additionalRoots` is empty when none are registered.
   */
  resolve(policy: SandboxExecutionPolicy): FilesystemScope {
    const primaryRoot = canonicalPath(policy.workspaceRoot)
    return { primaryRoot, additionalRoots: this.scopeOf(primaryRoot) }
  }

  /**
   * The additional roots registered for one canonical primary root.
   * @param primaryRoot - canonical primary root (or any spelling thereof).
   * @returns the canonical additional roots; empty when none are registered.
   */
  scopeOf(primaryRoot: string): readonly string[] {
    const registered = this.rootsByPrimary.get(canonicalPath(primaryRoot))
    if (registered === undefined) return []
    return sanitizeAdditionalRoots(canonicalPath(primaryRoot), registered)
  }

  /**
   * Replace the roots registered for one primary root.
   *
   * M1 uses this from tests and smoke scripts only; M3 feeds it from plugin
   * storage. It is a plain setter so the transition swaps the data source
   * without touching any provider.
   * @param primaryRoot - canonical primary root to register roots under.
   * @param roots - the additional roots, in display order.
   */
  setAdditionalRoots(primaryRoot: string, roots: readonly AdditionalWorkspaceRoot[]): void {
    const key = canonicalPath(primaryRoot)
    if (roots.length === 0) {
      this.rootsByPrimary.delete(key)
      return
    }
    this.rootsByPrimary.set(key, [...roots])
  }
}

export default MultiRootScopeService
