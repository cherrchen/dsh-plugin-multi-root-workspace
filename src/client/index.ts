/**
 * Browser half of the multi-root workspace plugin.
 *
 * One contribution: a sidebar footer action that opens the Workspace Folders
 * dialog. Everything it needs arrives through services the composition already
 * provides — `slots` to contribute, `locale` for its copy, `connection` for the
 * channel to the host half, and (optionally) `uiWorkspace` for the composed
 * directory picker and the client Session Controller for the current session.
 *
 * `slots.inject` is the soft seam: the footer action is registered when a
 * sidebar declares that slot and never otherwise, so a runtime whose sidebar
 * surface differs simply shows no panel instead of failing the client graph.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the SlotMap merge this plugin registers against, plus the CLIENT
// faces that publish `ctx.slots` / `ctx.locale` on the browser context.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createElement } from 'react'
import { currentSessionIdOf } from '../compat/client-session.ts'
import { createPanelClient, type PanelClient } from './panel-client.ts'
import { NS, en, zh } from './locales.ts'
import { STYLES } from './styles.ts'
import { WorkspaceFoldersAction, type Translate } from './WorkspaceFoldersAction.tsx'

/** The footer-action cell this plugin owns. */
export const SLOT_ID = 'multi-root-folders'

/** The id of the `<style>` element carrying this plugin's sheet. */
const STYLE_ELEMENT_ID = 'multi-root-workspace-styles'

/** Services the client half needs before it may activate. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the panel.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'multi-root-workspace: dictionaries')

  // The panel's classes resolve against this sheet; removing it on unload keeps
  // a hot-unplugged plugin from leaving dead rules behind.
  ctx.effect(() => {
    let element = document.getElementById(STYLE_ELEMENT_ID)
    if (element === null) {
      element = document.createElement('style')
      element.id = STYLE_ELEMENT_ID
      element.textContent = STYLES
      document.head.append(element)
    }
    return () => { element?.remove() }
  }, 'multi-root-workspace: styles')

  // Cordis binds `this.ctx` to the *caller's* fiber for the registry methods, so
  // reading the injected services here keeps them owned by this plugin.
  const panel: PanelClient | undefined = (() => {
    const connection = ctx.get('connection')
    return connection === undefined ? undefined : createPanelClient(connection)
  })()
  const pickDirectory = async (): Promise<string | null> => {
    const workspace = readService<{ pickDirectory?: () => Promise<string | null> }>(ctx, 'uiWorkspace')
    if (workspace?.pickDirectory === undefined) return null
    return await workspace.pickDirectory()
  }
  // The selection field moved between supported releases; the probe lives in
  // compat so this entry never compares version strings.
  const sessionId = (): string | undefined => currentSessionIdOf(readService(ctx, 'sessions'))
  const t = ctx.locale.bind(NS) as unknown as Translate

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: SLOT_ID,
    // After the shipped foot controls; the sidebar sorts a list slot by `order`.
    order: 50,
    // A thunk: the sidebar re-reads it per projection, so the label follows the
    // active locale without re-registering.
    label: () => t('action.label'),
    locale: NS,
    // The composed props include the owner share (`{ wide }`): forwarding it
    // lets the trigger render its rail form when the sidebar collapses.
  }, owner => {
    const wide = (owner as { readonly wide?: boolean } | undefined)?.wide
    return createElement(WorkspaceFoldersAction, {
      panel,
      pickDirectory,
      sessionId,
      t,
      ...(wide === undefined ? {} : { wide }),
    })
  }))
}

/**
 * Read one optional service by name.
 *
 * Both lookups are deliberately untyped reads: the client Session Controller
 * and the workspace UI service are composed by the surface, not by this
 * plugin, and neither is a dependency it may assume (the footer action exists
 * on surfaces where they do not). Absence is a supported state — the panel then
 * shows "No active session" and does not ask the host to guess a workspace root.
 * @param ctx - the client context.
 * @param name - the service key to read.
 * @returns the service, or `undefined` when this composition has none.
 */
function readService<T>(ctx: ClientContext, name: string): T | undefined {
  const reader = ctx as unknown as { get(key: string): unknown }
  return reader.get(name) as T | undefined
}

export type { PanelClient, Translate }
