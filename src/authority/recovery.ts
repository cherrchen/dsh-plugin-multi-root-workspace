/**
 * Bounded background retry for the registry authority: one pending timer and
 * one in-flight attempt per instance, post-completion backoff, and local
 * cancellation on dispose. The scheduler owns NO policy — the caller supplies
 * `run` (one recovery attempt) and `eligible` (whether a degraded state still
 * wants recovery), so the same object can drive contended, follower
 * resync, and retryable storage failures.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/authority/recovery
 */

/** Injectable clock so fake-timer specs can drive the scheduler exactly. */
export interface RecoveryTimers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  random(): number
  now(): number
}

/** What the scheduler is doing, for diagnostics surfaces. */
export type RecoveryPhase = 'idle' | 'waiting' | 'attempting' | 'disabled'

export class RecoveryScheduler {
  private readonly run: () => Promise<void>
  private readonly eligible: () => boolean
  private readonly enabled: boolean
  private readonly timers: RecoveryTimers
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private disposed = false
  private attempts = 0
  private retryAt: number | undefined

  constructor(options: { run: () => Promise<void>; eligible: () => boolean; enabled: boolean; timers?: RecoveryTimers }) {
    this.run = options.run
    this.eligible = options.eligible
    this.enabled = options.enabled
    this.timers = options.timers ?? { setTimeout, clearTimeout, random: Math.random, now: Date.now }
  }

  /**
   * Ask for a recovery attempt. Called after every `ensureAuthority()` and on
   * every downgrade event. A healthy state (`!eligible()`) resets the backoff;
   * a pending timer or in-flight attempt is never duplicated or reset.
   */
  arm(): void {
    if (this.disposed || !this.enabled) return
    if (!this.eligible()) { this.attempts = 0; this.clearTimer(); return }
    if (this.timer !== undefined || this.inFlight) return
    const delay = this.delay(this.attempts)
    this.retryAt = this.timers.now() + delay
    this.timer = this.timers.setTimeout(() => { void this.tick() }, delay)
    this.timer.unref()
  }

  /**
   * Progress event (a follower connection was just adopted): the backoff is
   * earned, so reset it and run the next attempt immediately — still through
   * the single pending timer.
   */
  kick(): void {
    if (this.disposed || !this.enabled) return
    this.attempts = 0
    if (this.inFlight) return
    this.clearTimer()
    this.retryAt = this.timers.now()
    this.timer = this.timers.setTimeout(() => { void this.tick() }, 0)
    this.timer.unref()
  }

  /** Stop scheduling. An in-flight attempt is left to finish on its own. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  get state(): { phase: RecoveryPhase; attempts: number; nextRetryAt: number | undefined } {
    const phase: RecoveryPhase = this.disposed || (!this.enabled && this.eligible()) ? 'disabled'
      : this.inFlight ? 'attempting'
      : this.timer !== undefined ? 'waiting'
      : 'idle'
    return { phase, attempts: this.attempts, nextRetryAt: this.timer === undefined ? undefined : this.retryAt }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) { this.timers.clearTimeout(this.timer); this.timer = undefined }
    this.retryAt = undefined
  }

  private delay(n: number): number {
    return Math.min(1000 * 2 ** n, 30000) * (0.8 + 0.4 * this.timers.random())
  }

  private async tick(): Promise<void> {
    this.timer = undefined
    this.retryAt = undefined
    if (!this.eligible()) { this.attempts = 0; return }
    this.inFlight = true
    try {
      await this.run()
    } catch { /* a failed attempt is rescheduled like any other */ }
    this.inFlight = false
    if (this.disposed || !this.eligible()) { this.attempts = 0; return }
    // The next round is measured from completion, at the next backoff step.
    this.attempts++
    this.arm()
  }
}
