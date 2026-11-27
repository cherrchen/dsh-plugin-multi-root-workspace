/**
 * The preview resource book (ADR-0053 P4): the in-memory registry of opaque
 * `dsh-resource://mrfw-remote/<uuid>` records, their pin lifetime, and the
 * bounded content views that read through them. Pure logic — no React, no
 * DOM — so the same book serves the sidebar occurrence pin (P5 wires
 * `resources.open`), the Files tree's open gesture, and tests.
 *
 * Boundaries (frozen in `docs/architecture/remote-file-preview.md`):
 * - Addresses carry a random UUID v4 only — never a user URL, a node path,
 *   a raw grant, or serialized credential data.
 * - A record lives while its DSH resource is pinned; the last pin release
 *   retires it. A grant failure retires every record of its exact
 *   providerKey — file-local failures never do.
 * - A record's bytes are never cached here: `read` returns content to the
 *   mount caller only, fenced by signal + generation; the renderer (P5)
 *   must itself render only for the current generation.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/resource-book
 */
import {
  REMOTE_FILE_PREVIEW_LIMITS,
  RemoteFilesError,
  remoteFilesReadRequest,
  type RemoteFilesFailureCode,
  type RemoteFilesReadContent,
} from '../../remote/files-contract.ts'
import { providerKey } from '../files-tree/provider.ts'
import type { RemoteFileContentClient } from '../remote-files-client.ts'
import { remoteFileAddress, remoteFileId } from './resource-address.ts'
import { authorizationRequest, type RemoteFilesAuthorizationBook, type SshFilesIdentity } from './authorization.ts'

/** One registry entry, as callers (the DSH resource occurrence, titles) see it. */
export interface RemotePreviewRecord {
  /** The opaque resource address `dsh-resource://mrfw-remote/<uuid>`. */
  readonly address: string
  /** The grant identity — session, remote root, incarnation. */
  readonly identity: SshFilesIdentity
  /** The `'/'`-separated path under the remote root. */
  readonly relativePath: string
  /** The environment displayName (or environmentId) — never the SSH target. */
  readonly label: string
  /** Dies with the record: grant loss, retirement, or book disposal. */
  readonly signal: AbortSignal
}

/**
 * One content view: a reservation to read one pinned record's bytes.
 * `signal` dies on record death, owner release, or `release()`.
 */
export interface RemotePreviewView {
  readonly signal: AbortSignal
  /**
   * Read the record's bytes. Only the LATEST call per view may resolve —
   * an older in-flight call is fenced off as `cancelled`; a session switch
   * away fences it the same way. Failures reject as `RemoteFilesError`.
   */
  read(signal: AbortSignal): Promise<RemoteFilesReadContent>
  /** End this reservation; idempotent. */
  release(): void
}

/**
 * The grant-level codes that retire a preview record — `provider-unavailable`
 * included: a dropped carrier or a dead service invalidates the grant just as
 * a revoked binding does. File-local failures (`file-not-found`,
 * `file-too-large`, `file-changed`) and malformed payloads never do.
 */
const PREVIEW_INVALIDATIONS: ReadonlySet<RemoteFilesFailureCode> = new Set<RemoteFilesFailureCode>([
  'provider-unavailable',
  'capability-unsupported',
  'preview-not-authorized',
  'session-unavailable',
  'root-unregistered',
  'root-identity-changed',
  'binding-changed',
  'environment-changed',
])

/** The internal record state behind one `RemotePreviewRecord`. */
interface RecordState {
  readonly record: RemotePreviewRecord
  /** `JSON.stringify([providerKey(identity), relativePath])` — the dedupe key. */
  readonly key: string
  readonly control: AbortController
  readonly pins: Map<AbortSignal, () => void>
  /**
   * The `pinState` subscribers (React `useSyncExternalStore` notifies):
   * pinged when the first pin lands — `pending → ready` — and when the
   * record retires — any state → `expired`.
   */
  readonly listeners: Set<() => void>
  readonly expiry: ReturnType<typeof setTimeout>
  leased: boolean
}

/** The internal state behind one `RemotePreviewView`. */
interface ViewState {
  readonly sessionId: string
  readonly control: AbortController
  latest: AbortController | undefined
}

/** A handoff can spend the outgoing slot only after the host commits it. */
export interface RemotePreviewReplacement {
  readonly address: string
  readonly committed: (address: string) => boolean
}

export class RemotePreviewBook {
  private disposed = false
  private readonly byAddress = new Map<string, RecordState>()
  private readonly byKey = new Map<string, RecordState>()
  private readonly views = new Set<ViewState>()
  private replacement: {
    readonly incoming: RecordState
    readonly outgoing: RecordState
    readonly committed: RemotePreviewReplacement['committed']
  } | undefined
  private activeReads = 0

  constructor(
    private readonly client: RemoteFileContentClient,
    private readonly authorization: RemoteFilesAuthorizationBook,
    private readonly activeSession: () => string | undefined,
    private readonly mintId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * Register a file for preview and return its opaque address, reusing the
   * live record the same logical key already has. `undefined` when the
   * request cannot parse or the session moved on. At capacity, stage only
   * one replacement with no pin or view until the host commits the handoff.
   * A request that needs another slot throws `resource-budget`.
   */
  register(identity: SshFilesIdentity, relativePath: string, label: string, replace?: RemotePreviewReplacement): string | undefined {
    if (this.disposed || this.activeSession() !== identity.sessionId) return undefined
    const request = { ...authorizationRequest(identity), relativePath }
    if (!remoteFilesReadRequest.safeParse(request).success) return undefined
    const key = JSON.stringify([providerKey(identity), relativePath])
    const existing = this.byKey.get(key)
    if (existing !== undefined && !existing.control.signal.aborted) return existing.record.address
    let outgoing: RecordState | undefined
    if (this.byAddress.size >= REMOTE_FILE_PREVIEW_LIMITS.clientResources) {
      outgoing = replace === undefined ? undefined : this.byAddress.get(replace.address)
      if (this.replacement !== undefined || outgoing === undefined || outgoing.pins.size === 0
        || outgoing.record.identity.sessionId !== identity.sessionId) throw new RemoteFilesError('resource-budget')
    }
    const address = remoteFileAddress(this.mintId())
    // A mint that cannot produce a v4 UUID, or one that collides with a live
    // record, is a programming fault — never a silent replacement.
    if (address === undefined) throw new Error('multi-root workspace: preview mint produced no v4 UUID')
    if (this.byAddress.has(address)) throw new Error('multi-root workspace: preview address collision')
    const control = new AbortController()
    const state: RecordState = {
      record: {
        address,
        // Defensive copies: the caller owns the objects it passed.
        identity: {
          sessionId: identity.sessionId,
          root: { kind: 'remote', environmentId: identity.root.environmentId, rootId: identity.root.rootId },
          incarnation: identity.incarnation,
        },
        relativePath,
        label,
        signal: control.signal,
      },
      key,
      control,
      pins: new Map(),
      listeners: new Set(),
      leased: false,
      expiry: setTimeout(() => this.forgetUnpinned(address), 5000),
    }
    this.byAddress.set(address, state)
    this.byKey.set(key, state)
    if (outgoing !== undefined && replace !== undefined) {
      this.replacement = { incoming: state, outgoing, committed: replace.committed }
    }
    return address
  }

  /**
   * The live record for one ACTIVE session — also answers for a
   * still-unpinned registered address (host title metadata before the
   * committed occurrence). Never a record the parse rejects, another
   * session owns, or whose session is no longer active.
   */
  get(address: string, sessionId: string): RemotePreviewRecord | undefined {
    if (remoteFileId(address) === undefined) return undefined
    const state = this.byAddress.get(address)
    if (state === undefined || state.control.signal.aborted) return undefined
    if (state.record.identity.sessionId !== sessionId || this.activeSession() !== sessionId) return undefined
    return state.record
  }

  /**
   * Pin a record for one DSH resource occurrence: the first pin installs
   * the shared authorization lease; the last pin's release retires the
   * record. `undefined` for an unknown, expired or foreign address.
   */
  pin(address: string, signal: AbortSignal): RemotePreviewRecord | undefined {
    const state = this.byAddress.get(address)
    if (state === undefined || state.control.signal.aborted || signal.aborted || remoteFileId(address) === undefined) return undefined
    const replacement = this.replacement
    if (replacement?.incoming === state) {
      if (!replacement.committed(address)) return undefined
      this.replacement = undefined
      // The Host can retain a resource subscription briefly after removing
      // its tab. The committed layout proves the old slot has no occurrence.
      this.retire(replacement.outgoing, new RemoteFilesError('cancelled'))
      if (state.control.signal.aborted || signal.aborted) return undefined
    }
    if (state.pins.has(signal)) return state.record
    if (!state.leased) {
      state.leased = true
      void this.authorization.observe(state.record.identity, state.control.signal).catch((failure: unknown) => {
        this.invalidateGrant(state, failure)
      })
    }
    const unpin = (): void => {
      state.pins.delete(signal)
      if (state.pins.size === 0) this.retire(state, new RemoteFilesError('cancelled'))
    }
    const wasUnpinned = state.pins.size === 0
    state.pins.set(signal, unpin)
    signal.addEventListener('abort', unpin, { once: true })
    // The pending → ready edge is observable: a viewer that mounted before
    // the occurrence pin wakes exactly here, never by polling.
    if (wasUnpinned) {
      for (const listener of [...state.listeners]) listener()
    }
    return state.record
  }

  /**
   * The pin readiness of a LIVE record, for `useSyncExternalStore` snapshots:
   * `pending` — registered, no occurrence pin yet; `ready` — at least one pin
   * (content views may mount); `expired` — retired, aborted, or foreign.
   */
  pinState(record: RemotePreviewRecord): 'pending' | 'ready' | 'expired' {
    const state = this.byAddress.get(record.address)
    if (state === undefined || state.record !== record || state.control.signal.aborted) return 'expired'
    return state.pins.size === 0 ? 'pending' : 'ready'
  }

  /**
   * Subscribe to `pinState` changes of one exact live record. The notify
   * fires when the first pin lands and when the record retires; the returned
   * unsubscribe is idempotent. An unknown, mismatched or dead record
   * subscribes nothing — React's snapshot read right after subscribe
   * observes `expired` on its own.
   */
  subscribePinState(record: RemotePreviewRecord, listener: () => void): () => void {
    const state = this.byAddress.get(record.address)
    if (state === undefined || state.record !== record || state.control.signal.aborted) return () => {}
    state.listeners.add(listener)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      state.listeners.delete(listener)
    }
  }

  /**
   * Retire a registered record that was never pinned — the expiry timer's
   * job. Does nothing under a live pin (only the release callback retires a
   * pinned record) or when the map already moved on.
   */
  forgetUnpinned(address: string): void {
    const state = this.byAddress.get(address)
    if (state === undefined || state.pins.size !== 0) return
    this.retire(state, new RemoteFilesError('cancelled'))
  }

  /**
   * Reserve a content view on a pinned record for one session. Throws a
   * coded failure when the record is gone, unpinned or foreign, and
   * `resource-budget` over the view cap. No network happens here.
   */
  mount(address: string, sessionId: string, signal: AbortSignal): RemotePreviewView {
    const state = this.byAddress.get(address)
    if (remoteFileId(address) === undefined || state === undefined || state.control.signal.aborted
      || state.record.identity.sessionId !== sessionId || this.activeSession() !== sessionId
      || state.pins.size === 0 || signal.aborted) {
      throw new RemoteFilesError('root-unregistered')
    }
    if (this.views.size >= REMOTE_FILE_PREVIEW_LIMITS.clientContentViews) throw new RemoteFilesError('resource-budget')
    const viewState: ViewState = { sessionId, control: new AbortController(), latest: undefined }
    const viewSignal = AbortSignal.any([state.control.signal, signal, viewState.control.signal])
    const retire = (): void => {
      if (!this.views.delete(viewState)) return
      viewState.control.abort()
    }
    viewSignal.addEventListener('abort', retire, { once: true })
    this.views.add(viewState)
    if (viewSignal.aborted) retire()
    const record = state.record
    const view: RemotePreviewView = {
      signal: viewSignal,
      read: async (caller: AbortSignal): Promise<RemoteFilesReadContent> => {
        if (viewSignal.aborted || caller.aborted || this.activeSession() !== sessionId) throw new RemoteFilesError('cancelled')
        viewState.latest?.abort()
        if (this.activeReads >= REMOTE_FILE_PREVIEW_LIMITS.clientReadConcurrent) throw new RemoteFilesError('resource-budget')
        const thisRead = new AbortController()
        viewState.latest = thisRead
        const readSignal = AbortSignal.any([viewSignal, caller, thisRead.signal])
        this.activeReads++
        try {
          const value = await this.client.read(
            { ...authorizationRequest(record.identity), relativePath: record.relativePath },
            readSignal,
          )
          if (readSignal.aborted || viewState.latest !== thisRead || this.activeSession() !== sessionId) {
            throw new RemoteFilesError('cancelled')
          }
          return value
        } catch (error: unknown) {
          if (readSignal.aborted || viewState.latest !== thisRead || this.activeSession() !== sessionId) {
            throw new RemoteFilesError('cancelled')
          }
          const failure = error instanceof RemoteFilesError ? error : new RemoteFilesError('provider-unavailable')
          // Grant-level failures retire every record of this exact grant;
          // file-local failures and malformed payloads never do.
          if (PREVIEW_INVALIDATIONS.has(failure.code)) this.invalidateGrant(state, failure)
          throw failure
        } finally {
          this.activeReads--
          if (viewState.latest === thisRead) viewState.latest = undefined
        }
      },
      release: () => { retire() },
    }
    return view
  }

  /**
   * Abort every content view of one session — records, pins and the shared
   * lease stay (a return to the session may still be authorized). No
   * content is retained across the operation.
   */
  stopSession(sessionId: string): void {
    for (const view of [...this.views]) {
      if (view.sessionId === sessionId) view.control.abort()
    }
  }

  /** Retire every record and view; the shared authorization book is not ours. */
  dispose(): void {
    this.disposed = true
    for (const view of [...this.views]) view.control.abort()
    for (const state of [...this.byAddress.values()]) this.retire(state, new RemoteFilesError('provider-unavailable'))
  }

  /**
   * Retire every live record of one grant — exact providerKey, including
   * session and incarnation. Called on lease rejection and on grant-level
   * read failures.
   */
  private invalidateGrant(state: RecordState, failure: unknown): void {
    // A late rejection from a retired record's lease must never sweep the
    // replacement minted under the same grant.
    if (this.byAddress.get(state.record.address) !== state || state.control.signal.aborted) return
    const key = providerKey(state.record.identity)
    for (const candidate of [...this.byAddress.values()]) {
      if (providerKey(candidate.record.identity) === key) {
        this.retire(candidate, failure instanceof RemoteFilesError ? failure : new RemoteFilesError('provider-unavailable'))
      }
    }
  }

  /**
   * Retire one record: drop its map entries, expiry and pin listeners
   * BEFORE broadcasting the abort — a reentrant caller (a pin release or a
   * fresh `register` under the same key inside a record-signal listener)
   * then observes no record at all, and a late callback can never kill a
   * replacement. The abort itself is still synchronous; `pinState`
   * subscribers are pinged after it so their next snapshot already reads
   * `expired`, then cleared.
   */
  private retire(state: RecordState, reason: unknown): void {
    if (this.byAddress.get(state.record.address) !== state) return
    if (this.replacement?.incoming === state) this.replacement = undefined
    this.byAddress.delete(state.record.address)
    if (this.byKey.get(state.key) === state) this.byKey.delete(state.key)
    clearTimeout(state.expiry)
    for (const [signal, unpin] of [...state.pins]) signal.removeEventListener('abort', unpin)
    state.pins.clear()
    state.control.abort(reason)
    for (const listener of [...state.listeners]) listener()
    state.listeners.clear()
  }
}
