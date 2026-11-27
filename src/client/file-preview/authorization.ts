/**
 * The shared authorization-lease book (ADR-0053 P4): ONE in-flight
 * `remotes.waitForAuthorizationChange` per remote grant — keyed by the
 * provider's exact `providerKey` — serves every observer of that grant
 * (the tree's owner lease today, the preview records tomorrow). The token
 * itself never leaves the request tuple: no serialized credential is
 * exported, persisted or logged.
 *
 * Semantics:
 * - `observe` resolves only when THAT observer releases (its signal) or the
 *   book is disposed; it rejects with the fixed `remoteFiles` vocabulary if
 *   the shared lease task fails first — the caller invalidates its surface.
 * - A rejection ends the shared task: no retry, no auto-relist.
 * - The last observer's release schedules the controller abort on a
 *   microtask — a same-turn rejoin shares the live wire call; once the
 *   abort lands, the map entry stays until the wire call actually unwinds
 *   (a transport that ignores cancel must not overlap two waits).
 * - Re-observing during that drain waits for the settlement — success or
 *   failure consumed — then acquires again only if the caller is still
 *   alive; never a second pending wait for one key. Book disposal settles
 *   drain-waiters promptly even when the wire stays stuck.
 * - A settled wire call renews only while an observer holds: a release
 *   landing mid-call ends the task instead of renewing for nobody.
 * - Distinct identities bound at `REMOTE_FILES_LIMITS.waitConcurrent`
 *   (draining entries count); no queue.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/authorization
 */
import { REMOTE_FILES_LIMITS, RemoteFilesError, type RemoteFilesAuthorizationRequest } from '../../remote/files-contract.ts'
import { providerKey, type FilesProviderIdentity, type WorkspaceRootRef } from '../files-tree/provider.ts'
import type { RemoteFilesClient } from '../remote-files-client.ts'

/** A remote provider identity narrowed to its remote root. */
export type SshFilesIdentity = FilesProviderIdentity & {
  readonly root: Extract<WorkspaceRootRef, { readonly kind: 'remote' }>
}

/** The lease request for one remote grant — the same tuple the tree's owner lease sends. */
export function authorizationRequest(identity: SshFilesIdentity): RemoteFilesAuthorizationRequest {
  return {
    sessionId: identity.sessionId,
    environmentId: identity.root.environmentId,
    rootId: identity.root.rootId,
    authorization: identity.incarnation,
  }
}

interface Observer {
  readonly settle: (failure: RemoteFilesError | undefined) => void
}

interface Lease {
  readonly control: AbortController
  count: number
  readonly observers: Set<Observer>
  /**
   * Consecutive `client.wait` calls until the controller aborts or a call
   * fails. Settles with the failure (or `undefined` on a plain end) — the
   * promise itself never rejects, so drain-waiters can consume either side.
   */
  readonly task: Promise<RemoteFilesError | undefined>
}

export class RemoteFilesAuthorizationBook {
  private disposed = false
  private readonly shutdown = new AbortController()
  private readonly leases = new Map<string, Lease>()

  constructor(private readonly client: Pick<RemoteFilesClient, 'wait'>) {}

  /**
   * Hold the shared lease for one remote grant.
   * @param identity - the provider identity (session + remote root + incarnation).
   * @param signal - THIS observer's release.
   * @returns resolves on the observer's release/book dispose; rejects when
   *   the shared lease ends in failure while the observer still holds.
   */
  observe(identity: SshFilesIdentity, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) return Promise.resolve()
    const key = providerKey(identity)
    const request = authorizationRequest(identity)
    return this.acquire(key, request, signal)
  }

  private async acquire(key: string, request: RemoteFilesAuthorizationRequest, signal: AbortSignal): Promise<void> {
    let lease = this.leases.get(key)
    if (lease !== undefined && lease.control.signal.aborted) {
      const drained = AbortSignal.any([signal, this.shutdown.signal])
      while (lease !== undefined && lease.control.signal.aborted) {
        const draining = lease
        // Draining: the previous wire call may ignore cancellation. Wait —
        // cancellably — for its settlement (the task never rejects), then
        // re-check; book disposal ends this wait promptly too.
        await new Promise<void>(resolve => {
          const onAbort = (): void => resolve()
          const onDrain = (): void => {
            drained.removeEventListener('abort', onAbort)
            resolve()
          }
          draining.task.then(onDrain)
          drained.addEventListener('abort', onAbort, { once: true })
          if (drained.aborted) onAbort()
        })
        if (drained.aborted) return
        lease = this.leases.get(key)
      }
      if (drained.aborted) return
    }
    if (lease === undefined) {
      if (this.leases.size >= REMOTE_FILES_LIMITS.waitConcurrent) throw new RemoteFilesError('resource-budget')
      lease = this.start(key, request)
      this.leases.set(key, lease)
    }
    return await this.join(lease, signal)
  }

  private start(key: string, request: RemoteFilesAuthorizationRequest): Lease {
    const control = new AbortController()
    const observers = new Set<Observer>()
    const created: Lease = {
      control,
      count: 0,
      observers,
      task: (async (): Promise<RemoteFilesError | undefined> => {
        try {
          while (!control.signal.aborted) {
            await this.client.wait(request, control.signal)
            // A release while the wire call was open leaves no observer to
            // serve — end instead of renewing for an empty lease.
            if (observers.size === 0) control.abort()
          }
          return undefined
        } catch (error: unknown) {
          if (control.signal.aborted) return undefined
          return error instanceof RemoteFilesError ? error : new RemoteFilesError('provider-unavailable')
        }
      })(),
    }
    void created.task.then(failure => {
      // The entry stays until the task actually unwound — a transport that
      // ignores cancellation must not overlap a second wait.
      if (this.leases.get(key) === created) this.leases.delete(key)
      for (const observer of [...created.observers]) observer.settle(failure)
      created.observers.clear()
    })
    return created
  }

  private async join(lease: Lease, signal: AbortSignal): Promise<void> {
    lease.count++
    return await new Promise<void>((resolve, reject) => {
      let settled = false
      const release = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', release)
        lease.observers.delete(observer)
        resolve()
        this.afterRelease(lease)
      }
      const observer: Observer = {
        settle: failure => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', release)
          lease.observers.delete(observer)
          if (failure === undefined) resolve()
          else reject(failure)
        },
      }
      lease.observers.add(observer)
      signal.addEventListener('abort', release, { once: true })
      if (signal.aborted) release()
    })
  }

  private afterRelease(lease: Lease): void {
    lease.count--
    if (lease.count !== 0) return
    // Let an immediate remount rejoin before the controller dies; if the
    // count is still zero afterwards, abort — but keep the map entry until
    // the task unwinds (the drain branch handles re-observation).
    queueMicrotask(() => {
      if (lease.count === 0) lease.control.abort()
    })
  }

  /** End every lease and release every held observer promptly. */
  dispose(): void {
    this.disposed = true
    this.shutdown.abort()
    for (const lease of this.leases.values()) {
      lease.control.abort()
      for (const observer of [...lease.observers]) observer.settle(undefined)
      lease.observers.clear()
    }
  }
}
