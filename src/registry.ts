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
 * Five deliberate properties:
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
 * - **One process is the Registry Authority.** The JSON backend is
 *   memory-authoritative after open, so two DSH processes sharing a storage
 *   root cannot each keep a live domain snapshot. A store-wide kernel lease
 *   (ADR-0007) elects one authority; a contended process publishes an empty
 *   scope, rejects mutations, and retries the lease from {@link MultiRootRegistry.refresh}.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/registry
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from './registry-lease.ts'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  removeStatusAt,
  resolveRootIndex,
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
/**
 * Operator-facing English for a contended lease. Host-side commands have no
 * locale; the panel also shows this string verbatim via `RootsView.unavailable`.
 */
export const REGISTRY_CONTENDED_MESSAGE
  = 'the root registry is owned by another DSH process; additional roots are not granted here. Close the other process, then retry.'

/**
 * Whether this process is the Registry Authority for the store-wide domain
 * medium. Contended and storage-failed are both fail-closed: the scope stays
 * empty and mutations reject.
 */
export type RegistryAuthorityState =
  | { readonly kind: 'active' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'storage-failed'; readonly reason: string }

/**
 * Plugin configuration for the registry row. `leasePath` must sit beside the
 * JSON backend's domain document; the patch default is
 * `$DSH_HOME/storages/multi_root_workspace.lock`. A custom `storage-json.root`
 * must override this in lockstep (ADR-0007).
 */
export interface Config {
  /** Absolute path of the store-wide kernel lock file. */
  readonly leasePath?: string
}

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

  /** Absolute lock path; absent means the row was composed without `leasePath`. */
  private readonly leasePath: string | undefined
  /** Whether this process currently owns the store. */
  private authorityState: RegistryAuthorityState = { kind: 'contended' }
  /** Held kernel lease; present once acquire succeeded, including after a failed open. */
  private lease: RegistryAuthorityLease | undefined
  /** Open domain handle; present only while {@link authority} is `active`. */
  private domain: { close(): Promise<void> } | undefined
  /** The open table; present once this process is the authority. */
  private table: KvTable<string, PersistedPrimaryRoot> | undefined
  /** Last classified status list per canonical primary root. */
  private readonly cache = new Map<string, readonly RootStatus[]>()
  /** Signature of the last published grant per key, so a no-op refresh stays a no-op. */
  private readonly published = new Map<string, string>()
  /** One promise chain per canonical primary root: mutations never interleave. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Store-wide queue for lease acquire / open / release. */
  private authorityChain: Promise<unknown> = Promise.resolve()
  /** Change listeners, keyed by their own disposer identity. */
  private readonly listeners = new Set<(primaryRoot: string) => void>()
  /** True after a contended-lease warning has been emitted, so refresh does not spam. */
  private loggedContended = false

  /**
   * @param ctx - the host context; `storageDomain` and `multiRootScope` are injected.
   * @param config - the patch row's `leasePath`.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'multiRootRegistry')
    this.leasePath = config.leasePath
  }

  /**
   * Become the Registry Authority if possible: acquire the store-wide lease,
   * then open the domain and publish every stored root into the scope.
   *
   * A contended lease is fail-closed rather than a stale open: this process
   * grants nothing and every mutation reports `registry-contended`. A store
   * this build cannot read is reported loudly and also grants nothing. Neither
   * case fails activation — a broken or contended side store must not keep the
   * whole harness from starting. {@link MultiRootRegistry.refresh} retries.
   */
  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => this.releaseAuthority(), 'multi-root-registry: authority release')
    await this.ensureAuthority()
  }

  /**
   * Why the registry is not granting, when it is not. Surfaces show this
   * instead of a silently empty list, so an operator can tell "no roots
   * configured" from "another DSH process owns the store" or "the file could
   * not be read".
   * @returns the recorded failure text, or `undefined` while this process is the authority.
   */
  get unavailable(): string | undefined {
    switch (this.authorityState.kind) {
      case 'active':
        return undefined
      case 'contended':
        return REGISTRY_CONTENDED_MESSAGE
      case 'storage-failed':
        return this.authorityState.reason
    }
  }

  /**
   * Whether this process is the Registry Authority for the store-wide medium.
   * Tests and diagnostics read this; surfaces use {@link unavailable}.
   */
  get authority(): RegistryAuthorityState {
    return this.authorityState
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
   *
   * Refresh is also the takeover path: it calls {@link MultiRootRegistry.ensureAuthority}
   * first, so a process that started contended can become the authority after
   * the previous holder exits, re-open the domain from disk, and publish the
   * last durable state — without a restart.
   * @param primaryRoot - the session workspace root to re-check.
   * @returns the refreshed status list.
   */
  async refresh(primaryRoot: string): Promise<readonly RootStatus[]> {
    await this.ensureAuthority()
    if (this.authorityState.kind !== 'active') return []
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
    await this.ensureAuthority()
    this.requireActive()
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
    await this.ensureAuthority()
    this.requireActive()
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
    await this.ensureAuthority()
    this.requireActive()
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.statusesOf(key)
      const targetIndex = resolveRootIndex(statuses, ref)
      const normalized = normalizeAlias(alias)
      const next = statuses.map((status, index) => {
        if (index !== targetIndex) return status
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
    await this.ensureAuthority()
    this.requireActive()
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.statusesOf(key)
      const targetIndex = resolveRootIndex(statuses, ref)
      const anchorIndex = beforeRef === undefined ? undefined : resolveRootIndex(statuses, beforeRef)
      if (anchorIndex === targetIndex) return statuses
      const target = statuses[targetIndex]!
      const without = statuses.filter((_status, index) => index !== targetIndex)
      const adjustedAnchor = anchorIndex === undefined
        ? without.length
        : anchorIndex - (targetIndex < anchorIndex ? 1 : 0)
      const next = [...without.slice(0, adjustedAnchor), target, ...without.slice(adjustedAnchor)]
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
    await this.ensureAuthority()
    this.requireActive()
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
    if (this.authorityState.kind !== 'active') return undefined
    return this.table?.get(key)
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
    else {
      // Validate the COMPLETE document before crossing the durable boundary.
      // In particular, legacy records keep an absent `recordedPath` absent;
      // they must never be rewritten as the schema-invalid empty string.
      const durable = persistedPrimaryRoot.parse({ roots: statuses.map(toPersistedRoot) })
      await table.put(key, durable)
    }
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
    const effective = statuses.flatMap(status => {
      if (status.state !== 'available' || status.recordedPath === undefined) return []
      return [{
        id: status.id,
        path: status.path,
        recordedPath: status.recordedPath,
        ...(status.alias === undefined ? {} : { alias: status.alias }),
      }]
    })
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
   * @throws {RootValidationError} `registry-contended` when another DSH process
   *   owns the store, `storage-unavailable` when the store could not be opened,
   *   or an error when the service has not started.
   */
  private requireTable(): KvTable<string, PersistedPrimaryRoot> {
    if (this.authorityState.kind === 'contended') {
      throw new RootValidationError('registry-contended', REGISTRY_CONTENDED_MESSAGE)
    }
    if (this.authorityState.kind === 'storage-failed') {
      throw new RootValidationError(
        'storage-unavailable',
        `the root registry store is unavailable (${this.authorityState.reason}); `
        + 'remove or repair $DSH_HOME/storages/' + DOMAIN_NAME + '.json and restart dsh',
      )
    }
    if (this.table === undefined) throw new Error('multi-root registry is not started yet')
    return this.table
  }

  /**
   * Reject mutations unless this process is the Registry Authority.
   * Called before path validation so a contended process never mis-reports
   * `missing` / `not-absolute` for a directory it is not allowed to register.
   */
  private requireActive(): void {
    this.requireTable()
  }

  /**
   * Acquire the store-wide lease if this process does not already hold it, then
   * open the domain from disk. Idempotent while active. A contended process
   * retries here (the command `list` and the panel Retry button both call
   * {@link MultiRootRegistry.refresh}).
   */
  private async ensureAuthority(): Promise<void> {
    await this.serializeAuthority(async () => {
      if (this.authorityState.kind === 'active') return
      if (this.lease !== undefined) {
        await this.openDomain()
        return
      }
      const leasePath = this.leasePath
      if (leasePath === undefined || leasePath === '') {
        this.enterStorageFailed(
          `${DOMAIN_NAME}: leasePath is not configured; set it next to storage-json.root `
          + `(default $DSH_HOME/storages/${DOMAIN_NAME}.lock)`,
        )
        return
      }
      if (!isAbsolute(leasePath)) {
        this.enterStorageFailed(`${DOMAIN_NAME}: leasePath must be an absolute path`)
        return
      }
      try {
        this.lease = await RegistryAuthorityLease.acquire(leasePath)
      } catch (error: unknown) {
        if (error instanceof RegistryLeaseContendedError) {
          this.enterContended()
          return
        }
        this.enterStorageFailed(
          `${DOMAIN_NAME}: cannot acquire the registry lease: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      await this.openDomain()
    })
  }

  /**
   * Open the domain under an already-held lease and publish every stored root.
   * On failure the lease is kept so a later refresh can retry the open without
   * letting a second process grant from a stale snapshot.
   */
  private async openDomain(): Promise<void> {
    let domain
    try {
      domain = await this.ctx.storageDomain.open(multiRootDomainSpec)
    } catch (error: unknown) {
      const reason = `${DOMAIN_NAME}: ${error instanceof Error ? error.message : String(error)}`
      this.ctx.logger.error(
        `multi-root-workspace: cannot open the root registry store (${DOMAIN_NAME});`
        + ' no additional root is granted until it is repaired or removed:'
        + ` ${reason}`,
      )
      this.enterStorageFailed(reason)
      return
    }
    this.domain = domain
    this.table = domain.table(TABLE_NAME)
    this.authorityState = { kind: 'active' }
    this.loggedContended = false
    this.cache.clear()
    this.published.clear()
    for (const [primaryRoot, record] of this.table.entries()) {
      this.accept(primaryRoot, record)
    }
  }

  /** Fail closed: empty scope, no table, contended state. */
  private enterContended(): void {
    this.withdrawPublished()
    this.table = undefined
    this.authorityState = { kind: 'contended' }
    if (!this.loggedContended) {
      this.loggedContended = true
      this.ctx.logger.warn(
        'multi-root-workspace: registry lease is held by another DSH process;'
        + ' additional roots are not granted here until it exits and this process refreshes',
      )
    }
  }

  /** Fail closed: empty scope, no table, storage-failed state. The lease, if held, stays. */
  private enterStorageFailed(reason: string): void {
    this.withdrawPublished()
    this.table = undefined
    this.authorityState = { kind: 'storage-failed', reason }
  }

  /** Drop every grant this process has published. Idempotent. */
  private withdrawPublished(): void {
    for (const key of this.published.keys()) {
      this.ctx.multiRootScope.setAdditionalRoots(key, [])
    }
    this.published.clear()
    this.cache.clear()
  }

  /**
   * Close the domain and release the kernel lease. The fiber disposer; also the
   * exclusive owner of those two resources. The lease is dropped before the
   * first `await` so a disposer that is not awaited still frees the kernel lock
   * before the next stack mounts.
   */
  private async releaseAuthority(): Promise<void> {
    this.withdrawPublished()
    this.table = undefined
    const lease = this.lease
    this.lease = undefined
    this.authorityState = { kind: 'contended' }
    if (lease !== undefined) {
      try {
        await lease.release()
      } catch {
        // Kernel release on process death is the fallback.
      }
    }
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) {
      try {
        await domain.close()
      } catch {
        // Dispose must not throw through the fiber.
      }
    }
  }

  /**
   * Run one authority-transition job after every job already queued. Acquire,
   * open, and release never interleave with each other.
   */
  private async serializeAuthority<T>(job: () => T | Promise<T>): Promise<T> {
    const previous = this.authorityChain
    const run = previous.then(job)
    this.authorityChain = run.then(() => undefined, () => undefined)
    return await run
  }
}

/** Project one status back to the durable record shape. */
function toPersistedRoot(status: RootStatus): PersistedRoot {
  return {
    id: status.id,
    path: status.path,
    ...(status.recordedPath === undefined || status.recordedPath === '' ? {} : { recordedPath: status.recordedPath }),
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
    ...(entry.recordedPath === undefined ? {} : { recordedPath: entry.recordedPath }),
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
