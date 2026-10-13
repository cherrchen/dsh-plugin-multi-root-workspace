/**
 * `MultiRootFileSystem`: the multi-root filesystem provider mounted as `ctx.fs`.
 *
 * It extends the local backend so every text-storage mechanic — resolve, stat,
 * read/stream, listing, the atomic write and the read-match-write edit critical
 * section — stays the upstream implementation's, verbatim; this class adds only
 * the per-call POLICY fence on the two mutations, exactly as the upstream
 * `SandboxedFileSystem` does, widened from one workspace root to the scope's
 * root set.
 *
 * Why not `extends SandboxedFileSystem`: its `checkedTarget` is TS-private, so a
 * cross-package subclass can neither reuse nor override it in a type-safe way.
 * Why the fence is implemented here rather than delegated: with zero additional
 * roots this class must behave exactly like the upstream provider, and the
 * differential suite in `tests/fs-parity.spec.ts` pins that equality against the
 * real upstream class for every mode and path class.
 *
 * Reads are untouched: no mode confines reading, upstream or here.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/fs
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './compat.ts'
import { isPathUnder } from './containment.ts'
import { brandMultiRootProvider } from './providers.ts'
import type { FilesystemScope } from './scope.ts'

/** Plugin config: the local backend's knobs verbatim (see `dsh-fs-local`). */
export type Config = LocalConfig

/**
 * Sandbox-enforcing filesystem backend over the multi-root scope. Registers as
 * `ctx.fs`; `ctx.sandboxPolicy` still owns the mode and the primary root, and
 * this class only widens the writable root set with the scope's additional
 * roots.
 */
export class MultiRootFileSystem extends LocalFileSystem {
  // `multiRootCompat` is the compatibility gate, not a collaborator: this class
  // widens the upstream write fence, so it must not run on a release the
  // contract has not verified (see src/compat.ts).
  static inject = ['multiRootCompat', 'sandboxPolicy', 'multiRootScope']

  private readonly defaultMode: SandboxMode

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The conflict gate (`multiRootProviders`) verifies this brand rather than
    // `instanceof`, so a duplicated install still identifies the provider.
    brandMultiRootProvider(this, 'fs')
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * The writable roots of one confined call: the upstream derivation (primary
   * root plus the platform temp areas, canonical and deduplicated — empty
   * under `read-only`) widened by the scope's EFFECTIVE writable members.
   * Under `read-only` that is exactly the fixed `read-write` roots (the tool
   * cap may already have emptied the scope's list), so an explicit grant
   * survives a globally read-only session. An unavailable registry authority
   * never contributes members: a process that cannot read the store grants
   * only the upstream derivation.
   * @param policy - the per-call policy.
   * @param scope - the scope resolved once for this call; both the fence and
   *   the denial message below share it instead of re-resolving.
   * @returns the canonical writable roots; possibly empty.
   */
  private rootsFor(policy: SandboxExecutionPolicy, scope: FilesystemScope): string[] {
    const roots = writableRoots(policy)
    if (scope.authority === 'unavailable') return roots
    for (const root of scope.writableRoots) {
      if (!roots.includes(root)) roots.push(root)
    }
    return roots
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target
   * the mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). Deny precedes containment: a root in
   * `scope.deniedRoots` — an explicit `read-only` root, or any member when the
   * call is tool-capped — refuses writes under EVERY mode, including
   * `danger-full-access` and where a broader grant (the platform temp area)
   * would otherwise cover the path. `read-only` then grants only the fixed
   * `read-write` members; `workspace-write` requires containment under the
   * widened writable set.
   *
   * `danger-full-access` is the only mode with a fast path, and only while
   * the deny set is empty: it then returns the caller's target untouched,
   * upstream-exact. Once ANY deny boundary exists the caller's `FsTarget` may
   * be stale — the directory it resolved through can since have been replaced
   * by a symlink into a denied root — so the fence re-resolves
   * `target.displayPath`, checks the FRESH target key, and mutates that fresh
   * target rather than the stale one the caller resolved earlier.
   *
   * One more Full-access rule: while the registry authority is `unavailable`
   * the empty deny set is not trustworthy — the store this process cannot
   * read may hold explicit `read-only` registrations — so the mode degrades
   * to upstream `workspace-write` semantics (primary root plus the platform
   * temp areas, no additional-root widening) until the authority returns.
   * @param target - the resolved target about to be mutated.
   * @param sandboxPolicy - the per-call policy; omit for the deployment fallback.
   * @returns the fresh canonical target the mutation must use.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    // One resolution per call: the deny pass, the containment pass, and (on
    // denial) the message all share this scope rather than re-resolving.
    const scope = this.ctx.multiRootScope.resolve(policy)
    const effectiveMode: SandboxMode = scope.authority === 'unavailable' && policy.mode === 'danger-full-access'
      ? 'workspace-write'
      : policy.mode
    if (effectiveMode === 'danger-full-access' && scope.deniedRoots.length === 0) return target
    const fresh = await this.resolve(target.displayPath)
    // The deny set first: it is what keeps an explicit `read-only` root
    // read-only when the ambient mode — or another writable grant covering the
    // same path — would allow the write.
    if (scope.deniedRoots.length > 0) {
      for (const path of scope.deniedRoots) {
        if (await isPathUnder(fresh.targetKey, path)) {
          const root = scope.roots.find(root => root.path === path)
          const reason = root?.access === 'read-only' || root === undefined
            ? `${path} is a read-only additional root`
            : `${path} is an additional root this call may not write`
          throw new FsError(`cannot write "${target.displayPath}": ${reason}`, 'FS_SANDBOX_DENIED')
        }
      }
    }
    if (effectiveMode === 'danger-full-access') return fresh
    const effectivePolicy: SandboxExecutionPolicy = { ...policy, mode: effectiveMode }
    const roots = this.rootsFor(effectivePolicy, scope)
    let contained = false
    for (const root of roots) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      let denial = `cannot write "${target.displayPath}": file access denied under ${effectiveMode} mode`
      if (scope.additionalRoots.length > 0) denial += `; allowed roots: ${roots.join(', ')}`
      throw new FsError(denial, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }
}

export default MultiRootFileSystem
