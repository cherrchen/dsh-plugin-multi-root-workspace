/**
 * `multi-root-worktrees`: worktree-aware additional-root suggestions (ADR-0039).
 *
 * The row is additive and compatibility-gated like every other widened-authority
 * row. It owns the discovery state of each primary root (candidates, prompt
 * queue, waiters, watchers), and it NEVER adds or removes a root on its own:
 * a registration only happens when the operator confirms a prompt, through
 * `addNew` on the Registry owner (phase P4).
 *
 * Activation is the full snapshot from `src/worktrees/repository.ts`:
 *
 * - `unactivated` — the first gate refused this workspace; no candidates, no
 *   watchers, no sidecar writes and no background retry. Only an explicit
 *   wait / reset / list may try again.
 * - `active` — inventory and watchers are alive.
 * - `lost` — the workspace WAS active and its snapshot no longer proves a
 *   checkout; candidates are dropped, watchers released, waiters answered and
 *   the workspace stays quiet until an explicit request re-detects it.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { configValue, volatileField } from './compat/skills.ts'
import { installWorktreeSettings } from './compat/worktree-settings.ts'
import { effectiveRootAccess, type WorktreeRootView, type WorktreeSnoozeChoice, type WorkspaceMode } from './contract.ts'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './scope.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import { primaryKey, RootValidationError, samePath } from './roots.ts'
import { inventoryWorktrees, type InventoryCandidate } from './worktrees/inventory.ts'
import { commonCandidate, commonDiscoveryKey, type CommonCandidate } from './worktrees/common.ts'
import { verifyPromptExpected } from './worktrees/owner.ts'
import { resolveRepo } from './worktrees/repository.ts'
import { lstatEntry, readPointerLine, resolvePointerTarget, SafeIoError } from './worktrees/fs-safe.ts'
import { snoozedDiscoveries, type WorktreeMapping, type WorktreeSnooze } from './worktrees/sidecar.ts'
import type { DeletedWorktreeOptions } from './registry.ts'
import { WorkspaceWatchSet, type WatchTargets } from './worktrees/watch.ts'
import type {
  PromptCandidateSnapshot,
  PromptExpected,
  PromptPrimarySnapshot,
  RepoSnapshot,
  WorktreePrompt,
  WorktreePromptWaitResult,
} from './worktrees/types.ts'

import { WorktreeError } from './worktrees/errors.ts'

export { WorktreeError }

/** The row's configuration. */
export interface Config {
  /** The live suggestion switch (also exposed through Settings). */
  readonly enabled?: boolean
  /** Long-poll budget; defaults to the ADR's 20s. */
  readonly waitTimeoutMs?: number
  /** Watcher debounce; defaults to the ADR's 150ms. */
  readonly debounceMs?: number
  /** Per-workspace admin watcher cap; defaults to the ADR's 128. */
  readonly maxAdminWatchers?: number
}

/** The schemastery face of {@link Config}. */
export const Config = z.object({
  enabled: volatileField(z.boolean().default(false)),
  waitTimeoutMs: z.number().default(20_000),
  debounceMs: z.number().default(150),
  maxAdminWatchers: z.number().default(128),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootWorktrees: MultiRootWorktrees
  }
}

/** Either kind of suggestion the queue can hold. */
type SuggestionCandidate = InventoryCandidate | CommonCandidate

/** One queued prompt: the candidate, its owner expectation, and its stable id. */
interface CandidateRecord {
  readonly candidate: SuggestionCandidate
  readonly expected: PromptExpected
  readonly promptId: string
  readonly discoveryKey: string
}

/** One long-poll waiter. */
interface Waiter {
  readonly sessionId: string
  readonly seenViewRevision: string | undefined
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (result: WorktreePromptWaitResult) => void
  readonly reject: (error: unknown) => void
}

/** Everything this Host knows about one primary root. */
interface WorkspaceState {
  readonly key: string
  readonly primaryRoot: string
  activation: 'unactivated' | 'active' | 'lost'
  activationDetail?: string | undefined
  activationGeneration: number
  readonly observedMissing: Set<string>
  repo?: RepoSnapshot | undefined
  /** Every proven B candidate, including filtered ones (watchers need them). */
  inventory: readonly InventoryCandidate[]
  candidates: Map<string, CandidateRecord>
  queue: CandidateRecord[]
  /** Candidate keys that were already evaluated for this activation. */
  evaluated: Set<string>
  /** Discovery keys the operator handled or explicitly ignored. */
  prompted: Set<string>
  /**
   * Discovery keys the operator was already SHOWN during this Host lifetime.
   * Host memory only: it never persists, never authorizes, and clearing it
   * (reset, a Host restart, the switch going off) only means the next
   * automatic check may announce the candidate again (ADR-0039 §6.2).
   */
  offered: Set<string>
  /** Discovery keys this workspace ignores (memory projection of the sidecar). */
  ignored: Set<string>
  /** The stored reminder delay (memory projection of the sidecar, §6.4). */
  snooze?: WorktreeSnooze | undefined
  /**
   * Fingerprints of expired reminder records whose claims were already
   * released. The sidecar deliberately keeps an expired record, so every
   * later explicit read observes the SAME record again; releasing twice would
   * delete claims the operator made after the renewed notice (PR #55 review).
   * Host memory only, like `offered` itself.
   */
  snoozeExpired: Set<string>
  /**
   * True while the workspace was activated by a READ-ONLY check only: no
   * watchers were installed and no owner-side reconciliation was scheduled.
   * Explicit requests (the Dialog, panel list, reset) promote it once.
   */
  passive: boolean
  /** B roots this feature currently tracks (sidecar mapping projection). */
  mappings: readonly WorktreeMapping[]
  /** Whether the read sidecar could be loaded; false keeps the mappings unknown. */
  sidecarAvailable: boolean
  /** Coalesced owner-sidecar reconciliation. */
  sidecarPending: boolean
  sidecarRunning?: Promise<void> | undefined
  waiters: Set<Waiter>
  watchers?: WorkspaceWatchSet | undefined
  degraded: boolean
  revision: number
  reconciling?: Promise<void> | undefined
  pendingReconcile: boolean
}

/** The live session facts a prompt request is filtered by. */
interface SessionView {
  readonly sessionId: string
  readonly primaryRoot: string
  readonly mode: WorkspaceMode
}

/** The service: `ctx.multiRootWorktrees`. */
export class MultiRootWorktrees extends Service {
  static Config = Config
  static provide = 'multiRootWorktrees'
  static inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'multiRootScope']

  private readonly config: Config
  private readonly waitTimeoutMs: number
  private readonly debounceMs: number
  private readonly maxAdminWatchers: number
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly ignored = new Map<string, Set<string>>()
  private settingsRead: (() => unknown) | undefined
  private revision = 0
  private closing = false

  /**
   * @param ctx - the host context.
   * @param config - the row config (switch, timeouts, watcher cap).
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'multiRootWorktrees')
    this.config = config
    // The ADR bounds the long poll at 20s; a larger configured value is clamped.
    this.waitTimeoutMs = clamp(config.waitTimeoutMs, 10, 20_000, 20_000)
    this.debounceMs = clamp(config.debounceMs, 0, 5000, 150)
    this.maxAdminWatchers = clamp(config.maxAdminWatchers, 1, 1024, 128)
  }

  /**
   * Whether the live switch allows any discovery or confirmation. Experimental
   * and off by default (ADR-0039 §9): only an explicit `true` — the persisted
   * setting or the loader row — enables it. A missing settings service means
   * off, never an implicit opt-in.
   */
  get enabled(): boolean {
    if (this.closing) return false
    return configValue(this.settingsRead?.() ?? this.config.enabled) === true
  }

  /** A monotonic generation for diagnostics and settings invalidation. */
  get generation(): number { return this.revision }

  /** Install the live settings seam and the registry change hook. */
  protected async [Service.init](): Promise<void> {
    const owner = this, ctx = this.ctx
    await ctx.effect(async function* () {
      const settings = installWorktreeSettings(ctx, () => owner.config.enabled, () => owner.invalidate())
      owner.settingsRead = settings.read
      yield settings.fiber.dispose
      yield ctx.multiRootRegistry.onChange(key => { owner.registryChanged(key) })
      ctx.multiRootRegistry.setWorktreeGateProvider(() => owner.enabled)
      yield () => {
        ctx.multiRootRegistry.setWorktreeGateProvider(undefined)
        owner.disposeAll(true)
      }
    }, 'multi-root worktrees: ordered owner')
  }

  /**
   * Re-evaluate one session's prompt view once (no long poll).
   *
   * `fresh: true` is the ONE automatic check of the second revision of the
   * trigger model (ADR-0039 第二十次修订): it answers only the candidates the
   * operator has NOT already been shown and no active snooze covers, and it
   * writes NOTHING — no offered claim, no sidecar, no Registry — so a duplicate
   * mount (React StrictMode, a reconnect) is idempotent. `fresh: false` (the
   * default) answers the complete visible list the confirmation Dialog renders.
   */
  async prompt(
    sessionId: string,
    options: { readonly fresh?: boolean } = {},
  ): Promise<{ readonly prompts: readonly WorktreePrompt[]; readonly viewRevision: string }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    // `'first'` — never `'explicit'`: an automatic check must not revive a
    // `lost` workspace. Only the panel/command list or an explicit reset may
    // re-detect it (ADR-0039 §4.4).
    // A fresh query is the ONE automatic check and therefore stays passive:
    // it reads metadata and the sidecar without installing watchers or
    // scheduling owner-side reconciliation (ADR-0039 §20.4).
    const passive = options.fresh === true
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'first', passive)
    await this.revalidate(workspace, passive)
    this.requireGeneration(generation)
    const records = options.fresh === true
      ? this.freshRecords(workspace, session.mode)
      : this.visibleRecords(workspace, session.mode)
    return {
      prompts: records.map(record => this.promptView(workspace, record, session.mode)),
      viewRevision: this.viewRevision(workspace, session.mode),
    }
  }

  /**
   * Claim that the operator was SHOWN these candidates. Host memory only: the
   * discovery keys join `offered` so the next automatic check stays quiet, and
   * nothing is written to the sidecar or the Registry (ADR-0039 §6.2).
   *
   * Ids that no longer name a visible record are silently ignored — a stale
   * Toast must never keep a candidate quiet that the operator cannot act on.
   * @param sessionId - the live session whose overlay showed the notice.
   * @param promptIds - the prompt ids the notice listed.
   * @returns how many ids were claimed.
   */
  async seen(sessionId: string, promptIds: readonly string[]): Promise<{ readonly seen: number }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'none')
    this.requireGeneration(generation)
    if (workspace.activation !== 'active') return { seen: 0 }
    const byId = new Map<string, CandidateRecord>()
    for (const record of workspace.queue) byId.set(record.promptId, record)
    let seen = 0
    for (const id of new Set(promptIds)) {
      const record = byId.get(id)
      if (record === undefined) continue
      if (!eligible(record.candidate.kind, session.mode)) continue
      if (workspace.candidates.get(record.candidate.key) !== record) continue
      workspace.offered.add(record.discoveryKey)
      seen++
    }
    return { seen }
  }

  /**
   * Long-poll one session's visible candidates.
   *
   * The result is a discriminated union: `prompt` (one candidate) /
   * `prompts` (several) / `timeout` / `unactivated` / `lost` / `stale`. No
   * branch carries a retry hint — `unactivated` and `lost` mean "stop",
   * `timeout` means "mount again".
   */
  async wait(
    sessionId: string,
    seen: { readonly seenViewRevision?: string | undefined } = {},
    signal?: AbortSignal,
  ): Promise<WorktreePromptWaitResult> {
    this.requireEnabled()
    signal?.throwIfAborted()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'first')
    // Every mount/timeout re-verifies the complete primary judgment before it
    // trusts the cached activation (ADR-0039 §4.4).
    await this.revalidate(workspace)
    this.requireGeneration(generation)
    signal?.throwIfAborted()
    const immediate = this.resultFor(workspace, session.mode, seen)
    if (immediate !== undefined) return immediate
    return await this.awaitPrompt(workspace, session, seen, signal)
  }

  /** Clear every prompt decision of one workspace and re-inventory it. */
  async reset(sessionId: string): Promise<{ readonly cleared: boolean }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'explicit')
    this.requireGeneration(generation)
    workspace.candidates.clear()
    workspace.queue = []
    workspace.evaluated.clear()
    workspace.prompted.clear()
    // The explicit reset also forgets what this Host already announced and the
    // reminder delay: "reset" means the operator wants to be asked again, and
    // the owner clears the persisted snooze in the same sidecar operation.
    workspace.offered.clear()
    workspace.snooze = undefined
    this.ignored.delete(workspace.key)
    workspace.ignored.clear()
    // An inactive workspace has no sidecar writes (ADR-0039 §4.4). The
    // in-memory decisions are still cleared so a later explicit activation
    // starts clean; the persisted ignores stay untouched.
    if (workspace.activation === 'active') {
      try {
        await this.ctx.multiRootRegistry.worktreeSidecar(workspace.primaryRoot, { op: 'reset' }, this.workspaceGuard(workspace))
      } catch {
        // Memory-only is a supported degradation.
      }
      workspace.revision++
      // A reset is an explicit request but needs no watchers: keep the
      // workspace's current posture instead of promoting it.
      await this.refreshInventory(workspace, workspace.passive)
    } else {
      workspace.revision++
    }
    this.requireGeneration(generation)
    this.wake(workspace)
    return { cleared: workspace.activation === 'active' }
  }

  /**
   * Confirm, dismiss or snooze one or more visible prompts.
   *
   * The batch is deliberately NOT a new write primitive: every row still calls
   * `addNew` with its own captured expectation, so the OWNER re-runs the
   * complete primary/candidate judgment per row and refuses a stale snapshot.
   * `dismiss` writes nothing to the Registry; with `dontRemind` it records the
   * workspace-wide discovery ignore in the owner's sidecar. `snooze` records a
   * reminder delay in the same sidecar and never touches the Registry — the
   * candidate stays in the queue so the operator can still add it from the
   * Dialog (ADR-0039 §6.3). Only ids and a mode travel from the browser: the
   * discovery keys are derived HERE from the queue records.
   *
   * A row that became stale is reported in `skipped` and the remaining rows
   * continue. Authority/storage failures (and the switch turning off) stop the
   * batch and throw: a partial registration set is still visible to the next
   * wait, but is never disguised as a successful full batch.
   */
  async resolve(
    sessionId: string,
    promptIds: string | readonly string[],
    action: 'add' | 'dismiss' | 'snooze',
    options: { readonly dontRemind?: boolean; readonly snooze?: WorktreeSnoozeChoice } = {},
  ): Promise<{
    readonly viewRevision: string
    readonly prompts: readonly WorktreePrompt[]
    readonly resolved: readonly { id: string; key: string; path: string; rootId?: string }[]
    readonly skipped: readonly { id: string; key?: string; path?: string; code: string }[]
  }> {
    this.requireEnabled()
    const ids = [...new Set(typeof promptIds === 'string' ? [promptIds] : promptIds)]
    if (ids.length === 0 || ids.length > 64) throw new WorktreeError('worktree/prompt-stale', 'no prompt was selected')
    const snooze = action === 'snooze' ? options.snooze : undefined
    if (action === 'snooze' && snooze === undefined) {
      throw new WorktreeError('worktree/bad-request', 'a snooze action requires a reminder mode')
    }
    if (action !== 'snooze' && snooze !== undefined) {
      throw new WorktreeError('worktree/bad-request', 'a reminder mode only belongs to the snooze action')
    }
    const dontRemind = action === 'dismiss' ? options.dontRemind : undefined
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'none')
    this.requireGeneration(generation)
    if (workspace.activation !== 'active') {
      throw new WorktreeError('worktree/prompt-stale', 'the workspace is no longer active')
    }
    const guard = this.workspaceGuard(workspace)
    // A guard for the one batch-level write (the snooze record) that is not
    // bound to a single row: the workspace activation and the live session's
    // primary root must still be the ones this batch started with.
    const batchGuard = () => {
      guard()
      if (primaryKey(this.sessionView(sessionId).primaryRoot) !== workspace.key) {
        throw new WorktreeError('worktree/prompt-stale', 'the live session or its prompt changed')
      }
    }
    const byId = new Map<string, CandidateRecord>()
    for (const record of workspace.queue) byId.set(record.promptId, record)
    const resolved: { id: string; key: string; path: string; rootId?: string }[] = []
    const skipped: { id: string; key?: string; path?: string; code: string }[] = []
    // The discovery keys of the rows this batch will actually snooze. Derived
    // from the queue records, never from the browser (ADR-0039 §6.3).
    const snoozedKeys: string[] = []
    for (const id of ids) {
      if (this.generation !== generation || workspace.activation !== 'active') {
        skipped.push({ id, code: 'worktree/prompt-stale' })
        continue
      }
      const record = byId.get(id)
      if (record === undefined) {
        skipped.push({ id, code: 'worktree/prompt-stale' })
        continue
      }
      const live = this.trySessionView(sessionId)
      if (live === undefined || !eligible(record.candidate.kind, live.mode)
        || workspace.candidates.get(record.candidate.key) !== record) {
        skipped.push({ id, key: record.candidate.key, path: record.candidate.path, code: 'worktree/prompt-stale' })
        continue
      }
      const beforeSubmit = () => {
        guard()
        const current = this.sessionView(sessionId)
        if (primaryKey(current.primaryRoot) !== workspace.key || !eligible(record.candidate.kind, current.mode)
          || workspace.candidates.get(record.candidate.key) !== record) {
          throw new WorktreeError('worktree/prompt-stale', 'the live session or its prompt changed')
        }
        const verdict = verifyPromptExpected(current.primaryRoot, record.expected)
        if (!verdict.ok) throw new WorktreeError('worktree/prompt-stale', verdict.detail)
      }
      try {
        if (action === 'add') {
          const added = await this.ctx.multiRootRegistry.addNew(workspace.primaryRoot, {
            path: record.candidate.path,
            access: 'inherit',
            expected: record.expected,
            // A roots carry no cleanup mapping: they are ordinary
            // registrations with the ordinary Remove lifecycle (ADR-0039 §1 / §6).
            ...(record.candidate.kind === 'worktree'
              ? { track: { adminId: record.candidate.adminId, common: record.candidate.common } }
              : {}),
          }, beforeSubmit)
          resolved.push({ id, key: record.candidate.key, path: record.candidate.path, rootId: added.id })
        } else if (action === 'snooze') {
          // Everything is re-verified before the delay is recorded; the write
          // itself happens once for the whole batch, below.
          beforeSubmit()
          snoozedKeys.push(record.discoveryKey)
          resolved.push({ id, key: record.candidate.key, path: record.candidate.path })
        } else {
          beforeSubmit()
          if (dontRemind === true) await this.ignoreRecord(workspace, record, beforeSubmit)
          resolved.push({ id, key: record.candidate.key, path: record.candidate.path })
        }
      } catch (error) {
        if (isFatalWorktreeFailure(error)) throw error
        if (error instanceof RootValidationError && error.code === 'duplicate') {
          // Already registered by the operator or another Host: treat the row
          // as handled, but never write a cleanup map for a duplicate.
          resolved.push({ id, key: record.candidate.key, path: record.candidate.path })
        } else if (error instanceof WorktreeError || error instanceof RootValidationError) {
          skipped.push({ id, key: record.candidate.key, path: record.candidate.path, code: error.code })
          continue
        } else {
          throw error
        }
      }
      // A snooze is NOT a handled candidate: it stays queued and confirmable
      // from the Dialog, and it never joins `prompted` (ADR-0039 §6.3).
      if (action === 'snooze') continue
      workspace.prompted.add(record.discoveryKey)
      if (workspace.candidates.get(record.candidate.key) === record) workspace.candidates.delete(record.candidate.key)
      workspace.queue = workspace.queue.filter(candidate => candidate.promptId !== id)
    }
    if (action === 'snooze' && snoozedKeys.length > 0 && snooze !== undefined && workspace.activation === 'active'
      && this.generation === generation) {
      await this.snoozeRecords(workspace, snoozedKeys, snooze, batchGuard)
    }
    // A skipped row may have been replaced while the batch ran; re-inventory so
    // the response carries the CURRENT ids instead of one the owner will keep
    // refusing.
    if (skipped.length > 0 && workspace.activation === 'active' && this.generation === generation) {
      try { await this.refreshInventory(workspace, workspace.passive) } catch { /* The waiter still re-syncs on the next request. */ }
    }
    if (workspace.activation === 'active') {
      workspace.revision++
      await this.loadSidecar(workspace)
    }
    this.wake(workspace)
    const mode = this.trySessionView(sessionId)?.mode ?? session.mode
    return {
      viewRevision: this.viewRevision(workspace, mode),
      prompts: this.promptViews(workspace, mode),
      resolved,
      skipped,
    }
  }

  /**
   * Record one reminder delay through the Registry owner. The delay takes
   * effect in memory FIRST: a sidecar that cannot be written degrades exactly
   * like an ignored candidate does — the notice closes, and only the next Host
   * restart forgets the delay (ADR-0039 §6.3 / §9).
   * @param workspace - the workspace the notice belongs to.
   * @param keys - discovery keys the host derived from the confirmed ids.
   * @param choice - the browser's mode; the host clock derives the instant.
   * @param beforeSubmit - the owner-queue guard.
   */
  private async snoozeRecords(
    workspace: WorkspaceState,
    keys: readonly string[],
    choice: WorktreeSnoozeChoice,
    beforeSubmit: () => void,
  ): Promise<void> {
    const at = Date.now()
    const record: WorktreeSnooze = choice.mode === 'until-new-worktree'
      ? { mode: 'until-new-worktree', keys: [...keys], at: new Date(at).toISOString() }
      : {
          mode: 'until',
          // The HOST clock decides: the browser's clock is not trusted for a
          // persistence decision (ADR-0039 §6.4).
          until: new Date(at + (choice.mode === '7d' ? 7 : 30) * 86_400_000).toISOString(),
          keys: [...keys],
          at: new Date(at).toISOString(),
        }
    workspace.snooze = record
    try {
      const view = await this.ctx.multiRootRegistry.worktreeSidecar(workspace.primaryRoot, { op: 'snooze', snooze: record }, beforeSubmit)
      if (view.available) this.adoptSnooze(workspace, view.snooze ?? record)
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      // Memory-only is a supported degradation; discovery still honors it.
    }
  }

  /** Record one discovery ignore through the Registry owner and update memory. */
  private async ignoreRecord(workspace: WorkspaceState, record: CandidateRecord, beforeSubmit: () => void): Promise<void> {
    workspace.ignored.add(record.discoveryKey)
    try {
      await this.ctx.multiRootRegistry.worktreeSidecar(workspace.primaryRoot, {
        op: 'ignore',
        key: record.discoveryKey,
        kind: record.candidate.kind,
        path: record.candidate.path,
      }, beforeSubmit)
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      // Memory-only is a supported degradation; discovery still honors it.
    }
  }

  /**
   * Clean up tracked B roots the panel explicitly selected. Every id must be a
   * sidecar mapping; the Registry owner re-verifies `rootId + path + addedAt`
   * and only deletes a CONFIRMED-missing directory.
   */
  async cleanup(sessionId: string, rootIds: readonly string[]): Promise<{
    readonly removed: readonly string[]
    readonly skipped: readonly { readonly id: string; readonly code: string }[]
  }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'none')
    this.requireGeneration(generation)
    if (workspace.activation !== 'active') throw new WorktreeError('worktree/inactive', 'the workspace is no longer an active checkout')
    const guard = this.workspaceGuard(workspace)
    const beforeSubmit = () => {
      guard()
      if (primaryKey(this.sessionView(sessionId).primaryRoot) !== workspace.key) {
        throw new WorktreeError('worktree/not-eligible', 'the session workspace changed')
      }
    }
    await this.loadSidecar(workspace)
    const removed: string[] = []
    const skipped: Array<{ id: string; code: string }> = []
    for (const id of [...new Set(rootIds)]) {
      const mapping = workspace.mappings.find(candidate => candidate.rootId === id)
      if (mapping === undefined) { skipped.push({ id, code: 'worktree/not-eligible' }); continue }
      const options: DeletedWorktreeOptions = { rootId: id, expectedPath: mapping.path, expectedAddedAt: mapping.rootAddedAt }
      try {
        await this.ctx.multiRootRegistry.removeForDeletedWorktree(workspace.primaryRoot, options, beforeSubmit)
        removed.push(id)
      } catch (error) {
        skipped.push({ id, code: codeOf(error) })
      }
    }
    await this.loadSidecar(workspace)
    workspace.revision++
    this.wake(workspace)
    return { removed, skipped }
  }

  /**
   * The worktree badge facts for one primary root's registered roots. This is
   * the one read that may trigger a first activation (the panel's list is an
   * explicit request); while the feature is disabled it answers nothing.
   * @param primaryRoot - the session workspace root.
   */
  async describeRoots(primaryRoot: string, explicit = true): Promise<{
    readonly badges: ReadonlyMap<string, WorktreeRootView>
    readonly cleanupCount: number
  } | undefined> {
    if (!this.enabled) return undefined
    const generation = this.generation
    const workspace = await this.ensureWorkspace(primaryRoot, explicit ? 'explicit' : 'none')
    if (workspace.activation !== 'active') return undefined
    const activation = workspace.activationGeneration
    if (explicit) await this.revalidate(workspace)
    if (!this.current(workspace, generation, activation)) return undefined
    await this.loadSidecar(workspace)
    if (!this.current(workspace, generation, activation)) return undefined
    const badges = this.observeTrackedRoots(workspace)
    const cleanupCount = [...badges.values()].filter(badge => badge.cleanupEligible).length
    return { badges, cleanupCount }
  }

  /** Remember deletion already observed for this registration during this Host lifetime. */
  private observeTrackedRoots(workspace: WorkspaceState): Map<string, WorktreeRootView> {
    const statuses = this.ctx.multiRootRegistry.list(workspace.primaryRoot)
    const badges = new Map<string, WorktreeRootView>()
    const identities = new Set<string>()
    for (const mapping of workspace.mappings) {
      const identity = `${mapping.rootId}\u0000${mapping.rootAddedAt}`
      identities.add(identity)
      const status = statuses.find(candidate => candidate.id === mapping.rootId)
      if (status === undefined || !samePath(status.path, mapping.path)) continue
      const badge = worktreeBadge(mapping, status, workspace.observedMissing.has(identity))
      if (badge.cleanupEligible) workspace.observedMissing.add(identity)
      badges.set(status.id, badge)
    }
    if (workspace.sidecarAvailable && this.ctx.multiRootRegistry.available) {
      for (const identity of workspace.observedMissing) {
        if (!identities.has(identity)) workspace.observedMissing.delete(identity)
      }
    }
    return badges
  }

  /** The active workspace state for diagnostics and tests. */
  activationOf(primaryRoot: string): { readonly activation: string; readonly detail?: string; readonly candidates: number; readonly degraded: boolean; readonly watching: boolean } {
    const workspace = this.workspaces.get(primaryKey(primaryRoot))
    if (workspace === undefined) return { activation: 'unactivated', candidates: 0, degraded: false, watching: false }
    return {
      activation: workspace.activation,
      ...(workspace.activationDetail === undefined ? {} : { detail: workspace.activationDetail }),
      candidates: workspace.queue.length,
      degraded: workspace.degraded,
      watching: workspace.watchers !== undefined,
    }
  }

  /** The session facts one request acts on, or the stable refusal. */
  private sessionView(sessionId: string): SessionView {
    const sessions = this.ctx.get('sessions')
    const session = sessions?.get(sessionId as SessionId)
    const cwd = session?.header?.cwd
    if (session === undefined || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new WorktreeError('worktree/session-not-found', `session "${sessionId}" is not an active host session`)
    }
    const mode = this.ctx.get('sandboxPolicy')?.resolve({ session })?.mode
    if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') {
      throw new WorktreeError('worktree/not-available', 'the live session sandbox mode is unavailable')
    }
    return { sessionId, primaryRoot: cwd, mode }
  }

  /** Throw when the live switch turned the feature off. */
  private requireEnabled(): void {
    if (!this.enabled) throw new WorktreeError('worktree/not-enabled', 'worktree root suggestions are disabled by this workspace configuration')
  }

  private requireGeneration(generation: number): void {
    this.requireEnabled()
    if (this.generation !== generation) throw new WorktreeError('worktree/not-enabled', 'the worktree setting changed during this request')
  }

  private current(workspace: WorkspaceState, generation: number, activation: number): boolean {
    return this.enabled && this.generation === generation && workspace.activation === 'active'
      && workspace.activationGeneration === activation && this.workspaces.get(workspace.key) === workspace
  }

  private workspaceGuard(workspace: WorkspaceState): () => void {
    const generation = this.generation, activation = workspace.activationGeneration
    return () => {
      this.requireGeneration(generation)
      if (!this.current(workspace, generation, activation)) {
        throw new WorktreeError('worktree/prompt-stale', 'the workspace activation changed')
      }
    }
  }

  /**
   * Load or create the workspace state.
   * @param primaryRoot - the session workspace root.
   * @param detect - how much this request may (re)detect the workspace.
   * @param passive - true for the read-only automatic check: a first
   *   activation then installs no watchers and schedules no reconciliation.
   */
  private async ensureWorkspace(primaryRoot: string, detect: 'none' | 'first' | 'explicit', passive = false): Promise<WorkspaceState> {
    const key = primaryKey(primaryRoot)
    let workspace = this.workspaces.get(key)
    if (workspace === undefined) {
      workspace = {
        key,
        primaryRoot,
        activation: 'unactivated',
        activationGeneration: 0,
        observedMissing: new Set(),
        inventory: [],
        candidates: new Map(),
        queue: [],
        evaluated: new Set(),
        prompted: new Set(),
        offered: new Set(),
        ignored: this.ignored.get(key) ?? new Set(),
        snoozeExpired: new Set(),
        passive: true,
        mappings: [],
        sidecarAvailable: false,
        sidecarPending: false,
        waiters: new Set(),
        degraded: false,
        revision: 0,
        pendingReconcile: false,
      }
      this.workspaces.set(key, workspace)
    }
    // Only an explicit request may try a first activation again; background
    // reconciliation never resurrects an `unactivated` or `lost` workspace.
    if (this.enabled && ((detect !== 'none' && workspace.activation === 'unactivated')
      || (detect === 'explicit' && workspace.activation === 'lost'))) await this.activate(workspace, passive)
    return workspace
  }

  /**
   * Run the full primary snapshot and (re)build state.
   * @param workspace - the workspace to (re)activate.
   * @param passive - true for the automatic read-only check: the sidecar is
   *   only READ and inventory runs without installing watchers. Persistent
   *   discovery starts with the first explicit request (ADR-0039 §20.4).
   */
  private async activate(workspace: WorkspaceState, passive = false): Promise<void> {
    const result = resolveRepo(workspace.primaryRoot)
    if (!result.ok) {
      this.transitionInactive(workspace, `${result.reason}: ${result.detail}`)
      return
    }
    const previousCommon = workspace.repo?.common
    const wasActive = workspace.activation === 'active'
    workspace.activation = 'active'
    workspace.passive = passive
    const generation = this.generation, activation = ++workspace.activationGeneration
    workspace.repo = result.repo
    delete workspace.activationDetail
    if (!wasActive || previousCommon !== result.repo.common) {
      // A new activation generation invalidates the transient queue and every
      // prompt id; explicit ignore decisions stay.
      workspace.queue = []
      workspace.candidates.clear()
      workspace.evaluated.clear()
      workspace.revision++
    }
    // A read-backed load only: the automatic check must never write the
    // sidecar (ADR-0039 §20.4).
    await this.loadSidecar(workspace)
    if (!this.current(workspace, generation, activation)) return
    // A new owner generation must rebind/prune its mappings only after an
    // explicit workspace activation (ADR-0039 §6.8).
    if (!passive) this.reconcileSidecar(workspace)
    await this.refreshInventory(workspace, passive)
    this.wake(workspace)
  }

  /**
   * Re-run the complete primary snapshot for an already active workspace.
   * A failure means the workspace WAS active and is now `lost`; the quiet
   * state releases every watcher and waiter and never schedules a retry.
   * @param workspace - the active workspace.
   * @param passive - true for the automatic read-only check: no watcher
   *   churn and no owner-side reconciliation.
   */
  private async revalidate(workspace: WorkspaceState, passive = false): Promise<void> {
    if (workspace.activation !== 'active' || this.closing) return
    const result = resolveRepo(workspace.primaryRoot)
    if (!result.ok) {
      this.transitionInactive(workspace, `${result.reason}: ${result.detail}`)
      return
    }
    const commonChanged = workspace.repo?.common !== result.repo.common
    workspace.repo = result.repo
    if (commonChanged) {
      workspace.queue = []
      workspace.candidates.clear()
      workspace.evaluated.clear()
      workspace.revision++
    }
    // The first explicit request promotes a read-only workspace to persistent
    // discovery: its mappings are reconciled and its watchers installed once.
    if (!passive && workspace.passive) {
      workspace.passive = false
      this.reconcileSidecar(workspace)
    }
    await this.refreshInventory(workspace, passive)
  }

  /** Move the workspace to its quiet state, release resources and wake waiters. */
  private transitionInactive(workspace: WorkspaceState, detail: string): void {
    // A workspace that was ever active stays `lost` across later failed
    // re-detections: downgrading it to `unactivated` would lose the fact that
    // the operator already saw prompts here.
    workspace.activation = workspace.activation === 'unactivated' ? 'unactivated' : 'lost'
    workspace.activationDetail = detail
    workspace.activationGeneration++
    workspace.repo = undefined
    workspace.inventory = []
    workspace.candidates.clear()
    workspace.queue = []
    workspace.evaluated.clear()
    workspace.watchers?.close()
    workspace.watchers = undefined
    workspace.degraded = false
    workspace.revision++
    this.wake(workspace)
  }

  /**
   * Re-run inventory, filters and watchers for an active workspace.
   * @param workspace - the active workspace.
   * @param passive - true to rebuild the candidate queue WITHOUT closing or
   *   installing watchers and without touching cleanup bookkeeping; the
   *   automatic fresh check must stay a read (ADR-0039 §20.4).
   */
  private async refreshInventory(workspace: WorkspaceState, passive = false): Promise<void> {
    const repo = workspace.repo
    if (repo === undefined || workspace.activation !== 'active' || this.closing || !this.enabled) return
    const inventory = inventoryWorktrees(repo.common, process.platform)
    const generation = this.generation, activation = workspace.activationGeneration
    const next = new Map<string, CandidateRecord>()
    const added: CandidateRecord[] = []
    let replaced = false
    // A candidates share the queue and dedupe set with B; visibility is
    // filtered per session mode when the queue is read.
    const common = commonCandidate(repo)
    const suggestions: SuggestionCandidate[] = common === undefined ? [...inventory.candidates] : [...inventory.candidates, common]
    for (const candidate of suggestions) {
      const discoveryKey = discoveryKeyFor(candidate)
      if (workspace.ignored.has(discoveryKey) || workspace.prompted.has(discoveryKey)) continue
      const probe = await this.probeAdd(workspace.primaryRoot, candidate.path)
      if (!this.current(workspace, generation, activation) || workspace.repo !== repo) return
      if (!probe.ok) {
        workspace.evaluated.add(candidate.key)
        continue
      }
      const expected = expectedFor(workspace, candidate)
      const previous = workspace.candidates.get(candidate.key)
      // The candidate KEY is stable across an admin HEAD change or a same-path
      // rebuild; the prompt ID must not be. Reusing the whole record would hand
      // the operator an ID whose owner expectation can never be confirmed.
      const unchanged = previous !== undefined && isDeepStrictEqual(previous.expected, expected)
      const record: CandidateRecord = unchanged
        ? previous
        : { candidate, expected, promptId: randomUUID(), discoveryKey }
      if (!unchanged) {
        if (previous === undefined) added.push(record)
        else replaced = true
      }
      next.set(candidate.key, record)
    }
    const changed = replaced || next.size !== workspace.queue.length || [...next.keys()].some(key => !workspace.candidates.has(key))
    const ordered = workspace.queue.filter(record => next.has(record.candidate.key))
      .map(record => next.get(record.candidate.key)!)
    workspace.inventory = inventory.candidates
    workspace.degraded = inventory.degraded || (!passive && inventory.candidates.length > this.maxAdminWatchers)
    workspace.candidates = next
    workspace.queue = [...ordered, ...added]
    if (!passive) {
      workspace.passive = false
      this.observeTrackedRoots(workspace)
      workspace.watchers?.close()
      workspace.watchers = this.createWatchers(workspace)
      if (workspace.watchers?.degraded === true) workspace.degraded = true
    }
    if (changed) workspace.revision++
    this.wake(workspace)
  }

  /** Ask the Registry whether a candidate could be registered at all (advisory). */
  private async probeAdd(primaryRoot: string, path: string): Promise<{ readonly ok: boolean }> {
    try {
      return await this.ctx.multiRootRegistry.probeAdd(primaryRoot, path)
    } catch {
      // An unavailable registry can never grant; the candidate stays out.
      return { ok: false }
    }
  }

  /** Build (or rebuild) the watcher set for one active workspace. */
  private createWatchers(workspace: WorkspaceState): WorkspaceWatchSet | undefined {
    const repo = workspace.repo
    if (repo === undefined) return undefined
    const ancestors: string[] = []
    let current = dirname(repo.canonical)
    for (let depth = 0; depth < 64; depth++) {
      try {
        const entry = lstatOrUndefined(join(current, '.git'))
        if (entry !== undefined) ancestors.push(current, join(current, '.git'))
      } catch {
        // Best effort only: an unreadable ancestor just means no event there.
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    const parents: Array<{ directory: string; name: string }> = []
    for (const candidate of workspace.inventory) {
      parents.push({ directory: dirname(candidate.path), name: basename(candidate.path) })
    }
    for (const path of this.trackedRootPaths(workspace)) {
      parents.push({ directory: dirname(path), name: basename(path) })
    }
    const targets: WatchTargets = {
      common: repo.common,
      worktrees: join(repo.common, 'worktrees'),
      admins: workspace.inventory.map(candidate => candidate.adminGitdir),
      primaryRoot: repo.canonical,
      primaryGit: join(repo.canonical, '.git'),
      ancestors,
      parents,
    }
    return new WorkspaceWatchSet(targets, () => { this.reconcile(workspace) }, {
      debounceMs: this.debounceMs,
      maxAdmins: this.maxAdminWatchers,
    })
  }

  /** B roots this workspace tracks for deletion watching. */
  private trackedRootPaths(workspace: WorkspaceState): readonly string[] {
    return workspace.mappings.map(mapping => mapping.path)
  }

  /**
   * Load the workspace's sidecar through the Registry owner. An unavailable
   * authority keeps the previous projection: an empty answer is NOT evidence
   * that the mappings are gone.
   */
  private async loadSidecar(workspace: WorkspaceState): Promise<void> {
    try {
      const view = await this.ctx.multiRootRegistry.worktreeSidecar(workspace.primaryRoot, { op: 'read' })
      if (!view.available) return
      workspace.mappings = view.worktreeRoots
      workspace.ignored = new Set(view.ignored.map(entry => entry.key))
      this.adoptSnooze(workspace, view.snooze)
      workspace.sidecarAvailable = true
    } catch {
      // The mapping is cleanup bookkeeping only; discovery stays usable.
    }
  }

  /** Ask the owner to prune/rebind mappings after a Registry change, coalesced. */
  private reconcileSidecar(workspace: WorkspaceState): void {
    if (workspace.sidecarRunning !== undefined) { workspace.sidecarPending = true; return }
    const beforeSubmit = this.workspaceGuard(workspace)
    workspace.sidecarRunning = (async () => {
      do {
        workspace.sidecarPending = false
        try {
          const view = await this.ctx.multiRootRegistry.worktreeSidecar(workspace.primaryRoot, { op: 'reconcile' }, beforeSubmit)
          beforeSubmit()
          if (view.available) {
            workspace.mappings = view.worktreeRoots
            this.adoptSnooze(workspace, view.snooze)
            workspace.sidecarAvailable = true
          }
        } catch {
          return
        }
      } while (workspace.sidecarPending)
    })().finally(() => {
      workspace.sidecarRunning = undefined
      if (workspace.sidecarPending && this.enabled && workspace.activation === 'active') this.reconcileSidecar(workspace)
    })
  }

  /** Coalesce one reconcile per workspace. */
  private reconcile(workspace: WorkspaceState): void {
    if (this.closing || !this.enabled) return
    if (workspace.activation !== 'active') return
    workspace.pendingReconcile = true
    if (workspace.reconciling !== undefined) return
    const generation = this.generation, activation = workspace.activationGeneration
    workspace.reconciling = (async () => {
      while (workspace.pendingReconcile && this.current(workspace, generation, activation)) {
        workspace.pendingReconcile = false
        try {
          const result = resolveRepo(workspace.primaryRoot)
          if (!result.ok) {
            this.transitionInactive(workspace, `${result.reason}: ${result.detail}`)
            return
          }
          workspace.repo = result.repo
          await this.refreshInventory(workspace, workspace.passive)
        } catch (error) {
          if (this.current(workspace, generation, activation)) {
            this.transitionInactive(workspace, `reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          return
        }
      }
    })().finally(() => {
      workspace.reconciling = undefined
      if (workspace.pendingReconcile) this.reconcile(workspace)
    })
  }

  /** The records a session may see, in queue order. */
  private visibleRecords(workspace: WorkspaceState, mode: WorkspaceMode): readonly CandidateRecord[] {
    if (workspace.activation !== 'active') return []
    return workspace.queue.filter(record => eligible(record.candidate.kind, mode))
  }

  /**
   * The candidates one automatic check may still announce: visible to this
   * session, not already offered to the operator during this Host lifetime,
   * and not covered by an active reminder delay.
   *
   * This is a pure filter — it claims nothing, so two mounts of the same
   * overlay observe the same answer (ADR-0039 §6.1).
   */
  private freshRecords(workspace: WorkspaceState, mode: WorkspaceMode): readonly CandidateRecord[] {
    this.expireSnooze(workspace)
    const suppressed = snoozedDiscoveries(workspace.snooze, Date.now())
    return this.visibleRecords(workspace, mode).filter(record =>
      !workspace.offered.has(record.discoveryKey) && suppressed?.has(record.discoveryKey) !== true)
  }

  /**
   * A timed reminder that has run out gives its candidates back.
   *
   * The notice claims its ids (`seen`) BEFORE the operator picks a delay, so
   * the claim alone would keep them quiet for the rest of this Host lifetime.
   * Once the stored `until` instant passes, the delay is dropped in memory and
   * the keys it covered are released from `offered`, so the next automatic
   * check announces them again. The persisted record is left alone: after a
   * restart the same expiry check applies, and the ADR does not require
   * actively pruning expired records from the sidecar (ADR-0039 §20.7).
   * @param workspace - the workspace whose stored delay is examined.
   */
  private expireSnooze(workspace: WorkspaceState): void {
    const snooze = workspace.snooze
    if (snooze === undefined || snooze.mode !== 'until') return
    const until = Date.parse(snooze.until ?? '')
    if (Number.isFinite(until) && Date.now() < until) return
    workspace.snooze = undefined
    this.releaseSnoozeOnce(workspace, snooze)
  }

  /**
   * Adopt the reminder-delay projection the owner reported.
   *
   * An expired timed record is dropped HERE and its discovery claims released
   * (at most once per record), exactly like the in-memory expiry path: an
   * explicit request (the panel list, a confirmation, cleanup) may read the
   * sidecar between the expiry instant and the next automatic check, and
   * dropping the record without the release would leave `offered` hiding the
   * candidates with no record left for `expireSnooze` to expire (PR #55
   * review). A record that was already processed stays processed: the sidecar
   * keeps it, so a later reload must not release a claim the operator made
   * after the renewed notice.
   * @param workspace - the workspace the projection belongs to.
   * @param persisted - the record the owner reported, if any.
   */
  private adoptSnooze(workspace: WorkspaceState, persisted: WorktreeSnooze | undefined): void {
    const live = liveSnooze(persisted)
    if (persisted !== undefined && live === undefined) this.releaseSnoozeOnce(workspace, persisted)
    workspace.snooze = live
  }

  /**
   * Release the claims of one expired record at most once.
   *
   * The persisted record is not cleared (automatic paths never write the
   * sidecar), so the same expired projection is read back by every later
   * panel/confirmation load. Only the FIRST observation releases; repeating
   * it would delete the acknowledgement the renewed notice received.
   * The fingerprint covers every persisted field, so a genuinely new delay
   * (a new write has a new `at`) is processed on its own.
   * @param workspace - the workspace whose claims are released.
   * @param snooze - the expired record that was observed.
   */
  private releaseSnoozeOnce(workspace: WorkspaceState, snooze: WorktreeSnooze): void {
    const fingerprint = snoozeFingerprint(snooze)
    if (workspace.snoozeExpired.has(fingerprint)) return
    workspace.snoozeExpired.add(fingerprint)
    this.releaseSnoozeClaims(workspace, snooze)
  }

  /** Release the discovery claims one dropped reminder delay covered. */
  private releaseSnoozeClaims(workspace: WorkspaceState, snooze: WorktreeSnooze): void {
    for (const key of snooze.keys) workspace.offered.delete(key)
  }

  /** Build the wire views for every visible record, in queue order. */
  private promptViews(workspace: WorkspaceState, mode: WorkspaceMode): readonly WorktreePrompt[] {
    return this.visibleRecords(workspace, mode).map(record => this.promptView(workspace, record, mode))
  }

  /** Build the wire prompt view for one visible record. */
  private promptView(workspace: WorkspaceState, record: CandidateRecord, mode: WorkspaceMode): WorktreePrompt {
    const visible = this.visibleRecords(workspace, mode)
    return {
      id: record.promptId,
      key: record.candidate.key,
      kind: record.candidate.kind,
      path: record.candidate.path,
      primaryRoot: workspace.primaryRoot,
      access: 'inherit',
      effectiveAccess: effectiveRootAccess('inherit', mode),
      remaining: visible.length,
      viewRevision: this.viewRevision(workspace, mode),
    }
  }

  /** The stable digest of one session's visible view. */
  private viewRevision(workspace: WorkspaceState, mode: WorkspaceMode): string {
    const visible = this.visibleRecords(workspace, mode)
    const material = JSON.stringify({
      activation: workspace.activation,
      common: workspace.repo?.common ?? '',
      effective: visible.length === 0 ? '' : effectiveRootAccess('inherit', mode),
      // Every id participates: replacing one candidate's expectation must
      // change the digest even when the key set is unchanged, so the client
      // never keeps an id the owner will refuse.
      visible: visible.map(record => ({ id: record.promptId, key: record.candidate.key, kind: record.candidate.kind })),
      prompted: [...workspace.prompted].sort(),
      ignored: [...workspace.ignored].sort(),
    })
    return createHash('sha256').update(material).digest('hex').slice(0, 24)
  }

  /**
   * The result a waiter should receive RIGHT NOW, or `undefined` to keep
   * waiting.
   *
   * `seenViewRevision` is the only "already shown" token: when it matches the
   * current digest nothing is delivered (the dialog stays open); when it
   * differs the whole visible view is delivered — one candidate as `prompt`,
   * several as `prompts`, none as `stale` so the dialog closes.
   */
  private resultFor(
    workspace: WorkspaceState,
    mode: WorkspaceMode,
    seen: { readonly seenViewRevision?: string | undefined },
  ): WorktreePromptWaitResult | undefined {
    const viewRevision = this.viewRevision(workspace, mode)
    if (workspace.activation === 'unactivated') return { status: 'unactivated', viewRevision }
    if (workspace.activation === 'lost') return { status: 'lost', viewRevision }
    const visible = this.visibleRecords(workspace, mode)
    if (seen.seenViewRevision === viewRevision) return undefined
    if (visible.length === 0) {
      // A first mount (no seen revision) simply waits; a view that HAD
      // candidates and now has none closes the dialog.
      return seen.seenViewRevision === undefined ? undefined : { status: 'stale', viewRevision, reason: 'prompt-gone' }
    }
    return visible.length === 1
      ? { status: 'prompt', prompt: this.promptView(workspace, visible[0]!, mode), viewRevision }
      : { status: 'prompts', prompts: visible.map(record => this.promptView(workspace, record, mode)), viewRevision }
  }

  /** Register one waiter and resolve it on the next relevant change or timeout. */
  private async awaitPrompt(
    workspace: WorkspaceState,
    session: SessionView,
    seen: { readonly seenViewRevision?: string | undefined },
    signal?: AbortSignal,
  ): Promise<WorktreePromptWaitResult> {
    return await new Promise<WorktreePromptWaitResult>((resolve, reject) => {
      // Declared before the closures only for typing; callbacks run after the
      // assignment, never during it.
      const waiter: Waiter = {
        sessionId: session.sessionId,
        seenViewRevision: seen.seenViewRevision,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve: () => {},
        reject: () => {},
      }
      const finish = (result: WorktreePromptWaitResult) => {
        clearTimeout(timer)
        workspace.waiters.delete(waiter)
        signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const fail = (error: unknown) => {
        clearTimeout(timer)
        workspace.waiters.delete(waiter)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const abort = () => fail(signal?.reason ?? new WorktreeError('worktree/cancelled', 'worktree prompt wait was cancelled'))
      const timer = setTimeout(() => {
        finish({ status: 'timeout', viewRevision: this.viewRevision(workspace, session.mode) })
      }, this.waitTimeoutMs)
      timer.unref?.()
      Object.assign(waiter, { timer, resolve: finish, reject: fail })
      workspace.waiters.add(waiter)
      if (signal !== undefined) {
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
      }
    })
  }

  /** Wake every waiter of one workspace and answer those whose view changed. */
  private wake(workspace: WorkspaceState): void {
    for (const waiter of [...workspace.waiters]) {
      const session = this.trySessionView(waiter.sessionId)
      if (session === undefined) {
        workspace.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.reject(new WorktreeError('worktree/session-not-found', `session "${waiter.sessionId}" is no longer active`))
        continue
      }
      const result = this.resultFor(workspace, session.mode, waiter)
      if (result === undefined) continue
      workspace.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(result)
    }
  }

  /** A session view that answers `undefined` instead of throwing. */
  private trySessionView(sessionId: string): SessionView | undefined {
    try {
      return this.sessionView(sessionId)
    } catch {
      return undefined
    }
  }

  /** Registry change hook: re-evaluate the affected active workspace only. */
  private registryChanged(key: string): void {
    const workspace = this.workspaces.get(key)
    if (workspace === undefined || workspace.activation !== 'active') return
    this.reconcile(workspace)
    // A read-only (passive) workspace owns no cleanup bookkeeping yet: a
    // registry change must not make the automatic check write the sidecar.
    if (!workspace.passive) this.reconcileSidecar(workspace)
  }

  /** React to a live settings change. */
  private invalidate(): void {
    this.revision++
    if (!this.enabled) {
      this.disposeAll()
      return
    }
    for (const workspace of this.workspaces.values()) {
      if (workspace.activation === 'active') this.reconcile(workspace)
    }
  }

  /**
   * Close every workspace, rejecting waiters. Idempotent.
   * @param permanent - true for the fiber teardown (the switch cannot come back).
   */
  private disposeAll(permanent = false): void {
    this.closing = true
    for (const workspace of this.workspaces.values()) {
      workspace.watchers?.close()
      workspace.watchers = undefined
      for (const waiter of workspace.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new WorktreeError('worktree/not-enabled', 'worktree root suggestions were disabled'))
      }
      workspace.waiters.clear()
      workspace.activationGeneration++
      if (workspace.activation === 'active') workspace.activation = 'unactivated'
      workspace.repo = undefined
      workspace.inventory = []
      workspace.queue = []
      workspace.candidates.clear()
      workspace.evaluated.clear()
      // offered/snooze are UI state of THIS Host: teardown forgets them so a
      // later re-enable starts from what the operator can be asked again.
      workspace.offered.clear()
      workspace.snooze = undefined
      workspace.pendingReconcile = false
      workspace.sidecarPending = false
    }
    if (permanent) this.workspaces.clear()
    else this.closing = false
  }
}

/** Read one `lstat` entry without throwing. */
function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

/**
 * The stored reminder delay as memory uses it: an expired timed record is
 * forgotten instead of being restored by a later sidecar read. The sidecar
 * keeps it (no automatic write), and the expiry check would drop it anyway;
 * reading it back as active would re-claim candidates the operator just saw
 * again (ADR-0039 §20.7).
 * @param snooze - the persisted delay, if any.
 * @returns the still-active record, or undefined once its instant has passed.
 */
function liveSnooze(snooze: WorktreeSnooze | undefined): WorktreeSnooze | undefined {
  if (snooze === undefined || snooze.mode !== 'until') return snooze
  const until = Date.parse(snooze.until ?? '')
  return Number.isFinite(until) && Date.now() >= until ? undefined : snooze
}

/**
 * The stable identity of one persisted reminder record: every field the
 * sidecar stores, with the key set ordered so a reordered read still
 * matches. Two records with this identical identity ARE the same persisted
 * delay for the once-per-record expiry release.
 * @param snooze - one persisted reminder record.
 * @returns a comparable fingerprint.
 */
function snoozeFingerprint(snooze: WorktreeSnooze): string {
  return JSON.stringify([snooze.mode, snooze.until ?? '', snooze.at, [...snooze.keys].sort()])
}

/** Clamp one numeric config value. */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Whether one candidate kind may be shown in one sandbox mode. */
export function eligible(kind: 'worktree' | 'main-checkout', mode: WorkspaceMode): boolean {
  if (mode === 'danger-full-access') return false
  if (kind === 'main-checkout') return mode === 'workspace-write'
  return true
}

/** The discovery key of one candidate; stable across admin moves for B. */
export function discoveryKeyOf(candidate: InventoryCandidate): string {
  return `worktree\u0000${candidate.path}`
}

/** The discovery key of either suggestion kind. */
function discoveryKeyFor(candidate: SuggestionCandidate): string {
  return candidate.kind === 'main-checkout' ? commonDiscoveryKey(candidate) : discoveryKeyOf(candidate)
}

/**
 * Whether a batch failure must stop the whole resolve instead of skipping one
 * row: losing the switch, the authority, storage, or the session mid-batch is
 * not a per-candidate condition.
 */
function isFatalWorktreeFailure(error: unknown): boolean {
  if (error instanceof WorktreeError) {
    return error.code === 'worktree/not-enabled'
      || error.code === 'worktree/not-available'
      || error.code === 'worktree/session-not-found'
      || error.code === 'worktree/registry-unavailable'
  }
  if (error instanceof RootValidationError) {
    return error.code === 'storage-unavailable' || error.code === 'registry-contended' || error.code === 'config-invalid'
  }
  return false
}

function pathState(path: string): 'present' | 'missing' | 'inaccessible' {
  try {
    return lstatEntry(path) === undefined ? 'missing' : 'present'
  } catch (error) {
    return error instanceof SafeIoError && error.reason === 'not-directory' ? 'missing' : 'inaccessible'
  }
}

/** The canonical target of one admin gitdir pointer, or undefined when unreadable. */
function pointerTarget(admin: string): string | undefined {
  try {
    return resolvePointerTarget(admin, readPointerLine(join(admin, 'gitdir')))
  } catch {
    return undefined
  }
}

/**
 * The deletion badge for one tracked mapping (ADR-0039 §6.1). Deletion signals
 * only decide the badge: cleanup is eligible ONLY when the record's own path is
 * confirmed missing AND its `addedAt` still binds the mapping.
 */
function worktreeBadge(mapping: WorktreeMapping, status: { readonly id: string; readonly path: string; readonly addedAt: string }, previouslyMissing: boolean): WorktreeRootView {
  const base = { adminId: mapping.adminId, path: status.path }
  const bound = status.addedAt === mapping.rootAddedAt
  const observed = pathState(status.path)
  if (observed === 'missing') return { ...base, state: 'directory-missing', cleanupEligible: bound }
  if (!bound || previouslyMissing || observed === 'inaccessible') return { ...base, state: 'changed', cleanupEligible: false }
  const admin = join(mapping.common, 'worktrees', mapping.adminId)
  const adminState = pathState(admin)
  if (adminState === 'missing') return { ...base, state: 'unregistered', cleanupEligible: false }
  if (adminState === 'inaccessible') return { ...base, state: 'changed', cleanupEligible: false }
  const target = pointerTarget(admin)
  if (target === undefined) return { ...base, state: 'changed', cleanupEligible: false }
  if (!samePath(dirname(target), status.path)) {
    return { ...base, state: 'moved', cleanupEligible: false }
  }
  return { ...base, state: 'active', cleanupEligible: false }
}

/** The stable code of one thrown failure. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : 'worktree/not-eligible'
}

/** Build the owner expectation one prompt binds. */
function expectedFor(workspace: WorkspaceState, candidate: SuggestionCandidate): PromptExpected {
  const repo = workspace.repo
  if (repo === undefined) throw new Error('cannot build a prompt expectation without a primary snapshot')
  const primary: PromptPrimarySnapshot = {
    shape: repo.shape,
    canonical: repo.canonical,
    common: repo.common,
    ...(repo.adminId === undefined ? {} : { adminId: repo.adminId }),
    ...(repo.adminGitdir === undefined ? {} : { adminGitdir: repo.adminGitdir }),
    ...(repo.adminHead === undefined ? {} : { adminHead: repo.adminHead }),
    rootIdentity: repo.rootIdentity,
    ...(repo.adminIdentity === undefined ? {} : { adminIdentity: repo.adminIdentity }),
  }
  const awaited: PromptCandidateSnapshot = {
    kind: candidate.kind,
    canonical: candidate.path,
    common: candidate.common,
    adminId: candidate.adminId,
    adminGitdir: candidate.adminGitdir,
    adminHead: candidate.adminHead,
    rootIdentity: candidate.rootIdentity,
    adminIdentity: candidate.adminIdentity,
  }
  return { primaryKey: workspace.key, primaryRoot: workspace.primaryRoot, primary, candidate: awaited, promptKey: candidate.key }
}

export default MultiRootWorktrees
