/**
 * `MultiRootSandboxProvider`: the kernel-sandbox dialect provider mounted as
 * `ctx.sandbox`.
 *
 * Every confined execution in this composition funnels through `confine()` —
 * the bash executor wraps `['bash','-c',command]`, and the terminal backend
 * wraps its PTY spawn argv — so widening the grant here is what gives bash, PTY,
 * and the fs fence one and the same root set (requirement §13). The bash
 * executor itself is therefore left upstream: it never computes roots.
 *
 * M1 (this milestone) ships the empty-root path only: with no additional roots
 * registered, `confine` returns the upstream provider's result untouched, which
 * is what "installed plugin behaves exactly like no plugin" means for this
 * service. Widening the grants for non-empty scopes lands in M2 and must keep
 * the three invariants documented on {@link MultiRootSandboxProvider.confine}.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/sandbox
 */

import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './scope.ts'

export type { Config }

/**
 * Local process-sandbox provider over the multi-root scope. Registers as
 * `ctx.sandbox`; the runner chain, probing, denial dialects, and Windows ACL
 * grant mechanics stay the upstream implementation's.
 */
export class MultiRootSandboxProvider extends LocalSandboxProvider {
  static inject = ['sandboxPolicy', 'multiRootScope']

  /**
   * Wrap `argv` so it executes confined under `policy` on this host.
   *
   * Three invariants M1 fixes for every later milestone:
   * 1. with an empty additional-root set the upstream result is returned
   *    ELEMENT FOR ELEMENT — same argv, same `enforcement`, same
   *    `denialSignatures`, same `runnerFailureRules`;
   * 2. `enforcement`, `denialSignatures`, and `runnerFailureRules` are NEVER
   *    recomputed here, even once additional roots widen the argv — the bash
   *    executor derives its denial and enforcement reporting from them;
   * 3. only `argv` may differ, and a dialect whose shape cannot be extended
   *    fails loudly instead of silently confining to the primary root alone.
   *
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the argv to spawn instead, plus the selected backend's facts.
   */
  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const scope = this.ctx.multiRootScope.resolve(policy)
    if (scope.additionalRoots.length === 0) return super.confine(argv, policy)
    throw new SandboxUnavailableError(
      policy.mode,
      `multi-root additional grants are not implemented yet (M1): ${scope.additionalRoots.join(', ')} `
      + `under primary root ${scope.primaryRoot} cannot be granted (see the M1 plan, docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md)`,
    )
  }
}

export default MultiRootSandboxProvider
