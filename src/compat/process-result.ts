/** Structural adaptation of settled shell executions and PTC results. Keeps
 * the execution identity, cached result, and installed sync/async shape.
 */
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { wrapMethod } from '../method-wrapper.ts'

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null
const textOf = (value: unknown): string => typeof value === 'string' ? value
  : object(value) && typeof value.text === 'string' ? value.text : ''

export function stampProcessResult(value: unknown, facts: ConfinedArgv, policy: SandboxExecutionPolicy): unknown {
  if (!object(value)) return value
  const stderr = textOf(value.stderr) + (object(value.error) ? textOf(value.error.message) : '')
    + (object(value.failure) ? textOf(value.failure.message) : '')
  const exitCode = typeof value.exitCode === 'number' || value.exitCode === null
    ? value.exitCode : value.ok === false || object(value.error) || object(value.failure) ? 1 : 0
  const nonzero = exitCode !== null && exitCode !== 0
  const lines = stderr.toLowerCase().split(/\r?\n/)
  const runnerFailed = nonzero && facts.runnerFailureRules.some(rule =>
    (rule.allowedExitCodes === undefined || rule.allowedExitCodes.includes(exitCode!))
    && lines.some(line => !rule.informationalLines?.some(info => info.toLowerCase() === line)
      && rule.fatalSignatures.some(signature => line.includes(signature.toLowerCase()))))
  const denied = nonzero && !runnerFailed && facts.denialSignatures.some(signature => stderr.toLowerCase().includes(signature.toLowerCase()))
  return { ...value, sandbox: { ...(object(value.sandbox) ? value.sandbox : {}),
    mode: policy.mode, enforcement: facts.enforcement, denied, ...(runnerFailed ? { runnerFailed: true } : {}),
  } }
}

export function decorateProcessOutcome(value: unknown, facts: ConfinedArgv, policy: SandboxExecutionPolicy): unknown {
  if (object(value) && typeof value.then === 'function') {
    return (value as unknown as Promise<unknown>).then(result => decorateProcessOutcome(result, facts, policy))
  }
  if (object(value) && typeof value.result === 'function') {
    let cached: unknown
    let settled = false
    wrapMethod(value, 'result', original => function (this: unknown, ...args: unknown[]) {
      if (!settled) {
        cached = decorateProcessOutcome((original as (...args: unknown[]) => unknown).apply(this, args), facts, policy)
        settled = true
      }
      return cached
    })
    return value
  }
  return stampProcessResult(value, facts, policy)
}
