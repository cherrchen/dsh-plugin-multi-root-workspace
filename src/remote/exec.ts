/**
 * The G3 `remote_bash` contract: an explicit remote command is admitted TWICE
 * by the registry's ordered control plane — once to verify and prepare, once
 * for the final launch — and the spawn happens inside the second admission's
 * body so a revocation between them can never reach a spawned process. No
 * retry, no reconnect: uncertainty is reported, not replayed.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { posix } from 'node:path'
import type { MultiRootRegistry } from '../registry.ts'
import { RemoteAdmissionError } from './contract.ts'
import type { AdmittedRemoteEndpoint, RemoteEndpointRef, RemoteOperationSession } from './contract.ts'
import { currentEndpointCandidates } from './endpoint-candidates.ts'
import { effectivePreviewLimit } from './output-budget.ts'
import { execFailureGuidance, execScopeUnconfirmedGuidance, execTerminationGuidance, execUncertainGuidance, type ExecGuidanceContext, type Guidance } from './result-guidance.ts'

/** The deployment-side execution contract a backend advertises. */
export interface RemoteExecDeployment {
  readonly shell: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly maxTimeoutMs: number
  readonly stdoutLimit: number
  readonly stderrLimit: number
  readonly terminateGraceMs: number
}

/**
 * Whole-stream coordinates one collected output chunk arrives with. A backend
 * that cannot prove them omits the meta; the tool then reports the stream's
 * totals as explicitly unknown instead of guessing.
 */
export interface OutputChunkMeta {
  /** Whole-stream byte offset of this chunk's first byte when the window is byte-faithful. */
  readonly offset?: number
  /** Total raw bytes observed on this stream; exact even when the window start is approximate. */
  readonly totalBytes?: number
  /** The chunk is a retained tail: bytes before it were already dropped upstream. */
  readonly lossy: boolean
  /**
   * The decoded text is not a byte-faithful image of the upstream window (a
   * boundary cut or invalid bytes produced U+FFFD). The total stays provable;
   * the number of raw bytes inside the preview window is not.
   */
  readonly approximate?: boolean
}

/** One command's output sink; `meta` is optional on purpose (test doubles and older adapters omit it). */
export interface RemoteProcessOutputSink {
  stdout(chunk: Uint8Array, meta?: OutputChunkMeta): void
  stderr(chunk: Uint8Array, meta?: OutputChunkMeta): void
}

export interface RemoteExecutionBackend {
  readonly deployment: RemoteExecDeployment
  confine(
    argv: readonly string[],
    policy: { mode: 'workspace-write'; workspaceRoot: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<{ argv: readonly string[]; enforcement: 'full' | 'partial'; generation: string }>
  currentGeneration(): string
  verifyCwd?(cwd: string, root: string, signal: AbortSignal, expected: { readonly kind: 'object' | 'path'; readonly value: string } | null): Promise<void>
  spawn(
    argv: readonly string[],
    options: { cwd: string; env: Readonly<Record<string, string>>; generation: string },
    sink: RemoteProcessOutputSink,
  ): RemoteProcessHandle
}

export interface RemoteProcessHandle {
  readonly started: Promise<void>
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>
  terminate(): void
  waitForExit(timeoutMs: number): Promise<boolean>
}

/** The remote side declared the outcome unknowable — never retried. */
export class RemoteConnectionLost extends Error {}

export interface RemoteCommandRequest {
  readonly session: RemoteOperationSession | undefined
  readonly environmentId: string
  readonly rootId: string
  readonly cwdRelative?: string | undefined
  readonly command: string
  readonly timeoutMs: number
  /** Per-stream preview cap; the tool layer clamps it to the deployment limit. */
  readonly maxOutputBytes?: number | undefined
}

interface Base {
  /**
   * Absent before an operation id exists. Deliberately optional: a tool's
   * canonical result must be lossless JSON, and an explicit `undefined` key is
   * not.
   */
  readonly operationId?: string
  readonly environmentId: string
  readonly rootId: string
  /** Bounded diagnostic copy generated from a stable code. */
  readonly message?: string
  /** Bounded, actionable next step when the code is diagnosable. */
  readonly hint?: string
}

export type RemoteCommandResult =
  | (Base & { status: 'not-started'; code: string })
  | (Base & { status: 'admitted-may-start'; reason: string })
  | (Base & {
      status: 'exited' | 'scope-exited'
      scope: 'unconfirmed' | 'confirmed'
      exitCode: number | null
      signal: string | null
      stdout: string
      stderr: string
      truncated: { stdout: boolean; stderr: boolean }
      /** Raw bytes observed per stream; null when the backend cannot prove the total. */
      totalBytes: { stdout: number | null; stderr: number | null }
      /** Raw bytes absent from the preview; null when the byte mapping or total is unproven. */
      droppedBytes: { stdout: number | null; stderr: number | null }
      termination?: 'timeout' | 'cancelled' | 'revoked'
    })
  | (Base & { status: 'unknown'; reconcileId: string; reason: string; termination?: 'timeout' | 'cancelled' | 'revoked' })

const TRANSIENT_ADMISSION_ERRORS = new Set([
  'remote-unavailable', 'config-digest-mismatch', 'owner-without-remote-protocol',
  'authority-unavailable', 'authority-disconnected', 'authority-busy', 'authority-timeout',
])

const STABLE_CODE = /^[a-z][a-z0-9-]{1,63}$/

/** Only stable lowercase codes may reach a result; anything else is generic. */
const stableCode = (code: string | undefined): string =>
  code !== undefined && STABLE_CODE.test(code) ? code : 'remote-failed'

/** Refusal codes whose hint may name registered endpoints usable for execution. */
const ENDPOINT_FAILURE_CODES = new Set([
  'endpoint-not-registered',
  'endpoint-withheld',
  'endpoint-revoked',
  'action-not-allowed',
  'binding-not-authorized',
])

const notStarted = (base: Base, code: string, text: Guidance): RemoteCommandResult => {
  const copy = { message: text.message, hint: text.hint }
  return base.operationId === undefined
    ? { environmentId: base.environmentId, rootId: base.rootId, status: 'not-started', code, ...copy }
    : { ...base, status: 'not-started', code, ...copy }
}

/** Read execution candidates from the Registry snapshot; this never opens a connection. */
async function enrichExecCandidates(
  registry: MultiRootRegistry,
  session: RemoteOperationSession | undefined,
  guidance: ExecGuidanceContext,
  code: string,
): Promise<void> {
  if (!ENDPOINT_FAILURE_CODES.has(code) || session === undefined) return
  const lists = await currentEndpointCandidates(registry, session.header.cwd, [{ direction: 'exec' }])
  const [candidates] = lists ?? []
  if (candidates !== undefined) guidance.candidates = candidates
}

function checkCwdRelative(cwdRelative: string): boolean {
  return cwdRelative === '' || (!cwdRelative.startsWith('/') && !cwdRelative.includes('\0') && !cwdRelative.includes('\\')
    && !cwdRelative.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
}

interface Prep {
  readonly operationId: string
  readonly epoch: string | undefined
  readonly authorizationFingerprint: string
  readonly effectiveMode: string
  readonly endpoint: AdmittedRemoteEndpoint
  readonly generation: string
  readonly argv: readonly string[]
  readonly remoteCwd: string
  readonly deployment: RemoteExecDeployment
}

/**
 * Run one remote command under the two-admission contract. `toolName` is the
 * dispatching tool's own name, passed in — never read from model arguments.
 */
export async function runRemoteCommand(
  registry: MultiRootRegistry,
  backendFor: (environmentId: string, workspace: string, environmentDigest?: string) => RemoteExecutionBackend | undefined,
  request: RemoteCommandRequest,
  toolName: string,
  signal: AbortSignal,
): Promise<RemoteCommandResult> {
  const base: Base = { environmentId: request.environmentId, rootId: request.rootId }
  const guidance: ExecGuidanceContext = { environmentId: request.environmentId, rootId: request.rootId }
  const refuse = (target: Base, code: string): RemoteCommandResult => notStarted(target, code, execFailureGuidance(code, guidance))
  if (signal.aborted) return refuse(base, 'cancelled')
  const endpoint: RemoteEndpointRef = { environmentId: request.environmentId, rootId: request.rootId }
  const admission = () => ({
    session: request.session, toolName, purpose: 'exec' as const, endpoints: [endpoint],
  })

  const checkCwd = async (backend: RemoteExecutionBackend, cwd: string, admitted: AdmittedRemoteEndpoint): Promise<string | undefined> => {
    if (backend.verifyCwd === undefined) return undefined
    try {
      await backend.verifyCwd(cwd, admitted.displayPath, signal, admitted.verifiedTarget)
    } catch (error) {
      const raw = (error as { code?: unknown }).code
      const code = typeof raw === 'string' && STABLE_CODE.test(raw) ? raw : 'cwd-unverifiable'
      if (code === 'endpoint-redirected' && admitted.incarnation !== undefined && request.session !== undefined) {
        await registry.withholdRemote(request.session.header.cwd, endpoint, admitted.incarnation).catch(() => {})
      }
      return signal.aborted ? 'cancelled' : code
    }
    return undefined
  }

  // Admission A: admit, then prepare. A denial means no confine ran.
  let prep: Prep | RemoteCommandResult
  try {
    prep = await registry.withRemoteOperation(admission(), async operation => {
      const denied = (code: string): RemoteCommandResult => refuse({ ...base, operationId: operation.identity.operationId }, code)
      const admitted = operation.endpoints[0]!
      guidance.displayPath = admitted.displayPath
      const backend = backendFor(request.environmentId, admitted.displayPath, admitted.environmentDigest ?? undefined)
      if (backend === undefined) return denied('backend-unavailable')
      const cwdRelative = request.cwdRelative ?? ''
      guidance.cwdRelative = cwdRelative
      if (!checkCwdRelative(cwdRelative)) return denied('invalid-cwd')
      const { deployment } = backend
      guidance.maxTimeoutMs = deployment.maxTimeoutMs
      if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > deployment.maxTimeoutMs) {
        return denied('invalid-timeout')
      }
      const remoteCwd = cwdRelative === '' ? admitted.displayPath : posix.join(admitted.displayPath, cwdRelative)
      const argv = [...deployment.shell, request.command]
      const cwdError = await checkCwd(backend, remoteCwd, admitted)
      if (cwdError !== undefined) return denied(cwdError)
      let confined: Awaited<ReturnType<RemoteExecutionBackend['confine']>>
      try {
        confined = await backend.confine(argv, {
          mode: 'workspace-write', workspaceRoot: admitted.displayPath, sessionId: operation.identity.sessionId,
        }, signal)
      } catch { return denied('confine-failed') }
      if (confined.enforcement !== 'full') return denied('sandbox-unverified')
      return {
        operationId: operation.identity.operationId,
        epoch: operation.identity.authorityEpoch, authorizationFingerprint: operation.identity.authorizationFingerprint,
        effectiveMode: operation.identity.effectiveMode,
        endpoint: admitted, generation: confined.generation, argv: confined.argv, remoteCwd, deployment,
      } satisfies Prep
    })
  } catch (error) {
    if (error instanceof RemoteAdmissionError) {
      const code = stableCode(error.code)
      await enrichExecCandidates(registry, request.session, guidance, code)
      return refuse(base, code)
    }
    throw error
  }
  if ('status' in prep) return prep

  guidance.displayPath = prep.endpoint.displayPath
  const backend = backendFor(request.environmentId, prep.endpoint.displayPath, prep.endpoint.environmentDigest ?? undefined)
  if (backend !== undefined) {
    const cwdError = await checkCwd(backend, prep.remoteCwd, prep.endpoint)
    if (cwdError !== undefined) return refuse({ ...base, operationId: prep.operationId }, cwdError)
  }

  // Admission B: the FINAL launch admission. The identical request re-enters
  // the owner's ordering point; a revocation since A denies here and spawn is
  // never called. The argv built under A is never cached across calls.
  interface Launched { operationId: string; handle: RemoteProcessHandle; stdout: Sink; stderr: Sink }
  let launch: { result: RemoteCommandResult } | { launched: Launched }
  try {
    launch = await registry.withRemoteOperation(admission(), operation => {
      const denied = (code: string) => ({ result: refuse({ ...base, operationId: operation.identity.operationId }, code) })
      if (signal.aborted) return denied('cancelled')
      const admitted = operation.endpoints[0]!
      const backend = backendFor(request.environmentId, admitted.displayPath, admitted.environmentDigest ?? undefined)
      if (backend === undefined) return denied('backend-unavailable')
      const unchanged = operation.identity.authorityEpoch === prep!.epoch
        && operation.identity.authorizationFingerprint === prep!.authorizationFingerprint
        && operation.identity.effectiveMode === prep!.effectiveMode
        && admitted.environmentId === prep!.endpoint.environmentId && admitted.rootId === prep!.endpoint.rootId
        && admitted.displayPath === prep!.endpoint.displayPath && admitted.bindingDigest === prep!.endpoint.bindingDigest
        && (admitted.verifiedTarget?.kind ?? null) === (prep!.endpoint.verifiedTarget?.kind ?? null)
        && (admitted.verifiedTarget?.value ?? null) === (prep!.endpoint.verifiedTarget?.value ?? null)
        && backend.currentGeneration() === prep!.generation
      if (!unchanged) return denied('admission-changed')
      const stdout = createSink(effectivePreviewLimit(request.maxOutputBytes, prep!.deployment.stdoutLimit))
      const stderr = createSink(effectivePreviewLimit(request.maxOutputBytes, prep!.deployment.stderrLimit))
      try {
        const handle = backend.spawn(prep!.argv, {
          cwd: prep!.remoteCwd, env: prep!.deployment.env, generation: prep!.generation,
        }, { stdout: stdout.append, stderr: stderr.append })
        return { launched: { operationId: operation.identity.operationId, handle, stdout, stderr } }
      } catch {
        return { result: { ...base, operationId: operation.identity.operationId, status: 'admitted-may-start' as const, reason: 'remote launch acknowledgement was not confirmed', ...execUncertainGuidance('admitted-may-start') } }
      }
    })
  } catch (error) {
    if (error instanceof RemoteAdmissionError) {
      const code = stableCode(error.code)
      await enrichExecCandidates(registry, request.session, guidance, code)
      return refuse(base, code)
    }
    throw error
  }
  if ('result' in launch) return launch.result
  const { operationId, handle, stdout, stderr } = launch.launched
  // Transport loss can arrive before the start acknowledgement, while the exit
  // promise is not part of the current race yet. Keep that early rejection from
  // surfacing as an unhandled rejection; the later await still observes it.
  const exited = handle.exited
  void exited.catch(() => {})

  // Observe from spawn, including the asynchronous start acknowledgement.
  // A notification is only a reason to re-admit; it never grants authority.
  let active = true
  let checking = false
  let termination: 'timeout' | 'cancelled' | 'revoked' | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = Promise.withResolvers<never>()
  void deadline.promise.catch(() => {})
  const terminateOnce = (why: 'timeout' | 'cancelled' | 'revoked') => {
    if (!active || termination !== undefined) return
    termination = why
    cleanupTimer = setTimeout(() => deadline.reject(new RemoteConnectionLost('remote termination was not confirmed before the cleanup deadline')), prep.deployment.terminateGraceMs)
    try { handle.terminate() } catch (error) {
      deadline.reject(new RemoteConnectionLost(error instanceof Error ? error.message : String(error)))
    }
  }
  const checkGrant = async () => {
    if (!active || checking || termination !== undefined) return
    checking = true
    const timer = setTimeout(() => terminateOnce('revoked'), 5_500)
    try {
      while (active && termination === undefined && !signal.aborted) {
        try {
          await registry.withRemoteOperation(admission(), operation => {
            if (operation.identity.authorityEpoch !== prep.epoch
              || operation.identity.authorizationFingerprint !== prep.authorizationFingerprint
              || operation.identity.effectiveMode !== prep.effectiveMode
              || backendFor(request.environmentId, prep.endpoint.displayPath, prep.endpoint.environmentDigest ?? undefined)?.currentGeneration() !== prep.generation) terminateOnce('revoked')
          })
          return
        } catch (error) {
          if (!(error instanceof RemoteAdmissionError) || !TRANSIENT_ADMISSION_ERRORS.has(error.code)) {
            terminateOnce('revoked')
            return
          }
          await delay(250)
        }
      }
    } finally { clearTimeout(timer); checking = false }
  }
  const unsubscribe = registry.onRemoteChange(() => { void checkGrant() })
  const poll = setInterval(() => { void checkGrant() }, 1_000)
  const timer = setTimeout(() => terminateOnce('timeout'), request.timeoutMs)
  const onAbort = () => terminateOnce('cancelled')
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  void checkGrant() // closes the spawn -> subscribe race
  // A lost transport must not wait for an acknowledgement that will never
  // arrive; a normal early exit keeps waiting for the start reply.
  const lossBeforeStart = exited.then(() => undefined, error => { throw error })
  try {
    try { await Promise.race([handle.started, lossBeforeStart, deadline.promise]) } catch (error) {
      if (error instanceof RemoteConnectionLost) throw error
      return { ...base, operationId, status: 'admitted-may-start', reason: 'remote launch acknowledgement was not confirmed', ...execUncertainGuidance('admitted-may-start') }
    }
    const exit = await Promise.race([exited, deadline.promise])
    const confirmed = await Promise.race([handle.waitForExit(prep.deployment.terminateGraceMs), deadline.promise])
    const out = stdout.preview()
    const err = stderr.preview()
    return {
      ...base, operationId, status: confirmed ? 'scope-exited' : 'exited',
      scope: confirmed ? 'confirmed' : 'unconfirmed',
      exitCode: exit.exitCode, signal: exit.signal,
      stdout: out.text, stderr: err.text,
      truncated: { stdout: out.truncated, stderr: err.truncated },
      totalBytes: { stdout: out.totalBytes, stderr: err.totalBytes },
      droppedBytes: { stdout: out.droppedBytes, stderr: err.droppedBytes },
      ...(termination === undefined
        ? confirmed ? {} : { ...execScopeUnconfirmedGuidance() }
        : { termination, ...execTerminationGuidance(termination, confirmed) }),
    }
  } catch (error) {
    if (error instanceof RemoteConnectionLost) {
      return {
        ...base, operationId, status: 'unknown', reconcileId: operationId,
        reason: 'remote execution or cleanup acknowledgement was lost',
        ...(termination === undefined ? {} : { termination }),
        ...execUncertainGuidance('unknown'),
      }
    }
    throw error
  } finally {
    active = false
    unsubscribe()
    clearInterval(poll)
    clearTimeout(timer)
    clearTimeout(cleanupTimer)
    signal.removeEventListener('abort', onAbort)
  }
}

interface OutputPreview {
  readonly text: string
  readonly truncated: boolean
  readonly totalBytes: number | null
  readonly droppedBytes: number | null
}

interface Sink {
  append(chunk: Uint8Array, meta?: OutputChunkMeta): void
  preview(): OutputPreview
}

/** Keep complete code points within the byte budget of a JSON string's contents. */
function clipJsonText(text: string, limit: number): string {
  if (Buffer.byteLength(JSON.stringify(text)) - 2 <= limit) return text
  let end = 0
  let remaining = limit
  for (const character of text) {
    const point = character.codePointAt(0)!
    let width = Buffer.byteLength(character)
    if (point === 0x22 || point === 0x5c) width = 2
    else if (point < 0x20) width = point >= 8 && point <= 13 && point !== 11 ? 2 : 6
    if (width > remaining) break
    remaining -= width
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * Apply the same stream budget to the raw prefix and its JSON representation.
 * Whole-stream coordinates let the final preview account for both cuts.
 */
function createSink(limit: number): Sink {
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  let headDropped = false
  let total: number | null = null
  let exactWindow = true
  let first = true
  return {
    append: (chunk, meta) => {
      if (meta === undefined) {
        total = null
        exactWindow = false
      } else {
        if (first && (meta.lossy || (meta.offset !== undefined && meta.offset > 0))) headDropped = true
        total = typeof meta.totalBytes === 'number' && Number.isSafeInteger(meta.totalBytes) && meta.totalBytes >= 0
          ? meta.totalBytes : null
        if (meta.approximate === true || meta.offset === undefined) exactWindow = false
      }
      first = false
      const remaining = Math.max(0, limit - size)
      if (chunk.byteLength > remaining) over = true
      const prefix = chunk.subarray(0, remaining)
      if (prefix.byteLength > 0) { chunks.push(prefix); size += prefix.byteLength }
    },
    preview: () => {
      const whole = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.byteLength }
      // Do not synthesize a replacement character for a truncated UTF-8 tail.
      // A lossy head alone says nothing about whether the end is incomplete.
      let decoded: string
      let byteFaithful = exactWindow
      try {
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(whole, { stream: over })
      } catch {
        decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(whole, { stream: over })
        byteFaithful = false
      }
      const text = clipJsonText(decoded, limit)
      return {
        text,
        truncated: over || headDropped || (total !== null && total > size) || text.length < decoded.length,
        totalBytes: total,
        droppedBytes: byteFaithful && total !== null ? Math.max(0, total - Buffer.byteLength(text)) : null,
      }
    },
  }
}
