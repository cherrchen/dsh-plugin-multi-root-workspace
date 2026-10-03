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
 * POSIX widening lives in `./dialects.ts`, Windows capabilities in
 * `./windows-profile.ts` and `./windows-runner.ts`: the upstream profile builders
 * are unreachable in the published package, so the additional roots are grafted
 * onto the profile `super.confine` actually produced (recognize the dialect
 * structurally, clone its grant spelling, fail loudly when the shape is not
 * known). This class owns only the policy that decides WHEN to graft:
 *
 * 1. with no additional roots, or under any mode other than `workspace-write`,
 *    the upstream result is returned ELEMENT FOR ELEMENT — same argv, same
 *    `enforcement`, same `denialSignatures`, same `runnerFailureRules`;
 * 2. `enforcement`, `denialSignatures`, and `runnerFailureRules` are NEVER
 *    recomputed here, even when the argv is widened — the bash executor derives
 *    its denial and enforcement reporting from them;
 * 3. only `argv` may differ, and a dialect whose shape cannot be extended fails
 *    loudly (`SandboxUnavailableError`) instead of silently confining to the
 *    primary root alone.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/sandbox
 */

import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './compat.ts'
import { widenConfined } from './compat/sandbox-confine.ts'
import type { ConfineCall, UpstreamConfined } from './compat/sandbox-confine.ts'
import { DialectUnrecognizedError, splitConfined, widenProfileArgs } from './dialects.ts'
import type {} from './scope.ts'
import { widenWindowsProfile } from './windows-profile.ts'

export type { Config }

/**
 * Local process-sandbox provider over the multi-root scope. Registers as
 * `ctx.sandbox`; the runner chain, probing, denial dialects, and Windows ACL
 * grant mechanics stay the upstream implementation's.
 */
export class MultiRootSandboxProvider extends LocalSandboxProvider {
  // `multiRootCompat` is the compatibility gate, not a collaborator: the dialect
  // widening below recognizes an upstream argv shape, so it must not run on a
  // release the contract has not verified (see src/compat.ts).
  static inject = ['multiRootCompat', 'sandboxPolicy', 'multiRootScope']

  /**
   * Wrap `argv` so it executes confined under `policy` on this host, granting
   * the scope's additional roots inside the SAME dialect profile.
   *
   * Under `read-only` nothing is added (the mode denies every write, additional
   * roots included), and `danger-full-access` never reaches here at all: the
   * bash executor and the PTY backend both hand their argv straight to the local
   * runtime in that mode. Widening therefore only ever ADDS the scope's
   * additional roots to an upstream `workspace-write` profile.
   *
   * The return shape is the INSTALLED upstream provider's: synchronous on a
   * release with a synchronous `confine`, a promise on a release with an
   * asynchronous one. `widenConfined` preserves whichever it is — see
   * `./compat/sandbox-confine.ts`.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation, forwarded to releases that accept it.
   * @returns the argv to spawn instead, plus the selected backend's facts.
   */
  override confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): UpstreamConfined {
    const base = super.confine as unknown as ConfineCall
    return widenConfined(base.bind(this), confined => this.widenForScope(confined, argv, policy), argv, policy, signal)
  }

  /**
   * Graft the scope's additional roots onto one upstream `confine` result.
   *
   * Pure with respect to the upstream call: it only ever reads the scope and
   * rewrites `argv`. `enforcement`, `denialSignatures` and `runnerFailureRules`
   * are passed through untouched, because the bash executor derives its denial
   * and enforcement reporting from them.
   * @param confined - the upstream result for this call.
   * @param argv - the caller's argv, needed to re-split the wrapped form.
   * @param policy - the per-call policy.
   * @returns the upstream result element for element, or one with a widened argv.
   */
  private widenForScope(confined: ConfinedArgv, argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    // The mode check comes BEFORE the scope is resolved: `resolve` re-realpaths
    // the workspace root and every registered root, and no mode other than
    // `workspace-write` can use that answer — the empty-root and read-only
    // passthrough cases must stay free of the extra synchronous IO.
    if (policy.mode !== 'workspace-write') return confined
    const scope = this.ctx.multiRootScope.resolve(policy)
    if (scope.additionalRoots.length === 0) return confined

    try {
      const shape = splitConfined(confined.argv, argv)
      if (shape.dialect === 'windows-acl') {
        return { ...confined, argv: [...widenWindowsProfile(shape.profileArgs, scope.additionalRoots, scope.primaryRoot), '--', ...argv] }
      }
      const profileArgs = widenProfileArgs(shape.dialect, shape.profileArgs, policy, scope.additionalRoots)
      return { ...confined, argv: [...profileArgs, '--', ...argv] }
    } catch (error: unknown) {
      if (!(error instanceof DialectUnrecognizedError)) throw error
      throw new SandboxUnavailableError(
        policy.mode,
        `multi-root workspace: cannot grant the additional workspace roots [${scope.additionalRoots.join(', ')}] `
        + `under the primary root ${scope.primaryRoot} — ${error.message}`,
      )
    }
  }

}

export default MultiRootSandboxProvider
