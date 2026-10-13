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

import type { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './compat.ts'
import { mapConfined, widenConfined } from './compat/sandbox-confine.ts'
import type { ConfineCall, UpstreamConfined } from './compat/sandbox-confine.ts'
import { denyProfileArgs, DialectUnrecognizedError, graftProfileArgs, splitConfined, widenProfileArgs } from './dialects.ts'
import { restrictProfileArgs } from './dialects.ts'
import { brandMultiRootProvider } from './providers.ts'
import type {} from './scope.ts'
import { restrictWindowsProfile, widenWindowsProfile } from './windows-profile.ts'

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

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The conflict gate (`multiRootProviders`) verifies this brand rather than
    // `instanceof`, so a duplicated install still identifies the provider.
    brandMultiRootProvider(this, 'sandbox')
  }

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
   * Graft the scope's effective grants and denies onto one upstream `confine`
   * result.
   *
   * Pure with respect to the upstream call: it only ever reads the scope and
   * rewrites `argv`. `enforcement`, `denialSignatures` and `runnerFailureRules`
   * are passed through untouched, because the bash executor derives its denial
   * and enforcement reporting from them.
   *
   * Mode behavior (B9): `workspace-write` widens the grant with the effective
   * writable roots AND denies any restricted root the upstream grants could
   * reach (a `read-only` root registered under the platform temp). `read-only`
   * grafts the fixed `read-write` roots back onto the deny-all baseline — the
   * three-state matrix's standout cell. `danger-full-access` never reaches
   * here (consumers bypass `confine`); its deny semantics live in
   * {@link restrictedArgvPrefix}.
   * @param confined - the upstream result for this call.
   * @param argv - the caller's argv, needed to re-split the wrapped form.
   * @param policy - the per-call policy.
   * @returns the upstream result element for element, or one with a rewritten argv.
   */
  private widenForScope(confined: ConfinedArgv, argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    // `danger-full-access` never confines; if a caller still hands it here the
    // upstream result passes untouched — its deny semantics live in
    // `restrictedArgvPrefix`, never on a confined profile.
    if (policy.mode !== 'workspace-write' && policy.mode !== 'read-only') return confined
    const scope = this.ctx.multiRootScope.resolve(policy)
    const writable = scope.writableRoots
    const denied = scope.deniedRoots
    if (writable.length === 0 && (denied.length === 0 || policy.mode === 'read-only')) return confined

    try {
      const shape = splitConfined(confined.argv, argv)
      if (shape.dialect === 'windows-acl') {
        return { ...confined, argv: [...widenWindowsProfile(shape.profileArgs, writable, denied, scope.primaryRoot), '--', ...argv] }
      }
      const profileArgs = policy.mode === 'workspace-write'
        ? denyProfileArgs(shape.dialect, widenProfileArgs(shape.dialect, shape.profileArgs, policy, writable), denied)
        : graftProfileArgs(shape.dialect, shape.profileArgs, writable)
      return { ...confined, argv: [...profileArgs, '--', ...argv] }
    } catch (error: unknown) {
      if (!(error instanceof DialectUnrecognizedError)) throw error
      throw new SandboxUnavailableError(
        policy.mode,
        `multi-root workspace: cannot apply the additional workspace roots (writable: [${writable.join(', ')}], `
        + `denied: [${denied.join(', ')}]) under the primary root ${scope.primaryRoot} — ${error.message}`,
      )
    }
  }

  /**
   * Build the runner-prefix that confines an ambient-writable execution to
   * everything EXCEPT `deniedRoots` — the `danger-full-access` + explicit
   * `read-only` cell, which the shell, PTY and PTC consumers never route
   * through `confine()` at all.
   *
   * The restricted profile does not depend on the callee's argv, so the prefix
   * is computed once per call here and the synchronous `ctx.subprocess.spawn`
   * seam only has to prepend it. The upstream profile builders stay private:
   * this probes `confine` under `read-only` for the runner's argument skeleton
   * and rewrites the file-effect part per dialect. Windows selects the
   * standalone ambient deny-token runner. Landlock cannot express
   * "everything except", so this combination selects bubblewrap; unusable
   * runners fail without spawning an unconfined command.
   *
   * The return preserves the installed `confine` shape: a synchronous result
   * on a synchronous release, a promise on an asynchronous one.
   * @param policy - the caller's policy (mode must be `danger-full-access`).
   * @param deniedRoots - canonical roots this execution must not write.
   * @param signal - cancellation, forwarded to releases that accept it.
   * @returns the argv prefix, ending at the `--` separator.
   */
  restrictedArgvPrefix(
    policy: SandboxExecutionPolicy,
    deniedRoots: readonly string[],
    signal?: AbortSignal,
  ): readonly string[] | Promise<readonly string[]> {
    const result = this.restrictedExecution(policy, deniedRoots, signal)
    return mapConfined(result, confined => confined.argv)
  }

  /** Full-access restriction and the actual selected backend's diagnostics. */
  restrictedExecution(
    policy: SandboxExecutionPolicy,
    deniedRoots: readonly string[],
    signal?: AbortSignal,
  ): UpstreamConfined {
    // `danger-full-access` is deliberately not a ConfinedSandboxMode: the probe
    // runs under `read-only` purely to harvest the runner skeleton.
    const probePolicy: SandboxPolicy = {
      mode: 'read-only',
      workspaceRoot: policy.workspaceRoot,
      ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
    }
    const base = super.confine as unknown as ConfineCall
    const probe = base.call(this, ['true'], probePolicy, signal)
    const restrict = (confined: ConfinedArgv): ConfinedArgv => {
      try {
        const shape = splitConfined(confined.argv, ['true'])
        const argv = [...(shape.dialect === 'windows-acl'
          ? restrictWindowsProfile(shape.profileArgs, deniedRoots)
          : restrictProfileArgs(shape.dialect, shape.profileArgs, deniedRoots)), '--']
        // Landlock cannot subtract a subtree. This combination selects the
        // bubblewrap backend instead; its diagnostics must follow that choice.
        return shape.dialect === 'landlock'
          ? { argv, enforcement: 'full', denialSignatures: ['read-only file system'], runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }] }
          : { ...confined, argv }
      } catch (error: unknown) {
        if (!(error instanceof DialectUnrecognizedError)) throw error
        throw new SandboxUnavailableError(
          policy.mode as ConfinedSandboxMode,
          `multi-root workspace: cannot confine an ambient execution away from the denied roots `
          + `[${deniedRoots.join(', ')}] — ${error.message}`,
        )
      }
    }
    return widenConfined(() => probe, restrict, ['true'], probePolicy, signal)
  }

}

export default MultiRootSandboxProvider
