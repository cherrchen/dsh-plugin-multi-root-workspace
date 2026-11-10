/**
 * The G3 `remote_bash` contract: an explicit remote command is admitted TWICE
 * by the registry's ordered control plane — once to verify and prepare, once
 * for the final launch — and the spawn happens inside the second admission's
 * body so a revocation between them can never reach a spawned process. No
 * retry, no reconnect: uncertainty is reported, not replayed.
 */
import { posix } from 'node:path'
import type { MultiRootRegistry } from '../registry.ts'
import { RemoteAdmissionError } from './contract.ts'
import type { AdmittedRemoteEndpoint, RemoteEndpointRef, RemoteOperationSession } from './contract.ts'

/** The deployment-side execution contract a backend advertises. */
export interface RemoteExecDeployment {
  readonly shell: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly maxTimeoutMs: number
  readonly stdoutLimit: number
  readonly stderrLimit: number
  readonly terminateGraceMs: number
}

export interface RemoteExecutionBackend {
  readonly deployment: RemoteExecDeployment
  confine(
    argv: readonly string[],
    policy: { mode: 'workspace-write'; workspaceRoot: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<{ argv: readonly string[]; enforcement: 'full' | 'partial'; generation: string }>
  currentGeneration(): string
  verifyCwd?(cwd: string, root: string, signal: AbortSignal): Promise<void>
  spawn(
    argv: readonly string[],
    options: { cwd: string; env: Readonly<Record<string, string>>; generation: string },
    sink: { stdout(chunk: Uint8Array): void; stderr(chunk: Uint8Array): void },
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
      termination?: 'timeout' | 'cancelled'
    })
  | (Base & { status: 'unknown'; reconcileId: string; reason: string; termination?: 'timeout' | 'cancelled' })

const notStarted = (base: Base, code: string): RemoteCommandResult =>
  base.operationId === undefined
    ? { environmentId: base.environmentId, rootId: base.rootId, status: 'not-started', code }
    : { ...base, status: 'not-started', code }

function checkCwdRelative(cwdRelative: string): boolean {
  return cwdRelative === '' || (!cwdRelative.startsWith('/') && !cwdRelative.includes('\0') && !cwdRelative.includes('\\')
    && !cwdRelative.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
}

interface Prep {
  readonly epoch: string | undefined
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
  backendFor: (environmentId: string) => RemoteExecutionBackend | undefined,
  request: RemoteCommandRequest,
  toolName: string,
  signal: AbortSignal,
): Promise<RemoteCommandResult> {
  const base: Base = { environmentId: request.environmentId, rootId: request.rootId }
  if (signal.aborted) return notStarted(base, 'cancelled')
  const endpoint: RemoteEndpointRef = { environmentId: request.environmentId, rootId: request.rootId }
  const admission = () => ({
    session: request.session, toolName, purpose: 'exec' as const, endpoints: [endpoint],
  })

  // Admission A: admit, then verify and prepare. A denial means no confine ran.
  let prep: Prep | RemoteCommandResult
  try {
    prep = await registry.withRemoteOperation(admission(), async operation => {
      const denied = (code: string): RemoteCommandResult => notStarted({ ...base, operationId: operation.identity.operationId }, code)
      const backend = backendFor(request.environmentId)
      if (backend === undefined) return denied('backend-unavailable')
      const cwdRelative = request.cwdRelative ?? ''
      if (!checkCwdRelative(cwdRelative)) return denied('invalid-cwd')
      const { deployment } = backend
      if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > deployment.maxTimeoutMs) {
        return denied('invalid-timeout')
      }
      const admitted = operation.endpoints[0]!
      const remoteCwd = cwdRelative === '' ? admitted.displayPath : posix.join(admitted.displayPath, cwdRelative)
      const argv = [...deployment.shell, request.command]
      if (backend.verifyCwd !== undefined) {
        try { await backend.verifyCwd(remoteCwd, admitted.displayPath, signal) } catch (error) {
          return denied(typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'cwd-unverifiable')
        }
      }
      let confined: Awaited<ReturnType<RemoteExecutionBackend['confine']>>
      try {
        confined = await backend.confine(argv, {
          mode: 'workspace-write', workspaceRoot: admitted.displayPath, sessionId: operation.identity.sessionId,
        }, signal)
      } catch { return denied('confine-failed') }
      if (confined.enforcement !== 'full') return denied('sandbox-unverified')
      return {
        epoch: operation.identity.authorityEpoch, effectiveMode: operation.identity.effectiveMode,
        endpoint: admitted, generation: confined.generation, argv: confined.argv, remoteCwd, deployment,
      } satisfies Prep
    })
  } catch (error) {
    if (error instanceof RemoteAdmissionError) return notStarted(base, error.code)
    throw error
  }
  if ('status' in prep) return prep

  // Admission B: the FINAL launch admission. The identical request re-enters
  // the owner's ordering point; a revocation since A denies here and spawn is
  // never called. The argv built under A is never cached across calls.
  interface Launched { operationId: string; handle: RemoteProcessHandle; stdout: Sink; stderr: Sink }
  let launch: { result: RemoteCommandResult } | { launched: Launched }
  try {
    launch = await registry.withRemoteOperation(admission(), operation => {
      const denied = (code: string) => ({ result: notStarted({ ...base, operationId: operation.identity.operationId }, code) })
      if (signal.aborted) return denied('cancelled')
      const backend = backendFor(request.environmentId)
      if (backend === undefined) return denied('backend-unavailable')
      const admitted = operation.endpoints[0]!
      const unchanged = operation.identity.authorityEpoch === prep!.epoch
        && operation.identity.effectiveMode === prep!.effectiveMode
        && admitted.environmentId === prep!.endpoint.environmentId && admitted.rootId === prep!.endpoint.rootId
        && admitted.displayPath === prep!.endpoint.displayPath && admitted.bindingDigest === prep!.endpoint.bindingDigest
        && (admitted.verifiedTarget?.kind ?? null) === (prep!.endpoint.verifiedTarget?.kind ?? null)
        && (admitted.verifiedTarget?.value ?? null) === (prep!.endpoint.verifiedTarget?.value ?? null)
        && backend.currentGeneration() === prep!.generation
      if (!unchanged) return denied('admission-changed')
      const stdout = createSink(prep!.deployment.stdoutLimit)
      const stderr = createSink(prep!.deployment.stderrLimit)
      try {
        const handle = backend.spawn(prep!.argv, {
          cwd: prep!.remoteCwd, env: prep!.deployment.env, generation: prep!.generation,
        }, { stdout: stdout.append, stderr: stderr.append })
        return { launched: { operationId: operation.identity.operationId, handle, stdout, stderr } }
      } catch (error) {
        return { result: { ...base, operationId: operation.identity.operationId, status: 'admitted-may-start' as const, reason: error instanceof Error ? error.message : String(error) } }
      }
    })
  } catch (error) {
    if (error instanceof RemoteAdmissionError) return notStarted(base, error.code)
    throw error
  }
  if ('result' in launch) return launch.result
  const { operationId, handle, stdout, stderr } = launch.launched

  try {
    await handle.started
  } catch (error) {
    if (error instanceof RemoteConnectionLost) {
      return {
        ...base, operationId, status: 'unknown', reconcileId: operationId,
        reason: error.message,
      }
    }
    return {
      ...base, operationId, status: 'admitted-may-start',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  // From here the command may be running: wait OUTSIDE every queue, bound the
  // output, and terminate exactly once on timeout or caller cancellation.
  let terminated = false
  let termination: 'timeout' | 'cancelled' | undefined
  const terminateOnce = (why: 'timeout' | 'cancelled') => {
    if (terminated) return
    terminated = true
    termination = why
    handle.terminate()
  }
  const timer = setTimeout(() => terminateOnce('timeout'), request.timeoutMs)
  const onAbort = () => terminateOnce('cancelled')
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const exit = await handle.exited
    const confirmed = await handle.waitForExit(prep.deployment.terminateGraceMs)
    return {
      ...base, operationId, status: confirmed ? 'scope-exited' : 'exited',
      scope: confirmed ? 'confirmed' : 'unconfirmed',
      exitCode: exit.exitCode, signal: exit.signal,
      stdout: stdout.text(), stderr: stderr.text(),
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      ...(termination === undefined ? {} : { termination }),
    }
  } catch (error) {
    if (error instanceof RemoteConnectionLost) {
      return {
        ...base, operationId, status: 'unknown', reconcileId: operationId,
        reason: error.message,
        ...(termination === undefined ? {} : { termination }),
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

interface Sink {
  readonly append: (chunk: Uint8Array) => void
  readonly text: () => string
  readonly truncated: boolean
}

/** One bounded byte sink: appends until the limit, then only flags. */
function createSink(limit: number): Sink {
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  return {
    get truncated() { return over },
    append: chunk => {
      if (size + chunk.byteLength > limit) { over = true; return }
      chunks.push(chunk); size += chunk.byteLength
    },
    text: () => {
      const whole = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder().decode(whole)
    },
  }
}
