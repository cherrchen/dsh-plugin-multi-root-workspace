/** Structural adaptation of settled shell executions and PTC results. Keeps
 * the execution identity, cached result, and installed sync/async shape.
 */
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { wrapMethod } from '../method-wrapper.ts'

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null
const thenable = (value: unknown): value is Promise<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
const textOf = (value: unknown): string => typeof value === 'string' ? value
  : object(value) && typeof value.text === 'string' ? value.text : ''

/** Diagnostics a caller can supply for outcomes that carry no stderr of their
 * own — a non-consuming `collected.stderr.readFrom(0)` tail on the subprocess
 * the confined call spawned, read at settle the way the executor's own
 * `onProcessDone` seam does.
 */
export interface SettledOutcomeDiagnostics {
  readonly stderr?: (() => string | undefined) | undefined
}

const stderrOf = (value: RecordValue): string =>
  textOf(value.stderr) + (object(value.error) ? textOf(value.error.message) : '')
  + (object(value.failure) ? textOf(value.failure.message) : '')
const exitCodeOf = (value: RecordValue): number | null =>
  typeof value.exitCode === 'number' || value.exitCode === null
    ? value.exitCode as number | null
    : value.ok === false || object(value.error) || object(value.failure) ? 1 : 0

/** Denial and runner-failure verdicts for one settled process — the same
 * non-zero-exit + stderr-signature rules the sandbox executors apply: a fatal
 * runner line is an infrastructure failure, never a policy denial. */
const classifyOutcome = (exitCode: number | null, stderr: string, facts: ConfinedArgv): { denied: boolean; runnerFailed: boolean } => {
  const nonzero = exitCode !== null && exitCode !== 0
  const lines = stderr.toLowerCase().split(/\r?\n/)
  const runnerFailed = nonzero && facts.runnerFailureRules.some(rule =>
    (rule.allowedExitCodes === undefined || rule.allowedExitCodes.includes(exitCode as number))
    && lines.some(line => !rule.informationalLines?.some(info => info.toLowerCase() === line)
      && rule.fatalSignatures.some(signature => line.includes(signature.toLowerCase()))))
  const denied = nonzero && !runnerFailed
    && facts.denialSignatures.some(signature => stderr.toLowerCase().includes(signature.toLowerCase()))
  return { denied, runnerFailed }
}

/** The `sandbox` stamp one settled outcome carries, merged over any stamp the
 * confining executor already installed. */
const sandboxStamp = (value: RecordValue, facts: ConfinedArgv, policy: SandboxExecutionPolicy, stderr?: string): RecordValue => {
  const { denied, runnerFailed } = classifyOutcome(exitCodeOf(value), stderr ?? stderrOf(value), facts)
  return { ...(object(value.sandbox) ? value.sandbox : {}),
    mode: policy.mode, enforcement: facts.enforcement, denied, ...(runnerFailed ? { runnerFailed: true } : {}),
  }
}

export function stampProcessResult(value: unknown, facts: ConfinedArgv, policy: SandboxExecutionPolicy): unknown {
  if (!object(value)) return value
  return { ...value, sandbox: sandboxStamp(value, facts, policy) }
}

/** Whether a non-thenable, non-`result()` value is a live process handle
 * rather than settled result data: it owns a `done` settle hook or callable
 * members, or carries a shaped prototype. Copying it would freeze
 * `status`/`exitCode` where consumers poll them and sever `readOutput`/`kill`
 * identity — the model-facing `proc.sandbox` read happens on this very
 * object, so the stamp must land in place.
 */
const liveHandle = (value: RecordValue): boolean =>
  thenable(value.done) || typeof value.done === 'function'
  || Object.values(value).some(member => typeof member === 'function')
  || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)

export function decorateProcessOutcome(value: unknown, facts: ConfinedArgv, policy: SandboxExecutionPolicy, diagnostics?: SettledOutcomeDiagnostics): unknown {
  if (object(value) && typeof value.then === 'function') {
    return (value as unknown as Promise<unknown>).then(result => decorateProcessOutcome(result, facts, policy, diagnostics))
  }
  if (object(value) && typeof value.result === 'function') {
    let cached: unknown
    let settled = false
    wrapMethod(value, 'result', original => function (this: unknown, ...args: unknown[]) {
      if (!settled) {
        cached = decorateProcessOutcome((original as (...args: unknown[]) => unknown).apply(this, args), facts, policy, diagnostics)
        settled = true
      }
      return cached
    })
    return value
  }
  if (object(value) && liveHandle(value)) {
    // The executor stamps `proc.sandbox` from its `onProcessDone` settle hook;
    // at this seam the hook is `done` — stamp on resolution so a still-running
    // handle never reports a settled verdict it has not earned.
    const settle = () => {
      try {
        value.sandbox = sandboxStamp(value, facts, policy, diagnostics?.stderr?.())
      } catch { /* a stamp failure must never break the process chain */ }
    }
    if (thenable(value.done)) {
      const done = value.done
      value.done = done.then(
        outcome => { settle(); return decorateProcessOutcome(outcome, facts, policy, diagnostics) },
        error => { settle(); throw error },
      )
      return value
    }
    if (typeof value.done === 'function') {
      wrapMethod(value, 'done', original => function (this: unknown, ...args: unknown[]) {
        const outcome = (original as (...args: unknown[]) => unknown).apply(this, args)
        return thenable(outcome)
          ? outcome.then(
            resolved => { settle(); return decorateProcessOutcome(resolved, facts, policy, diagnostics) },
            error => { settle(); throw error })
          : (settle(), decorateProcessOutcome(outcome, facts, policy, diagnostics))
      })
      return value
    }
    settle()
    return value
  }
  return stampProcessResult(value, facts, policy)
}
