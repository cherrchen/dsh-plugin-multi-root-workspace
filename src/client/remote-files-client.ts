/**
 * The panel's `remoteFiles` client: `remoteFiles.list` and the authorization
 * lease `remotes.waitForAuthorizationChange` over the same authenticated
 * Connection RPC channel the roots and remotes clients already use
 * (ADR-0052 P4). The browser never names a raw remote path — requests carry
 * the opaque `browseAuthorization` a `remotes` view minted.
 *
 * Every failure reaches the caller as a {@link RemoteFilesError} whose code
 * is a member of the fixed vocabulary; the host's message text is never
 * forwarded. A carrier failure (no host, a dropped connection, an unreadable
 * answer) collapses to `provider-unavailable`, and an aborted caller signal
 * reports `cancelled` — matching what the host itself would answer.
 *
 * The Host deliberately refuses a fifth concurrent listing instead of
 * queueing it. A tree refresh can fan out wider than that inside this one
 * browser client, so `list` calls are scheduled here at the same cap; the
 * local wait is cancellation-aware (a hidden/switched/closed tree never
 * reaches the wire) and never applies to authorization leases.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/remote-files-client
 */
import { PANEL_CHANNEL } from '../contract.ts'
import {
  REMOTE_FILES_AUTHORIZATION_WAIT,
  REMOTE_FILES_FAILURES,
  REMOTE_FILES_LIMITS,
  REMOTE_FILES_LIST,
  RemoteFilesError,
  remoteFilesAuthorizationAnswer,
  remoteFilesListing,
  type RemoteFilesAuthorizationRequest,
  type RemoteFilesFailureCode,
  type RemoteFilesListRequest,
  type RemoteFilesListing,
} from '../remote/files-contract.ts'

interface Channel {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}

/** The two remote-files endpoints, as callable methods. */
export interface RemoteFilesClient {
  /**
   * List one registered remote root's directory through the Host's bounded
   * listing service.
   * @param request - the schema-validated listing request.
   * @param signal - the listing's lifetime.
   * @returns the validated listing; failures reject as `RemoteFilesError`.
   */
  list(request: RemoteFilesListRequest, signal: AbortSignal): Promise<RemoteFilesListing>
  /**
   * One authorization lease: resolves when the window expires unchanged —
   * the caller then starts the next lease — and rejects with the fixed
   * vocabulary when the grant's identity stops matching, the caller aborts,
   * or the host fails.
   */
  wait(request: RemoteFilesAuthorizationRequest, signal: AbortSignal): Promise<void>
}

/** The failure a carrier-level breakdown reports — never the host's text. */
const unavailable = (): RemoteFilesError => new RemoteFilesError('provider-unavailable')

/**
 * Fold an answer or exception into the fixed vocabulary. A known code keeps
 * its own entry (and its fixed message); anything else — a transport drop, a
 * code this client predates, an unreadable envelope — is
 * `provider-unavailable`, and a dead caller signal is `cancelled`.
 */
const failureOf = (error: unknown, signal: AbortSignal): RemoteFilesError => {
  if (signal.aborted) return new RemoteFilesError('cancelled')
  if (error instanceof RemoteFilesError) return error
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code in REMOTE_FILES_FAILURES
    ? new RemoteFilesError(code as RemoteFilesFailureCode)
    : unavailable()
}

/**
 * The browser-side listing scheduler. It exists because the Host's cap is a
 * refusal, not a queue: overflow would surface as a spurious per-directory
 * `resource-budget` during one ordinary tree refresh. Waiting callers hold no
 * Host resources, and aborting one removes it before any wire call is made.
 */
function createListGate(): {
  readonly acquire: (signal: AbortSignal) => Promise<void>
  readonly release: () => void
} {
  let active = 0
  const waiting: { readonly start: () => void; readonly cancel: () => void }[] = []
  const pump = (): void => {
    while (active < REMOTE_FILES_LIMITS.concurrent && waiting.length !== 0) {
      waiting.shift()!.start()
    }
  }
  return {
    acquire: async signal => {
      if (signal.aborted) throw new RemoteFilesError('cancelled')
      if (active < REMOTE_FILES_LIMITS.concurrent) {
        active++
        return
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const waiter = {
          start: (): void => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', waiter.cancel)
            active++
            resolve()
          },
          cancel: (): void => {
            if (settled) return
            settled = true
            const at = waiting.indexOf(waiter)
            if (at >= 0) waiting.splice(at, 1)
            signal.removeEventListener('abort', waiter.cancel)
            reject(new RemoteFilesError('cancelled'))
          },
        }
        waiting.push(waiter)
        signal.addEventListener('abort', waiter.cancel, { once: true })
        if (signal.aborted) waiter.cancel()
      })
    },
    release: () => {
      active--
      pump()
    },
  }
}

/**
 * Build the remote-files client.
 * @param connection - the client Connection service.
 * @returns the client, with every failure normalized to the fixed vocabulary.
 */
export function createRemoteFilesClient(connection: Channel): RemoteFilesClient {
  const listGate = createListGate()
  const call = async (endpoint: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted()
    let result: { ok: boolean; value?: unknown; error?: { code?: unknown } }
    try {
      result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as typeof result
    } catch (error: unknown) {
      throw failureOf(error, signal)
    }
    if (signal.aborted) throw new RemoteFilesError('cancelled')
    if (!result.ok) throw failureOf(result.error ?? unavailable(), signal)
    return result.value
  }
  return {
    list: async (request, signal) => {
      await listGate.acquire(signal)
      try {
        const value = await call(REMOTE_FILES_LIST, { ...request }, signal)
        const parsed = remoteFilesListing.safeParse(value)
        if (!parsed.success) throw new RemoteFilesError('invalid-listing')
        return parsed.data
      } finally {
        listGate.release()
      }
    },
    wait: async (request, signal) => {
      const value = await call(REMOTE_FILES_AUTHORIZATION_WAIT, { ...request }, signal)
      if (!remoteFilesAuthorizationAnswer.safeParse(value).success) throw unavailable()
    },
  }
}
