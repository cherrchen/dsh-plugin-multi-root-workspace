/**
 * The panel's own client for the Connection RPC channel.
 *
 * The browser half cannot use a Typert Remote namespace: contract generation
 * is workspace-shaped and the client assembly's contribution list belongs to
 * the shipped composition, so an out-of-tree plugin has no supported way to
 * mount one (see docs/decisions/ADR-0005 and the M3 plan). What IS public and
 * present in both supported runtimes is the generic Connection channel the
 * shipped sibling plugin already uses: the host registers
 * `connection.rpc.handle(PANEL_CHANNEL, …)` and this module calls it.
 *
 * The call is typed by {@link PanelResponseMap}: the endpoint decides the
 * request shape AND the response type, so a caller cannot decode one endpoint's
 * answer as another's. The response is additionally parsed at the boundary,
 * because the type is a promise about the host while the value on the wire is
 * whatever the host actually sent.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/panel-client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  PANEL_CHANNEL,
  parseErrorView,
  parseRevealedView,
  parseRootsView,
  type PanelEndpoint,
  type PanelRequest,
  type PanelResponseMap,
} from '../contract.ts'
import { zh, type Key } from './locales.ts'

/**
 * The Connection result shape this plugin consumes. Declared structurally
 * rather than imported: the host face of the same package would drag the
 * HOST context augmentations into the browser program, and a channel handler
 * is an ordinary `{ ok, value } | { ok, error }` envelope on the wire.
 */
type ChannelResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

/** A failure the panel renders from its `code`. */
export class PanelError extends Error {
  /**
   * @param code - stable code from the root vocabulary, or a transport code.
   * @param message - the host's fallback text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PanelError'
  }
}

/**
 * The copy key for one failure code, with a safe fallback for codes this build
 * does not know (a newer host, or a transport failure).
 * @param code - the failure code.
 * @returns the locale key to render.
 */
export function errorKeyOf(code: string): Key {
  const candidate = `error.${code}`
  return (candidate in zh ? candidate : 'error.fallback') as Key
}

/** The panel's callable face, injected into its component. */
export interface PanelClient {
  /**
   * Call one endpoint.
   * @param endpoint - the endpoint name; it also selects the response type.
   * @param payload - the request fields for that endpoint (the endpoint name
   *   travels as the RPC method, so it is not repeated in the payload).
   * @returns the host's value, in the shape the endpoint promises.
   * @throws {PanelError} when the host answered with a failure, or with a value
   *   that is not what this endpoint promises.
   */
  call<E extends PanelEndpoint>(endpoint: E, payload: PanelRequest): Promise<PanelResponseMap[E]>
}

/**
 * Build the panel client over a Connection handle.
 * @param connection - the client Connection service.
 * @returns the client, with every transport failure normalized to a `PanelError`.
 */
export function createPanelClient(connection: ConnectionHandle): PanelClient {
  return {
    async call(endpoint, payload) {
      let result: ChannelResult
      try {
        result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload) as ChannelResult
      } catch (error: unknown) {
        throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
      }
      if (!result.ok) {
        // The host reports failures as `{ code, message }`; a transport that
        // failed differently still has to reach the panel as a renderable code.
        const failure = parseErrorView(result.error)
        throw failure === undefined
          ? new PanelError('unavailable', 'the host answered with an unreadable failure')
          : new PanelError(failure.code, failure.message)
      }
      return expectShape(endpoint, result.value)
    },
  }
}

/**
 * Read the value one endpoint promised, narrowing it at the boundary so a host
 * that answered a different endpoint — or a shape from another version — cannot
 * crash the render.
 * @param endpoint - the endpoint that was called.
 * @param value - the raw endpoint value.
 * @returns the value as the endpoint's declared type.
 * @throws {PanelError} `panel/bad-response` when the value is not that shape.
 */
function expectShape<E extends PanelEndpoint>(endpoint: E, value: unknown): PanelResponseMap[E] {
  const parsed = endpoint === 'reveal' ? parseRevealedView(value) : parseRootsView(value)
  if (!parsed.ok) throw new PanelError('panel/bad-response', parsed.message)
  return parsed.value as PanelResponseMap[E]
}

/** The current session id, when the composed client can name one. */
export function currentSessionIdOf(sessions: unknown): string | undefined {
  const candidate = sessions as { list?: { getSnapshot?: () => { current?: unknown } } } | undefined
  const current = candidate?.list?.getSnapshot?.().current
  return typeof current === 'string' && current !== '' ? current : undefined
}
