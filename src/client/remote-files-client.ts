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
  REMOTE_FILES_READ,
  RemoteFilesError,
  remoteFilesAuthorizationAnswer,
  remoteFilesListing,
  remoteFilesReadContent,
  remoteFilesReadRequest,
  type RemoteFilesAuthorizationRequest,
  type RemoteFilesFailureCode,
  type RemoteFilesListRequest,
  type RemoteFilesListing,
  type RemoteFilesReadContent,
  type RemoteFilesReadRequest,
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

/**
 * The preview content read (ADR-0053 P4): `remoteFiles.read` returns the
 * decoded content envelope — metadata plus the one `bytes` attachment the
 * Connection rehydrated. Fixtures that only exercise browsing may omit it.
 */
export interface RemoteFileContentClient {
  /**
   * Read one regular remote file through the Host's preview pipeline.
   * @param request - the schema-validated read request.
   * @param signal - the read's lifetime.
   * @returns the validated content; failures reject as `RemoteFilesError`.
   */
  read(request: RemoteFilesReadRequest, signal: AbortSignal): Promise<RemoteFilesReadContent>
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
  return typeof code === 'string' && Object.hasOwn(REMOTE_FILES_FAILURES, code)
    ? new RemoteFilesError(code as RemoteFilesFailureCode)
    : unavailable()
}

/** Cancellation-aware sleep used only while a locally admitted retry still holds its scheduler slot. */
function retryAfter(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    const cancel = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
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
      signal.throwIfAborted()
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
            reject(signal.reason)
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
export function createRemoteFilesClient(connection: Channel): RemoteFilesClient & RemoteFileContentClient {
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
    // A malformed carrier answer — a missing `ok`, a non-object envelope —
    // is a carrier failure, never a forwarded code.
    if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') throw unavailable()
    if (!result.ok) throw failureOf(result.error ?? unavailable(), signal)
    return result.value
  }
  return {
    list: async (request, signal) => {
      // `resource-budget` is explicitly retryable. It can also be transiently
      // caused by THIS client: a cancelled wire call answers before the Host
      // has finished unwinding the slot it already admitted. Re-admitting a
      // queued listing once is therefore not enough — while the retry budget
      // lasts, a budget refusal waits (still cancellable, still holding its
      // local slot) and tries again instead of turning one ordinary refresh
      // into a missing directory.
      const retryBudget = new AbortController()
      const retrySignal = AbortSignal.any([signal, retryBudget.signal])
      let retryUntil: number | undefined
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let backoff = 25
      try {
        for (;;) {
          await listGate.acquire(retrySignal)
          const now = performance.now()
          retryUntil ??= now + REMOTE_FILES_LIMITS.deadlineMs
          try {
            // A slot can be granted just before the deadline timer runs.
            retrySignal.throwIfAborted()
            if (now >= retryUntil) throw new RemoteFilesError('resource-budget')
            const value = await call(REMOTE_FILES_LIST, { ...request }, signal)
            const parsed = remoteFilesListing.safeParse(value)
            if (!parsed.success) throw new RemoteFilesError('invalid-listing')
            return parsed.data
          } catch (error: unknown) {
            if (!(error instanceof RemoteFilesError) || error.code !== 'resource-budget' || signal.aborted) throw error
            const remaining = retryUntil - performance.now()
            if (remaining <= 0) throw error
            retryTimer ??= setTimeout(() => retryBudget.abort(error), remaining)
            await retryAfter(Math.min(backoff, remaining), retrySignal)
            backoff = Math.min(backoff * 2, 200)
          } finally {
            listGate.release()
          }
        }
      } catch (error: unknown) {
        if (signal.aborted) throw new RemoteFilesError('cancelled')
        throw error
      } finally {
        clearTimeout(retryTimer)
      }
    },
    wait: async (request, signal) => {
      const value = await call(REMOTE_FILES_AUTHORIZATION_WAIT, { ...request }, signal)
      if (!remoteFilesAuthorizationAnswer.safeParse(value).success) throw unavailable()
    },
    read: async (request, signal) => {
      if (signal.aborted) throw new RemoteFilesError('cancelled')
      const parsedRequest = remoteFilesReadRequest.safeParse(request)
      if (!parsedRequest.success) throw new RemoteFilesError('invalid-request')
      const value = await call(REMOTE_FILES_READ, { ...parsedRequest.data }, signal)
      // The Connection rehydrates exactly one `bytes` attachment into the
      // envelope before this parse runs; there is no JSON byte fallback.
      const result = remoteFilesReadContent.safeParse(value)
      if (!result.success) throw new RemoteFilesError('invalid-content')
      return result.data
    },
  }
}
