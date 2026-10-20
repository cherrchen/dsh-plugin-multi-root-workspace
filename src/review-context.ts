/** Read-only, current host context for the optional Auto Review companion. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './registry.ts'
import type {} from './scope.ts'
import type { CurrentRootInstruction } from './instructions.ts'
import { nativeInstructionFingerprint } from './compat/review-session.ts'
import { assertAutoReviewRelease } from './compat/auto-review-contract.ts'
import { effectiveDirectory } from './compat/session-directory.ts'
import { DEFAULT_MAX_BYTES, touchedPathOfToolCall } from './instructions.ts'
import { isCanonicallyUnder } from './roots.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { multiRootReviewContext: MultiRootReviewContext }
}

export interface ReviewExecution {
  readonly agent?: Agent
  readonly name: string
  readonly arguments: unknown
}
export interface ReviewContext {
  readonly schemaVersion: 1
  readonly environment: {
    readonly sessionOrigin: string
    readonly effectiveCwd: string
    readonly sandboxMode: string
    readonly registryAuthority: 'available' | 'unavailable'
    readonly roots: readonly { readonly path: string; readonly access: string; readonly effectiveWritable: boolean }[]
    readonly writableRoots: readonly string[]
    readonly deniedRoots: readonly string[]
    readonly protectedHome?: string
    /** Full access permits unregistered paths subject to the existing deny fence. */
    readonly ambientWrites: boolean
    readonly readConfinement: false
    readonly primaryRootWritable: boolean
    readonly writeBoundary: string
  }
  /** Provenance from current scope and the existing delivery index; never a grant. */
  readonly instructionProvenanceRoots: readonly string[]
  readonly constraints: readonly CurrentRootInstruction[]
  readonly completeness: 'complete'
  readonly fingerprint: string
}

/** All authority remains in the existing Registry/scope and instruction index. */
export class MultiRootReviewContext extends Service {
  static inject = ['multiRootCompat', 'multiRootProviders', 'multiRootScope', 'multiRootRegistry', 'multiRootInstructions', 'sandboxPolicy', 'workingDirectory', 'fs']
  constructor(ctx: Context) { super(ctx, 'multiRootReviewContext') }

  assertCompatible(): void { assertAutoReviewRelease(this.ctx.multiRootCompat.release) }

  async build(exec: ReviewExecution, signal: AbortSignal): Promise<ReviewContext> {
    signal.throwIfAborted()
    const agent = exec.agent
    if (agent === undefined) throw new Error('review-context: missing session')
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const primary = canonicalPath(policy.workspaceRoot)
    if (agent.session.header.cwd !== undefined && canonicalPath(agent.session.header.cwd) !== primary) throw new Error('review-context: inconsistent session origin')
    await this.ctx.multiRootRegistry.refresh(primary)
    signal.throwIfAborted()
    const cwd = effectiveDirectory(this.ctx, agent.session)
    if (cwd === undefined) throw new Error('review-context: missing effective cwd')
    const scope = this.ctx.multiRootScope.previewForTool(policy, exec.name)
    const environment: ReviewContext['environment'] = {
      sessionOrigin: scope.primaryRoot, effectiveCwd: cwd, sandboxMode: policy.mode,
      registryAuthority: scope.authority,
      roots: scope.roots.map(root => ({ path: root.path, access: root.access,
        effectiveWritable: scope.writableRoots.includes(root.path) && !scope.deniedRoots.some(deny => isCanonicallyUnder(root.path, deny)) })),
      writableRoots: scope.writableRoots, deniedRoots: scope.deniedRoots,
      ...(scope.protectedHome === undefined ? {} : { protectedHome: scope.protectedHome }),
      ambientWrites: policy.mode === 'danger-full-access' && scope.authority === 'available',
      readConfinement: false,
      primaryRootWritable: policy.mode !== 'read-only' && !scope.deniedRoots.some(deny => isCanonicallyUnder(scope.primaryRoot, deny)),
      // The Auto preset pins danger-full-access, so the narrower modes are
      // unreachable through the companion today; they keep the contract honest
      // for a direct caller that builds a context under a different policy.
      writeBoundary: scope.authority === 'unavailable' && policy.mode !== 'read-only'
        ? 'primary-root-only; no shared temp grants; explicit denies take precedence'
        : policy.mode === 'danger-full-access'
          ? 'ambient host writes minus explicit deny boundaries; membership is not an access allowlist'
          : policy.mode === 'workspace-write'
            ? 'primary root, effective writable additional roots and upstream host temp grants; explicit denies take precedence'
            : 'only effective writable additional roots; explicit denies take precedence',
    }
    const path = touchedPathOfToolCall(exec.name, JSON.stringify(exec.arguments))
    const target = path === undefined ? undefined : this.ctx.fs.processPath(await this.ctx.fs.resolve(resolve(cwd, path), {signal}))
    const constraints = await this.ctx.multiRootInstructions.snapshot(agent, scope.authority === 'available' ? scope.additionalRoots : [], target, signal)
    signal.throwIfAborted()
    const instructionProvenanceRoots = [...new Set([...scope.additionalRoots, ...this.ctx.multiRootInstructions.knownRoots(agent.session)])]
    const payload = { schemaVersion: 1 as const, environment, instructionProvenanceRoots, constraints, completeness: 'complete' as const }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > DEFAULT_MAX_BYTES) throw new Error('review-context: context budget exceeded')
    return { ...payload, fingerprint: createHash('sha256').update(JSON.stringify([payload,nativeInstructionFingerprint(agent.session)])).digest('hex') }
  }

  async assertCurrent(exec: ReviewExecution, snapshot: ReviewContext, signal: AbortSignal): Promise<void> {
    if ((await this.build(exec, signal)).fingerprint !== snapshot.fingerprint) {
      throw new Error('review-context: snapshot changed; retry the tool call')
    }
  }
}
export default MultiRootReviewContext
