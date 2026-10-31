/**
 * Unit tests for the bounded background-recovery scheduler: a single pending
 * timer, post-completion backoff, coalescing, kick, opt-out, and dispose.
 * Driven by injected timers + `vi.useFakeTimers()` so no wall-clock is spent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecoveryScheduler, type RecoveryTimers } from '../src/authority/recovery.ts'

let runs: number
let eligible: boolean
let scheduler: RecoveryScheduler
const timers: RecoveryTimers = {
  // Rebound to the faked globals inside beforeEach.
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  random: () => 0.5,
  now: () => Date.now(),
}

beforeEach(() => {
  vi.useFakeTimers()
  runs = 0
  eligible = true
  scheduler = new RecoveryScheduler({ run: async () => { runs++ }, eligible: () => eligible, enabled: true, timers })
})
afterEach(() => { scheduler.dispose(); vi.useRealTimers() })

describe('RecoveryScheduler', () => {
  it('keeps at most one pending timer and it is unrefed', () => {
    scheduler.arm()
    scheduler.arm()
    scheduler.arm()
    expect(vi.getTimerCount()).toBe(1)
    expect(scheduler.state.phase).toBe('waiting')
    expect(scheduler.state.nextRetryAt).toBe(Date.now() + 1000)
  })

  it('backs off geometrically from completion time and caps at 30s', async () => {
    scheduler.arm()
    // random() is pinned at 0.5, so jitter is exactly ×1.0.
    for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = runs
      await vi.advanceTimersByTimeAsync(expected)
      expect(runs).toBe(before + 1)
      // The next round is armed from completion at the next backoff step.
      expect(scheduler.state.nextRetryAt).toBe(Date.now() + Math.min(expected * 2, 30000))
    }
  })

  it('scales the delay by jitter: 0.8× at random=0, 1.2× at random=1', () => {
    const jittered = (random: number) => new RecoveryScheduler({ run: async () => {}, eligible: () => true, enabled: true, timers: { ...timers, random: () => random } })
    const low = jittered(0), high = jittered(1)
    low.arm(); high.arm()
    expect(low.state.nextRetryAt).toBe(Date.now() + 800)
    expect(high.state.nextRetryAt).toBe(Date.now() + 1200)
    low.dispose(); high.dispose()
  })

  it('does not reset the backoff on repeated arm() while a timer waits', () => {
    scheduler.arm()
    const retryAt = scheduler.state.nextRetryAt
    vi.advanceTimersByTime(500)
    scheduler.arm()
    scheduler.arm()
    expect(scheduler.state.nextRetryAt).toBe(retryAt)
  })

  it('schedules the next round only after the in-flight run completes', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const slow = new RecoveryScheduler({ run: () => blocked, eligible: () => eligible, enabled: true, timers })
    slow.arm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(slow.state.phase).toBe('attempting')
    slow.arm()
    expect(vi.getTimerCount()).toBe(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    // The follow-up tick is armed from completion, at the next backoff step.
    expect(vi.getTimerCount()).toBe(1)
    expect(slow.state.nextRetryAt).toBe(Date.now() + 2000)
    expect(slow.state.attempts).toBe(1)
    slow.dispose()
  })

  it('resets attempts when eligibility disappears between rounds', async () => {
    scheduler.arm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduler.state.attempts).toBe(1)
    eligible = false
    scheduler.arm()
    expect(vi.getTimerCount()).toBe(0)
    expect(scheduler.state.attempts).toBe(0)
    expect(scheduler.state.phase).toBe('idle')
  })

  it('treats a thrown run as a failed attempt and re-arms', async () => {
    let failures = 0
    const failing = new RecoveryScheduler({ run: async () => { failures++; throw new Error('boom') }, eligible: () => true, enabled: true, timers })
    failing.arm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(failures).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(failures).toBe(2)
    expect(failing.state.attempts).toBe(2)
    failing.dispose()
  })

  it('kick() zeroes the backoff and runs the next attempt at 0 delay', async () => {
    scheduler.arm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduler.state.attempts).toBe(1)
    scheduler.kick()
    expect(scheduler.state.attempts).toBe(0)
    expect(scheduler.state.nextRetryAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(2)
  })

  it('kick() does not add a timer while an attempt is in flight', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const slow = new RecoveryScheduler({ run: () => blocked, eligible: () => true, enabled: true, timers })
    slow.arm()
    await vi.advanceTimersByTimeAsync(1000)
    slow.kick()
    expect(vi.getTimerCount()).toBe(0)
    expect(slow.state.phase).toBe('attempting')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    slow.dispose()
  })

  it('never runs and reports disabled when enabled is false', async () => {
    const off = new RecoveryScheduler({ run: async () => { runs++ }, eligible: () => true, enabled: false, timers })
    off.arm()
    off.kick()
    await vi.advanceTimersByTimeAsync(60000)
    expect(runs).toBe(0)
    expect(off.state.phase).toBe('disabled')
    off.dispose()
  })

  it('clears the pending timer on dispose and never runs again', async () => {
    scheduler.arm()
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(60000)
    expect(runs).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.arm()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a recovery timer unrefed so it cannot hold the process', () => {
    const unref = vi.fn()
    const injected = new RecoveryScheduler({
      run: async () => {},
      eligible: () => true,
      enabled: true,
      timers: {
        setTimeout: (() => ({ unref })) as unknown as typeof setTimeout,
        clearTimeout: (() => {}) as unknown as typeof clearTimeout,
        random: () => 0.5,
        now: Date.now,
      },
    })
    injected.arm()
    injected.kick()
    expect(unref).toHaveBeenCalledTimes(2)
    injected.dispose()
  })
})
