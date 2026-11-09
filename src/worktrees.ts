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
import { effectiveRootAccess, type WorkspaceMode, type WorktreeRootView } from './contract.ts'
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
import type { WorktreeMapping } from './worktrees/sidecar.ts'
import type { AddNewRootOptions, DeletedWorktreeOptions } from './registry.ts'
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
  enabled: volatileField(z.boolean().default(true)),
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
  readonly seenPromptId: string | undefined
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
  /** Discovery keys this workspace ignores (memory projection of the sidecar). */
  ignored: Set<string>
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

  /** Whether the live switch allows any discovery or confirmation. */
  get enabled(): boolean {
    if (this.closing) return false
    return configValue(this.settingsRead?.() ?? this.config.enabled) !== false
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

  /** Re-evaluate one session's prompt view once (no long poll). */
  async prompt(sessionId: string): Promise<{ readonly prompt?: WorktreePrompt; readonly viewRevision: string }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'explicit')
    await this.revalidate(workspace)
    this.requireGeneration(generation)
    const viewRevision = this.viewRevision(workspace, session.mode)
    const head = this.visibleRecords(workspace, session.mode)[0]
    return head === undefined
      ? { viewRevision }
      : { prompt: this.promptView(workspace, head, session.mode), viewRevision }
  }

  /**
   * Long-poll one session's first visible prompt.
   *
   * The result is a discriminated union: `prompt` / `timeout` /
   * `unactivated` / `lost` / `stale`. No branch carries a retry hint —
   * `unactivated` and `lost` mean "stop", `timeout` means "mount again".
   */
  async wait(
    sessionId: string,
    seen: { readonly seenPromptId?: string | undefined; readonly seenViewRevision?: string | undefined } = {},
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
    const immediate = this.resultFor(workspace, session.mode, seen, false)
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
      await this.refreshInventory(workspace)
    } else {
      workspace.revision++
    }
    this.requireGeneration(generation)
    this.wake(workspace)
    return { cleared: workspace.activation === 'active' }
  }

  /**
   * Confirm or dismiss one visible prompt.
   *
   * `add` calls the Registry's `addNew` with the captured expectation: the
   * OWNER re-runs the complete primary/candidate judgment and refuses a stale
   * snapshot. `dismiss` writes nothing to the Registry; with `dontRemind` it
   * records the workspace-wide discovery ignore in the owner's sidecar.
   */
  async resolve(
    sessionId: string,
    promptId: string,
    action: 'add' | 'dismiss',
    dontRemind?: boolean,
  ): Promise<{ readonly viewRevision: string; readonly prompt?: WorktreePrompt }> {
    this.requireEnabled()
    const session = this.sessionView(sessionId)
    const generation = this.generation
    const workspace = await this.ensureWorkspace(session.primaryRoot, 'none')
    this.requireGeneration(generation)
    if (workspace.activation !== 'active') {
      throw new WorktreeError('worktree/prompt-stale', 'the workspace is no longer active')
    }
    const record = [...workspace.candidates.values()].find(candidate => candidate.promptId === promptId)
    if (record === undefined || !eligible(record.candidate.kind, session.mode)) {
      throw new WorktreeError('worktree/prompt-stale', 'the prompt is no longer visible')
    }
    const guard = this.workspaceGuard(workspace)
    const beforeSubmit = () => {
      guard()
      const live = this.sessionView(sessionId)
      if (primaryKey(live.primaryRoot) !== workspace.key || !eligible(record.candidate.kind, live.mode)
        || workspace.candidates.get(record.candidate.key) !== record) {
        throw new WorktreeError('worktree/prompt-stale', 'the live session or its prompt changed')
      }
      const verdict = verifyPromptExpected(live.primaryRoot, record.expected)
      if (!verdict.ok) throw new WorktreeError('worktree/prompt-stale', verdict.detail)
    }
    if (action === 'add') {
      const options: AddNewRootOptions = {
        path: record.candidate.path,
        access: 'inherit',
        expected: record.expected,
        // A roots carry no cleanup mapping: they are ordinary registrations
        // with the ordinary Remove lifecycle (ADR-0039 §1 / §6).
        ...(record.candidate.kind === 'worktree'
          ? { track: { adminId: record.candidate.adminId, common: record.candidate.common } }
          : {}),
      }
      try {
        await this.ctx.multiRootRegistry.addNew(workspace.primaryRoot, options, beforeSubmit)
      } catch (error) {
        // A duplicate means the operator (or another Host) already registered
        // this directory: treat it as handled, but never write a cleanup map.
        if (error instanceof RootValidationError && error.code === 'duplicate') {
          // handled below
        } else if (error instanceof WorktreeError && error.code === 'worktree/not-enabled') {
          throw error
        } else if (error instanceof WorktreeError) {
          throw new WorktreeError('worktree/prompt-stale', error.message)
        } else if (error instanceof RootValidationError) {
          throw new WorktreeError('worktree/prompt-stale', error.message)
        } else {
          throw error
        }
      }
    } else {
      beforeSubmit()
      if (dontRemind === true) await this.ignoreRecord(workspace, record, beforeSubmit)
    }
    // An already-submitted owner operation keeps its result across a toggle,
    // but must not republish or remove a prompt from a later activation.
    if (this.generation !== generation || workspace.activation !== 'active') {
      return { viewRevision: this.viewRevision(workspace, session.mode) }
    }
    workspace.prompted.add(record.discoveryKey)
    if (workspace.candidates.get(record.candidate.key) === record) workspace.candidates.delete(record.candidate.key)
    workspace.queue = workspace.queue.filter(candidate => candidate.promptId !== promptId)
    workspace.revision++
    await this.loadSidecar(workspace)
    this.wake(workspace)
    const head = this.visibleRecords(workspace, session.mode)[0]
    const viewRevision = this.viewRevision(workspace, session.mode)
    return head === undefined ? { viewRevision } : { viewRevision, prompt: this.promptView(workspace, head, session.mode) }
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

  /** Load or create the workspace state. */
  private async ensureWorkspace(primaryRoot: string, detect: 'none' | 'first' | 'explicit'): Promise<WorkspaceState> {
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
        ignored: this.ignored.get(key) ?? new Set(),
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
      || (detect === 'explicit' && workspace.activation === 'lost'))) await this.activate(workspace)
    return workspace
  }

  /** Run the full primary snapshot and (re)build state. */
  private async activate(workspace: WorkspaceState): Promise<void> {
    const result = resolveRepo(workspace.primaryRoot)
    if (!result.ok) {
      this.transitionInactive(workspace, `${result.reason}: ${result.detail}`)
      return
    }
    const previousCommon = workspace.repo?.common
    const wasActive = workspace.activation === 'active'
    workspace.activation = 'active'
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
    await this.loadSidecar(workspace)
    if (!this.current(workspace, generation, activation)) return
    // A new owner generation must rebind/prune its mappings only after an
    // explicit workspace activation (ADR-0039 §6.8).
    this.reconcileSidecar(workspace)
    await this.refreshInventory(workspace)
    this.wake(workspace)
  }

  /**
   * Re-run the complete primary snapshot for an already active workspace.
   * A failure means the workspace WAS active and is now `lost`; the quiet
   * state releases every watcher and waiter and never schedules a retry.
   */
  private async revalidate(workspace: WorkspaceState): Promise<void> {
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
    await this.refreshInventory(workspace)
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

  /** Re-run inventory, filters and watchers for an active workspace. */
  private async refreshInventory(workspace: WorkspaceState): Promise<void> {
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
    workspace.degraded = inventory.degraded || inventory.candidates.length > this.maxAdminWatchers
    workspace.candidates = next
    workspace.queue = [...ordered, ...added]
    this.observeTrackedRoots(workspace)
    workspace.watchers?.close()
    workspace.watchers = this.createWatchers(workspace)
    if (workspace.watchers?.degraded === true) workspace.degraded = true
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
          await this.refreshInventory(workspace)
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
    const head = visible[0]
    const material = JSON.stringify({
      activation: workspace.activation,
      common: workspace.repo?.common ?? '',
      head: head?.promptId ?? '',
      effective: head === undefined ? '' : effectiveRootAccess('inherit', mode),
      remaining: visible.length,
      visible: visible.map(record => record.candidate.key),
      prompted: [...workspace.prompted].sort(),
      ignored: [...workspace.ignored].sort(),
    })
    return createHash('sha256').update(material).digest('hex').slice(0, 24)
  }

  /**
   * The result a waiter should receive RIGHT NOW, or `undefined` to keep
   * waiting. `mounting` distinguishes a first request (which returns an
   * existing prompt) from a re-mount that already saw the same view.
   */
  private resultFor(
    workspace: WorkspaceState,
    mode: WorkspaceMode,
    seen: { readonly seenPromptId?: string | undefined; readonly seenViewRevision?: string | undefined },
    mounting: boolean,
  ): WorktreePromptWaitResult | undefined {
    const viewRevision = this.viewRevision(workspace, mode)
    if (workspace.activation === 'unactivated') return { status: 'unactivated', viewRevision }
    if (workspace.activation === 'lost') return { status: 'lost', viewRevision }
    const visible = this.visibleRecords(workspace, mode)
    if (seen.seenPromptId !== undefined && seen.seenPromptId !== '' && !visible.some(record => record.promptId === seen.seenPromptId)) {
      return { status: 'stale', viewRevision, reason: 'prompt-gone' }
    }
    const head = visible[0]
    if (head !== undefined) {
      const same = seen.seenPromptId === head.promptId && seen.seenViewRevision === viewRevision
      if (!same) return { status: 'prompt', prompt: this.promptView(workspace, head, mode), viewRevision }
      return undefined
    }
    if (!mounting && seen.seenViewRevision !== undefined && seen.seenViewRevision !== viewRevision) {
      // The view changed while waiting (a prompt was handled elsewhere); the
      // client re-mounts immediately.
      return { status: 'timeout', viewRevision }
    }
    return undefined
  }

  /** Register one waiter and resolve it on the next relevant change or timeout. */
  private async awaitPrompt(
    workspace: WorkspaceState,
    session: SessionView,
    seen: { readonly seenPromptId?: string | undefined; readonly seenViewRevision?: string | undefined },
    signal?: AbortSignal,
  ): Promise<WorktreePromptWaitResult> {
    return await new Promise<WorktreePromptWaitResult>((resolve, reject) => {
      // Declared before the closures only for typing; callbacks run after the
      // assignment, never during it.
      const waiter: Waiter = {
        sessionId: session.sessionId,
        seenPromptId: seen.seenPromptId,
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
      const result = this.resultFor(workspace, session.mode, waiter, false)
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
    this.reconcileSidecar(workspace)
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

/** Clamp one numeric config value. */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Whether one candidate kind may be shown in one sandbox mode. */
export function eligible(kind: 'worktree' | 'git-common', mode: WorkspaceMode): boolean {
  if (mode === 'danger-full-access') return false
  if (kind === 'git-common') return mode === 'workspace-write'
  return true
}

/** The discovery key of one candidate; stable across admin moves for B. */
export function discoveryKeyOf(candidate: InventoryCandidate): string {
  return `worktree\u0000${candidate.path}`
}

/** The discovery key of either suggestion kind. */
function discoveryKeyFor(candidate: SuggestionCandidate): string {
  return candidate.kind === 'git-common' ? commonDiscoveryKey(candidate) : discoveryKeyOf(candidate)
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
