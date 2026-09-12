/**
 * The panel's own client for the Connection RPC channel.
 *
 * The browser half cannot use a Typert Remote namespace: contract generation
 * is workspace-shaped and the client assembly's contribution list belongs to
 * the shipped composition, so an out-of-tree plugin has no supported way to
 * mount one (see docs/decisions/ADR-0004 and the M3 plan). What IS public and
 * present in both supported runtimes is the generic Connection channel the
 * shipped sibling plugin already uses: the host registers
 * `connection.rpc.handle(PANEL_CHANNEL, …)` and this module calls it.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/panel-client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { PANEL_CHANNEL, type PanelEndpoint, type PanelRequest, type RootsView } from '../contract.ts'

/**
 * The Connection result shape this plugin consumes. Declared structurally
 * rather than imported: the host face of the same package would drag the
 * HOST context augmentations into the browser program, and a channel handler
 * is an ordinary `{ ok, value } | { ok, error }` envelope on the wire.
 */
type ChannelResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
import { zh, type Key } from './locales.ts'

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
   * @param endpoint - endpoint name.
   * @param payload - request payload.
   * @returns the host's value.
   * @throws {PanelError} when the host answered with a failure.
   */
  call(endpoint: PanelEndpoint, payload: PanelRequest): Promise<unknown>
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
      if (!result.ok) throw new PanelError(result.error.code, result.error.message)
      return result.value
    },
  }
}

/**
 * Read the roots view the host answers with, narrowing the two fields the panel
 * relies on so a host that answered a different endpoint cannot crash the render.
 * @param value - the raw endpoint value.
 * @returns the view.
 * @throws {PanelError} when the value is not a roots view.
 */
export function asRootsView(value: unknown): RootsView {
  if (value === null || typeof value !== 'object') {
    throw new PanelError('panel/bad-response', 'the host answered a non-object')
  }
  const view = value as Partial<RootsView>
  if (typeof view.primaryRoot !== 'string' || !Array.isArray(view.roots)) {
    throw new PanelError('panel/bad-response', 'the host answer is not a roots view')
  }
  return { primaryRoot: view.primaryRoot, roots: view.roots, ...(view.unavailable === undefined ? {} : { unavailable: view.unavailable }) }
}

/** The current session id, when the composed client can name one. */
export function currentSessionIdOf(sessions: unknown): string | undefined {
  const candidate = sessions as { list?: { getSnapshot?: () => { current?: unknown } } } | undefined
  const current = candidate?.list?.getSnapshot?.().current
  return typeof current === 'string' && current !== '' ? current : undefined
}
