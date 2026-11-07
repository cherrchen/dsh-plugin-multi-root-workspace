/**
 * The panel's remote-environment client. It speaks the same Connection RPC
 * channel as the roots client, but over the remote contract
 * (`remote/panel-contract.ts`): a host that does not serve these endpoints
 * answers with a failure the section renders instead of a broken roots view.
 *
 * Every call is session-addressed. Listing never connects; only `add` asks the
 * host to verify an endpoint, which is the host's own explicit action.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/remotes-client
 */
import { PANEL_CHANNEL } from '../contract.ts'
import { parseRemotesView, type RemotesView } from '../remote/panel-contract.ts'
import { PanelError } from './panel-client.ts'

interface Channel {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}

/** The three remote endpoints, as callable methods. */
export interface RemotesClient {
  list(sessionId: string, signal?: AbortSignal): Promise<RemotesView>
  add(sessionId: string, environmentId: string, rootId: string, signal?: AbortSignal): Promise<RemotesView>
  remove(sessionId: string, environmentId: string, rootId: string, signal?: AbortSignal): Promise<RemotesView>
}

/**
 * Build the remote section client.
 * @param connection - the client Connection service.
 * @returns the client, with every wire failure normalized to a `PanelError`.
 */
export function createRemotesClient(connection: Channel): RemotesClient {
  const call = async (endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<RemotesView> => {
    let result: { ok: boolean; value?: unknown; error?: unknown }
    try {
      result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as typeof result
    } catch (error: unknown) {
      throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
    }
    if (!result.ok) {
      const failure = result.error as { code?: unknown; message?: unknown } | undefined
      throw new PanelError(
        typeof failure?.code === 'string' ? failure.code : 'unavailable',
        typeof failure?.message === 'string' ? failure.message : 'the host answered with an unreadable failure',
      )
    }
    const parsed = parseRemotesView(result.value)
    if (!parsed.ok) throw new PanelError('panel/bad-response', parsed.message)
    return parsed.value
  }
  return {
    list: async (sessionId, signal) => await call('remotes', { sessionId }, signal),
    add: async (sessionId, environmentId, rootId, signal) => await call('addRemote', { sessionId, environmentId, rootId }, signal),
    remove: async (sessionId, environmentId, rootId, signal) => await call('removeRemote', { sessionId, environmentId, rootId }, signal),
  }
}
