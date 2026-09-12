/**
 * `MultiRootRegistry`: the durable answer to "which directories are extra
 * writable roots of this workspace".
 *
 * It is the M3 data source the M2 providers were already written against: the
 * registry owns the records, validates every mutation, re-validates everything
 * it reads back, and feeds the ONE place enforcement resolves from
 * (`ctx.multiRootScope`). Neither provider learns that a registry exists —
 * `setAdditionalRoots()` stays the scope's only write port.
 *
 * Four deliberate properties:
 *
 * - **Only usable roots are granted.** A registered directory that is absent
 *   right now stays registered and is reported as `missing`, but is withheld
 *   from the scope: handing a nonexistent root to bwrap or Landlock would fail
 *   the confined command instead of merely not granting it. A registration
 *   whose path now resolves to a DIFFERENT directory is `redirected` and is
 *   withheld for the same reason it was never granted: re-resolving a path is
 *   not re-authorizing it (see `src/scope.ts`).
 * - **Nothing is deleted on the operator's behalf.** A record that violates a
 *   rule is reported as `invalid` and excluded from the scope; it disappears
 *   only when the operator removes it (or when the store is repaired). Storage
 *   that cannot be parsed at all is backed up and skipped by the domain layer,
 *   with a warning.
 * - **Mutations are serialized per primary root.** Every mutation runs its
 *   whole read → validate → persist sequence inside one queue per key. The
 *   storage domain serializes individual `put()`/`delete()` calls, which is not
 *   enough: two concurrent `add()` calls would both read the same snapshot and
 *   the later write would drop the earlier one, and a removal racing an add
 *   could write a deleted record back.
 * - **Reads re-check, but never write.** {@link MultiRootRegistry.refresh} is
 *   the one revalidation entry point the command and the panel both call: it
 *   re-stats and re-canonicalizes every record, republishes the scope, and
 *   leaves storage untouched — a read must not rewrite the store, and a
 *   read-only refresh must not resurrect anything.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/registry
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  removeStatusAt,
  resolveRootRef,
  RootValidationError,
  validateRootCandidate,
  type AdditionalRootId,
  type RegisteredRoot,
  type RootRef,
  type RootStatus,
} from './roots.ts'
// Type-only: publishes the `ctx.multiRootScope` augmentation. The scope service
// is injected, never constructed here.
import type {} from './scope.ts'

/** The domain name; also the store file stem (`$DSH_HOME/storages/<name>.json`). */
export const DOMAIN_NAME = 'multi_root_workspace'
/** The single table name inside the domain. */
export const TABLE_NAME = 'roots'
/** Longest accepted display alias. */
export const MAX_ALIAS_LENGTH = 120

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootRegistry: MultiRootRegistry
  }
}

/** One persisted root record. `zod` validates it at the durable boundary. */
const persistedRoot = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  // Absent only in records written before the field existed (or by hand). Such a
  // record is reported `invalid` rather than granted on a guess — see
  // classifyStoredRoots.
  recordedPath: z.string().min(1).optional(),
  alias: z.string().optional(),
  addedAt: z.string().min(1),
})

/**
 * One primary root's whole registration list. The domain's `single` layout
 * stores the entire unit as one document, so keys stay opaque strings — which
 * is exactly what lets the canonical primary root itself be the key.
 */
const persistedPrimaryRoot = z.object({ roots: z.array(persistedRoot) })

/** Stored shape of one primary root's records. */
export type PersistedPrimaryRoot = z.infer<typeof persistedPrimaryRoot>

/** Stored shape of one root record. */
type PersistedRoot = z.infer<typeof persistedRoot>

/**
 * The domain declaration: version 1, `single` layout, one `roots` table keyed
 * by the canonical primary root. Records that fail validation are backed up and
 * skipped rather than blocking the whole harness from starting (see
 * docs/decisions/ADR-0004).
 */
export const multiRootDomainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { roots: domainTable<string, PersistedPrimaryRoot>(persistedPrimaryRoot) },
})

/** Registration request for one new additional root. */
export interface AddRootInput {
  /** The directory, as typed by the operator (a leading `~` is expanded). */
  readonly path: string
  /** Optional display alias. */
  readonly alias?: string
}

/** The registry service: `ctx.multiRootRegistry`. */
export class MultiRootRegistry extends Service {
  static inject = ['storageDomain', 'multiRootScope']

  /** The open table; present once the service has started. */
  private table?: KvTable<string, PersistedPrimaryRoot>
  /** Why the store is unusable, when it is; every mutation then fails loudly. */
  private failure?: string
  /** Last classified status list per canonical primary root. */
  private readonly cache = new Map<string, readonly RootStatus[]>()
  /** Signature of the last published grant per key, so a no-op refresh stays a no-op. */
  private readonly published = new Map<string, string>()
  /** One promise chain per canonical primary root: mutations never interleave. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Change listeners, keyed by their own disposer identity. */
  private readonly listeners = new Set<(primaryRoot: string) => void>()

  /**
   * @param ctx - the host context; `storageDomain` and `multiRootScope` are injected.
   */
  constructor(ctx: Context) {
    super(ctx, 'multiRootRegistry')
  }

  /**
   * Open the domain and publish every stored root into the scope.
   *
   * A store this build cannot read (corrupt records, a version written by a
   * different plugin version) is reported loudly and degrades to the empty
   * root set instead of failing activation: granting nothing is the safe
   * direction, and a broken side store must not keep the whole harness from
   * starting. Every mutation then reports `storage-unavailable` with that
   * reason until the file is repaired or removed.
   */
  protected async [Service.init](): Promise<void> {
    let domain
    try {
      domain = await this.ctx.storageDomain.open(multiRootDomainSpec)
    } catch (error: unknown) {
      this.failure = `${DOMAIN_NAME}: ${error instanceof Error ? error.message : String(error)}`
      this.ctx.logger.error(
        `multi-root-workspace: cannot open the root registry store (${DOMAIN_NAME});`
        + ' no additional root is granted until it is repaired or removed:'
        + ` ${this.failure}`,
      )
      return
    }
    this.ctx.effect(() => () => domain.close(), 'multi-root-registry: domain close')
    this.table = domain.table(TABLE_NAME)
    for (const [primaryRoot, record] of this.table.entries()) {
      this.accept(primaryRoot, record)
    }
  }

  /**
   * Why the store is unusable, when it is. Surfaces show this instead of a
   * silently empty list, so an operator can tell "no roots configured" from
   * "the configuration could not be read".
   * @returns the recorded failure text, or `undefined` while the store is healthy.
   */
  get unavailable(): string | undefined {
    return this.failure
  }

  /**
   * Every registration of one primary root, in registry order, as last
   * classified. A READ of the in-memory state: it never touches the filesystem
   * and never writes. Surfaces that must re-check the directories first call
   * {@link MultiRootRegistry.refresh}.
   * @param primaryRoot - the session workspace root (any spelling).
   * @returns the statuses; empty when nothing is registered.
   */
  list(primaryRoot: string): readonly RootStatus[] {
    return this.statusesOf(canonicalRoot(primaryRoot))
  }

  /**
   * Re-examine every registration of one primary root WITHOUT writing storage:
   * re-`stat` every directory, re-resolve every path against its recorded
   * directory, re-judge every rule, then republish the scope and notify
   * listeners.
   *
   * This is the one revalidation entry point the command (`/workspace-folders
   * list`) and the panel (`list` endpoint) both call, so "what the list shows"
   * and "what is granted" cannot drift: a directory deleted after registration
   * becomes `missing` and loses its grant, and a directory that came back is
   * granted again — without either surface asking for a restart.
   *
   * The serialized queue is shared with the mutations, so a refresh never
   * interleaves with a write that is mid-flight.
   * @param primaryRoot - the session workspace root to re-check.
   * @returns the refreshed status list.
   */
  async refresh(primaryRoot: string): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, () => this.reclassify(key))
  }

  /**
   * Registers one additional root.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param input - the directory and optional alias.
   * @returns the updated status list.
   * @throws {RootValidationError} when the candidate violates a root rule.
   */
  async add(primaryRoot: string, input: AddRootInput): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.statusesOf(key)
      const canonical = validateRootCandidate(input.path, {
        primaryRoot: key,
        // A withheld or unusable registration grants nothing, so it may not block
        // re-registering the very directory the operator is trying to restore.
        existing: availableRoots(statuses),
      })
      const alias = normalizeAlias(input.alias)
      // Reviving looks at BOTH spellings of an existing registration: the
      // canonical path it is stored under, and the path it currently resolves
      // to. Re-adding a directory that was replaced by a symlink therefore
      // updates the existing registration (re-recording what it is granted for)
      // instead of piling a second record for the same operator-given path on
      // top of it.
      const revived = statuses.findIndex(status =>
        status.path === canonical || canonicalRoot(status.path) === canonical)
      const next = revived === -1
        ? [...statuses, {
          id: additionalRootId(randomUUID()),
          path: canonical,
          recordedPath: canonical,
          state: 'available',
          ...(alias === undefined ? {} : { alias }),
          addedAt: new Date().toISOString(),
        } satisfies RootStatus]
        : statuses.map((status, index) => index === revived
          ? {
            ...status,
            path: canonical,
            // Re-registering a withheld root is the operator confirming THIS
            // directory again, which is exactly what re-records the grant.
            recordedPath: canonical,
            addedAt: new Date().toISOString(),
            ...(alias === undefined ? {} : { alias }),
          }
          : status)
      return await this.persist(key, next)
    })
  }

  /**
   * Remove one registration.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to remove.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found` when the reference matches nothing.
   */
  async remove(primaryRoot: string, ref: RootRef): Promise<readonly RootStatus[]> {
    return await this.removeAt(primaryRoot, ref)
  }

  /**
   * Remove exactly one registration — the one the reference names.
   *
   * Unlike a filter by id, this removes a single record, so a store holding two
   * records that share an id can be cleaned up one entry at a time instead of
   * losing both to one click.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to remove.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found` when the reference matches nothing.
   */
  async removeAt(primaryRoot: string, ref: RootRef): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => await this.persist(key, removeStatusAt(this.statusesOf(key), ref)))
  }

  /**
   * Set or clear one registration's display alias.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to rename.
   * @param alias - the new alias; empty or absent clears it.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found`/`invalid-alias`.
   */
  async setAlias(primaryRoot: string, ref: RootRef, alias: string | undefined): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.statusesOf(key)
      const target = resolveRootRef(statuses, ref)
      const normalized = normalizeAlias(alias)
      const next = statuses.map((status) => {
        if (status.id !== target.id) return status
        const { alias: _dropped, ...rest } = status
        return normalized === undefined ? rest : { ...rest, alias: normalized }
      })
      return await this.persist(key, next)
    })
  }

  /**
   * Move one registration within the display order.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to move.
   * @param beforeRef - the anchor to move in front of; absent moves it to the end.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found` when either reference matches nothing.
   */
  async move(primaryRoot: string, ref: RootRef, beforeRef?: RootRef): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.statusesOf(key)
      const target = resolveRootRef(statuses, ref)
      const anchor = beforeRef === undefined ? undefined : resolveRootRef(statuses, beforeRef)
      if (anchor !== undefined && anchor.id === target.id) return statuses
      const without = statuses.filter(status => status.id !== target.id)
      const index = anchor === undefined ? without.length : without.findIndex(status => status.id === anchor.id)
      const next = [...without.slice(0, index), target, ...without.slice(index)]
      return await this.persist(key, next)
    })
  }

  /**
   * Re-examine every registration of one primary root and persist what the
   * re-examination produced — {@link MultiRootRegistry.refresh} plus one durable
   * write. The recovery path after a directory was restored by hand, and the
   * only read-shaped operation that is allowed to touch the store.
   * @param primaryRoot - the session workspace root to re-check.
   * @returns the refreshed status list.
   */
  async recheck(primaryRoot: string): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => await this.persist(key, this.reclassify(key)))
  }

  /**
   * Observe registry changes.
   * @param listener - called with the canonical primary root after each durable change.
   * @returns the disposer that stops observing.
   */
  onChange(listener: (primaryRoot: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The scope the registry publishes: only usable roots, in registry order.
   * @param primaryRoot - the session workspace root (any spelling).
   * @returns the canonical paths of every `available` root.
   */
  granted(primaryRoot: string): readonly string[] {
    return availableRoots(this.statusesOf(canonicalRoot(primaryRoot)))
  }

  /**
   * The scope the registry publishes: only usable roots, in registry order.
   * @param policy - the per-call policy; its workspace root is the primary root.
   * @returns the granted canonical roots.
   */
  grantedFor(policy: SandboxExecutionPolicy): readonly string[] {
    return this.granted(policy.workspaceRoot)
  }

  /** Classify one stored record set and cache it. */
  private accept(primaryRoot: string, record: PersistedPrimaryRoot): readonly RootStatus[] {
    const key = canonicalRoot(primaryRoot)
    const statuses = classifyStoredRoots(key, record.roots.map(toRegisteredRoot))
    this.cache.set(key, statuses)
    this.publish(key, statuses)
    return statuses
  }

  /**
   * The statuses of one key, from memory where possible: the cache, else what
   * storage holds, else empty. A cached answer is never re-checked here — that
   * is {@link MultiRootRegistry.reclassify}, which the read surfaces and
   * {@link MultiRootRegistry.refresh} call deliberately.
   */
  private statusesOf(key: string): readonly RootStatus[] {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const record = this.lookupRecords(key)
    if (record === undefined) return []
    return this.accept(key, record)
  }

  /**
   * The stored record set of one key, or `undefined` when there is none (or
   * when the store itself could not be read: an unusable store reads as
   * "nothing registered" so reads stay answerable and the surfaces can explain
   * the situation, while every write fails loudly in `requireTable()`).
   */
  private lookupRecords(key: string): PersistedPrimaryRoot | undefined {
    if (this.failure !== undefined) return undefined
    return this.requireTable().get(key)
  }

  /**
   * Re-classify one key from its stored records: every directory is `stat`ed
   * again and every path is resolved again against its recorded canonical
   * directory. Updates the cache, republishes the scope, and returns the new
   * list — the shared body of the read-path re-checks.
   */
  private reclassify(key: string): readonly RootStatus[] {
    const record = this.lookupRecords(key)
    if (record === undefined) {
      this.cache.set(key, [])
      this.publish(key, [])
      return []
    }
    return this.accept(key, record)
  }

  /**
   * Persist one status list, then republish it into the scope and to listeners.
   * The durable write happens first: a failed write must not leave the running
   * scope granting something storage does not hold.
   */
  private async persist(key: string, statuses: readonly RootStatus[]): Promise<readonly RootStatus[]> {
    const table = this.requireTable()
    if (statuses.length === 0) await table.delete(key)
    else await table.put(key, { roots: statuses.map(toPersistedRoot) })
    const classified = statuses.length === 0 ? [] : classifyStoredRoots(key, statuses.map(toRegisteredRoot))
    this.cache.set(key, classified)
    this.publish(key, classified)
    return classified
  }

  /**
   * Run one job for one primary root after every job already queued for that
   * root. The whole read → validate → write sequence belongs inside the job:
   * the storage domain serializes individual writes, so without this the loser
   * of a race reads a snapshot that is already stale and writes it back.
   */
  private async serialize<T>(key: string, job: () => T | Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const run = previous.then(job)
    // The tail must never reject: a failed operation must not poison the queue
    // for the operations behind it.
    const tail = run.then(() => undefined, () => undefined)
    this.chains.set(key, tail)
    try {
      return await run
    } finally {
      // Drop the chain once it is idle, so a long-lived process does not keep
      // one entry per workspace it ever touched.
      if (this.chains.get(key) === tail) this.chains.delete(key)
    }
  }

  /**
   * Push one status list into the scope and notify listeners.
   *
   * What is published is the effective GRANT — only `available` roots, so a
   * withheld registration can never reach a provider. When the grant and the
   * withheld set are unchanged (the common case for a read-path refresh on a
   * healthy workspace) the scope is left alone and no listener fires: a refresh
   * exists to keep the two in sync, not to churn on every listing — and, since
   * the scope rebuilds its root table on each call, skipping the no-op write is
   * also what keeps the read path cheap.
   */
  private publish(key: string, statuses: readonly RootStatus[]): void {
    const withheld = statuses.filter(status => status.state !== 'available')
    const signature = [
      ...statuses.filter(status => status.state === 'available').map(status => `available:${status.recordedPath}`),
      ...withheld.map(status => `${status.state}:${status.path}`),
    ].join('\n')
    if (this.published.get(key) === signature) return
    this.published.set(key, signature)
    const effective: RegisteredRoot[] = statuses
      .filter(status => status.state === 'available')
      .map(status => toRegisteredRoot(status))
    this.ctx.multiRootScope.setAdditionalRoots(key, effective)
    if (withheld.length > 0) {
      this.ctx.logger.warn(
        `multi-root-workspace: ${withheld.length} registered root(s) of ${key} are not writable right now`
        + ` (${withheld.map(status => `${status.path}: ${status.state}`).join(', ')});`
        + ' they stay registered and are reported by /workspace-folders',
      )
    }
    for (const listener of this.listeners) listener(key)
  }

  /**
   * The open table.
   * @returns the live table.
   * @throws {RootValidationError} `storage-unavailable` when the store could
   *   not be opened at activation, or the service has not started.
   */
  private requireTable(): KvTable<string, PersistedPrimaryRoot> {
    if (this.failure !== undefined) {
      throw new RootValidationError(
        'storage-unavailable',
        `the root registry store is unavailable (${this.failure}); `
        + 'remove or repair $DSH_HOME/storages/' + DOMAIN_NAME + '.json and restart dsh',
      )
    }
    if (this.table === undefined) throw new Error('multi-root registry is not started yet')
    return this.table
  }
}

/** Project one status back to the durable record shape. */
function toPersistedRoot(status: RootStatus): PersistedRoot {
  return {
    id: status.id,
    path: status.path,
    recordedPath: status.recordedPath,
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    addedAt: status.addedAt,
  }
}

/** Recover the registered-root view of a stored record entry. */
function toRegisteredRoot(entry: PersistedRoot): RegisteredRoot {
  return {
    id: additionalRootId(entry.id),
    path: entry.path,
    // A record written before this field existed (or by hand) keeps whatever it
    // has: classification needs to SEE the absence to report it as invalid,
    // rather than have it papered over here.
    recordedPath: entry.recordedPath ?? '',
    ...(entry.alias === undefined ? {} : { alias: entry.alias }),
    addedAt: entry.addedAt,
  }
}

/**
 * Validate and normalize an optional display alias.
 * @param alias - the operator input; empty means "no alias".
 * @returns the trimmed alias, or `undefined`.
 * @throws {RootValidationError} `invalid-alias` for control characters or an over-long value.
 */
function normalizeAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined
  const trimmed = alias.trim()
  if (trimmed === '') return undefined
  // eslint-disable-next-line no-control-regex -- control characters must not reach the panel or the prompt.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RootValidationError('invalid-alias', 'an alias must not contain control characters')
  }
  if (trimmed.length > MAX_ALIAS_LENGTH) {
    throw new RootValidationError('invalid-alias', `an alias must be at most ${MAX_ALIAS_LENGTH} characters`)
  }
  return trimmed
}

export type { AdditionalRootId, RegisteredRoot, RootRef, RootStatus }
export default MultiRootRegistry
