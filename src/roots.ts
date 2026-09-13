/**
 * The root vocabulary: identities, the durable record shape, the status a
 * stored record is reported with, and the validation rules every write and
 * every startup re-read passes through.
 *
 * This module is the single home of "what makes a directory a legal additional
 * root" (requirement §15). Both the registry (which persists) and the command
 * and panel surfaces (which report) speak these types, so a rule can never be
 * enforced on one path and forgotten on another.
 *
 * Rules, applied in this order — the first failure names the reason:
 *
 * 1. `not-absolute` — a relative input (after `~` expansion) is a
 *    misconfiguration, not a path to guess at.
 * 2. `missing` — the directory does not exist.
 * 3. `not-a-directory` — it exists but is not a directory.
 * 4. `equals-primary` — the canonical candidate IS the session's workspace
 *    root, which is already granted by the upstream policy.
 * 5. `primary-overlap` — the candidate lies under the workspace root, or
 *    contains it. The union grants nothing new, and the displayed list would
 *    stop matching the enforced root set.
 * 6. `duplicate` — another registered root canonicalizes to the same path.
 * 7. `nested` — the candidate lies under a registered root, or contains one.
 *    Same reasoning as rule 5, applied to the additional roots.
 *
 * The stored side of the same rules lives in {@link classifyStoredRoots}, which
 * must never throw: a registration that stopped being usable is REPORTED, not
 * deleted, so the operator can see it and remove it deliberately.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/roots
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

/**
 * Stable identity of one registered additional root. A generated uuid, never
 * the path: a path is re-canonicalized on every read and a display alias may
 * change, while a reference anchor must stay put. The brand is local to this
 * package — it is a compile-time distinction only and has no runtime form.
 */
export type AdditionalRootId = string & { readonly __multiRootAdditionalRootId: 'AdditionalRootId' }

/**
 * Brand one generated uuid as an {@link AdditionalRootId}.
 * @param value - the raw uuid.
 * @returns the branded id.
 */
export function additionalRootId(value: string): AdditionalRootId {
  return value as AdditionalRootId
}

/** One registered additional root exactly as it is persisted. */
export interface RegisteredRoot {
  /** Stable registry identity. */
  readonly id: AdditionalRootId
  /** Canonical absolute directory (the `realpath` captured at registration). */
  readonly path: string
  /**
   * The canonical directory this registration was GRANTED for: the `realpath`
   * observed when the operator registered it (or the last time the operator
   * restored it). Authorization is `canonicalPath(path) === recordedPath` — a
   * root whose current resolution moved somewhere else is reported as
   * `redirected` and withheld, never silently granted elsewhere.
   */
  readonly recordedPath?: string
  /** Optional display alias; absent when the operator cleared it. */
  readonly alias?: string
  /** ISO-8601 instant of registration. */
  readonly addedAt: string
}

/**
 * How one stored record currently stands.
 *
 * - `available` — the directory is there, resolves to the recorded canonical
 *   directory, and is granted.
 * - `missing` — the directory is not there right now; kept, withheld.
 * - `redirected` — the path no longer resolves to the directory it was
 *   registered for (it was replaced by a symlink, or a symlink in the chain
 *   changed); kept, withheld, and `recheck` restores it once the original
 *   directory is back.
 * - `invalid` — the record violates a rule and can only be removed.
 */
export type RootState = 'available' | 'missing' | 'redirected' | 'invalid'

/** One registered root as the surfaces report it. */
export interface RootStatus extends RegisteredRoot {
  /** Whether the root is granted right now, withheld, or unusable. */
  readonly state: RootState
  /** Why the root is not `available`; absent otherwise. */
  readonly detail?: string
}

/** One status together with the 1-based ordinal the surfaces accept for it. */
export interface IndexedRootStatus {
  /** The 1-based position in the registration list. */
  readonly ordinal: number
  /** The record at that position. */
  readonly status: RootStatus
}

/** How a caller names one registered root, including a verified surface snapshot. */
export type RootRef =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'ordinal'; readonly ordinal: number }
  | {
    readonly kind: 'entry'
    readonly ordinal: number
    readonly id: string
    readonly path: string
    readonly addedAt: string
  }

/** Every way root handling can fail, as a stable code the surfaces localize. */
export type RootValidationCode =
  | 'not-absolute'
  | 'missing'
  | 'not-a-directory'
  | 'equals-primary'
  | 'primary-overlap'
  | 'duplicate'
  | 'nested'
  | 'invalid-alias'
  | 'not-found'
  | 'invalid-ref'
  | 'storage-unavailable'
  | 'reveal-unavailable'

/** A rejected root operation; `code` is the stable contract, `message` the fallback prose. */
export class RootValidationError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - human-readable fallback text (English; the panel localizes by code).
   * @param detail - structured context, e.g. the conflicting root.
   */
  constructor(
    readonly code: RootValidationCode,
    message: string,
    readonly detail?: { readonly conflict?: string; readonly reference?: string },
  ) {
    super(message)
    this.name = 'RootValidationError'
  }
}

/**
 * Expand the one shell shorthand an operator may reasonably type, and nothing
 * else: a leading `~` (alone or as `~/…`). Every other relative spelling is
 * left intact so validation can reject it as `not-absolute` instead of
 * silently resolving it against some unrelated process cwd.
 * @param raw - the raw operator input.
 * @param home - the home directory to expand against; defaults to `os.homedir()`.
 * @returns the expanded path (still unvalidated).
 */
export function expandRootInput(raw: string, home: string = homedir()): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/** Whether lexical comparison preserves case on this platform. */
const CASE_SENSITIVE = process.platform !== 'win32'

/** Compare two canonical path spellings under the platform's case convention. */
function comparable(path: string): string {
  return CASE_SENSITIVE ? path : path.toLowerCase()
}

/** Whether two canonical paths name the same directory on this platform. */
function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right)
}

/**
 * Whether `candidate` is `root` itself or lies beneath it. Both sides must
 * already be canonical: symlinks are resolved by then, so the lexical test is
 * exact for the alias cases (8.3 names, casing) the fence handles separately.
 * @param candidate - canonical path to test.
 * @param root - canonical root to test against.
 * @returns whether the candidate is contained by the root.
 */
export function isCanonicallyUnder(candidate: string, root: string): boolean {
  const target = comparable(candidate)
  const base = comparable(root)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Canonicalize a directory path the way the enforcement layers do (`realpath`),
 * leaving an unreachable path untouched so the caller can report it as missing.
 * @param path - the path to canonicalize.
 * @returns the canonical path.
 */
export function canonicalRoot(path: string): string {
  return canonicalPath(path)
}

/** Caller-supplied facts one candidate is judged against. */
export interface RootCandidateContext {
  /** The session's workspace root; the candidate may not equal or overlap it. */
  readonly primaryRoot: string
  /**
   * The home directory a leading `~` expands against. Defaults to `os.homedir()`;
   * a caller that knows which home it means (a test, a probe) may say so instead
   * of depending on where the host's home directory happens to sit.
   */
  readonly home?: string
  /**
   * Canonical paths already granted. Missing and invalid registrations are
   * deliberately excluded: a withheld root grants nothing, so a candidate may
   * legitimately sit under it, and an unusable record must not block a store
   * the operator is trying to make work again.
   */
  readonly existing: readonly string[]
}

/**
 * Judge one candidate root and return its canonical spelling.
 * @param raw - the raw operator input (a path, possibly `~`-prefixed).
 * @param context - the primary root and the currently granted roots.
 * @returns the canonical path the caller must store (and record as `recordedPath`).
 * @throws {RootValidationError} with the first rule that failed.
 */
export function validateRootCandidate(raw: string, context: RootCandidateContext): string {
  const expanded = expandRootInput(raw, context.home)
  if (expanded === '') {
    throw new RootValidationError('not-absolute', 'a root path is required')
  }
  if (!isAbsolute(expanded)) {
    throw new RootValidationError(
      'not-absolute',
      `"${expanded}" is not an absolute path; give an absolute directory or one starting with "~/"`,
      { reference: expanded },
    )
  }
  const canonical = canonicalRoot(expanded)
  assertDirectory(canonical, expanded)
  const primaryRoot = canonicalRoot(context.primaryRoot)
  if (samePath(canonical, primaryRoot)) {
    throw new RootValidationError(
      'equals-primary',
      `"${canonical}" is this session's workspace root and is already writable`,
      { conflict: primaryRoot, reference: canonical },
    )
  }
  // The primary root takes part in the overlap rule exactly like an additional
  // root does: a child of the workspace root (or an ancestor of it) adds no
  // writable range and would make the listed roots disagree with the enforced
  // set. Checking it here — not only against `existing` — is what makes the
  // rule hold on an empty registration list.
  if (isCanonicallyUnder(canonical, primaryRoot) || isCanonicallyUnder(primaryRoot, canonical)) {
    throw new RootValidationError(
      'primary-overlap',
      `"${canonical}" overlaps this session's workspace root "${primaryRoot}"`,
      { conflict: primaryRoot, reference: canonical },
    )
  }
  for (const existing of context.existing) {
    if (samePath(canonical, existing)) {
      throw new RootValidationError('duplicate', `"${canonical}" is already registered`, {
        conflict: existing,
        reference: canonical,
      })
    }
  }
  for (const existing of context.existing) {
    if (isCanonicallyUnder(canonical, existing)) {
      throw new RootValidationError(
        'nested',
        `"${canonical}" is already covered by the registered root "${existing}"`,
        { conflict: existing, reference: canonical },
      )
    }
    if (isCanonicallyUnder(existing, canonical)) {
      throw new RootValidationError(
        'nested',
        `"${canonical}" contains the registered root "${existing}"; remove that root first`,
        { conflict: existing, reference: canonical },
      )
    }
  }
  return canonical
}

/** Assert that a canonical path is an existing directory. */
function assertDirectory(canonical: string, asTyped: string): void {
  let stats
  try {
    stats = statSync(canonical)
  } catch {
    throw new RootValidationError('missing', `"${asTyped}" does not exist`, { reference: asTyped })
  }
  if (!stats.isDirectory()) {
    throw new RootValidationError('not-a-directory', `"${asTyped}" is not a directory`, { reference: asTyped })
  }
}

/**
 * Re-judge every stored record of one primary root — the startup and refresh
 * path, which must never throw: a registration that stopped being usable is
 * REPORTED, not deleted, so the operator can see it and remove it deliberately.
 *
 * Existence and reachability are the only rules a record may recover from on
 * its own, hence `missing` and `redirected` (kept, withheld) rather than
 * `invalid` (kept, unusable).
 * @param primaryRoot - the session workspace root the records belong to.
 * @param records - the stored records, in registry order.
 * @returns one status per record, in the same order.
 */
export function classifyStoredRoots(
  primaryRoot: string,
  records: readonly RegisteredRoot[],
): RootStatus[] {
  const primary = canonicalRoot(primaryRoot)
  const claimed: string[] = []
  const duplicated = duplicatedIds(records)
  const statuses: RootStatus[] = []
  for (const [index, record] of records.entries()) {
    const status = classifyStoredRoot(record, primary, claimed, duplicated.has(record.id), index)
    statuses.push(status)
    if (status.state === 'available') claimed.push(status.path)
  }
  return statuses
}

/**
 * The ids that more than one record claims. Computed for the whole list up
 * front, because "this id is duplicated" is a property of the SET: deciding it
 * while walking would make the first occurrence look fine and only the later
 * ones broken, and the first match is precisely the ambiguity being reported.
 */
function duplicatedIds(records: readonly RegisteredRoot[]): Set<string> {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) duplicated.add(record.id)
    else seen.add(record.id)
  }
  return duplicated
}

/**
 * Judge one stored record against the primary root and the roots claimed before
 * it.
 *
 * Identity and the recorded directory are checked BEFORE the current
 * resolution is used for anything: a record whose path now resolves elsewhere
 * must not have its new (attacker-influenced) target participate in the
 * overlap rules.
 */
function classifyStoredRoot(
  record: RegisteredRoot,
  primary: string,
  claimed: readonly string[],
  duplicatedId: boolean,
  position: number,
): RootStatus {
  const invalid = (detail: string): RootStatus => ({ ...record, state: 'invalid', detail })
  if (typeof record.path !== 'string' || record.path === '') return invalid('the record has no path')
  if (typeof record.id !== 'string' || record.id === '') return invalid('the record has no id')
  if (duplicatedId) {
    // Two records sharing one id cannot be told apart by an operator or by a
    // surface: a removal by id would delete both, and the panel would show one
    // row twice. EVERY record of that id is reported unusable — including the
    // first one — because "the first match wins" is exactly the ambiguity that
    // makes such a store unreadable. Nothing is granted for it; an exact entry
    // reference lets the operator delete distinguishable rows one at a time.
    return invalid(`the id "${record.id}" is used by more than one record (entry ${position + 1})`)
  }
  if (!isAbsolute(record.path)) return invalid(`"${record.path}" is not an absolute path`)
  const recorded = record.recordedPath
  if (typeof recorded !== 'string' || recorded === '') {
    return invalid('the record does not say which directory it was granted for')
  }
  const canonical = canonicalRoot(record.path)
  if (!samePath(canonical, recorded)) {
    // The reported path stays the REGISTERED spelling. Substituting the new
    // resolution would show the operator a directory they never registered, and
    // every surface — the list, the report, the panel row — should keep naming
    // the registration they have to fix. Where it resolves now goes in `detail`.
    return {
      ...record,
      state: 'redirected',
      detail: `the path now resolves to "${canonical}" instead of the registered "${recorded}"`,
    }
  }
  if (samePath(canonical, primary)) {
    return invalid(`"${canonical}" is this session's workspace root`)
  }
  if (isCanonicallyUnder(canonical, primary) || isCanonicallyUnder(primary, canonical)) {
    return invalid(`"${canonical}" overlaps this session's workspace root`)
  }
  if (claimed.some(existing => samePath(existing, canonical))) {
    return invalid(`"${canonical}" is registered twice`)
  }
  for (const existing of claimed) {
    if (isCanonicallyUnder(canonical, existing) || isCanonicallyUnder(existing, canonical)) {
      return invalid(`"${canonical}" overlaps the registered root "${existing}"`)
    }
  }
  let isDirectory = false
  try {
    isDirectory = statSync(canonical).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    return { ...record, path: canonical, state: 'missing', detail: 'the directory is not present right now' }
  }
  return { ...record, path: canonical, state: 'available' }
}

/**
 * The canonical roots a status list grants, in registry order.
 * @param statuses - the statuses to project.
 * @returns the canonical paths of every `available` root.
 */
export function availableRoots(statuses: readonly RootStatus[]): string[] {
  return statuses.filter(status => status.state === 'available').map(status => status.path)
}

/**
 * Pair every status with the 1-based ordinal the surfaces accept for it. The
 * ordinal belongs to the POSITION, so it stays correct even for records whose
 * id is duplicated or missing — which is exactly the case where a positional
 * removal is the only unambiguous way to delete one of them.
 * @param statuses - the statuses to index.
 * @returns one entry per status, in the same order.
 */
export function indexedStatuses(statuses: readonly RootStatus[]): IndexedRootStatus[] {
  return statuses.map((status, index) => ({ ordinal: index + 1, status }))
}

/**
 * Resolve one operator-supplied reference against a status list.
 * @param statuses - the statuses to search, in registry order.
 * @param ref - the reference to resolve.
 * @returns the matched status.
 * @throws {RootValidationError} `not-found` when nothing matches.
 */
export function resolveRootRef(statuses: readonly RootStatus[], ref: RootRef): RootStatus {
  return statuses[resolveRootIndex(statuses, ref)]!
}

/**
 * Resolve one reference to its exact position.
 *
 * Id/path references are accepted only when unique. An `entry` reference also
 * verifies the row identity captured by the surface, so a concurrent reorder
 * cannot turn a click into an operation on a different record.
 */
export function resolveRootIndex(statuses: readonly RootStatus[], ref: RootRef): number {
  const reference = describeRef(ref)
  const matches = (predicate: (status: RootStatus) => boolean): number[] => {
    const result: number[] = []
    for (const [index, status] of statuses.entries()) if (predicate(status)) result.push(index)
    return result
  }
  const indices = ((): number[] => {
    switch (ref.kind) {
      case 'id':
        return matches(status => status.id === ref.id)
      case 'ordinal':
        return ref.ordinal >= 1 && ref.ordinal <= statuses.length ? [ref.ordinal - 1] : []
      case 'path': {
        const canonical = canonicalRoot(expandRootInput(ref.path))
        return matches(status => samePath(status.path, canonical))
      }
      case 'entry': {
        const sameEntry = (status: RootStatus): boolean => status.id === ref.id
          && samePath(status.path, ref.path)
          && status.addedAt === ref.addedAt
        const found = matches(sameEntry)
        if (found.length !== 1) return found
        const expected = ref.ordinal - 1
        return expected === found[0] ? [expected] : found
      }
    }
  })()
  if (indices.length === 0) {
    throw new RootValidationError('not-found', `no registered root matches ${reference}`, { reference })
  }
  if (indices.length > 1) {
    throw new RootValidationError(
      'invalid-ref',
      `${reference} matches more than one registered root; use its displayed number`,
      { reference },
    )
  }
  return indices[0]!
}

/** Capture a list row as a mutation-safe reference. */
export function entryRootRef(status: RootStatus, ordinal: number): RootRef {
  return { kind: 'entry', ordinal, id: status.id, path: status.path, addedAt: status.addedAt }
}

/**
 * Remove exactly ONE record — the one the reference names — from a status list.
 *
 * Removing by id is rejected when it is ambiguous. Exact entry or ordinal
 * references address one record, so a duplicate-id pair can be cleaned up one
 * entry at a time without turning one operation into several.
 * @param statuses - the statuses to remove from.
 * @param ref - which record to remove.
 * @returns a new list without that record, order preserved.
 * @throws {RootValidationError} `not-found` when the reference matches nothing.
 */
export function removeStatusAt(statuses: readonly RootStatus[], ref: RootRef): RootStatus[] {
  const index = resolveRootIndex(statuses, ref)
  return statuses.filter((_status, position) => position !== index)
}

/** Render one reference for messages. */
function describeRef(ref: RootRef): string {
  switch (ref.kind) {
    case 'id':
      return `id "${ref.id}"`
    case 'ordinal':
      return `#${ref.ordinal}`
    case 'path':
      return `"${ref.path}"`
    case 'entry':
      return `entry #${ref.ordinal} (${ref.path})`
  }
}
