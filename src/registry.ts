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
 * - **Mutations and fs admissions are serialized store-wide.** Every mutation
 *   runs its whole read → validate → persist sequence inside the store queue. The
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
 *   scope marked `authority: 'unavailable'` — under which Full-access is
 *   limited to primary-root-only writes — rejects mutations, and retries the lease
 *   from {@link MultiRootRegistry.refresh}.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/registry
 */

import { migrateRootSkills, validateAliasId } from './skills/metadata.ts'
import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { openAuthorityStorage } from './compat/authority-storage.ts'
import { storeIdentity } from './authority/native.ts'
import { AuthorityClient, AuthorityServer, snapshotSchema, parseArguments, type Method, type Snapshot } from './authority/protocol.ts'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from './compat.ts'
import { domainZod, type DomainValueSchema } from './compat/storage-zod.ts'
import type {} from './providers.ts'
import { RecoveryScheduler } from './authority/recovery.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from './registry-lease.ts'
import { freezeOperationScope, runRegistryOperation, runPrimaryOperation } from './registry-operation.ts'
import type { RegistryOperation, RegistryOperationKind } from './registry-operation.ts'
import {
  additionalRootId,
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  expandRootInput,
  isWindowsNetworkOrDevicePath,
  removeStatusAt,
  reservedRootBoundary,
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

/** Operator/test capability diagnostics; never bypasses peer authentication. */
export { nativeHostAvailability } from './authority/native.ts'

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
 * The recovery class of a `storage-failed` authority: `retryable` failures
 * (open/listen/acquire) may be re-attempted by `ensureAuthority`, while
 * `config` (a row the operator must fix) and `quarantine` (an unknown durable
 * outcome, isolated until restart) make the state terminal.
 */
export type StorageFailureRecovery = 'retryable' | 'config' | 'quarantine'

/** The recovery class a degraded authority belongs to (see {@link StorageFailureRecovery}). */
export type RecoveryClass = 'retryable' | 'config' | 'quarantine'

/** Operator-facing read-only picture of the registry authority and its recovery. */
export interface RegistryDiagnostics {
  readonly authorityState: RegistryAuthorityState
  readonly epoch: string | undefined
  readonly connectionFailure: string | undefined
  readonly recoveryClass: RecoveryClass | undefined
  readonly recovery: {
    readonly phase: 'idle' | 'waiting' | 'attempting' | 'disabled' | 'requires-restart'
    readonly attempts: number
    readonly nextRetryAt: number | undefined
    readonly pendingSync: number
  }
}

/**
 * Whether this process is the Registry Authority for the store-wide domain
 * medium. Contended and storage-failed are both fail-closed: the scope stays
 * empty, is marked `authority: 'unavailable'`, and mutations reject.
 */
export type RegistryAuthorityState =
  | { readonly kind: 'active' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'follower'; readonly epoch: string }
  | { readonly kind: 'storage-failed'; readonly reason: string; readonly recovery: StorageFailureRecovery }
  | { readonly kind: 'config-invalid'; readonly reason: string }

/** A medium/lock binding error only a changed configuration can repair. */
class SharedConfigError extends Error {}

/**
 * Plugin configuration for the registry row. `leasePath` must sit beside the
 * JSON backend's domain document; the patch default is
 * `$DSH_HOME/storages/multi_root_workspace.lock`. A custom `storage-json.root`
 * must override this in lockstep (ADR-0007).
 */
export interface Config {
  /** Absolute path of the store-wide kernel lock file. */
  readonly leasePath?: string
  /** Explicit medium binding for the multi-Host authority service. */
  readonly sharedStorageRoot?: string
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
  /**
   * Whether the registry retries a degraded authority in the background
   * (bounded backoff, `unref`ed). Defaults to `true`; `false` leaves
   * recovery to on-demand calls (refresh, the panel Retry button).
   */
  readonly backgroundRecovery?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootRegistry: MultiRootRegistry
  }
}

/**
 * Stored shape of one root record.
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
type PersistedRoot = {
  id: string
  path: string
  /**
   * Absent only in records written before the field existed (or by hand),
   * and in non-inherit records. Such a record is reported `invalid` rather
   * than granted on a guess — see classifyStoredRoots.
   */
  recordedPath?: string | undefined
  readOnlyRecordedPath?: string | undefined
  readWriteRecordedPath?: string | undefined
  alias?: string | undefined
  aliasId?: unknown
  skillsEnabled?: unknown
  addedAt: string
}

/**
 * Stored shape of one primary root's records: the whole registration list.
 * The domain's `single` layout stores the entire unit as one document, so
 * keys stay opaque strings — which is exactly what lets the canonical
 * primary root itself be the key.
 */
export type PersistedPrimaryRoot = { roots: PersistedRoot[] }

/**
 * The durable-boundary validators. The builder is the zod module the
 * INSTALLED storage-domain resolves, not this package's own `zod` copy:
 * `domainTable` types `schema` as the `ZodType` of ITS resolved zod, and
 * since `0.2.1-alpha.3` upstream pins that copy at `4.4.3` exactly while
 * this package floats on `^4.6.2` for its wire validation. The two copies
 * brand incompatible types on either side of that upstream change, so the
 * schema is built where the boundary type comes from — see
 * `src/compat/storage-zod.ts`.
 */
const z = domainZod()

const persistedRoot: DomainValueSchema<PersistedRoot> = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  recordedPath: z.string().min(1).optional(),
  readOnlyRecordedPath: z.string().min(1).optional(),
  readWriteRecordedPath: z.string().min(1).optional(),
  alias: z.string().optional(),
  aliasId: z.unknown().optional(),
  skillsEnabled: z.unknown().optional(),
  addedAt: z.string().min(1),
})

const persistedPrimaryRoot: DomainValueSchema<PersistedPrimaryRoot> = z.object({
  roots: z.array(persistedRoot),
})

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
  private readonly sharedStorageRoot: string | undefined
  private readonly authorityStorageContext: Context
  private medium: ReturnType<typeof storeIdentity> | undefined
  private server: AuthorityServer | undefined
  private client: AuthorityClient | undefined
  private connectionFailure: string | undefined
  private connectionGeneration = 0
  /** Local cancel of the in-flight handshake; teardown must not wait out hello. */
  private connectionAbort: AbortController | undefined
  private remoteProjectionReady = false
  private readonly remoteRevisions = new Map<string, number>()
  /**
   * Primary roots whose projection must still be synced after a follower
   * reconnect — populated from the tracked cache keys at adoption, removed as
   * each `applySnapshot` lands. Recovery completes only when it empties.
   */
  private pendingSync = new Set<string>()
  /** Bounded background retry for degraded authority states (ADR-0026 R1). */
  private readonly recovery: RecoveryScheduler
  private readonly operationProof = Object.freeze({})
  /** Whether this process currently owns the store. */
  private authorityState: RegistryAuthorityState = { kind: 'contended' }
  /** Held kernel lease; present once acquire succeeded, including after a failed open. */
  private lease: RegistryAuthorityLease | undefined
  /** Open domain handle; present only while {@link authority} is `active`. */
  private domain: { close(): Promise<void> } | undefined
  /** The last failed `openDomain` reason; a repeat failure is not re-logged. */
  private lastOpenFailure: string | undefined
  /** The open table; present once this process is the authority. */
  private table: KvTable<string, PersistedPrimaryRoot> | undefined
  /** Last classified status list per canonical primary root. */
  private readonly cache = new Map<string, readonly RootStatus[]>()
  /** Signature of the last published grant per key, so a no-op refresh stays a no-op. */
  private readonly published = new Map<string, string>()
  /** Pending store-ordered work, grouped by primary for teardown accounting. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Admissions and mutations share one order, including across primary roots. */
  private operationChain: Promise<void> = Promise.resolve()
  private operationEpoch: string | undefined
  private operationRevision = 0
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
    this.authorityStorageContext = ctx
    this.leasePath = config.leasePath
    this.sharedStorageRoot = config.sharedStorageRoot
    this.recovery = new RecoveryScheduler({
      enabled: config.backgroundRecovery !== false,
      eligible: () => !this.disposed && (this.authorityState.kind === 'contended'
        || (this.authorityState.kind === 'storage-failed' && this.authorityState.recovery === 'retryable')
        || (this.authorityState.kind === 'follower' && this.pendingSync.size > 0)),
      run: async () => {
        if (this.authorityState.kind === 'follower' && this.pendingSync.size > 0) { await this.syncProjection(); return }
        await this.ensureAuthority({ background: true })
        if (this.client) await this.syncProjection()
        this.noteRecoveryTransition()
      },
    })
    if (config.sharedStorageRoot !== undefined) this.ctx.multiRootScope.requireAdmission(this.operationProof)
    // Until `openDomain()` proves otherwise this process is NOT the store's
    // authority: the empty root table a contended, storage-failed or
    // config-invalid registry publishes must read as "restrictions unknown",
    // never as "nothing is restricted" — Full-access enforcement downgrades
    // to primary-root-only writes while this flag is out (ADR-0017 review amendment).
    this.ctx.multiRootScope.setRegistryAuthority(false)
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
      this.noteRecoveryTransition()
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
      case 'follower':
        return undefined
      case 'contended':
        return this.shared && this.connectionFailure ? `shared registry is unavailable: ${this.connectionFailure}` : REGISTRY_CONTENDED_MESSAGE
      case 'storage-failed':
      case 'config-invalid':
        return this.authorityState.reason
    }
  }

  /**
   * Whether this process is the Registry Authority for the store-wide medium.
   * Tests and diagnostics read this; surfaces use {@link unavailable}.
   */
  get epoch(): string | undefined { return this.authorityState.kind === 'active' ? this.operationEpoch : this.client?.epoch }

  get shared(): boolean { return this.sharedStorageRoot !== undefined }
  get available(): boolean { return this.authorityState.kind === 'active' || this.authorityState.kind === 'follower' }

  get authority(): RegistryAuthorityState {
    return this.authorityState
  }

  /** The class a degraded authority belongs to; `undefined` when healthy. */
  private get recoveryClass(): RecoveryClass | undefined {
    switch (this.authorityState.kind) {
      case 'contended': return 'retryable'
      case 'storage-failed': return this.authorityState.recovery
      case 'config-invalid': return 'config'
      case 'follower': return this.pendingSync.size > 0 ? 'retryable' : undefined
      default: return undefined
    }
  }

  /**
   * Read-only diagnostics for operators: the authority state, the epoch, the
   * last connection failure, and what the recovery scheduler is doing.
   * `requires-restart` marks classes no timer will ever fix — a `config`
   * row or a `quarantine`d store must NOT read as "retrying". Purely a read;
   * it never arms or runs anything.
   */
  get diagnostics(): RegistryDiagnostics {
    const recoveryClass = this.recoveryClass
    const scheduled = this.recovery.state
    return {
      authorityState: this.authorityState,
      epoch: this.epoch,
      connectionFailure: this.connectionFailure,
      recoveryClass,
      recovery: {
        phase: recoveryClass === 'config' || recoveryClass === 'quarantine' ? 'requires-restart' : scheduled.phase,
        attempts: scheduled.attempts,
        nextRetryAt: scheduled.nextRetryAt,
        pendingSync: this.pendingSync.size,
      },
    }
  }

  /** The last logged `(kind, recoveryClass)` pair; dedupes transition logs. */
  private loggedRecovery: string | undefined

  /**
   * Log one line per authority/recovery-class TRANSITION — never per tick:
   * waiting↔attempting moves say nothing an operator did not already know.
   */
  private noteRecoveryTransition(): void {
    const key = `${this.authorityState.kind}:${this.recoveryClass ?? ''}`
    if (this.loggedRecovery === key) return
    this.loggedRecovery = key
    const detail = this.authorityState.kind === 'storage-failed' || this.authorityState.kind === 'config-invalid'
      ? this.authorityState.reason
      : this.connectionFailure ?? ''
    this.ctx.logger.info(
      this.recoveryClass === undefined
        ? `multi-root-workspace: registry authority recovered (${this.authorityState.kind})`
        : `multi-root-workspace: registry authority is ${this.authorityState.kind}`
          + ` (${this.recoveryClass})${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
    )
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
    if (this.client) {
      try { return await this.remote('snapshot', [primaryRoot]) }
      catch (error) {
        // Queries may re-elect/resynchronize. Mutations never replay a request
        // whose response was lost, since it might already have committed.
        if (this.client) throw error
        await this.ensureAuthority()
        if (this.client) return await this.remote('snapshot', [primaryRoot])
      }
    }
    if (this.authorityState.kind !== 'active') return []
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, () => this.reclassify(key))
  }

  /**
   * Admit one fs invocation in the same order as mutations, then run its I/O
   * OUTSIDE the queue. Revocation does not wait for already-admitted work.
   * Shared followers obtain the same ordered snapshot through attested IPC.
   */
  async withOperation<T>(
    policy: SandboxExecutionPolicy,
    kind: RegistryOperationKind,
    body: (operation: RegistryOperation) => T | Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw new Error('multi-root registry: cannot admit an operation after disposal')
    // Copy policy before the first await; the trusted caller still owns it.
    const capturedPolicy = structuredClone(policy)
    await this.ensureAuthority()
    const key = canonicalRoot(capturedPolicy.workspaceRoot)
    if (this.shared && this.available) {
      const snapshot = this.client
        ? await this.remoteSnapshot('admit', [key])
        : await this.captureSnapshot(key)
      const scope = freezeOperationScope(this.ctx.multiRootScope.resolveSnapshot(capturedPolicy, this.projectRoots(snapshot.roots as RootStatus[]), snapshot.available))
      return await runRegistryOperation(scope, kind, snapshot.epoch, snapshot.revision, body, this.operationProof, capturedPolicy.mode)
    }
    const admission = await this.serialize(key, () => {
      if (this.disposed) throw new Error('multi-root registry: cannot admit an operation after disposal')
      return {
        scope: freezeOperationScope(this.shared
          ? this.ctx.multiRootScope.resolveSnapshot(capturedPolicy, this.projectRoots(this.cache.get(key) ?? []), false)
          : this.ctx.multiRootScope.resolve(capturedPolicy)),
        epoch: this.operationEpoch,
        revision: this.operationRevision,
      }
    })
    return await runRegistryOperation(admission.scope, kind, admission.epoch, admission.revision, body, this.operationProof, capturedPolicy.mode)
  }

  withPrimaryOperation<T>(policy: SandboxExecutionPolicy, body: () => T): T {
    // No IPC, no additional grant, and no shared temp authority. This is only
    // the compatibility fallback for a public entry that must stay synchronous.
    const scope = this.ctx.multiRootScope.resolveSnapshot(policy, this.projectRoots(this.cache.get(canonicalRoot(policy.workspaceRoot)) ?? []), false)
    return runPrimaryOperation(freezeOperationScope(scope), policy.mode, this.operationProof, body)
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
    if (this.client) return await this.remote('add', [primaryRoot, input])
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
      const canonical = validateRootCandidate(input.path, {
        primaryRoot: key,
        // The overlap rules judge every registration that still carries an
        // intact recorded grant — available, missing, redirected, and
        // membership-conflict records alike. A withheld root grants nothing,
        // but its recorded boundary is exactly the negative restriction a new
        // writable root must not swallow while the operator has not removed
        // the record; only a structurally invalid record reserves nothing.
        // The revive exemption is by INDEX, never by path: re-registering the
        // exact row being confirmed releases only that one reservation — a
        // second record that happens to name the same boundary keeps its own.
        existing: statuses.flatMap((status, index) => {
          if (index === revived) return []
          const boundary = reservedRootBoundary(status)
          return boundary === undefined ? [] : [boundary]
        }),
      })
      const access = input.access ?? 'inherit'
      const next = revived === -1
        ? [...statuses, {
          id: additionalRootId(randomUUID()),
          path: canonical,
          access,
          skillsEnabled: access !== 'read-only',
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
            ...(input.access !== undefined && input.access !== status.access ? { skillsEnabled: input.access !== 'read-only' } : {}),
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
    if (this.client) return await this.remote('setAccess', [primaryRoot, ref, access])
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
          skillsEnabled: access !== 'read-only',
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
    if (this.client) return await this.remote('removeAt', [primaryRoot, ref])
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
    if (this.client) return await this.remote('setAlias', [primaryRoot, ref, alias ?? null])
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

  /** Change a Skill switch without changing any grant field. */
  async setSkillsEnabled(primaryRoot: string, ref: RootRef, skillsEnabled: boolean): Promise<readonly RootStatus[]> {
    await this.ensureAuthority()
    if (this.client) return await this.remote('setSkillsEnabled', [primaryRoot, ref, skillsEnabled])
    if (typeof skillsEnabled !== 'boolean') throw new RootValidationError('invalid-ref', 'skillsEnabled must be a boolean')
    return await this.setSkillsMetadata(primaryRoot, ref, { skillsEnabled })
  }

  async setAliasId(primaryRoot: string, ref: RootRef, aliasId: string): Promise<readonly RootStatus[]> {
    await this.ensureAuthority()
    if (this.client) return await this.remote('setAliasId', [primaryRoot, ref, aliasId])
    return await this.setSkillsMetadata(primaryRoot, ref, { aliasId })
  }

  private async setSkillsMetadata(primaryRoot: string, ref: RootRef, patch: { skillsEnabled?: boolean; aliasId?: string }): Promise<readonly RootStatus[]> {
    await this.ensureAuthority()
    this.requireActive()
    const key = canonicalRoot(primaryRoot)
    return await this.serialize(key, async () => {
      const statuses = this.reclassify(key)
      const target = resolveRootIndex(statuses, ref)
      if (patch.aliasId !== undefined) validateAliasId(patch.aliasId, statuses.filter((_row, index) => index !== target))
      return await this.persist(key, statuses.map((row, index) => index === target ? { ...row, ...patch } : row))
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
    if (this.client) return await this.remote('move', [primaryRoot, ref, beforeRef ?? null])
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
    if (this.client) return await this.remote('recheck', [primaryRoot])
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
    return this.shared
      ? this.ctx.multiRootScope.snapshot({ workspaceRoot: primaryRoot, mode: 'workspace-write' }).additionalRoots
      : availableRoots(this.statusesOf(canonicalRoot(primaryRoot)))
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
    const statuses = this.classify(key, record)
    this.cache.set(key, statuses)
    this.publish(key, statuses)
    return statuses
  }

  /**
   * The pure half of {@link accept}: classification plus the over-limit
   * warning, without writing the cache or the scope. {@link openDomain}
   * staging uses it so a half-opened domain cannot materialize rows.
   */
  private classify(key: string, record: PersistedPrimaryRoot): readonly RootStatus[] {
    const statuses = classifyStoredRoots(key, record.roots.map(toRegisteredRoot))
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
    try { return this.table?.get(key) }
    catch (error) {
      if (unknownStorageState(error)) this.enterStorageFailed('registry storage state cannot be confirmed; restart and reconcile', 'quarantine')
      throw error
    }
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
    const durable = persistedPrimaryRoot.parse({ roots: migrateRootSkills(statuses.map(toPersistedRoot)) })
    try {
      if (statuses.length === 0) await table.delete(key)
      else {
        // Validate the COMPLETE document before crossing the durable boundary.
        // In particular, legacy records keep an absent `recordedPath` absent;
        // they must never be rewritten as the schema-invalid empty string.
        await table.put(key, durable)
      }
    } catch (error) {
      if (unknownStorageState(error)) this.enterStorageFailed('registry write result is unknown; restart and reconcile durable state', 'quarantine')
      throw error
    }
    const classified = statuses.length === 0 ? [] : classifyStoredRoots(key, durable.roots.map(toRegisteredRoot))
    this.cache.set(key, classified)
    this.publish(key, classified)
    return classified
  }

  /**
   * Run one job after every store job already queued. The whole
   * read → validate → write sequence belongs inside the job:
   * the storage domain serializes individual writes, so without this the loser
   * of a race reads a snapshot that is already stale and writes it back.
   */
  private async serialize<T>(key: string, job: () => T | Promise<T>): Promise<T> {
    const previous = this.operationChain
    const run = previous.then(job)
    // The tail must never reject: a failed operation must not poison the queue
    // for the operations behind it.
    const tail = run.then(() => undefined, () => undefined)
    this.operationChain = tail
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
   * What is published is the effective GRANT — membership requires
   * `available`, so a withheld registration can never reach a provider as a
   * grant. Withheld entries still publish for their DENY boundary alone;
   * that includes `membership-conflict` records, whose recorded grant is
   * intact and trustworthy even though their membership cannot stand. When
   * the grant and the withheld set are unchanged (the common case for a
   * read-path refresh on a
   * healthy workspace) the scope is left alone and no listener fires: a refresh
   * exists to keep the two in sync, not to churn on every listing — and, since
   * the scope rebuilds its root table on each call, skipping the no-op write is
   * also what keeps the read path cheap.
   *
   * Available roots keep registry order: instruction discovery consumes them
   * under a shared byte budget, so a move must update the live scope immediately.
   * Aliases and no-op moves still leave the signature unchanged.
   */
  private readonly metadataPublished = new Map<string, string>()

  private publish(key: string, statuses: readonly RootStatus[]): void {
    const withheld = statuses.filter(status => status.state !== 'available')
    // Access AND invalidReason are part of the signature: an access change IS
    // a grant change and must republish, and a flip between structural
    // `invalid` and `membership-conflict` changes whether the recorded
    // boundary still denies — while aliases still produce an identical
    // signature.
    const signature = [
      ...statuses.filter(status => status.state === 'available').map(status => `available:${status.access}:${recordedGrantOf(status)}`),
      ...withheld.map(status => `${status.state}:${status.invalidReason ?? ''}:${status.access}:${status.path}:${recordedGrantOf(status) ?? ''}`),
    ].join('\n')
    // A key with nothing published yet reads as the empty signature: the very
    // first classification of an empty key must not "publish" an empty grant
    // (and fire every listener) for a set that was already empty.
    const previousMetadata = this.metadataPublished.get(key)
    const metadata = JSON.stringify(this.shared ? statuses : statuses.map(row => [row.id, row.aliasId, row.skillsEnabled, row.state]))
    this.metadataPublished.set(key, metadata)
    if ((this.published.get(key) ?? '') === signature) {
      if (previousMetadata !== metadata && (previousMetadata !== undefined || statuses.length > 0)) {
        this.operationRevision++
        this.deliverNotifications(key)
      }
      return
    }
    // An empty signature is the absent key — `published` maps to scope content.
    if (signature === '') this.published.delete(key)
    else this.published.set(key, signature)
    this.operationRevision++
    const effective = this.projectRoots(statuses)
    this.ctx.multiRootScope.setAdditionalRoots(key, effective)
    if (withheld.length > 0) {
      this.ctx.logger.warn(
        `multi-root-workspace: ${withheld.length} registered root(s) of ${key} are not writable right now`
        + ` (${withheld.map(status => `${status.path}: ${status.state}`).join(', ')});`
        + ' they stay registered and are reported by /workspace-folders',
      )
    }
    this.deliverNotifications(key)
  }

  private projectRoots(statuses: readonly RootStatus[]) {
    return statuses.flatMap(status => {
      const recorded = recordedGrantOf(status)
      // A structurally `invalid` record publishes NOTHING — not even its deny
      // boundary: a record too corrupt to parse cannot state a trustworthy
      // restriction, so under Full-access its former path becomes
      // ambient-writable again. A `membership-conflict` record is different:
      // its recorded grant IS intact and trustworthy, so it still publishes —
      // withheld, deny-only — and a read-only boundary inside a covering grant
      // stays denied. The tradeoff is recorded in ADR-0017 (失效登记的负授权修订
      // and its membership-conflict amendment).
      if ((status.state === 'invalid' && status.invalidReason !== 'membership-conflict') || recorded === undefined) return []
      return [{
        id: status.id,
        path: status.path,
        recordedPath: recorded,
        access: status.access,
        ...(status.state === 'available' ? {} : { withheld: true }),
        ...(status.alias === undefined ? {} : { alias: status.alias }),
      }]
    })
  }

  private snapshotOf(primary: string): Snapshot {
    return snapshotSchema.parse({ protocol: 1, store: this.medium!.id, epoch: this.operationEpoch!,
      revision: this.operationRevision, primary, roots: this.cache.get(primary) ?? [], available: this.authorityState.kind === 'active' })
  }

  private async captureSnapshot(primary: string): Promise<Snapshot> {
    const key = canonicalRoot(primary)
    return await this.serialize(key, () => {
      this.requireActive()
      this.reclassify(key)
      return this.snapshotOf(key)
    })
  }

  private notifyShared(key: string) {
    if (this.server && this.authorityState.kind === 'active') this.server.changed(this.snapshotOf(key))
  }

  /** Depth of {@link commit}; nested calls share the outer round's buffers. */
  private commitDepth = 0
  /** Keys whose publish inside a commit produced deferred notifications, first-seen order. */
  private readonly commitNotifications = new Set<string>()

  /**
   * Run `body` as one Registry commit: scope writes inside it go through
   * `multiRootScope.batch`, and the `notifyShared` broadcasts plus Registry
   * listener calls `publish()` produces are collected per key instead of
   * delivered. When the OUTERMOST commit ends — also when `body` throws — the
   * scope batch flushes first, then the broadcasts go out in first-seen key
   * order, then the listeners: no synchronous callback can observe a
   * half-committed state.
   */
  private commit<T>(body: () => T): T {
    this.commitDepth++
    try {
      return this.ctx.multiRootScope.batch(body)
    } finally {
      if (--this.commitDepth === 0) {
        const keys = [...this.commitNotifications]
        this.commitNotifications.clear()
        for (const key of keys) this.notifyShared(key)
        for (const key of keys) for (const listener of this.listeners) listener(key)
      }
    }
  }

  /** Deliver one key's notifications now, or collect them inside a commit. */
  private deliverNotifications(key: string): void {
    if (this.commitDepth > 0) { this.commitNotifications.add(key); return }
    this.notifyShared(key)
    for (const listener of this.listeners) listener(key)
  }

  private applySnapshot(snapshot: Snapshot) {
    if (!this.client || snapshot.store !== this.medium?.id || snapshot.epoch !== this.client.epoch) return
    const previous = this.remoteRevisions.get(snapshot.primary) ?? -1
    if (snapshot.revision < previous) return
    this.remoteRevisions.set(snapshot.primary, snapshot.revision)
    const rows = snapshot.roots.map(row => Object.fromEntries(Object.entries({ ...row, id: additionalRootId(row.id) }).filter(([, value]) => value !== undefined))) as unknown as RootStatus[]
    // One commit per key: the projection and the authority fact land together,
    // so a subscriber never sees roots without their authority (or vice versa).
    this.commit(() => {
      this.cache.set(snapshot.primary, rows)
      this.publish(snapshot.primary, rows)
      this.ctx.multiRootScope.setRegistryAuthority(snapshot.available)
    })
    this.remoteProjectionReady = snapshot.available
    // An owner broadcast carries a complete snapshot too, so it settles the key.
    this.pendingSync.delete(snapshot.primary)
  }

  private remoteUnavailable() {
    try {
      this.connectionGeneration++
      this.client = undefined
      this.remoteRevisions.clear()
      this.pendingSync.clear()
      this.authorityState = { kind: 'contended' }
      this.ctx.multiRootScope.setRegistryAuthority(false)
      if (!this.remoteProjectionReady) return
      this.remoteProjectionReady = false
      // Keep recorded negative boundaries and Files' lexical deny information.
      for (const [primary, rows] of this.cache) this.withholdScope(primary, rows)
    } finally { this.recovery.arm(); this.noteRecoveryTransition() }
  }

  /**
   * Resynchronize each still-pending tracked primary outside the authority
   * queue: per-key snapshots through the live client. A failed key stays in
   * `pendingSync` for the next tick; a lost connection abandons the round —
   * `remoteUnavailable` already emptied the set.
   */
  private async syncProjection(): Promise<void> {
    for (const key of [...this.pendingSync]) {
      try { await this.remoteSnapshot('snapshot', [key]) }
      catch { if (!this.client) break }
    }
  }

  /**
   * Write one key's withheld-only projection into the scope, keeping
   * `published` truthful: the signature records what the scope HOLDS, never
   * what `publish()` last computed — a withheld signature can never equal a
   * publish signature, so an empty snapshot afterwards really writes the
   * retraction. A repeated write of the same withheld projection is a no-op
   * (the same-signature skip is also the republish gate of a repeated
   * downgrade). `metadataPublished` is untouched: a withheld write announces
   * nothing to the Registry view.
   */
  private withholdScope(key: string, rows: readonly RootStatus[]): void {
    const roots = this.projectRoots(rows).map(root => ({ ...root, withheld: true }))
    const signature = roots.length === 0 ? '' : `\u0000withheld\n${JSON.stringify(roots)}`
    if ((this.published.get(key) ?? '') === signature) return
    if (signature === '') this.published.delete(key)
    else this.published.set(key, signature)
    this.ctx.multiRootScope.setAdditionalRoots(key, roots)
  }

  private async remoteSnapshot(method: Method, args: unknown[]): Promise<Snapshot> {
    const client = this.client, generation = this.connectionGeneration
    if (!client) throw new Error('registry authority is unavailable')
    const value = await client.request(method, args)
    let snapshot: Snapshot
    try { snapshot = snapshotSchema.parse(value) }
    catch (error) { client.close(); throw error }
    if (generation !== this.connectionGeneration || client !== this.client || snapshot.store !== this.medium?.id || snapshot.epoch !== client.epoch || snapshot.primary !== canonicalRoot(String(args[0]))) {
      client.close(); throw new Error('stale registry connection or authority epoch')
    }
    this.applySnapshot(snapshot)
    return snapshot
  }

  private async remote(method: Method, args: unknown[]): Promise<readonly RootStatus[]> {
    await this.remoteSnapshot(method, args)
    return this.list(String(args[0]))
  }

  private async dispatchShared(method: Method, values: unknown[]): Promise<Snapshot> {
    const args = parseArguments(method, values)
    const primary = String(args[0])
    if (!isAbsolute(primary)) throw new Error('registry primary must be absolute')
    if (method === 'snapshot' || method === 'admit') return this.captureSnapshot(primary)
    // Only authenticated Host facades reach this dispatch; browsers still send
    // sessionId to their own Host, never a primary supplied by the browser.
    const ref = args[1] as RootRef
    switch (method) {
      case 'add': await this.add(primary, args[1] as AddRootInput); break
      case 'removeAt': await this.removeAt(primary, ref); break
      case 'setAccess': await this.setAccess(primary, ref, args[2] as RootAccess); break
      case 'setAlias': await this.setAlias(primary, ref, args[2] === null ? undefined : args[2] as string); break
      case 'setSkillsEnabled': await this.setSkillsEnabled(primary, ref, args[2] as boolean); break
      case 'setAliasId': await this.setAliasId(primary, ref, args[2] as string); break
      case 'move': await this.move(primary, ref, args[2] === null ? undefined : args[2] as RootRef); break
      case 'recheck': await this.recheck(primary); break
      default: throw new Error('unsupported registry method')
    }
    return this.captureSnapshot(primary)
  }

  /**
   * The open table.
   * @returns the live table.
   * @throws {RootValidationError} `registry-contended` when another DSH process
   *   owns the store, `storage-unavailable` when the store could not be opened,
   *   or an error when the service has not started.
   */
  private requireTable(): KvTable<string, PersistedPrimaryRoot> {
    if (this.authorityState.kind === 'follower') throw new Error('a follower never opens registry storage')
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
  private async ensureAuthority(options: { background?: boolean } = {}): Promise<void> {
    try { await this.serializeAuthority(async () => {
      // The teardown queues behind any acquisition, so a disposer that ran
      // first must not be followed by a new medium nobody will ever close.
      if (this.disposed) return
      if (this.authorityState.kind === 'active' || this.client !== undefined) return
      // A config-invalid registry is terminally fail-closed: no lease, no domain.
      if (this.authorityState.kind === 'config-invalid') return
      // `config` needs a row change and `quarantine` a restart: neither retries.
      if (this.authorityState.kind === 'storage-failed' && this.authorityState.recovery !== 'retryable') return
      if (this.lease !== undefined) {
        // An opened domain with an unknown durable result is quarantined until
        // restart; reopening in place could grant a different memory snapshot.
        if (this.domain !== undefined) return
        await this.openDomain()
        return
      }
      const leasePath = this.leasePath
      if (leasePath === undefined || leasePath === '') {
        this.enterStorageFailed(
          `${DOMAIN_NAME}: leasePath is not configured; set it next to storage-json.root `
          + `(default $DSH_HOME/storages/${DOMAIN_NAME}.lock)`,
          'config',
        )
        return
      }
      if (!isAbsolute(leasePath)) {
        this.enterStorageFailed(`${DOMAIN_NAME}: leasePath must be an absolute path`, 'config')
        return
      }
      if (this.sharedStorageRoot !== undefined && this.medium === undefined) {
        try {
          if (!isAbsolute(this.sharedStorageRoot)) throw new SharedConfigError('sharedStorageRoot must be absolute')
          const medium = storeIdentity(this.sharedStorageRoot)
          if (storeIdentity(dirname(leasePath)).id !== medium.id || basename(leasePath) !== `${DOMAIN_NAME}.lock`) throw new SharedConfigError('shared registry requires its canonical medium lock, without alternate lock names')
          this.medium = medium
        } catch (error) { this.enterStorageFailed(String(error), error instanceof SharedConfigError ? 'config' : 'retryable'); return }
      }
      try {
        this.lease = await RegistryAuthorityLease.acquire(leasePath)
      } catch (error: unknown) {
        if (error instanceof RegistryLeaseContendedError) {
          this.enterContended()
          if (this.medium !== undefined) {
            // A holder can still be loading its domain. Bound startup waiting;
            // never release/steal its lease or spin from invalidation callbacks.
            for (const delay of options.background ? [0] : [0, 50, 150]) {
              if (delay) await new Promise(resolve => setTimeout(resolve, delay))
              if (this.disposed) return
              const generation = ++this.connectionGeneration
              const controller = new AbortController()
              this.connectionAbort = controller
              let adopted = false
              try {
                const client = await AuthorityClient.connect(this.medium.endpoint, this.medium.id, this.maxRoots,
                  snapshot => { if (adopted && generation === this.connectionGeneration) this.applySnapshot(snapshot) },
                  () => { if (adopted && generation === this.connectionGeneration) this.remoteUnavailable() },
                  controller.signal)
                if (this.disposed || generation !== this.connectionGeneration) { client.close(); return }
                this.client = client; adopted = true
                this.connectionFailure = undefined
                this.authorityState = { kind: 'follower', epoch: client.epoch! }
                // Recovery completes only after the tracked projections sync;
                // with nothing to sync the connection alone is enough.
                this.pendingSync = new Set(this.cache.keys())
                if (this.pendingSync.size === 0) {
                  this.ctx.multiRootScope.setRegistryAuthority(true)
                  this.remoteProjectionReady = true
                }
                this.recovery.kick()
                break
              } catch (error) { this.connectionFailure = String(error) /* Never open a follower domain. */ }
              finally { if (this.connectionAbort === controller) this.connectionAbort = undefined }
            }
          }
          return
        }
        this.enterStorageFailed(
          `${DOMAIN_NAME}: cannot acquire the registry lease: `
          + `${error instanceof Error ? error.message : String(error)}`,
          'retryable',
        )
        return
      }
      await this.openDomain()
    })
    } finally { this.recovery.arm(); this.noteRecoveryTransition() }
  }

  /**
   * Open the domain under an already-held lease and publish every stored root.
   * On failure the lease is kept so a later refresh can retry the open without
   * letting a second process grant from a stale snapshot.
   */
  private async openDomain(): Promise<void> {
    let domain
    try {
      domain = this.medium === undefined ? await this.ctx.storageDomain.open(multiRootDomainSpec)
        : await openAuthorityStorage(this.authorityStorageContext, this.medium.root, multiRootDomainSpec)
    } catch (error: unknown) {
      const reason = `${DOMAIN_NAME}: ${error instanceof Error ? error.message : String(error)}`
      if (this.lastOpenFailure !== reason) {
        this.lastOpenFailure = reason
        this.ctx.logger.error(
          `multi-root-workspace: cannot open the root registry store (${DOMAIN_NAME});`
          + ' no additional root is granted until it is repaired or removed:'
          + ` ${reason}`,
        )
      }
      this.enterStorageFailed(reason, 'retryable')
      return
    }
    const epoch = randomUUID()
    // This attempt's private staging: the migrate + classify results stay in
    // local state so a failed attempt moves no cache entry, scope row, or
    // notification away from the last committed projection.
    const staged = new Map<string, readonly RootStatus[]>()
    let table: KvTable<string, PersistedPrimaryRoot>
    try {
      table = domain.table(TABLE_NAME)
      // Skills migrations serialize here without `serialize`: nobody can hold
      // the table yet — local callers queue behind `authorityChain`, and the
      // listener serving IPC does not exist until the commit below.
      for (const [primaryRoot, record] of table.entries()) {
        const migrated = { roots: migrateRootSkills(record.roots) }
        let accepted = record
        if (JSON.stringify(migrated) !== JSON.stringify(record)) {
          try { await table.put(primaryRoot, migrated); accepted = migrated }
          catch (error: unknown) {
            // An opened domain with an unknown durable result is quarantined
            // until restart; reopening could grant a different snapshot.
            if (unknownStorageState(error)) { this.domain = domain; this.enterStorageFailed('Skills migration result is unknown; restart and reconcile', 'quarantine'); return }
            this.ctx.logger.warn(`multi-root skills: metadata migration failed; Skills remain withheld: ${String(error)}`)
          }
        }
        const key = canonicalRoot(primaryRoot)
        staged.set(key, this.classify(key, accepted))
      }
    } catch (error) {
      if (unknownStorageState(error)) { this.domain = domain; this.enterStorageFailed('registry storage state cannot be confirmed; restart and reconcile', 'quarantine'); return }
      try { await domain.close() } catch { /* a failed attempt still releases the medium */ }
      throw error
    }
    let server: AuthorityServer | undefined
    if (this.medium !== undefined) {
      try {
        server = await AuthorityServer.listen(this.medium.endpoint, this.medium.id, epoch, this.maxRoots,
          (method, args) => this.dispatchShared(method, args))
      } catch (error) {
        await domain.close()
        this.enterStorageFailed(`cannot start shared registry: ${String(error)}`, 'retryable')
        return
      }
    }
    // One synchronous commit: the domain/table/epoch/authority assignments,
    // the cache swap, the per-key publishes over the OLD ∪ NEW key union
    // (a key deleted from disk is published empty), and the authority fact
    // all land before any subscriber, broadcast, or listener runs.
    this.commit(() => {
      this.domain = domain
      this.table = table
      this.operationEpoch = epoch
      this.operationRevision = 0
      this.authorityState = { kind: 'active' }
      this.loggedContended = false
      this.server = server
      const earlier = new Set(this.cache.keys())
      this.cache.clear()
      for (const [key, statuses] of staged) this.cache.set(key, statuses)
      for (const key of new Set([...earlier, ...staged.keys()])) this.publish(key, staged.get(key) ?? [])
      // Authority is published only AFTER every stored root reached the scope:
      // between acquisition and this line the scope must still read
      // `unavailable`, so a Full-access call can never race a half-published
      // registry into an ambient grant.
      this.ctx.multiRootScope.setRegistryAuthority(true)
      this.lastOpenFailure = undefined
    })
  }

  /** Fail closed: empty scope, no table, contended state. */
  private enterContended(): void {
    this.operationEpoch = undefined
    if (this.shared) this.remoteUnavailable()
    else this.withdrawPublished()
    this.ctx.multiRootScope.setRegistryAuthority(false)
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
  private enterStorageFailed(reason: string, recovery: StorageFailureRecovery): void {
    this.operationEpoch = undefined
    this.ctx.multiRootScope.setRegistryAuthority(false)
    if (this.shared) {
      // Retain negative boundaries and cached lexical paths on uncertainty.
      for (const [key, rows] of this.cache) this.withholdScope(key, rows)
      this.server?.close(); this.server = undefined
    } else this.withdrawPublished()
    this.table = undefined
    this.authorityState = { kind: 'storage-failed', reason, recovery }
    this.noteRecoveryTransition()
  }

  /** Drop every grant this process has published. Idempotent. */
  private withdrawPublished(): void {
    for (const key of this.published.keys()) {
      this.ctx.multiRootScope.setAdditionalRoots(key, [])
    }
    this.published.clear()
    this.metadataPublished.clear()
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
    this.connectionGeneration++
    this.recovery.dispose()
    // Aborted BEFORE queueing behind `authorityChain`: the in-flight handshake
    // this teardown would otherwise wait out ends immediately.
    this.connectionAbort?.abort()
    this.client?.close(); this.client = undefined
    await this.serializeAuthority(async () => {
      // An in-flight open may create its listener after disposal starts. Wait
      // for that acquisition, then retire its endpoint before storage/lease.
      this.server?.close(); this.server = undefined
      // Fail closed first, so no further mutation is admitted while teardown
      // runs (a mutation admitted later would fail in `requireTable()`, by
      // design) — and so enforcement immediately stops treating the empty
      // scope as proof that nothing is denied.
      this.table = undefined
      this.operationEpoch = undefined
      this.authorityState = { kind: 'contended' }
      this.ctx.multiRootScope.setRegistryAuthority(false)
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
   * Wait until no store work is queued or running (operation I/O is outside).
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
    ...(status.aliasId === undefined ? {} : { aliasId: status.aliasId }),
    ...(status.skillsEnabled === undefined ? {} : { skillsEnabled: status.skillsEnabled }),
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
    ...(entry.aliasId === undefined ? {} : { aliasId: entry.aliasId }),
    ...(entry.skillsEnabled === undefined ? {} : { skillsEnabled: entry.skillsEnabled }),
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

/** Structural across storage releases; older versions do not expose this code. */
function unknownStorageState(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] }
  return value.code === 'unknown-state' || unknownStorageState(value.cause, seen)
    || (Array.isArray(value.errors) && value.errors.some(item => unknownStorageState(item, seen)))
}
