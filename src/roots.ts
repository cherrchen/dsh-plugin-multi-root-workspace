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
 * 8. `unsupported-path` — on Windows, a network or device path (`\\server`,
 *    `\\?\…`, `\\.\…`): the ACL confinement cannot be shown to cover it, so it
 *    is rejected lexically before any filesystem touch.
 *
 * The stored side of the same rules lives in {@link classifyStoredRoots}, which
 * must never throw: a registration that stopped being usable is REPORTED, not
 * deleted, so the operator can see it and remove it deliberately. It runs in
 * two passes — every record's own structural trust and availability first,
 * then overlap between the RECORDED boundaries of all structurally sound
 * records — so the answer never depends on registry order, and a pair of
 * records whose grants collide (`membership-conflict`) keeps its trustworthy
 * negative boundary even while its membership is withheld.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/roots
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

// The predicate lives in the standalone runner's contract module: its whole
// static graph may import node builtins only. Re-exported so the established
// import sites (`roots.ts` readers, `windows-profile.ts`) keep working.
import { isWindowsNetworkOrDevicePath } from './windows-runner-contract.ts'
export { isWindowsNetworkOrDevicePath }

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

/**
 * The write authority one registration carries (B9, ADR-0017).
 *
 * - `inherit` — the root follows the session mode: writable under
 *   `workspace-write` and unrestricted under `danger-full-access`, read-only
 *   under `read-only`. This is what legacy `recordedPath` records mean.
 * - `read-only` — the root stays a workspace member (instructions, LSP,
 *   workspace-file routing, and reads all still see it) but a write is refused
 *   under EVERY mode, including `danger-full-access`.
 * - `read-write` — the root is writable under EVERY mode, including a global
 *   `read-only` session; it does not widen anything beyond its own directory.
 */
export type RootAccess = 'inherit' | 'read-write' | 'read-only'

/** One registered additional root exactly as it is persisted. */
export interface RegisteredRoot {
  /** Stable registry identity. */
  readonly id: AdditionalRootId
  /** Canonical absolute directory (the `realpath` captured at registration). */
  readonly path: string
  /**
   * The write authority this registration carries. In memory every record has
   * exactly one value; on disk it is expressed by WHICH grant field is
   * present — `recordedPath` means `inherit`, `readOnlyRecordedPath` means
   * `read-only`, `readWriteRecordedPath` means `read-write` — never by a
   * separate `access` key (see `registry.ts` for the downgrade safety that
   * split buys).
   */
  readonly access: RootAccess
  /**
   * The canonical directory this INHERIT registration was GRANTED for: the
   * `realpath` observed when the operator registered it (or the last time the
   * operator restored it). Authorization is `canonicalPath(path) ===
   * recordedPath` — a root whose current resolution moved somewhere else is
   * reported as `redirected` and withheld, never silently granted elsewhere.
   */
  readonly recordedPath?: string
  /**
   * The canonical directory this READ-ONLY registration was granted for. It
   * plays exactly the role `recordedPath` plays for an inherit record, kept
   * under a separate key so the single persisted layout stays downgrade-safe.
   */
  readonly readOnlyRecordedPath?: string
  /**
   * The canonical directory this fixed READ-WRITE registration was granted
   * for. Same role as the other two grant fields, under its own key: an older
   * plugin strips the unknown field and classifies the record `invalid`
   * rather than granting it as a legacy `recordedPath` write.
   */
  readonly readWriteRecordedPath?: string
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
 * - `invalid` — the record violates a rule and can only be removed. Whether the
 *   violation also voids the record's negative boundary is told apart by
 *   {@link RootStatus.invalidReason}.
 */
export type RootState = 'available' | 'missing' | 'redirected' | 'invalid'

/** One registered root as the surfaces report it. */
export interface RootStatus extends RegisteredRoot {
  /** Whether the root is granted right now, withheld, or unusable. */
  readonly state: RootState
  /** Why the root is not `available`; absent otherwise. */
  readonly detail?: string
  /**
   * Distinguishes WHY an `invalid` record is unusable. Internal only: it is
   * neither persisted nor sent over the panel wire — `state` and `detail`
   * carry everything a surface needs.
   *
   * `'membership-conflict'` means the record passed every structural rule —
   * including an intact, absolute recorded grant — but its recorded boundary
   * overlaps another record's. Neither membership may be granted while the
   * conflict stands, yet the boundary remains a trustworthy negative
   * restriction, so {@link reservedRootBoundary} keeps it reserved and the
   * registry publishes the root as a withheld, deny-only entry. Every other
   * `invalid` verdict left the grant unverifiable, so it contributes nothing.
   */
  readonly invalidReason?: 'membership-conflict'
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
  | 'registry-contended'
  | 'root-limit-reached'
  | 'config-invalid'
  | 'reveal-unavailable'
  | 'session-not-found'
  | 'unsupported-path'
  | 'root-unavailable'

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
   * The platform the rules run for; defaults to `process.platform`. A caller
   * (a test, a probe) may exercise another platform's rules — notably the
   * Windows network/device-path refusal — on any host.
   */
  readonly platform?: NodeJS.Platform
  /**
   * The recorded boundaries already reserved: {@link reservedRootBoundary}
   * applied to every other status — available, missing, redirected, and
   * membership-conflict records alike. A withheld root grants nothing, but
   * its recorded boundary is the negative restriction a new writable root
   * must not swallow while the operator has not removed it. Only a
   * structurally invalid record contributes nothing, and the row being
   * revived exempts only itself.
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
  const platform = context.platform ?? process.platform
  if (platform === 'win32' && isWindowsNetworkOrDevicePath(expanded)) {
    throw unsupportedPath(expanded)
  }
  const canonical = canonicalRoot(expanded)
  // The canonical spelling is judged too: realpath turns a mapped network
  // drive letter into its \\server\share form.
  if (platform === 'win32' && isWindowsNetworkOrDevicePath(canonical)) {
    throw unsupportedPath(expanded)
  }
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

/** The `unsupported-path` refusal, shared by the input and canonical checks. */
function unsupportedPath(asTyped: string): RootValidationError {
  return new RootValidationError(
    'unsupported-path',
    `"${asTyped}" is a network or device path, which Windows ACL confinement cannot cover`,
    { reference: asTyped },
  )
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
 * @param platform - the platform the rules run for; defaults to `process.platform`.
 * @returns one status per record, in the same order.
 */
export function classifyStoredRoots(
  primaryRoot: string,
  records: readonly RegisteredRoot[],
  platform: NodeJS.Platform = process.platform,
): RootStatus[] {
  const primary = canonicalRoot(primaryRoot)
  const duplicated = duplicatedIds(records)
  // Pass one judges each record alone — structural trust, the primary-root
  // rules on the RECORDED boundary, and current availability. Neither
  // registration order nor another record's verdict participates, so a
  // cosmetic `move` can never change who is granted.
  const statuses = records.map((record, index) =>
    classifyStoredRoot(record, primary, duplicated.has(record.id), index, platform))
  return markMembershipConflicts(statuses)
}

/**
 * Pass two of {@link classifyStoredRoots}: every pair of structurally sound
 * records whose RECORDED boundaries overlap is a membership conflict, and
 * BOTH are unusable — which side "won" must never depend on registry order
 * (a reorder is cosmetic and cannot revoke a deny boundary). Missing and
 * redirected records participate too: withheld roots carry no grant, but
 * their recorded boundaries still describe restrictions the operator has not
 * removed.
 *
 * The comparison is lexical over the recorded grant via
 * {@link isCanonicallyUnder}/{@link samePath} — never the current resolution,
 * which a replaced directory can steer. The conflict set is built from the
 * ORIGINAL first-pass statuses, so a third overlapping record is marked even
 * when the pair found first was already doomed.
 */
function markMembershipConflicts(statuses: readonly RootStatus[]): RootStatus[] {
  // A structurally invalid record carries no trustworthy boundary: its fields
  // can claim nothing — no membership, and no deny either.
  const boundaries = statuses.map(status => (status.state === 'invalid' ? undefined : singleGrantOf(status)))
  const conflicts = new Map<number, string[]>()
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]
    if (boundary === undefined) continue
    for (let other = index + 1; other < boundaries.length; other += 1) {
      const otherBoundary = boundaries[other]
      if (otherBoundary === undefined) continue
      if (samePath(boundary, otherBoundary)
        || isCanonicallyUnder(boundary, otherBoundary)
        || isCanonicallyUnder(otherBoundary, boundary)) {
        conflicts.set(index, [...(conflicts.get(index) ?? []), otherBoundary])
        conflicts.set(other, [...(conflicts.get(other) ?? []), boundary])
      }
    }
  }
  if (conflicts.size === 0) return [...statuses]
  return statuses.map((status, index) => {
    const others = conflicts.get(index)
    if (others === undefined) return status
    const boundary = boundaries[index]!
    const partners = others.map(other => `"${other}"`).join(', ')
    return {
      ...status,
      state: 'invalid',
      invalidReason: 'membership-conflict',
      detail: `the recorded grant "${boundary}" overlaps the recorded grant ${partners} — `
        + 'neither membership is granted until one registration is removed, '
        + 'and any recorded read-only restriction remains in force',
    }
  })
}

/**
 * The single recorded grant a record or status carries — `undefined` unless
 * EXACTLY one grant field holds a non-empty string. Shared by the conflict
 * pass and {@link reservedRootBoundary}; the stored decoder is the source of
 * the access level, so this never cross-checks the field against `access`.
 */
function singleGrantOf(record: {
  readonly recordedPath?: string
  readonly readOnlyRecordedPath?: string
  readonly readWriteRecordedPath?: string
}): string | undefined {
  const grants = [record.recordedPath, record.readOnlyRecordedPath, record.readWriteRecordedPath]
    .filter((grant): grant is string => typeof grant === 'string' && grant !== '')
  return grants.length === 1 ? grants[0] : undefined
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
 * Judge one stored record's structural trust and current availability —
 * WITHOUT looking at any other record (record-vs-record overlap is the second
 * pass of {@link classifyStoredRoots}).
 *
 * Identity and the recorded directory are checked BEFORE the current
 * resolution is used for anything: a record whose path now resolves elsewhere
 * must not have its new (attacker-influenced) target participate in the
 * overlap rules. The primary-root rules therefore judge the RECORDED
 * boundary — the directory the operator was granted — not what `path`
 * resolves to today.
 */
function classifyStoredRoot(
  record: RegisteredRoot,
  primary: string,
  duplicatedId: boolean,
  position: number,
  platform: NodeJS.Platform,
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
  // A record may carry at most ONE grant field: `recordedPath` means
  // `inherit`, `readOnlyRecordedPath` means `read-only`, and
  // `readWriteRecordedPath` means `read-write` (ADR-0017). A record naming
  // more than one claims different access levels at once — it classifies
  // `invalid`, because silently picking one would turn a corrupted store
  // into a grant.
  const grants = [record.recordedPath, record.readOnlyRecordedPath, record.readWriteRecordedPath]
    .filter((grant): grant is string => typeof grant === 'string' && grant !== '')
  if (grants.length > 1) {
    return invalid('the record declares more than one grant (ambiguous access)')
  }
  const recorded = grants[0]
  if (typeof recorded !== 'string' || recorded === '') {
    return invalid('the record does not say which directory it was granted for')
  }
  // The recorded boundary feeds every overlap rule — against the primary root
  // here, against other records in pass two — so it must be an absolute
  // canonical spelling. A non-absolute one can claim nothing and contributes
  // nothing (no membership, no deny).
  if (!isAbsolute(recorded)) {
    return invalid(`the recorded grant "${recorded}" is not an absolute path`)
  }
  // A network or device path is judged lexically, BEFORE re-resolving it:
  // canonicalizing a UNC path would touch the filesystem (and the network).
  if (platform === 'win32' && (isWindowsNetworkOrDevicePath(record.path) || isWindowsNetworkOrDevicePath(recorded))) {
    return invalid(`"${record.path}" is a network or device path, which Windows ACL confinement cannot cover`)
  }
  // The primary-root rules judge the recorded boundary BEFORE the redirect
  // check resolves `path`: the current resolution is attacker-influenceable,
  // the recorded grant is not. A record whose grant was the workspace root —
  // or inside it, or containing it — is unusable no matter where `path`
  // points now.
  if (samePath(recorded, primary)) {
    return invalid(`"${recorded}" is this session's workspace root`)
  }
  if (isCanonicallyUnder(recorded, primary) || isCanonicallyUnder(primary, recorded)) {
    return invalid(`"${recorded}" overlaps this session's workspace root`)
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
 * The recorded boundary one status still RESERVES: the grant it was
 * registered for, which a new or revived registration may not overlap merely
 * because the root is currently unusable.
 *
 * `available`, `missing`, `redirected`, and membership-conflict statuses all
 * carry an intact, trustworthy recorded grant; every other `invalid` verdict
 * means the grant could not be parsed at all, so it reserves — and denies —
 * nothing. This is not an independent authorization table: it derives the
 * boundary from the status list {@link classifyStoredRoots} produced, with
 * the same grant-extraction semantics, so its answer can never disagree with
 * classification.
 * @param status - one classified registration.
 * @returns the absolute recorded boundary, or `undefined` when there is none.
 */
export function reservedRootBoundary(status: RootStatus): string | undefined {
  if (status.state === 'invalid' && status.invalidReason !== 'membership-conflict') return undefined
  const boundary = singleGrantOf(status)
  return boundary !== undefined && isAbsolute(boundary) ? boundary : undefined
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
