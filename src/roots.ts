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
 * 5. `duplicate` — another registered root canonicalizes to the same path.
 * 6. `nested` — the candidate lies under a registered root, or contains one.
 *    A nested entry grants nothing the union did not already grant, while
 *    making the displayed list disagree with the enforced root set; M3
 *    therefore rejects it (see docs/decisions/ADR-0004).
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
  /** Optional display alias; absent when the operator cleared it. */
  readonly alias?: string
  /** ISO-8601 instant of registration. */
  readonly addedAt: string
}

/**
 * How one stored record currently stands. `missing` keeps the registration
 * (the directory may come back) while withholding the grant; `invalid` marks a
 * record that violates a rule and can only be removed.
 */
export type RootState = 'available' | 'missing' | 'invalid'

/** One registered root as the surfaces report it. */
export interface RootStatus extends RegisteredRoot {
  /** Whether the root is granted right now, withheld, or unusable. */
  readonly state: RootState
  /** Why the root is not `available`; absent otherwise. */
  readonly detail?: string
}

/** How a caller names one registered root: by id, by path, or by 1-based ordinal. */
export type RootRef =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'ordinal'; readonly ordinal: number }

/** Every way root handling can fail, as a stable code the surfaces localize. */
export type RootValidationCode =
  | 'not-absolute'
  | 'missing'
  | 'not-a-directory'
  | 'equals-primary'
  | 'duplicate'
  | 'nested'
  | 'invalid-alias'
  | 'not-found'
  | 'invalid-ref'
  | 'storage-unavailable'

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
  /** The session's workspace root; the candidate may not equal it. */
  readonly primaryRoot: string
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
 * @returns the canonical path the caller must store.
 * @throws {RootValidationError} with the first rule that failed.
 */
export function validateRootCandidate(raw: string, context: RootCandidateContext): string {
  const expanded = expandRootInput(raw)
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
  if (comparable(canonical) === comparable(primaryRoot)) {
    throw new RootValidationError(
      'equals-primary',
      `"${canonical}" is this session's workspace root and is already writable`,
      { conflict: primaryRoot, reference: canonical },
    )
  }
  for (const existing of context.existing) {
    if (comparable(canonical) === comparable(existing)) {
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
 * Re-judge every stored record of one primary root — the startup path, which
 * must never throw: a registration that stopped being usable is REPORTED, not
 * deleted, so the operator can see it and remove it deliberately.
 *
 * Existence is the only rule a record may recover from on its own, hence
 * `missing` (kept, withheld) rather than `invalid` (kept, unusable).
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
  const statuses: RootStatus[] = []
  for (const record of records) {
    statuses.push(classifyStoredRoot(record, primary, claimed))
    const status = statuses[statuses.length - 1]
    if (status !== undefined && status.state === 'available') claimed.push(status.path)
  }
  return statuses
}

/** Judge one stored record against the primary root and the roots claimed before it. */
function classifyStoredRoot(record: RegisteredRoot, primary: string, claimed: readonly string[]): RootStatus {
  const invalid = (detail: string): RootStatus => ({ ...record, state: 'invalid', detail })
  if (typeof record.path !== 'string' || record.path === '') return invalid('the record has no path')
  if (typeof record.id !== 'string' || record.id === '') return invalid('the record has no id')
  if (!isAbsolute(record.path)) return invalid(`"${record.path}" is not an absolute path`)
  const canonical = canonicalRoot(record.path)
  if (comparable(canonical) === comparable(primary)) {
    return invalid(`"${canonical}" is this session's workspace root`)
  }
  if (claimed.some(existing => comparable(existing) === comparable(canonical))) {
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
 * Resolve one operator-supplied reference against a status list.
 * @param statuses - the statuses to search, in registry order.
 * @param ref - the reference to resolve.
 * @returns the matched status.
 * @throws {RootValidationError} `not-found` when nothing matches.
 */
export function resolveRootRef(statuses: readonly RootStatus[], ref: RootRef): RootStatus {
  const reference = describeRef(ref)
  const matched = ((): RootStatus | undefined => {
    switch (ref.kind) {
      case 'id':
        return statuses.find(status => status.id === ref.id)
      case 'ordinal':
        return ref.ordinal >= 1 && ref.ordinal <= statuses.length ? statuses[ref.ordinal - 1] : undefined
      case 'path': {
        const canonical = canonicalRoot(expandRootInput(ref.path))
        return statuses.find(status => comparable(status.path) === comparable(canonical))
      }
    }
  })()
  if (matched === undefined) {
    throw new RootValidationError('not-found', `no registered root matches ${reference}`, { reference })
  }
  return matched
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
  }
}
