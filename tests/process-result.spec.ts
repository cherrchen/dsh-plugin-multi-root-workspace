import { describe, expect, it } from 'vitest'
import { decorateProcessOutcome, stampProcessResult } from '../src/compat/process-result.ts'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
const facts: ConfinedArgv = { argv: ['runner'], enforcement: 'full', denialSignatures: ['Operation not permitted'],
  runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['runner unavailable'] }] }
const policy = { mode: 'danger-full-access' as const, workspaceRoot: '/primary' }

describe('Full-access process result diagnostics', () => {
  it('preserves execution identity, caller context and the cached result while marking a kernel denial', async () => {
    let calls = 0
    const execution = { cancel() {}, result() {
      expect(this).toBe(execution); calls++
      return Promise.resolve({ exitCode: 1, stderr: { text: 'Operation not permitted' }, sandbox: { mode: policy.mode, denied: false } })
    } }
    expect(decorateProcessOutcome(execution, facts, policy)).toBe(execution)
    const first = execution.result(), second = execution.result()
    expect(first).toBe(second)
    expect(await first).toMatchObject({ sandbox: { mode: policy.mode, denied: true, enforcement: 'full' } })
    expect(calls).toBe(1)
  })
  it('distinguishes infrastructure refusal from denied file effects, including overlapping signatures', () => {
    expect(stampProcessResult({ exitCode: 127, stderr: 'runner unavailable: Operation not permitted' }, facts, policy))
      .toMatchObject({ sandbox: { runnerFailed: true, denied: false } })
    expect(stampProcessResult({ exitCode: 0, stderr: 'Operation not permitted' }, facts, policy))
      .toMatchObject({ sandbox: { denied: false } })
    expect(stampProcessResult({ exitCode: null, stderr: 'Operation not permitted' }, facts, policy))
      .toMatchObject({ sandbox: { denied: false } })
  })
  it('decorates PTC failures and successful results without changing payloads', async () => {
    expect(await decorateProcessOutcome(Promise.resolve({ ok: false, failure: { message: 'Operation not permitted' } }), facts, policy))
      .toMatchObject({ ok: false, sandbox: { denied: true, enforcement: 'full' } })
    expect(await decorateProcessOutcome(Promise.resolve({ logs: [], error: { kind: 'exception', message: 'EPERM: Operation not permitted' } }), facts, policy))
      .toMatchObject({ error: { kind: 'exception' }, sandbox: { denied: true, enforcement: 'full' } })
    expect(await decorateProcessOutcome(Promise.resolve({ ok: true, value: 42 }), facts, policy))
      .toMatchObject({ ok: true, value: 42, sandbox: { denied: false } })
  })
})
