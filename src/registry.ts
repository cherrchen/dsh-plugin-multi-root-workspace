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
import type {} from './compat.ts'
import type {} from './providers.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from './registry-lease.ts'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  expandRootInput,
  isWindowsNetworkOrDevicePath,
  removeStatusAt,
  resolveRootIndex,
  RootValidationError,
  validateRootCandidate,
  type AdditionalRootId,
  type RegisteredRoot,
  type RootAccess,
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
 * Default cap on stored additional-root records per primary root. The bench
 * evidence for this default lives in `docs/reference/bench-root-scale-*.json`
 * (`pnpm bench:roots`): classification and argv widening stay flat far beyond
 * it, so the cap exists to bound the operator-facing list and the widened
 * profile size, not to protect the classifier.
 */
export const DEFAULT_MAX_ADDITIONAL_ROOTS = 16
/** Hard ceiling for `maxAdditionalRoots`: values above it are config-invalid. */
export const MAX_ADDITIONAL_ROOTS_CEILING = 64

/**
 * Whether this process is the Registry Authority for the store-wide domain
 * medium. Contended and storage-failed are both fail-closed: the scope stays
 * empty and mutations reject.
 */
export type RegistryAuthorityState =
  | { readonly kind: 'active' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'storage-failed'; readonly reason: string }
  | { readonly kind: 'config-invalid'; readonly reason: string }

/**
 * Plugin configuration for the registry row. `leasePath` must sit beside the
 * JSON backend's domain document; the patch default is
 * `$DSH_HOME/storages/multi_root_workspace.lock`. A custom `storage-json.root`
 * must override this in lockstep (ADR-0007).
 */
export interface Config {
  /** Absolute path of the store-wide kernel lock file. */
  readonly leasePath?: string
  /**
   * Cap on STORED additional-root records per primary root (every state
   * counts, including withheld and unusable ones, so the count is stable and
   * independent of the filesystem). Must be an integer in
   * 1..{@link MAX_ADDITIONAL_ROOTS_CEILING}; an invalid value puts the
   * registry in the fail-closed `config-invalid` state instead of throwing.
   * A store that already exceeds the limit keeps every record and grants
   * exactly what classification grants — only new adds are refused.
   */
  readonly maxAdditionalRoots?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootRegistry: MultiRootRegistry
  }
}

/**
 * One persisted root record. `zod` validates it at the durable boundary.
 *
 * The access level is expressed by WHICH grant key is present, never by an
 * `access` field on the same `recordedPath` (ADR-0017):
 *
 * - `recordedPath` means `inherit` — the historical writable grant, which
 *   under B9 keeps following the session mode. Upgrading a legacy record to
 *   `inherit` changes nothing about its effective authority.
 * - `readOnlyRecordedPath` means `read-only`.
 * - `readWriteRecordedPath` means fixed `read-write` (B9).
 *
 * That split is what makes this single layout downgrade-safe at domain
 * version 1 (the JSON backend checks the version with strict equality, so a
 * bump would break both upgrade and downgrade):
 *
 * - an OLDER plugin version parses this record with a schema that strips
 *   unknown keys, so a read-only or fixed read-write record loses its grant
 *   field and arrives with NO `recordedPath`; the old classification reports
 *   it `invalid` and grants nothing — a downgrade can never escalate either
 *   restricted level into a write grant. A fixed read-write record must
 *   therefore NEVER also write `recordedPath`: an older plugin would see the
 *   legacy field and grant it as plain read-write;
 * - a record with `recordedPath` only is the writable grant it always was,
 *   so upgrading changes nothing for legacy records.
 */
const persistedRoot = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  // Absent only in records written before the field existed (or by hand), and
  // in non-inherit records. Such a record is reported `invalid` rather than
  // granted on a guess — see classifyStoredRoots.
  recordedPath: z.string().min(1).optional(),
  readOnlyRecordedPath: z.string().min(1).optional(),
  readWriteRecordedPath: z.string().min(1).optional(),
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
  /**
   * The write authority to register; defaults to `inherit` (the historical
   * session-following grant). On a REVIVE the existing record keeps its
   * access unless this field is given explicitly.
   */
  readonly access?: RootAccess
}

/** The registry service: `ctx.multiRootRegistry`. */
export class MultiRootRegistry extends Service {
  // `multiRootCompat` is the compatibility gate, not a collaborator: this
  // service is what decides which directories become writable roots, so it must
  // not run on a release the contract has not verified (see src/compat.ts).
  // `multiRootProviders` is the provider-conflict gate: with a foreign `ctx.fs`
  // or `ctx.sandbox` it never starts, so this registry stays unmounted and the
  // scope keeps granting nothing (see src/providers.ts).
  static inject = ['multiRootCompat', 'multiRootProviders', 'storageDomain', 'multiRootScope']

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
  /** True once the fiber disposer has run: no further acquisition may happen. */
  private disposed = false
  /** The validated per-primary-root cap (the default when the row omits it). */
  private readonly maxRoots: number
  /** Keys already warned about a historical over-limit store (one warning each). */
  private readonly warnedOverLimit = new Set<string>()

  /**
   * @param ctx - the host context; `storageDomain` and `multiRootScope` are injected.
   * @param config - the patch row's `leasePath` and `maxAdditionalRoots`.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'multiRootRegistry')
    this.leasePath = config.leasePath
    const configured = config.maxAdditionalRoots === undefined ? DEFAULT_MAX_ADDITIONAL_ROOTS : config.maxAdditionalRoots
    if (Number.isInteger(configured) && configured >= 1 && configured <= MAX_ADDITIONAL_ROOTS_CEILING) {
      this.maxRoots = configured
    } else {
      // Fail closed, not throw: a bad row config must not keep the whole
      // harness from starting, and it must never silently widen the cap.
      this.maxRoots = DEFAULT_MAX_ADDITIONAL_ROOTS
      this.authorityState = {
        kind: 'config-invalid',
        reason: `${DOMAIN_NAME}: maxAdditionalRoots must be an integer between 1 and `
          + `${MAX_ADDITIONAL_ROOTS_CEILING}, got ${JSON.stringify(configured)}`,
      }
    }
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
    // An invalid row config is fail-closed like an unreadable store: loud, and
    // nothing is ever granted — but activation itself does not fail.
    if (this.authorityState.kind === 'config-invalid') {
      this.ctx.logger.error(`multi-root-workspace: ${this.authorityState.reason}; no additional root is granted`)
      return
    }
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
      case 'config-invalid':
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
   * The configured cap on stored additional-root records per primary root.
   * Surfaces show it next to the count so "N of LIMIT" is always explainable.
   */
  get limit(): number {
    return this.maxRoots
  }

  /**
   * Whether one primary root's stored record count exceeds {@link limit} — a
   * historical over-limit store, which stays fully classified and granted.
   * @param primaryRoot - the session workspace root (any spelling).
   */
  overLimit(primaryRoot: string): boolean {
    return this.statusesOf(canonicalRoot(primaryRoot)).length > this.maxRoots
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
      // Re-classify FIRST, from the stored records: the cached list may be
      // stale (a `missing` root whose directory came back, a `redirected` one
      // whose target moved), and a candidate judged against it would either be
      // refused for a rule that no longer holds or — worse — admitted into a
      // store where it immediately classifies as `invalid`. Revocations publish
      // before any grant, which is the required order.
      // The state the operator last saw is captured BEFORE the fresh
      // classification: the fresh list alone cannot tell "the operator
      // re-confirms a root that was withheld at their last observation" from
      // "the operator re-adds a root that was — and still is — granted".
      const earlier = this.cache.get(key)
      const statuses = this.reclassify(key)
      const alias = normalizeAlias(input.alias)
      // Reviving is detected BEFORE the candidate is judged: re-registering the
      // very directory an existing record names is the operator confirming it,
      // not a duplicate. The check looks at BOTH spellings of a registration —
      // the canonical path it is stored under, and the path it currently
      // resolves to — so re-adding a directory that was replaced by a symlink
      // updates that registration (re-recording what it is granted for)
      // instead of piling a second record for the same operator-given path on
      // top of it. A re-add revives when EITHER observation reports the record
      // withheld — the fresh classification catches a root that degraded since
      // the last one (a grant that is now `redirected` must revive, never
      // duplicate), the last observation catches the operator re-confirming a
      // root whose directory silently came back. Only a root that was granted
      // then AND is granted now stays a `duplicate` refusal.
      const expanded = expandRootInput(input.path)
      // Revive matching must obey the same pre-I/O rejection as candidate
      // validation: even realpath of a UNC path can initiate SMB auth.
      if (process.platform === 'win32' && isWindowsNetworkOrDevicePath(expanded)) {
        throw new RootValidationError('unsupported-path', `Windows ACL confinement cannot cover network or device paths: ${expanded}`)
      }
      const preliminary = isAbsolute(expanded) ? canonicalRoot(expanded) : undefined
      const revived = preliminary === undefined ? -1 : statuses.findIndex((status) => {
        if (process.platform === 'win32' && isWindowsNetworkOrDevicePath(status.path)) return false
        if (status.path !== preliminary && canonicalRoot(status.path) !== preliminary) return false
        const before = earlier?.find(candidate => candidate.id === status.id)
        return status.state !== 'available' || (before !== undefined && before.state !== 'available')
      })
      // The cap counts STORED records — every state, including withheld and
      // unusable ones — so it is stable and independent of the filesystem. A
      // revive re-confirms an existing record and never counts as new, which
      // is also what lets an over-limit store be repaired by re-registering.
      if (revived === -1 && statuses.length >= this.maxRoots) {
        throw new RootValidationError(
          'root-limit-reached',
          `this workspace already has ${statuses.length} additional roots; the configured limit is `
          + `${this.maxRoots}. Remove one first, or raise maxAdditionalRoots.`,
          { reference: String(this.maxRoots) },
        )
      }
      const revivedPath = revived === -1 ? undefined : statuses[revived]!.path
      const canonical = validateRootCandidate(input.path, {
        primaryRoot: key,
        // A withheld or unusable registration grants nothing, so it may not block
        // re-registering the very directory the operator is trying to restore —
        // and neither may the revived record's own grant, whose re-registration
        // is exactly what a revive confirms.
        existing: availableRoots(statuses).filter(root => root !== revivedPath),
      })
      const access = input.access ?? 'inherit'
      const next = revived === -1
        ? [...statuses, {
          id: additionalRootId(randomUUID()),
          path: canonical,
          access,
          ...grantFields(access, canonical),
          state: 'available',
          ...(alias === undefined ? {} : { alias }),
          addedAt: new Date().toISOString(),
        } satisfies RootStatus]
        : statuses.map((status, index) => index === revived
          ? {
            ...dropGrantFields(status),
            path: canonical,
            // A revive keeps the registration's access unless the operator
            // named a new one explicitly.
            access: input.access ?? status.access,
            // Re-registering a withheld root is the operator confirming THIS
            // directory again, which is exactly what re-records the grant —
            // under the grant field the (possibly new) access level uses.
            ...grantFields(input.access ?? status.access, canonical),
            addedAt: new Date().toISOString(),
            ...(alias === undefined ? {} : { alias }),
          }
          : status)
      return await this.persist(key, next)
    })
  }

  /**
   * Change one registration's write authority WITHOUT re-recording its path.
   *
   * Re-resolving is not re-authorizing: the grant keeps the canonical
   * directory it was recorded for; only which persisted field carries it
   * changes. The three levels are not a total order — `inherit` is weaker
   * than `read-write` under a read-only session but stronger under
   * Full-access — so "upgrade" cannot be a single direction. The gate is
   * therefore: pinning to `read-only` is always allowed (a withheld root may
   * be restricted while it is withheld), while ANY other target requires the
   * root to be `available` under the FRESH classification — every
   * non-read-only level can widen authority under some session mode, and a
   * root that is not currently granted must not be granted anything by a
   * metadata change.
   * @param primaryRoot - the session workspace root the root belongs to.
   * @param ref - which registered root to change.
   * @param access - the new write authority.
   * @returns the updated status list.
   * @throws {RootValidationError} `not-found` when the reference matches
   *   nothing, `root-unavailable` when the target is not `available` and the
   *   new level is not `read-only`.
   */
  async setAccess(primaryRoot: string, ref: RootRef, access: RootAccess): Promise<readonly RootStatus[]> {
    await this.ensureAuthority()
    this.requireActive()
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.reclassify(key)
      const targetIndex = resolveRootIndex(statuses, ref)
      const target = statuses[targetIndex]!
      if (target.access === access) return statuses
      if (access !== 'read-only' && target.state !== 'available') {
        throw new RootValidationError(
          'root-unavailable',
          `"${target.path}" is ${target.state} and cannot change to "${access}";`
          + ' restore the directory first — only "read-only" may be set while a root is not granted',
          { reference: target.id },
        )
      }
      const recorded = target.recordedPath ?? target.readOnlyRecordedPath ?? target.readWriteRecordedPath
      const next = statuses.map((status, index) => index === targetIndex
        ? {
          ...dropGrantFields(status),
          access,
          ...(recorded === undefined ? {} : grantFields(access, recorded)),
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
    return await this.serialize(key, async () => await this.persist(key, removeStatusAt(this.reclassify(key), ref)))
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
      const statuses = this.reclassify(key)
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
      const statuses = this.reclassify(key)
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
    // A historical over-limit store (the limit was lowered, or the document
    // was edited by hand) is never truncated and keeps granting exactly what
    // classification grants; it is reported once per key instead.
    if (statuses.length > this.maxRoots && !this.warnedOverLimit.has(key)) {
      this.warnedOverLimit.add(key)
      this.ctx.logger.warn(
        `multi-root-workspace: ${statuses.length} roots are stored for ${key}, above the configured limit `
        + `of ${this.maxRoots}; all of them stay granted, only new adds are refused`,
      )
    }
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
   *
   * Available roots keep registry order: instruction discovery consumes them
   * under a shared byte budget, so a move must update the live scope immediately.
   * Aliases and no-op moves still leave the signature unchanged.
   */
  private publish(key: string, statuses: readonly RootStatus[]): void {
    const withheld = statuses.filter(status => status.state !== 'available')
    // Access is part of the signature: an access change IS a grant change and
    // must republish, while aliases still produce an identical signature.
    const signature = [
      ...statuses.filter(status => status.state === 'available').map(status => `available:${status.access}:${recordedGrantOf(status)}`),
      ...withheld.map(status => `${status.state}:${status.path}`),
    ].join('\n')
    // A key with nothing published yet reads as the empty signature: the very
    // first classification of an empty key must not "publish" an empty grant
    // (and fire every listener) for a set that was already empty.
    if ((this.published.get(key) ?? '') === signature) return
    this.published.set(key, signature)
    const effective = statuses.flatMap(status => {
      const recorded = recordedGrantOf(status)
      if (status.state !== 'available' || recorded === undefined) return []
      return [{
        id: status.id,
        path: status.path,
        recordedPath: recorded,
        access: status.access,
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
    if (this.authorityState.kind === 'config-invalid') {
      throw new RootValidationError(
        'config-invalid',
        `the root registry configuration is invalid (${this.authorityState.reason}); no additional root is granted`,
      )
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
      // The teardown queues behind any acquisition, so a disposer that ran
      // first must not be followed by a new medium nobody will ever close.
      if (this.disposed) return
      if (this.authorityState.kind === 'active') return
      // A config-invalid registry is terminally fail-closed: no lease, no domain.
      if (this.authorityState.kind === 'config-invalid') return
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
   * Drain every queued mutation, close the domain, then release the kernel
   * lease — in that order, and inside the authority-transition queue.
   *
   * The order is the invariant, not a detail. The lease is what makes "the
   * store is mine" true, so it must outlive every write this process will ever
   * make, including the queued writes `close()` itself drains: a successor that
   * acquired the lease and opened the medium in the window between a release
   * and a `put()` would read a snapshot missing that mutation. Running the
   * whole teardown through {@link MultiRootRegistry.serializeAuthority} is the
   * other half: a `refresh()` that is mid-flight when the fiber disposes must
   * not finish by opening a domain and a lease that nothing will ever close.
   */
  private async releaseAuthority(): Promise<void> {
    this.disposed = true
    await this.serializeAuthority(async () => {
      // Fail closed first, so no further mutation is admitted while teardown
      // runs (a mutation admitted later would fail in `requireTable()`, by design).
      this.table = undefined
      this.authorityState = { kind: 'contended' }
      await this.drainMutations()
      // After the drain, so a grant a finishing mutation just published is
      // dropped instead of outliving the teardown.
      this.withdrawPublished()
      const domain = this.domain
      this.domain = undefined
      if (domain !== undefined) {
        try {
          await domain.close()
        } catch {
          // Dispose must not throw through the fiber.
        }
      }
      const lease = this.lease
      this.lease = undefined
      if (lease !== undefined) {
        try {
          await lease.release()
        } catch {
          // Kernel release on process death is the fallback.
        }
      }
    })
  }

  /**
   * Wait until no per-primary-root mutation is queued or running.
   *
   * One pass is enough, and only because the authority state has already been
   * flipped: no further mutation can be admitted (it would fail in
   * `requireTable()`), and every mutation admitted earlier put its own tail in
   * `chains` before it ran.
   */
  private async drainMutations(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
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

/** The recorded canonical directory a record was granted for, whichever grant field holds it. */
function recordedGrantOf(record: {
  readonly recordedPath?: string
  readonly readOnlyRecordedPath?: string
  readonly readWriteRecordedPath?: string
}): string | undefined {
  return record.recordedPath ?? record.readOnlyRecordedPath ?? record.readWriteRecordedPath
}

/** The grant fields one access level persists: exactly one key, always. */
function grantFields(access: RootAccess, recorded: string): { readonly recordedPath: string } | { readonly readOnlyRecordedPath: string } | { readonly readWriteRecordedPath: string } {
  if (access === 'read-only') return { readOnlyRecordedPath: recorded }
  if (access === 'read-write') return { readWriteRecordedPath: recorded }
  return { recordedPath: recorded }
}

/** Strip every grant field so a re-write can set exactly the right one back. */
function dropGrantFields<T extends { readonly recordedPath?: string; readonly readOnlyRecordedPath?: string; readonly readWriteRecordedPath?: string }>(
  status: T,
): Omit<T, 'recordedPath' | 'readOnlyRecordedPath' | 'readWriteRecordedPath'> {
  const { recordedPath: _inherit, readOnlyRecordedPath: _read, readWriteRecordedPath: _write, ...rest } = status
  return rest
}

/** Project one status back to the durable record shape. */
function toPersistedRoot(status: RootStatus): PersistedRoot {
  const grants = [status.recordedPath, status.readOnlyRecordedPath, status.readWriteRecordedPath]
    .filter((grant): grant is string => grant !== undefined && grant !== '')
  // A record that somehow carries MORE THAN ONE grant field is kept verbatim:
  // it classifies `invalid` every time it is read, but rewriting it under one
  // field would silently heal the ambiguity into a real grant.
  const grant = grants.length > 1
    ? {
      ...(status.recordedPath === undefined ? {} : { recordedPath: status.recordedPath }),
      ...(status.readOnlyRecordedPath === undefined ? {} : { readOnlyRecordedPath: status.readOnlyRecordedPath }),
      ...(status.readWriteRecordedPath === undefined ? {} : { readWriteRecordedPath: status.readWriteRecordedPath }),
    }
    // Exactly one field present: re-emit it ONLY when it already names the
    // status's access. A record whose single field contradicts its access is
    // inconsistent memory state — rewriting it under the access's field would
    // silently heal the mismatch into a real grant, so the grant is dropped
    // instead and the record classifies `invalid` on the next read.
    : status.access === 'read-only'
      ? (status.readOnlyRecordedPath === undefined || status.readOnlyRecordedPath === '' ? {} : { readOnlyRecordedPath: status.readOnlyRecordedPath })
      : status.access === 'read-write'
        ? (status.readWriteRecordedPath === undefined || status.readWriteRecordedPath === '' ? {} : { readWriteRecordedPath: status.readWriteRecordedPath })
        : (status.recordedPath === undefined || status.recordedPath === '' ? {} : { recordedPath: status.recordedPath })
  return {
    id: status.id,
    path: status.path,
    ...grant,
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    addedAt: status.addedAt,
  }
}

/**
 * Recover the registered-root view of a stored record entry.
 *
 * Access is derived from WHICH grant field is present, never read from a
 * stored `access` key: the persisted layout carries no such key on purpose.
 * That is the downgrade safety in action — an older plugin version parses the
 * same document with a schema that strips unknown keys, so a read-only record
 * (no `recordedPath`) reaches the old classifier as "no grant recorded" and is
 * reported `invalid`: downgrading can never escalate a read-only registration
 * into a writable grant.
 */
function toRegisteredRoot(entry: PersistedRoot): RegisteredRoot {
  const hasInheritGrant = entry.recordedPath !== undefined && entry.recordedPath !== ''
  const hasReadGrant = entry.readOnlyRecordedPath !== undefined && entry.readOnlyRecordedPath !== ''
  const hasWriteGrant = entry.readWriteRecordedPath !== undefined && entry.readWriteRecordedPath !== ''
  // Exactly one grant field names the access. Zero or several still resolves
  // to a value — the in-memory type requires one — but the record classifies
  // `invalid` on the grant-field count before `access` is ever read.
  const access: RootAccess = hasWriteGrant && !hasInheritGrant && !hasReadGrant
    ? 'read-write'
    : hasReadGrant && !hasInheritGrant && !hasWriteGrant
      ? 'read-only'
      : 'inherit'
  return {
    id: additionalRootId(entry.id),
    path: entry.path,
    access,
    // A record written before these fields existed (or by hand) keeps whatever
    // it has: classification needs to SEE the absence to report it as invalid,
    // rather than have it papered over here.
    ...(entry.recordedPath === undefined ? {} : { recordedPath: entry.recordedPath }),
    ...(entry.readOnlyRecordedPath === undefined ? {} : { readOnlyRecordedPath: entry.readOnlyRecordedPath }),
    ...(entry.readWriteRecordedPath === undefined ? {} : { readWriteRecordedPath: entry.readWriteRecordedPath }),
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
