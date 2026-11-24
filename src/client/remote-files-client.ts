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
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/remote-files-client
 */
import { PANEL_CHANNEL } from '../contract.ts'
import {
  REMOTE_FILES_AUTHORIZATION_WAIT,
  REMOTE_FILES_FAILURES,
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
 * Build the remote-files client.
 * @param connection - the client Connection service.
 * @returns the client, with every failure normalized to the fixed vocabulary.
 */
export function createRemoteFilesClient(connection: Channel): RemoteFilesClient {
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
      const value = await call(REMOTE_FILES_LIST, { ...request }, signal)
      const parsed = remoteFilesListing.safeParse(value)
      if (!parsed.success) throw new RemoteFilesError('invalid-listing')
      return parsed.data
    },
    wait: async (request, signal) => {
      const value = await call(REMOTE_FILES_AUTHORIZATION_WAIT, { ...request }, signal)
      if (!remoteFilesAuthorizationAnswer.safeParse(value).success) throw unavailable()
    },
  }
}
