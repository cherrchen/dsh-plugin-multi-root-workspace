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

  it('keeps a live background handle identical and stamps proc.sandbox only at settle', async () => {
    let resolveDone!: (outcome: unknown) => void
    const proc: {
      status: string
      exitCode: number | null
      signal: null
      done: Promise<unknown>
      sandbox?: unknown
      readOutput(): { delta: string; lossy: boolean }
      kill(): boolean
    } = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise(resolve => { resolveDone = resolve }),
      readOutput: () => ({ delta: 'tail', lossy: false }),
      kill: () => { proc.status = 'killed'; return true },
    }
    expect(decorateProcessOutcome(proc, facts, policy, { stderr: () => 'Operation not permitted' })).toBe(proc)
    // A still-running handle must not report a settled verdict.
    expect(proc.sandbox).toBeUndefined()
    expect(proc.readOutput()).toMatchObject({ delta: 'tail' })
    proc.exitCode = 1
    proc.status = 'completed'
    resolveDone(undefined)
    expect(await proc.done).toBeUndefined()
    expect(proc.sandbox).toMatchObject({ mode: policy.mode, enforcement: 'full', denied: true })
    expect(proc.kill()).toBe(true)
    expect(proc.status).toBe('killed')
  })

  it('classifies a settled live handle against the captured stderr tail, not fabricated fields', async () => {
    const handle = (exitCode: number | null, stderr: string | undefined) => {
      let resolveDone!: (outcome: unknown) => void
      const proc = {
        status: 'running' as string,
        exitCode,
        signal: null,
        done: new Promise(resolve => { resolveDone = resolve }),
        readOutput: () => ({ delta: '', lossy: false }),
        kill: () => false,
        sandbox: undefined as unknown,
      }
      decorateProcessOutcome(proc, facts, policy, { stderr: () => stderr })
      resolveDone(undefined)
      return proc.done.then(() => proc.sandbox)
    }
    expect(await handle(1, 'Operation not permitted')).toMatchObject({ denied: true })
    expect(await handle(127, 'runner unavailable: boom')).toMatchObject({ runnerFailed: true, denied: false })
    expect(await handle(1, undefined)).toMatchObject({ denied: false })
    expect(await handle(0, 'Operation not permitted')).toMatchObject({ denied: false })
  })

  it('stamps a handle-shaped settled object in place rather than copying it', () => {
    const proc = { exitCode: 1, stderr: { text: 'Operation not permitted' }, dispose() { return true } }
    const decorated = decorateProcessOutcome(proc, facts, policy)
    expect(decorated).toBe(proc)
    expect(proc).toMatchObject({ sandbox: { denied: true, enforcement: 'full' } })
    expect(proc.dispose()).toBe(true)
  })
})
