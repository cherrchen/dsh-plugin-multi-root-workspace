/**
 * The workspace's watcher set.
 *
 * `fs.watch` events are hints only (ADR-0039 §3.3): every event debounces into
 * one reconcile that re-runs the full activation snapshot. `filename === null`
 * is a reconcile request, never an entry to ignore. Watcher errors and the
 * admin cap degrade the set to timeout/reconnect reconciliation — the service
 * never claims complete per-admin coverage.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/watch
 */

import { watch, type FSWatcher } from 'node:fs'

/** Everything one workspace wants observed. */
export interface WatchTargets {
  /** The common git dir; filters `worktrees`. */
  readonly common: string
  /** `<common>/worktrees`; admin entry churn. */
  readonly worktrees: string
  /** Admin dirs; filters `gitdir` / `commondir`. */
  readonly admins: readonly string[]
  /** The primary root, for a `.git` replace/remove. */
  readonly primaryRoot: string
  /** The primary `.git` path (file or dir). */
  readonly primaryGit: string
  /** Ancestor directories that carry a `.git` entry (best effort). */
  readonly ancestors: readonly string[]
  /** Parent directories of tracked B roots, filtered by the root basename. */
  readonly parents: readonly { readonly directory: string; readonly name: string }[]
}

/** One installation of watchers; close it before installing the next. */
export class WorkspaceWatchSet {
  private readonly watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private degradedFlag = false

  /**
   * @param targets - what to observe.
   * @param onChange - debounced reconcile request.
   * @param options - debounce and the per-admin cap.
   */
  constructor(
    targets: WatchTargets,
    private readonly onChange: () => void,
    options: { readonly debounceMs: number; readonly maxAdmins: number },
  ) {
    const adminLimit = options.maxAdmins
    const admins = targets.admins.slice(0, adminLimit)
    if (targets.admins.length > adminLimit) this.degradedFlag = true
    this.observe(targets.common, name => name === 'worktrees' || name === null, options.debounceMs)
    this.observe(targets.worktrees, () => true, options.debounceMs)
    for (const admin of admins) {
      this.observe(admin, name => name === 'gitdir' || name === 'commondir' || name === null, options.debounceMs)
    }
    this.observe(targets.primaryRoot, name => name === '.git' || name === null, options.debounceMs)
    // Watching a directory's top-level entries also covers the .git file; a
    // file target is watched for replacement. Both are best effort.
    this.observe(targets.primaryGit, () => true, options.debounceMs)
    for (const ancestor of targets.ancestors) {
      this.observe(ancestor, name => name === '.git' || name === 'index' || name === null, options.debounceMs)
    }
    const parents = new Map<string, Set<string>>()
    for (const parent of targets.parents) {
      const names = parents.get(parent.directory) ?? new Set<string>()
      names.add(parent.name)
      parents.set(parent.directory, names)
    }
    for (const [directory, names] of parents) {
      this.observe(directory, name => name === null || names.has(name), options.debounceMs)
    }
  }

  /** Whether any administrator declined coverage. */
  get degraded(): boolean { return this.degradedFlag }

  private observe(path: string, filter: (name: string | null) => boolean, debounceMs: number): void {
    if (this.closed) return
    let watcher: FSWatcher
    try {
      watcher = watch(path, { persistent: false }, (_event, filename) => {
        if (filter(filename === null ? null : String(filename))) this.schedule(debounceMs)
      })
    } catch {
      // A vanished path is not an authorization change; the next reconcile
      // re-runs the full snapshot and decides. Ancestor watchers are best effort.
      return
    }
    watcher.on('error', () => { this.degradedFlag = true; this.schedule(debounceMs) })
    this.watchers.push(watcher)
  }

  private schedule(debounceMs: number): void {
    if (this.closed) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.closed) this.onChange()
    }, Math.max(0, debounceMs))
    this.timer.unref?.()
  }

  /** Stop every watcher and drop any pending reconcile. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const watcher of this.watchers) {
      try { watcher.close() } catch { /* closing twice is harmless */ }
    }
    this.watchers.length = 0
  }
}
