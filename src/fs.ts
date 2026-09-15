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
   * The writable roots of one workspace-write call: the upstream derivation
   * (primary root plus the platform temp areas, canonical and deduplicated)
   * widened by the scope's additional roots, in scope order.
   * @param policy - the per-call policy.
   * @param scope - the scope resolved once for this call; both the fence and
   *   the denial message below share it instead of re-resolving.
   * @returns the canonical writable roots; empty under `read-only`.
   */
  private rootsFor(policy: SandboxExecutionPolicy, scope: FilesystemScope): string[] {
    const roots = writableRoots(policy)
    if (roots.length === 0) return roots
    for (const root of scope.additionalRoots) {
      if (!roots.includes(root)) roots.push(root)
    }
    return roots
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (reflecting a concurrently swapped symlink ancestor),
   * requires containment under one of the scope's writable roots, and returns
   * THAT fresh target; `danger-full-access` returns the caller's target unfenced.
   * @param target - the resolved target about to be mutated.
   * @param sandboxPolicy - the per-call policy; omit for the deployment fallback.
   * @returns the fresh canonical target the mutation must use.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const fresh = await this.resolve(target.displayPath)
    // One resolution per call: the fence and (on denial) the message below
    // share this scope rather than each paying for its own re-realpath pass.
    const scope = this.ctx.multiRootScope.resolve(policy)
    const roots = this.rootsFor(policy, scope)
    let contained = false
    for (const root of roots) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      const denial = `cannot write "${target.displayPath}": file access denied under workspace-write mode`
      throw new FsError(
        scope.additionalRoots.length === 0 ? denial : `${denial}; allowed roots: ${roots.join(', ')}`,
        'FS_SANDBOX_DENIED',
      )
    }
    return fresh
  }
}

export default MultiRootFileSystem
