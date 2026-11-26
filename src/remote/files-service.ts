/**
 * The `remoteFiles.list` service (ADR-0052 P3): the only code path that turns a
 * browser's "show me this registered remote root" into SFTP directory I/O.
 *
 * The security model is deliberately narrow: a listing runs ONLY when the
 * deployment binding carries `directoryListing: 'stable-path'` — the
 * operator's assertion that no untrusted remote process can swap workspace or
 * ancestor directories while the Host browses. Path canonicalization alone
 * cannot defeat an ABA symlink swap on SFTP, so the opt-in is the boundary;
 * without it every request fails `capability-unsupported` before any I/O.
 * Helper transports may carry object-target grants for exec/copy, but browsing
 * never interprets that object identity as a path grant: it is admitted only
 * when the same opted-in binding also passed registration's independent SFTP
 * path probe, and every listing re-probes the canonical path on its owned
 * SFTP channel.
 *
 * Concurrency: at most {@link REMOTE_FILES_LIMITS.concurrent} listings are
 * active; a fifth request fails `resource-budget` immediately — there is no
 * queue. A claimed slot is held until the work actually unwinds. Every
 * listing runs under one 12s wall deadline that includes admission.
 *
 * Fail-closed by construction: the browser's opaque `authorization` must
 * equal the hash of the live epoch, grant incarnation, binding digest and
 * environment digest — computed twice, before AND after the network I/O — and
 * the service cancels in-flight work only when THIS endpoint's admission
 * stops matching; an unrelated registry write never aborts a listing.
 */
import { RemoteAdmissionError, type RemoteEndpointRef } from './contract.ts'
import { remoteFilesAuthorization } from './files-authorization.ts'
import {
  RemoteFilesError,
  REMOTE_FILES_LIMITS,
  type RemoteFilesAuthorizationRequest,
  type RemoteFilesFailureCode,
  type RemoteFilesListRequest,
  type RemoteFilesListing,
} from './files-contract.ts'
import { bindingDigest, environmentDigest, type DeploymentManifest, type RemoteBinding } from './manifest.ts'
import { SftpClient, SftpConnectionLost, SftpStatusError, SSH_FX_NO_SUCH_FILE, SSH_FX_PERMISSION_DENIED } from './sftp.ts'
import { SshEnvironmentError, type SftpEnvironment } from './ssh-environment.ts'
import { primaryKey } from '../roots.ts'

export { remoteFilesAuthorization } from './files-authorization.ts'

/** The registry surface the service needs — satisfied by MultiRootRegistry. */
export interface RemoteFilesRegistry {
  remoteManifest: DeploymentManifest | undefined
  withRemoteFilesRead<T>(sessionId: string, endpoint: RemoteEndpointRef, body: (operation: {
    readonly identity: {
      readonly primaryRoot: string
      readonly authorityEpoch: string | undefined
    }
    readonly endpoints: readonly {
      readonly environmentId: string
      readonly rootId: string
      readonly displayPath: string
      readonly verifiedTarget: { readonly kind: 'object' | 'path'; readonly value: string } | null
      readonly bindingDigest: string | null
      readonly environmentDigest: string | null
      readonly incarnation?: string
      readonly localRoot: unknown
    }[]
  }) => T | Promise<T>): Promise<T>
  onRemoteChange(listener: () => void): () => void
}

/** The connection surface the service needs — satisfied by SshEnvironmentManager. */
export interface RemoteFilesManager {
  readonly deployment: DeploymentManifest
  /**
   * The host's SSH capability verdict (`SshEnvironmentManager.capability`):
   * a manager that lost its gate may not advertise browse support. Absent
   * on test doubles, which then count as ungated.
   */
  readonly capability?: { readonly eligible: boolean } | undefined
  openFilesSftp(environmentId: string, signal: AbortSignal, expectedDigest: string): Promise<SftpEnvironment & { live(): boolean }>
}

/** The immutable grant facts extracted inside one admission callback. */
interface AdmittedGrant {
  readonly path: string
  readonly environmentDigest: string
  readonly token: string
}

/** RemoteAdmissionError code → vocabulary entry; everything else degrades. */
const ADMISSION_CODES: Record<string, RemoteFilesFailureCode> = {
  'remote-unavailable': 'provider-unavailable',
  'session-unavailable': 'session-unavailable',
  'session-policy-unavailable': 'session-unavailable',
  'local-root-unavailable': 'session-unavailable',
  'endpoint-not-registered': 'root-unregistered',
  'endpoint-revoked': 'root-unregistered',
  'endpoint-withheld': 'root-unregistered',
  'mode-denies': 'permission-denied',
  'tool-capped': 'permission-denied',
  'action-not-allowed': 'permission-denied',
  'invalid-arguments': 'invalid-request',
  'stale-epoch': 'environment-changed',
  'binding-changed': 'binding-changed',
  'config-digest-mismatch': 'environment-changed',
}

function environmentCode(code: string): RemoteFilesFailureCode {
  if (code === 'unknown-environment' || code === 'stale') return 'environment-changed'
  if (code === 'binding-changed') return 'binding-changed'
  if (code === 'remote-unavailable') return 'provider-unavailable'
  if (code === 'files-unavailable' || code === 'transfer-unavailable') return 'resource-budget'
  if (code === 'credential-isolation-unattested' || code === 'permission-denied') return 'permission-denied'
  if (code.startsWith('ssh-capability-absent') || code === 'capability-unsupported'
    || code === 'publish-unsupported' || code === 'transport-not-helper' || code === 'workspace-invalid') {
    return 'capability-unsupported'
  }
  return 'connection-failed'
}

export class RemoteFilesService {
  private active = 0
  private waits = 0
  private live = true
  private readonly jobs = new Set<Promise<void>>()
  private readonly shutdown = new AbortController()

  constructor(
    private readonly registry: RemoteFilesRegistry,
    private readonly manager: RemoteFilesManager,
    private readonly logger: { debug(message: string): void; warn(message: string): void },
  ) {}

  /** Whether one binding may be browsed RIGHT NOW — the explicit opt-in and live capability gate. */
  supports(environmentId: string, binding: RemoteBinding): boolean {
    if (!this.live || typeof this.manager.openFilesSftp !== 'function') return false
    if (this.manager.capability !== undefined && !this.manager.capability.eligible) return false
    return this.registry.remoteManifest?.environments.some(entry => entry.environmentId === environmentId) === true
      && binding.directoryListing === 'stable-path'
  }

  /**
   * Stop admitting work, abort every in-flight listing and wait for its
   * unwind. The manager owns the physical channels; this only ends ours.
   */
  async dispose(): Promise<void> {
    if (!this.live) return
    this.live = false
    this.shutdown.abort()
    await Promise.allSettled([...this.jobs])
  }

  async list(request: RemoteFilesListRequest, callerSignal?: AbortSignal): Promise<RemoteFilesListing> {
    if (!this.live) throw new RemoteFilesError('provider-unavailable')
    // 0 waiting: a request that cannot start immediately never queues.
    if (this.active >= REMOTE_FILES_LIMITS.concurrent) throw new RemoteFilesError('resource-budget')
    const deadline = new AbortController()
    const stateAbort = new AbortController()
    const signal = AbortSignal.any(
      callerSignal === undefined
        ? [this.shutdown.signal, deadline.signal, stateAbort.signal]
        : [this.shutdown.signal, deadline.signal, stateAbort.signal, callerSignal],
    )
    // The abort race: a backend operation that ignores the signal still
    // loses the listing; the owned channel is closed by run's own listener.
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.reject(signal.reason instanceof Error ? signal.reason : new RemoteFilesError('cancelled'))
    }
    // A pre-aborted request never claims a slot nor reaches admission.
    if (signal.aborted) throw this.normalize(signal.reason, deadline, stateAbort, callerSignal)
    this.active++
    const job = Promise.withResolvers<void>()
    this.jobs.add(job.promise)
    const timer = setTimeout(() => deadline.abort(), REMOTE_FILES_LIMITS.deadlineMs)
    timer.unref()
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      const run = this.run(request, signal, stateAbort, callerSignal, deadline).finally(() => {
        // The slot, job record and timer are released only when the task
        // ACTUALLY unwound — never when the race merely returned early.
        clearTimeout(timer)
        this.active--
        this.jobs.delete(job.promise)
        job.resolve()
      })
      try {
        const listing = await Promise.race([run, aborted.promise])
        // A cancellation landing between the last I/O and now must not
        // report success.
        signal.throwIfAborted()
        return listing
      } catch (error) {
        throw this.normalize(error, deadline, stateAbort, callerSignal)
      }
    } finally {
      // The race already consumed any abort; removing the listener keeps a
      // late abort from rejecting a promise nobody awaits.
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One authorization lease (ADR-0052 P4): an authenticated metadata wait on
   * the grant's live identity — NOT a filesystem watch. It resolves only when
   * the 15s window expires AFTER a final admission still matches; any drift in
   * this endpoint's hashed identity rejects with the same fixed vocabulary a
   * listing would report, so the browser retires the tree instead of drawing a
   * stale one. There is no SSH probing, no file data, and no auto-relist —
   * only the control plane answers, and the lease ends on caller abort,
   * disconnect, service unmount or the cap.
   */
  async waitForAuthorizationChange(request: RemoteFilesAuthorizationRequest, callerSignal?: AbortSignal): Promise<void> {
    if (!this.live) throw new RemoteFilesError('provider-unavailable')
    // 0 waiting, and independent of the listing pool.
    if (this.waits >= REMOTE_FILES_LIMITS.waitConcurrent) throw new RemoteFilesError('resource-budget')
    const stateAbort = new AbortController()
    const signal = AbortSignal.any(
      callerSignal === undefined
        ? [this.shutdown.signal, stateAbort.signal]
        : [this.shutdown.signal, stateAbort.signal, callerSignal],
    )
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.reject(signal.reason instanceof Error ? signal.reason : new RemoteFilesError('cancelled'))
    }
    // A pre-aborted lease never claims a slot nor reaches admission.
    if (signal.aborted) throw this.normalize(signal.reason, undefined, stateAbort, callerSignal)
    this.waits++
    const job = Promise.withResolvers<void>()
    this.jobs.add(job.promise)
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      const run = this.wait(request, signal, stateAbort).finally(() => {
        // The lease slot is released only when the body actually unwinds.
        this.waits--
        this.jobs.delete(job.promise)
        job.resolve()
      })
      try {
        await Promise.race([run, aborted.promise])
        signal.throwIfAborted()
      } catch (error) {
        throw this.normalize(error, undefined, stateAbort, callerSignal)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One lease end to end: the change listener installs BEFORE the first
   * admission (a drift between them cannot slip), notifications coalesce
   * through a dirty flag while one re-admission is pending, and the lease
   * timer's answer requires a final matching admission. Every admission is
   * bounded by {@link REMOTE_FILES_LIMITS.waitAdmissionMs} so an ordered-owner
   * stall — an expired session, a stuck manifest read — cannot outlive the
   * lease.
   */
  private async wait(request: RemoteFilesAuthorizationRequest, signal: AbortSignal, stateAbort: AbortController): Promise<void> {
    signal.throwIfAborted()
    // Every engine task this lease started — tracked so the caller's slot
    // stays claimed until the LAST underlying admission actually settles:
    // a cancelled race does not free the budget while the ordered registry
    // call still runs, so cancel+resubmit can never bypass the cap.
    const pending = new Set<Promise<AdmittedGrant>>()
    // At most one admission engine call runs per lease at a time: a
    // recheck for the SAME token reuses the in-flight admission instead of
    // stacking another ordered call behind it.
    let inFlight: { readonly token: string | undefined; readonly promise: Promise<AdmittedGrant> } | undefined
    const admitBounded = async (expectedToken?: string): Promise<AdmittedGrant> => {
      // A dead lease never starts the timer nor the ordered engine call.
      signal.throwIfAborted()
      const bound = new AbortController()
      const timer = setTimeout(() => bound.abort(new RemoteFilesError('timeout')), REMOTE_FILES_LIMITS.waitAdmissionMs)
      timer.unref()
      const combined = AbortSignal.any([signal, bound.signal])
      const failed = Promise.withResolvers<never>()
      const onAbort = (): void => {
        failed.reject(combined.reason instanceof Error ? combined.reason : new RemoteFilesError('timeout'))
      }
      try {
        // Checked BEFORE launching: an aborted lease creates no engine task.
        combined.throwIfAborted()
        let admission: Promise<AdmittedGrant> | undefined
        if (inFlight !== undefined && inFlight.token === expectedToken) {
          admission = inFlight.promise
        } else {
          const created = this.admit(request, expectedToken).finally(() => {
            pending.delete(created)
            if (inFlight?.promise === created) inFlight = undefined
          })
          admission = created
          pending.add(created)
          inFlight = { token: expectedToken, promise: created }
        }
        combined.addEventListener('abort', onAbort, { once: true })
        // An abort landing between creation and listener registration is
        // still honored — the engine task stays tracked in `pending` and is
        // drained by the lease's own finally.
        combined.throwIfAborted()
        return await Promise.race([admission, failed.promise])
      } finally {
        clearTimeout(timer)
        combined.removeEventListener('abort', onAbort)
      }
    }
    let done = false
    let dirty = false
    let rechecking: Promise<void> | undefined
    let admitted: AdmittedGrant | undefined
    const unsubscribe = this.registry.onRemoteChange(() => {
      if (done) return
      if (rechecking !== undefined) { dirty = true; return }
      rechecking = (async () => {
        try {
          do {
            dirty = false
            await admitBounded(admitted?.token)
          } while (dirty && !done)
        } catch (error: unknown) {
          if (!done) stateAbort.abort(error)
        } finally {
          rechecking = undefined
        }
      })()
    })
    try {
      admitted = await admitBounded()
      await new Promise<void>((resolve, reject) => {
        const bail = (): void => {
          clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new RemoteFilesError('cancelled'))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', bail)
          resolve()
        }, REMOTE_FILES_LIMITS.waitLeaseMs)
        timer.unref()
        if (signal.aborted) bail()
        else signal.addEventListener('abort', bail, { once: true })
      })
      // A lease may only answer "unchanged" after a FINAL admission still
      // matches — never a blind timer success. The expiry sequence is
      // deliberate: stop accepting notifications, let any in-flight re-
      // admission unwind, then require a NEW ordered admission — a pending
      // recheck that ordered BEFORE a newer revoke must never stand in for
      // the final proof.
      done = true
      unsubscribe()
      if (rechecking !== undefined) await rechecking
      signal.throwIfAborted()
      inFlight = undefined
      await admitBounded(admitted.token)
      signal.throwIfAborted()
    } catch (error) {
      // Wake the caller's race BEFORE draining engine tasks — but only for
      // a real coded failure: a reason that is merely the abort artifact
      // (caller/shutdown cancellation already fired, and it wins) changes
      // nothing and would pollute normalization.
      if (!signal.aborted && !stateAbort.signal.aborted
        && (error instanceof RemoteFilesError || error instanceof RemoteAdmissionError)) {
        stateAbort.abort(error)
      }
      throw error
    } finally {
      done = true
      unsubscribe()
      await Promise.allSettled([...pending])
    }
  }

  /**
   * One listing end to end: admit → verify → owned channel → canonical probes
   * → bounded OPENDIR/READDIR → probes again → re-admit → bytes. Network I/O
   * always happens OUTSIDE the registry's ordered admission; the re-admission
   * listener subscribes only after the first admit produced the token.
   */
  private async run(
    request: RemoteFilesListRequest,
    signal: AbortSignal,
    stateAbort: AbortController,
    callerSignal: AbortSignal | undefined,
    deadline: AbortController,
  ): Promise<RemoteFilesListing> {
    signal.throwIfAborted()
    const admitted = await this.admit(request)
    signal.throwIfAborted()
    // Cancel only when THIS endpoint's facts stop matching; an unrelated
    // registry write re-admits cleanly and the listing continues. While one
    // re-admission is in flight, further notifications coalesce into the
    // dirty flag and drain in a do-loop — never a second pending admit.
    let done = false
    let dirty = false
    let rechecking: Promise<void> | undefined
    const unsubscribe = this.registry.onRemoteChange(() => {
      if (done) return
      if (rechecking !== undefined) { dirty = true; return }
      rechecking = (async () => {
        try {
          do {
            dirty = false
            await this.admit(request, admitted.token)
          } while (dirty && !done)
        } catch (error: unknown) {
          if (!done) stateAbort.abort(error)
        } finally {
          rechecking = undefined
        }
      })()
    })
    let env: (SftpEnvironment & { live(): boolean }) | undefined
    // envReady gates the close promise so an abort landing while
    // openFilesSftp is still pending still disposes the late-arriving
    // channel rather than closing "nothing".
    const envReady = Promise.withResolvers<void>()
    let closing: Promise<void> | undefined
    const closeOwned = (): Promise<void> => closing ??= envReady.promise.then(async () => {
      // Exactly-once, and only ever OUR channel: env.dispose is idempotent
      // and the shared/transfer sessions are different manager records.
      if (env === undefined) return
      await env.dispose().catch(() => {
        this.logger.warn('multi-root remote: files channel cleanup failed')
      })
    })
    try {
      const close = (): void => { void closeOwned() }
      signal.addEventListener('abort', close, { once: true })
      try {
        signal.throwIfAborted()
        // The computed absolute lookup path is bounded BEFORE the channel
        // opens: binding root + '/' + relative must fit `absolutePathBytes`
        // — the manifest bound each piece separately, so the assembly is
        // refused here, without spending an SFTP open on it.
        if (Buffer.byteLength(`${admitted.path}/${request.relativePath}`, 'utf8') > REMOTE_FILES_LIMITS.absolutePathBytes) {
          throw new RemoteFilesError('invalid-request')
        }
        env = await this.manager.openFilesSftp(request.environmentId, signal, admitted.environmentDigest)
          .then(acquired => {
            // Assign BEFORE resolving envReady so a close racing the open
            // always sees the channel it must dispose.
            env = acquired
            envReady.resolve()
            return acquired
          }, (error: unknown) => {
            envReady.resolve()
            throw this.normalize(error, deadline, stateAbort, callerSignal)
          })
        // The open may have resolved after the abort fired: the listener
        // already scheduled disposal; never proceed on a dead signal.
        signal.throwIfAborted()
        const target = await this.probe(env.client, admitted, request.relativePath, signal)
        const listing = await env.client.readdirBounded(target, signal)
        signal.throwIfAborted()
        // SFTP offers no fd-bound listing: the same canonical probes repeat
        // AFTER the read so a swap landing mid-listing still fails closed.
        await this.probe(env.client, admitted, request.relativePath, signal)
        signal.throwIfAborted()
        if (!env.live()) throw new RemoteFilesError('connection-lost')
        // Finish in the authorization lease's order: stop taking newer
        // notifications, drain the recheck already admitted into the dirty
        // loop, then require a NEW ordered admission. A recheck that ordered
        // before a newer revoke can never stand in for the final proof.
        done = true
        unsubscribe()
        if (rechecking !== undefined) await rechecking
        signal.throwIfAborted()
        await this.admit(request, admitted.token)
        signal.throwIfAborted()
        if (!env.live()) throw new RemoteFilesError('connection-lost')
        return listing
      } finally {
        done = true
        signal.removeEventListener('abort', close)
        // A throw BEFORE the open settled leaves envReady pending; resolve
        // it so a close scheduled during the wait cannot deadlock.
        envReady.resolve()
        await closeOwned()
      }
    } finally {
      unsubscribe()
      // A notification already admitted into the dirty-loop is part of this
      // listing's ordered work. Drain it before `run` settles: the caller may
      // still win the cancellation race early, but the listing slot and the
      // service-dispose barrier never release ahead of the registry request.
      if (rechecking !== undefined) await rechecking
    }
  }

  /**
   * One ordered admission: re-binds the session, re-checks the grant's live
   * digests and the opt-in, and returns ONLY the immutable facts the network
   * phase needs. With `expectedToken` this is the re-admission: any drift in
   * the hashed identity fails the listing before its bytes are trusted.
   */
  private async admit(
    request: { readonly sessionId: string; readonly environmentId: string; readonly rootId: string; readonly authorization: string },
    expectedToken?: string,
  ): Promise<AdmittedGrant> {
    return await this.registry.withRemoteFilesRead(
      request.sessionId,
      { environmentId: request.environmentId, rootId: request.rootId },
      operation => {
        const endpoint = operation.endpoints.find(
          entry => entry.environmentId === request.environmentId && entry.rootId === request.rootId,
        )
        if (endpoint === undefined || endpoint.localRoot !== null) throw new RemoteFilesError('root-unregistered')
        const epoch = operation.identity.authorityEpoch
        if (epoch === undefined || endpoint.incarnation === undefined
          || endpoint.bindingDigest === null || endpoint.environmentDigest === null) {
          throw new RemoteFilesError('root-identity-changed')
        }
        if (endpoint.verifiedTarget === null) throw new RemoteFilesError('root-identity-changed')
        const token = remoteFilesAuthorization(epoch, endpoint.incarnation, endpoint.bindingDigest, endpoint.environmentDigest)
        if (request.authorization !== token || (expectedToken !== undefined && token !== expectedToken)) {
          throw new RemoteFilesError('binding-changed')
        }
        const deployment = this.manager.deployment
        const environment = deployment.environments.find(entry => entry.environmentId === request.environmentId)
        const binding = deployment.bindings.find(entry => entry.environmentId === request.environmentId
          && entry.rootId === request.rootId && primaryKey(entry.primary) === operation.identity.primaryRoot)
        if (environment === undefined || environmentDigest(environment) !== endpoint.environmentDigest) {
          throw new RemoteFilesError('environment-changed')
        }
        if (binding === undefined || bindingDigest(environment, binding) !== endpoint.bindingDigest
          || endpoint.displayPath !== binding.path) {
          throw new RemoteFilesError('binding-changed')
        }
        // SFTP registrations are path-targeted and must still name the same
        // path. Helper registrations stay object-targeted for exec/copy; the
        // opt-in's separate SFTP path probe is what authorizes browse-only
        // listing, never the object identity domain.
        if (endpoint.verifiedTarget.kind === 'path' && endpoint.verifiedTarget.value !== binding.path) {
          throw new RemoteFilesError('root-identity-changed')
        }
        if (endpoint.verifiedTarget.kind === 'object' && environment.transport !== 'helper') {
          throw new RemoteFilesError('root-identity-changed')
        }
        // Same gate `supports` announces: a manager that lost eligibility
        // (Helper-less channel gone, broker demoted) may not announce a
        // matching token — listings AND authorization waits fail identically.
        // Manager-shaped fixtures without `capability` stay admitted.
        if (binding.directoryListing !== 'stable-path' || this.manager.capability?.eligible === false) {
          throw new RemoteFilesError('capability-unsupported')
        }
        return { path: binding.path, environmentDigest: endpoint.environmentDigest, token }
      },
    )
  }

  /**
   * The canonical-path probes, built by appending validated segments with '/'
   * — never a host path API. The root's `realpath` must return the declared
   * path verbatim (else `root-identity-changed`); every ancestor must be a
   * real directory, never a symlink; the target's `realpath` must equal the
   * assembled path (else `path-escapes-root`). Runs before AND after the
   * bounded listing.
   */
  private async probe(client: SftpClient, admitted: AdmittedGrant, relativePath: string, signal: AbortSignal): Promise<string> {
    // The root's own lstat runs BEFORE realpath: a root swapped for a
    // symlink is refused outright, never followed.
    const rootKind = await this.kindOf(client, admitted.path, true)
    if (rootKind !== 'directory') throw new RemoteFilesError('root-identity-changed')
    signal.throwIfAborted()
    const real = await client.realpath(admitted.path).catch((error: unknown) => { throw this.probeError(error, true) })
    if (real !== admitted.path) throw new RemoteFilesError('root-identity-changed')
    const segments = relativePath === '' ? [] : relativePath.split('/')
    let target = admitted.path
    for (let i = 0; i < segments.length; i++) {
      signal.throwIfAborted()
      target = `${target === '/' ? '' : target}/${segments[i]}`
      // lstat BEFORE realpath on the target as well: a swapped-in symlink
      // fails closed instead of being resolved.
      const kind = await this.kindOf(client, target, false)
      if (kind === 'symlink') throw new RemoteFilesError('path-escapes-root')
      if (kind !== 'directory') throw new RemoteFilesError('not-directory')
      if (i === segments.length - 1) {
        const realTarget = await client.realpath(target).catch((error: unknown) => { throw this.probeError(error, false) })
        if (realTarget !== target) throw new RemoteFilesError('path-escapes-root')
      }
    }
    signal.throwIfAborted()
    return target
  }

  private async kindOf(client: SftpClient, path: string, root: boolean): Promise<'directory' | 'symlink' | 'other'> {
    const attrs = await client.lstat(path).catch((error: unknown) => { throw this.probeError(error, root) })
    const kind = (attrs.permissions ?? 0) & 0o170000
    return kind === 0o040000 ? 'directory' : kind === 0o120000 ? 'symlink' : 'other'
  }

  /** Path-probe failures: root failures are identity; descendants keep the distinct vocabulary. */
  private probeError(error: unknown, root: boolean): Error {
    if (error instanceof RemoteFilesError || error instanceof SftpConnectionLost) return error
    if (error instanceof SftpStatusError) {
      if (error.code === SSH_FX_PERMISSION_DENIED) return new RemoteFilesError('permission-denied')
      if (root) return new RemoteFilesError('root-identity-changed')
      if (error.code === SSH_FX_NO_SUCH_FILE) return new RemoteFilesError('directory-not-found')
      return new RemoteFilesError('connection-failed')
    }
    return root ? new RemoteFilesError('root-identity-changed') : error as Error
  }

  /** Everything leaving this service is a vocabulary entry — never raw error text. */
  private normalize(error: unknown, deadline: AbortController | undefined, stateAbort: AbortController, callerSignal: AbortSignal | undefined): RemoteFilesError {
    // Abort-state checks come FIRST: an abort racing a coded failure reports
    // the abort's own classification, not whichever error landed alongside.
    if (stateAbort.signal.aborted) {
      const reason: unknown = stateAbort.signal.reason
      if (reason instanceof RemoteFilesError) return reason
      // An admission rejection carries its own code — do not collapse it
      // into a root-identity failure.
      if (reason instanceof RemoteAdmissionError) {
        return new RemoteFilesError(ADMISSION_CODES[reason.code] ?? 'provider-unavailable')
      }
      return new RemoteFilesError('root-identity-changed')
    }
    if (callerSignal?.aborted) return new RemoteFilesError('cancelled')
    if (deadline?.signal.aborted === true) return new RemoteFilesError('timeout')
    if (this.shutdown.signal.aborted || !this.live) return new RemoteFilesError('provider-unavailable')
    if (error instanceof RemoteFilesError) return error
    if (error instanceof RemoteAdmissionError) return new RemoteFilesError(ADMISSION_CODES[error.code] ?? 'provider-unavailable')
    if (error instanceof SftpStatusError) {
      if (error.message === 'invalid-listing') return new RemoteFilesError('invalid-listing')
      if (error.code === SSH_FX_NO_SUCH_FILE) return new RemoteFilesError('directory-not-found')
      if (error.code === SSH_FX_PERMISSION_DENIED) return new RemoteFilesError('permission-denied')
      return new RemoteFilesError('connection-failed')
    }
    if (error instanceof SftpConnectionLost) return new RemoteFilesError('connection-lost')
    if (error instanceof SshEnvironmentError) return new RemoteFilesError(environmentCode(error.code))
    return new RemoteFilesError('connection-failed')
  }
}
