/**
 * The per-workspace sidecar: A/B discovery ignores and the B roots this
 * feature created.
 *
 * This file is NOT authorization data (ADR-0039 §5): losing or corrupting it
 * only loses suggestions and cleanup tracking; a tracked root then behaves
 * like a manually added one. Every write is performed by the Registry owner
 * inside its serialized queue, through the helpers below.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/sidecar
 */

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** One discovery decision the operator made ("do not suggest this again"). */
export interface IgnoredCandidate {
  readonly key: string
  readonly kind: 'worktree' | 'main-checkout'
  readonly path: string
  readonly addedAt: string
}

/** One B root this feature created and still tracks. */
export interface WorktreeMapping {
  readonly rootId: string
  readonly adminId: string
  /** The common git dir, for diagnostics only. */
  readonly common: string
  /** The registry record's canonical path at creation. */
  readonly path: string
  /** The registry record's `addedAt` at creation (the cleanup binding). */
  readonly rootAddedAt: string
  /** When this mapping was written. */
  readonly addedAt: string
  readonly mapRevision: number
  readonly registryEpoch?: string
  readonly registryRevision?: number
}

/**
 * One reminder delay the operator chose. `until-new-worktree` needs no
 * instant: the keys it names stay quiet, and any key it does NOT name is a
 * newly appeared candidate that surfaces immediately (ADR-0039 §6.4).
 */
export interface WorktreeSnooze {
  readonly mode: 'until-new-worktree' | 'until'
  /** ISO instant; present exactly when `mode === 'until'`. */
  readonly until?: string
  /** Discovery keys the host derived from the confirmed prompt ids. */
  readonly keys: readonly string[]
  /** When the delay was recorded. */
  readonly at: string
}

/** The whole sidecar document. */
export interface WorktreeSidecarDocument {
  readonly version: 1
  readonly revision: number
  readonly primaryKey: string
  readonly primaryRoot: string
  readonly ignored: readonly IgnoredCandidate[]
  readonly worktreeRoots: readonly WorktreeMapping[]
  /**
   * Pending reminder delays, one per operator choice. A corrupt entry is
   * ignored, not fatal; the legacy single `snooze` object is read as one
   * entry (PR #55 review).
   */
  readonly snoozes?: readonly WorktreeSnooze[]
}

/**
 * Upper bound on pending reminder records. Snoozes are rare; the cap keeps a
 * pathological sequence from growing the sidecar without limit, dropping the
 * OLDEST choice first (its keys then simply become eligible again).
 */
export const MAX_SNOOZE_RECORDS = 32

/**
 * Whether one reminder delay still applies at `now`.
 * @param snooze - the stored delay.
 * @param now - the host clock instant, milliseconds since the epoch.
 */
export function snoozeActive(snooze: WorktreeSnooze, now: number): boolean {
  if (snooze.mode === 'until-new-worktree') return true
  const until = Date.parse(snooze.until ?? '')
  return Number.isFinite(until) && now < until
}

/**
 * The still-pending reminder records at `now`. An expired or unreadable
 * record is not pending any more; the caller releases its claims (once) and
 * drops it.
 * @param snoozes - the stored delays.
 * @param now - the host clock instant, milliseconds since the epoch.
 */
export function liveSnoozes(snoozes: readonly WorktreeSnooze[], now: number): readonly WorktreeSnooze[] {
  return snoozes.filter(snooze => snoozeActive(snooze, now))
}

/**
 * The discovery keys the pending delays currently suppress.
 *
 * Each `until` is evaluated against the HOST clock (the caller passes `now`);
 * `until-new-worktree` keeps exactly its recorded keys quiet, so a key no
 * record names is a new worktree and shows immediately. Expired or unreadable
 * records suppress nothing.
 * @param snoozes - the stored delays, if any.
 * @param now - the host clock instant, milliseconds since the epoch.
 * @returns the still-suppressed keys, or `undefined` when no delay applies.
 */
export function snoozedDiscoveries(snoozes: readonly WorktreeSnooze[] | undefined, now: number): ReadonlySet<string> | undefined {
  if (snoozes === undefined || snoozes.length === 0) return undefined
  const suppressed = new Set<string>()
  for (const snooze of snoozes) {
    if (!snoozeActive(snooze, now)) continue
    for (const key of snooze.keys) suppressed.add(key)
  }
  return suppressed.size === 0 ? undefined : suppressed
}

/**
 * Merge one new operator choice into the pending set.
 *
 * Each choice keeps its own deadline, so a later snooze of DIFFERENT
 * candidates must not replace an outstanding earlier reminder (that would
 * silently turn it into permanent suppression).
 *
 * Overlap is handled per KEY, not per record: the keys the new choice names
 * are superseded, while the remaining keys of a partially overlapping shared
 * record keep their ORIGINAL deadline. Two Hosts can hold notices covering
 * different candidate sets, so deleting the whole record would drop a
 * deadline nobody re-chose (PR #55 review).
 * @param existing - the pending records.
 * @param record - the operator's new choice.
 * @returns the merged pending set, capped at {@link MAX_SNOOZE_RECORDS}.
 */
export function mergeSnoozeRecords(existing: readonly WorktreeSnooze[], record: WorktreeSnooze): readonly WorktreeSnooze[] {
  const claimed = new Set(record.keys)
  const kept: WorktreeSnooze[] = []
  for (const entry of existing) {
    const remaining = entry.keys.filter(key => !claimed.has(key))
    if (remaining.length === entry.keys.length) {
      kept.push(entry)
      continue
    }
    if (remaining.length === 0) continue
    kept.push(entry.mode === 'until'
      ? { mode: 'until', ...(entry.until === undefined ? {} : { until: entry.until }), keys: remaining, at: entry.at }
      : { mode: 'until-new-worktree', keys: remaining, at: entry.at })
  }
  const merged = [...kept, record]
  return merged.length <= MAX_SNOOZE_RECORDS ? merged : merged.slice(merged.length - MAX_SNOOZE_RECORDS)
}

/** The directory name under the store root. */
export const SIDECAR_DIRECTORY = 'multi_root_workspace.worktree-prompts'

/** The sidecar file of one primary root. */
export function sidecarPath(promptsRoot: string, primaryKey: string): string {
  return join(promptsRoot, createHash('sha256').update(primaryKey).digest('hex') + '.json')
}

/** An empty document for one workspace, revision 0. */
export function emptySidecar(primaryKey: string, primaryRoot: string): WorktreeSidecarDocument {
  return { version: 1, revision: 0, primaryKey, primaryRoot, ignored: [], worktreeRoots: [] }
}

/** One read verdict. */
export type SidecarReadResult =
  | { readonly ok: true; readonly document: WorktreeSidecarDocument; readonly exists: boolean }
  | { readonly ok: false; readonly detail: string }

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseIgnored(value: unknown): IgnoredCandidate | undefined {
  const entry = objectOf(value)
  if (entry === undefined) return undefined
  if (typeof entry.key !== 'string' || typeof entry.path !== 'string' || typeof entry.addedAt !== 'string') return undefined
  // `git-common` is the pre-nineteenth-revision A kind. Read it as a legacy
  // record (its key no longer matches, so it is inert) instead of refusing the
  // whole document.
  if (entry.kind !== 'worktree' && entry.kind !== 'main-checkout' && entry.kind !== 'git-common') return undefined
  const kind = entry.kind === 'worktree' ? 'worktree' as const : 'main-checkout' as const
  return { key: entry.key, kind, path: entry.path, addedAt: entry.addedAt }
}

/**
 * Parse ONE reminder record LENIENTLY. A broken UI-only delay must never take
 * `ignored` and `worktreeRoots` down with it: the whole document stays
 * readable and only that entry is dropped.
 */
function parseSnoozeRecord(value: unknown): WorktreeSnooze | undefined {
  const entry = objectOf(value)
  if (entry === undefined) return undefined
  if (entry.mode !== 'until-new-worktree' && entry.mode !== 'until') return undefined
  if (typeof entry.at !== 'string' || !Array.isArray(entry.keys)) return undefined
  if (!entry.keys.every(key => typeof key === 'string' && key !== '')) return undefined
  if (entry.mode === 'until') {
    if (typeof entry.until !== 'string' || !Number.isFinite(Date.parse(entry.until))) return undefined
    return { mode: 'until', until: entry.until, keys: entry.keys, at: entry.at }
  }
  return { mode: 'until-new-worktree', keys: entry.keys, at: entry.at }
}

/**
 * Parse the optional reminder projection LENIENTLY. Entries that do not
 * parse are dropped individually, and a legacy single-object `snooze` field
 * is read as one pending record.
 * @param value - the `snoozes` array, as persisted.
 * @param legacy - the pre-list single `snooze` object, if present.
 */
export function parseSidecarSnoozes(value: unknown, legacy?: unknown): readonly WorktreeSnooze[] {
  if (Array.isArray(value)) {
    const parsed: WorktreeSnooze[] = []
    for (const entry of value) {
      const record = parseSnoozeRecord(entry)
      if (record !== undefined) parsed.push(record)
      if (parsed.length >= MAX_SNOOZE_RECORDS) break
    }
    if (parsed.length > 0) return parsed
  }
  const single = parseSnoozeRecord(legacy)
  return single === undefined ? [] : [single]
}

function parseMapping(value: unknown): WorktreeMapping | undefined {
  const entry = objectOf(value)
  if (entry === undefined) return undefined
  if (typeof entry.rootId !== 'string' || typeof entry.adminId !== 'string' || typeof entry.common !== 'string') return undefined
  if (typeof entry.path !== 'string' || typeof entry.rootAddedAt !== 'string' || typeof entry.addedAt !== 'string') return undefined
  if (typeof entry.mapRevision !== 'number') return undefined
  return {
    rootId: entry.rootId, adminId: entry.adminId, common: entry.common, path: entry.path,
    rootAddedAt: entry.rootAddedAt, addedAt: entry.addedAt, mapRevision: entry.mapRevision,
    ...(typeof entry.registryEpoch === 'string' ? { registryEpoch: entry.registryEpoch } : {}),
    ...(typeof entry.registryRevision === 'number' ? { registryRevision: entry.registryRevision } : {}),
  }
}

/**
 * Read one sidecar document. A missing file is an EMPTY document (not an
 * error); an unparsable one is refused so the owner can stay memory-only.
 * @param promptsRoot - absolute sidecar directory.
 * @param primaryKey - the workspace key.
 * @param primaryRoot - the workspace root, for a fresh document.
 * @returns the document, whether it existed, or the corruption detail.
 */
export function readSidecar(promptsRoot: string, primaryKey: string, primaryRoot: string): SidecarReadResult {
  let text: string
  try {
    text = readFileSync(sidecarPath(promptsRoot, primaryKey), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, document: emptySidecar(primaryKey, primaryRoot), exists: false }
    return { ok: false, detail: 'sidecar cannot be read: ' + (error instanceof Error ? error.message : String(error)) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'sidecar is not valid JSON' }
  }
  const entry = objectOf(parsed)
  if (entry === undefined || entry.version !== 1) return { ok: false, detail: 'sidecar version is not 1' }
  if (typeof entry.revision !== 'number' || !Array.isArray(entry.ignored) || !Array.isArray(entry.worktreeRoots)) {
    return { ok: false, detail: 'sidecar layout is invalid' }
  }
  if (entry.primaryKey !== primaryKey) return { ok: false, detail: 'sidecar belongs to another workspace' }
  const ignored: IgnoredCandidate[] = []
  const worktreeRoots: WorktreeMapping[] = []
  for (const value of entry.ignored) {
    const candidate = parseIgnored(value)
    if (candidate === undefined) return { ok: false, detail: 'sidecar has an invalid ignored entry' }
    ignored.push(candidate)
  }
  for (const value of entry.worktreeRoots) {
    const mapping = parseMapping(value)
    if (mapping === undefined) return { ok: false, detail: 'sidecar has an invalid worktreeRoots entry' }
    worktreeRoots.push(mapping)
  }
  const snoozes = parseSidecarSnoozes(entry.snoozes, entry.snooze)
  return {
    ok: true,
    exists: true,
    document: {
      version: 1,
      revision: entry.revision,
      primaryKey,
      primaryRoot: typeof entry.primaryRoot === 'string' ? entry.primaryRoot : primaryRoot,
      ignored,
      worktreeRoots,
      ...(snoozes.length === 0 ? {} : { snoozes }),
    },
  }
}

/**
 * Atomically replace one sidecar document: temp file, fsync, rename.
 * @param promptsRoot - absolute sidecar directory (created when absent).
 * @param primaryKey - the workspace key.
 * @param document - the document to persist.
 */
export function writeSidecar(promptsRoot: string, primaryKey: string, document: WorktreeSidecarDocument): void {
  mkdirSync(promptsRoot, { recursive: true, mode: 0o700 })
  const target = sidecarPath(promptsRoot, primaryKey)
  const temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp'
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(document, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

export { randomUUID as sidecarUUID }
