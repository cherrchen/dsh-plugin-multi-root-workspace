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
 * Two deliberate properties:
 *
 * - **Only usable roots are granted.** A registered directory that is absent
 *   right now stays registered and is reported as `missing`, but is withheld
 *   from the scope: handing a nonexistent root to bwrap or Landlock would fail
 *   the confined command instead of merely not granting it.
 * - **Nothing is deleted on the operator's behalf.** A record that violates a
 *   rule is reported as `invalid` and excluded from the scope; it disappears
 *   only when the operator removes it (or when the store is repaired). Storage
 *   that cannot be parsed at all is backed up and skipped by the domain layer,
 *   with a warning.
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
   * Every registration of one primary root, in registry order.
   * @param primaryRoot - the session workspace root (any spelling).
   * @returns the statuses; empty when nothing is registered.
   */
  list(primaryRoot: string): readonly RootStatus[] {
    return this.statusesOf(canonicalRoot(primaryRoot))
  }

  /**
   * The canonical paths granted right now — the projection the scope receives.
   * @param primaryRoot - the session workspace root (any spelling).
   * @returns the canonical paths of every `available` root.
   */
  granted(primaryRoot: string): readonly string[] {
    return availableRoots(this.statusesOf(canonicalRoot(primaryRoot)))
  }

  /**
   * Register one additional root.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param input - the directory and optional alias.
   * @returns the updated status list.
   * @throws {RootValidationError} when the candidate violates a root rule.
   */
  async add(primaryRoot: string, input: AddRootInput): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    const statuses = this.statusesOf(key)
    const canonical = validateRootCandidate(input.path, {
      primaryRoot: key,
      // A withheld or unusable registration grants nothing, so it may not block
      // re-registering the very directory the operator is trying to restore.
      existing: availableRoots(statuses),
    })
    const alias = normalizeAlias(input.alias)
    const revived = statuses.findIndex(status => canonicalRoot(status.path) === canonical)
    const next = revived === -1
      ? [...statuses, {
        id: additionalRootId(randomUUID()),
        path: canonical,
        state: 'available',
        ...(alias === undefined ? {} : { alias }),
        addedAt: new Date().toISOString(),
      } satisfies RootStatus]
      : statuses.map((status, index) => index === revived
        ? {
          ...status,
          path: canonical,
          addedAt: new Date().toISOString(),
          ...(alias === undefined ? {} : { alias }),
        }
        : status)
    return await this.commit(key, next)
  }

  /**
   * Remove one registration.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to remove.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found` when the reference matches nothing.
   */
  async remove(primaryRoot: string, ref: RootRef): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    const target = resolveRootRef(this.statusesOf(key), ref)
    const next = this.statusesOf(key).filter(status => status.id !== target.id)
    return await this.commit(key, next)
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
    const target = resolveRootRef(this.statusesOf(key), ref)
    const normalized = normalizeAlias(alias)
    const next = this.statusesOf(key).map((status) => {
      if (status.id !== target.id) return status
      const { alias: _dropped, ...rest } = status
      return normalized === undefined ? rest : { ...rest, alias: normalized }
    })
    return await this.commit(key, next)
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
    const statuses = this.statusesOf(key)
    const target = resolveRootRef(statuses, ref)
    const anchor = beforeRef === undefined ? undefined : resolveRootRef(statuses, beforeRef)
    if (anchor !== undefined && anchor.id === target.id) return statuses
    const without = statuses.filter(status => status.id !== target.id)
    const index = anchor === undefined ? without.length : without.findIndex(status => status.id === anchor.id)
    const next = [...without.slice(0, index), target, ...without.slice(index)]
    return await this.commit(key, next)
  }

  /**
   * Re-examine every registration of one primary root — the recovery path
   * after a directory was restored by hand.
   * @param primaryRoot - the session workspace root to re-check.
   * @returns the refreshed status list.
   */
  async recheck(primaryRoot: string): Promise<readonly RootStatus[]> {
    const key = canonicalRoot(primaryRoot)
    return await this.commit(key, this.statusesOf(key))
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

  /** The statuses of one key: the cache, else what storage holds, else empty. */
  private statusesOf(key: string): readonly RootStatus[] {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    // An unusable store reads as "nothing registered": reads stay answerable so
    // the surfaces can explain the situation, while every write fails loudly in
    // requireTable().
    if (this.failure !== undefined) return []
    const record = this.requireTable().get(key)
    if (record === undefined) return []
    return this.accept(key, record)
  }

  /**
   * Persist one status list, then republish it into the scope and to listeners.
   * The durable write happens first: a failed write must not leave the running
   * scope granting something storage does not hold.
   */
  private async commit(key: string, statuses: readonly RootStatus[]): Promise<readonly RootStatus[]> {
    const table = this.requireTable()
    if (statuses.length === 0) await table.delete(key)
    else await table.put(key, { roots: statuses.map(toPersistedRoot) })
    const classified = statuses.length === 0 ? [] : classifyStoredRoots(key, statuses.map(toRegisteredRoot))
    this.cache.set(key, classified)
    this.publish(key, classified)
    return classified
  }

  /** Push one status list into the scope and notify listeners. */
  private publish(key: string, statuses: readonly RootStatus[]): void {
    const effective: RegisteredRoot[] = statuses
      .filter(status => status.state === 'available')
      .map(status => toRegisteredRoot(status))
    this.ctx.multiRootScope.setAdditionalRoots(key, effective)
    const withheld = statuses.filter(status => status.state !== 'available')
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
function toPersistedRoot(status: RootStatus): RegisteredRoot {
  return {
    id: status.id,
    path: status.path,
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    addedAt: status.addedAt,
  }
}

/** Recover the registered-root view of a stored record entry. */
function toRegisteredRoot(entry: PersistedRoot): RegisteredRoot {
  return {
    id: additionalRootId(entry.id),
    path: entry.path,
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
