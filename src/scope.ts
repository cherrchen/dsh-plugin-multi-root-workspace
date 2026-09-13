/**
 * The multi-root workspace scope: the plugin's single home for the question
 * "which directories belong to this workspace".
 *
 * The primary root is never stored here — it is the session's immutable cwd as
 * resolved by the upstream `ctx.sandboxPolicy` service. This service owns the
 * additional roots, the canonical key that indexes them, and the one model-facing
 * statement of that topology, so every enforcing provider (fs fence,
 * kernel-sandbox dialects) and the prompt snapshot all resolve the same scope.
 *
 * The root table is still filled by the registry's own API (tests and smoke
 * scripts today; plugin storage in M3). Keeping the empty case on the same code
 * path as the populated one is deliberate — the pass-through safety net must
 * exercise the real provider wiring, not a stub that later gets replaced.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/scope
 */

import { statSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootScope: MultiRootScopeService
  }
}

/** One configured additional root, as the registry persists it. */
export interface AdditionalWorkspaceRoot {
  /** Stable registry identity (opaque; M3 brands it). */
  id: string
  /** Canonical absolute directory, as spelled in the registration. */
  path: string
  /**
   * The canonical directory this registration was granted for (the `realpath`
   * captured when the operator registered it). The root is granted only while
   * `canonicalPath(path)` still equals this value: re-resolving a path is NOT
   * re-authorizing it, because whoever can replace the directory (or a symlink
   * in its chain) could otherwise move the grant to a directory no operator
   * ever registered.
   */
  recordedPath: string
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
 * primary itself, duplicates, missing/non-directory paths, and any root whose
 * current resolution no longer matches the directory it was registered for;
 * preserve registry order.
 *
 * The last rule is the security-relevant one. `canonicalPath` is `realpath`, so
 * a registered directory that has since been replaced by a symlink resolves to
 * a different directory — granting that would hand out a directory nobody
 * registered, on nothing more than a local replace. A registration whose
 * resolution moved is therefore withheld here (the registry reports it as
 * `redirected`), and it comes back only when the path resolves to the recorded
 * directory again.
 *
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
    const recorded = root.recordedPath
    if (typeof recorded !== 'string' || recorded === '') continue
    const canonical = canonicalPath(root.path)
    if (canonical !== recorded) continue
    try {
      if (!statSync(canonical).isDirectory()) continue
    } catch {
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return result
}

/**
 * The name of the runtime-context contribution that tells the model which extra
 * roots belong to this session's workspace.
 */
export const MULTI_ROOT_CONTEXT_NAME = 'multi-root:scope'

/**
 * Render the workspace topology the model is told about. Only roots are listed
 * (never files), and the sentence states the two facts a denied write would
 * otherwise have to teach: that the additional roots are part of the SAME
 * workspace, and that the session cwd is unchanged (requirement §5, §8).
 * @param primaryRoot - the canonical session workspace root.
 * @param additionalRoots - canonical additional roots, in scope order.
 * @returns the stable topology sentence.
 */
export function renderWorkspaceRootsContext(primaryRoot: string, additionalRoots: readonly string[]): string {
  return `Current DSH workspace roots: ${JSON.stringify(additionalRoots)} are additional roots of this session's `
    + `workspace. Under workspace-write they may be modified like the session workspace; `
    + `the session cwd remains the primary root (${JSON.stringify(primaryRoot)}).`
}

/**
 * The `ctx.multiRootScope` service. Providers ask it — never the filesystem —
 * what the current scope is, which is what keeps the fs fence and every kernel
 * dialect on one permission world (requirement §13).
 */
export class MultiRootScopeService extends Service {
  /** Additional roots keyed by canonical primary root; empty until roots are registered. */
  private readonly rootsByPrimary = new Map<string, readonly AdditionalWorkspaceRoot[]>()

  constructor(ctx: Context) {
    super(ctx, 'multiRootScope')

    // The prompt contribution is a SOFT dependency: a composition without a
    // system-prompt seam (bare test contexts, headless probes) simply never
    // contributes topology instead of failing to load. The callback's own scoped
    // context is the one that may read the injected services — the service's own
    // ctx has no inject map for them.
    ctx.inject(['systemPrompt', 'sandboxPolicy'], (scope: Context) => {
      scope.systemPrompt.context({
        name: MULTI_ROOT_CONTEXT_NAME,
        // Immediately after the sandbox policy sentence this topology extends.
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (assembly) => {
          const session = assembly.agent?.session
          if (session === undefined) return ''
          const policy = scope.sandboxPolicy.resolve({ session })
          // `read-only` mentions no writable root at all (upstream's policy
          // sentence stays silent about the workspace root too), and with no
          // additional root there is nothing to add.
          if (policy.mode !== 'workspace-write') return ''
          const resolved = this.resolve(policy)
          if (resolved.additionalRoots.length === 0) return ''
          return renderWorkspaceRootsContext(resolved.primaryRoot, resolved.additionalRoots)
        },
      })
    })
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
