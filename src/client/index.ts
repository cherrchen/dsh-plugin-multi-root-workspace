/**
 * Browser half of the multi-root workspace plugin.
 *
 * Sidebar footer and optional Files actions open the Workspace Folders dialog.
 * Everything it needs arrives through services the composition already
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
// Merges `sessionId` onto session-scope composed props and `SessionId` onto
// the inject factory's first parameter — the same merge upstream's Files
// registration compiles against.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createElement, useCallback, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { currentSessionIdOf, subscribeSessions, subscribeCurrentSession } from '../compat/client-session.ts'
import { nativeTreeRenderer } from '../compat/files-tree.ts'
import { createPanelClient, type PanelClient } from './panel-client.ts'
import { createWorktreeClient } from './worktree-client.ts'
import { WorktreePrompt } from './WorktreePrompt.tsx'
import { NS, en, zh } from './locales.ts'
import { STYLES } from './styles.ts'
import { HeroWorkspaceEntry } from './HeroWorkspaceEntry.tsx'
import { installSkillsClient } from './skills.tsx'
import { installSkillsSettingsCard } from './skills-settings.tsx'
import { createWorkspaceFoldersDialogController } from './workspace-folders-dialog.ts'
import { installWorkspaceMenu, type UiWorkspaceClient, type WorkspacesClient } from './workspace-menu.ts'
import { RootSwitcher } from './RootSwitcher.tsx'
import { WorkspaceFoldersAction, type Translate } from './WorkspaceFoldersAction.tsx'
import { OPEN_IN_APP_NS, createOpenInAppAdapter } from './open-in-app/adapter.tsx'
import { OpenInAppToast } from './open-in-app/open-toast.tsx'
import { FILES_TREE_NS, createFilesTreeSeats, createFilesTreeSurface } from './files-tree/adapter.tsx'
import { NavigatorRetarget } from './files-tree/navigator.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.tab.files.actions': {
      kind: 'list'
      scope: 'session'
      owner: { readonly absolutePath: string }
    }
    // The document preview's header seat, declared in
    // `ui-sidebar-documentpreview`'s contract since `0.2.2-alpha.3`: one
    // list occupant per session, owner `{ absolutePath }` — the previewed
    // file's host path, the navigator retarget's only input.
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: { readonly absolutePath: string }
    }
  }
}

/** The footer-action cell this plugin owns. */
export const SLOT_ID = 'multi-root-folders'

/**
 * The New Session hero-row cell this plugin owns. It exists as soon as the
 * runtime offers `conversation.hero.options` (`0.2.1-alpha.3+`); older
 * runtimes never declare that slot, so the registration silently stays out
 * and the sidebar footer action remains the only entry.
 */
export const HERO_SLOT_ID = 'multi-root-folders.hero'

/** After the forge worktree entry, whose default order is 0. */
export const HERO_ORDER = 10

/** The document-preview navigator retarget's occupant id. */
const NAVIGATOR_SLOT_ID = 'multi-root-navigator'

/** The id of the `<style>` element carrying this plugin's sheet. */
const STYLE_ELEMENT_ID = 'multi-root-workspace-styles'

/**
 * Phase P3 gate: the prompt renders as a read-only preview until the Registry
 * write path (P4) is in place. The host refuses the confirmation either way;
 * this constant only keeps the UI from offering a button that cannot work.
 */
const WORKTREE_PREVIEW_ONLY = false

/** Services the client half needs before it may activate. */
export const inject = ['slots', 'locale', 'connection']

/**
 * The slice of the slot service this entry uses.
 *
 * `conversation.hero.options` is declared by `ui-conversation` from
 * `0.2.1-alpha.3`; the typecheck matrix also runs against older releases whose
 * SlotMap predates the key, so the registration goes through this narrow
 * structural face instead of the merged SlotMap. `spec` is the public
 * declaration probe on the SlotRegistry service (`specDynamic` exists only on
 * the internal SlotCore, not on `ctx.slots`); absence means the running DSH
 * has no such seat.
 */
interface HeroOptionsSlotService {
  /** Public declaration lookup on every supported SlotRegistry service. */
  spec?(key: string): unknown
  inject(key: string, callback: () => () => void): () => void
  register(
    options: { readonly name: string; readonly id: string; readonly order: number; readonly locale: string },
    component: (props: { readonly sessionId: string }) => ReactNode,
  ): () => void
}

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
  const connectionHandle = ctx.get('connection')
  const panel: PanelClient | undefined = connectionHandle === undefined ? undefined : createPanelClient(connectionHandle)
  const worktreeClient = connectionHandle === undefined ? undefined : createWorktreeClient(connectionHandle)
  // The footer's dialog owner and the workspace menu share exactly one
  // controller for this apply() lifetime: the menu asks the footer to open
  // its dialog, and the menu entry is disabled while no footer owner exists
  // (ADR-0036). RootSwitcher deliberately keeps its own local dialog.
  const dialogController = createWorkspaceFoldersDialogController()
  const pickDirectory = async (): Promise<string | null> => {
    // Read per call, as before: the picker belongs to the surface and may be
    // composed or replaced independently of this apply lifetime.
    const workspace = readService<UiWorkspaceClient>(ctx, 'uiWorkspace')
    if (workspace?.pickDirectory === undefined) return null
    return await workspace.pickDirectory()
  }
  // The selection field moved between supported releases; the probe lives in
  // compat so this entry never compares version strings.
  const sessionId = (): string | undefined => currentSessionIdOf(readService(ctx, 'sessions'))
  const subscribeSession = (listener: () => void): (() => void) => subscribeSessions(readService(ctx, 'sessions'), listener)
  const t = ctx.locale.bind(NS) as unknown as Translate
  installSkillsClient(ctx, t, listener => subscribeCurrentSession(readService(ctx, 'sessions'), listener))
  const worktreeSettings = installSkillsSettingsCard(ctx, t)
  // The worktree confirmation is a shell-level overlay: it must be able to
  // appear over any page, and it long-polls only while a live session exists.
  // The settings signal is what remounts a loop that stopped when the switch
  // was turned off.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'multi-root-worktree-prompt',
    locale: NS,
    inject: () => ({
      client: worktreeClient,
      sessionId,
      subscribeSession,
      readEnabled: worktreeSettings.enabled,
      subscribeEnabled: worktreeSettings.subscribe,
      t,
      previewOnly: WORKTREE_PREVIEW_ONLY,
    }),
  }, WorktreePrompt))
  // The fork binds upstream's own open-in-app namespace — the same strings
  // the native button shows, upstream's dictionary updates included. The
  // adapter is undefined where the fork cannot render (pixel-era glyph
  // names), which is also upstream's own "no button" state.
  const openInApp = createOpenInAppAdapter({
    t: ctx.locale.bind(OPEN_IN_APP_NS) as unknown as (key: string, params?: Record<string, unknown>) => string,
    shortcuts: readService<{ catalog?: ObservableSnapshot<readonly ShortcutCatalogEntry[]> }>(ctx, 'shortcuts')?.catalog,
  })
  // The toast entry mirrors upstream's own `shell.overlay` registration so a
  // native-open failure (and a mobile handoff) announces from the shell even
  // after this panel unmounts; absent adapter means the fork cannot render.
  if (openInApp !== undefined) {
    const { toast } = openInApp
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'multi-root-open-in-app.toast', locale: OPEN_IN_APP_NS,
      inject: () => ({ hooks: toast.hooks, dismiss: toast.dismiss }),
    }, OpenInAppToast))
  }
  // The files-tree fork's seats: an exclusive store and the verbatim face
  // over a lazily resolved `remote` — the same declaration upstream's own
  // Files registration makes, plus the session-bound open route. The fork
  // binds upstream's `sidebarFiles` namespace so its rows say exactly what
  // the native tree says.
  const filesTreeSeats = createFilesTreeSeats(ctx)
  const filesTreeT = ctx.locale.bind(FILES_TREE_NS)

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
      subscribeSession,
      t,
      worktrees: worktreeClient,
      dialogController,
      dialogOwner: true,
      ...(wide === undefined ? {} : { wide }),
    })
  }))
  // Optional and purely additive: the New Session hero row's options slot
  // exists from 0.2.1-alpha.3; old runtimes never declare it, so the entry is
  // simply not rendered there and the sidebar footer action above stays the
  // only entry. `inject` itself waits for a declaration, and the explicit
  // `spec` probe makes the version gate legible even for an inject
  // implementation that fires before/without a declaration.
  // The trigger is a dialog button, not a menu: no chevron, and the same
  // WorkspaceFoldersDialog — no second manager, no second RPC surface. The
  // session identity comes from the slot's composed props (this slot is
  // session-scope); it is memoized so the dialog's refresh identity — and the
  // list call it keys — stays stable across upstream store writes.
  const heroSlots = ctx.slots as unknown as HeroOptionsSlotService
  heroSlots.inject('conversation.hero.options', () => {
    if (heroSlots.spec?.('conversation.hero.options') === undefined) return () => {}
    return heroSlots.register({
      name: 'conversation.hero.options',
      id: HERO_SLOT_ID,
      order: HERO_ORDER,
      locale: NS,
    }, function HeroOptionsOccupant(props: { readonly sessionId: string }) {
      const composedSessionId = props.sessionId
      const readSession = useCallback(() => composedSessionId, [composedSessionId])
      return createElement(HeroWorkspaceEntry, {
        panel,
        pickDirectory,
        sessionId: readSession,
        t,
        worktrees: worktreeClient,
      })
    })
  })
  // Optional: old surfaces without the Files actions slot retain the footer entry.
  ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.files.actions', id: SLOT_ID, order: 50,
    // The fork's store + face, declared exactly as upstream declares them on
    // its own registration: the framework mints the store per session, runs
    // the inject factory with (sessionId, bound actions), and spreads the
    // face's members onto the composed props.
    store: filesTreeSeats.store,
    inject: filesTreeSeats.inject,
  }, function FilesActionsOccupant(props) {
    // The slot contract promises owner.absolutePath — the pane's primary root.
    // A runtime that stops carrying it falls back to the icon-only launcher
    // rather than to a nameless switcher.
    const absolutePath = (props as { readonly absolutePath?: string } | undefined)?.absolutePath
    // The slot is session-scoped: `props.sessionId` is THIS pane's session —
    // the same identity the framework minted `filesTree` with. Panel calls
    // must target it, not the global current-session resolver: a Files pane
    // that outlives a session switch would otherwise list — and fail to
    // route — another session's roots over its own tree and primary root.
    // The global resolver remains the fallback for a composition that
    // composes the occupant without session shares.
    // The composed session share is a stable string; resolving it inside a
    // callback memoized on that string keeps `refresh`'s identity — and with
    // it the list-call effect — stable across every render this occupant
    // sees, instead of re-issuing `list` on each upstream store write.
    const composedSessionId = (props as { readonly sessionId?: string } | undefined)?.sessionId
    const paneSessionId = useCallback(
      (): string | undefined => composedSessionId ?? sessionId(),
      [composedSessionId],
    )
    // The wrapper is rebuilt per render but every member it carries is a
    // framework-stable prop or an apply-level constant, so the switcher's
    // takeover effect — which keys on the selection, not the wrapper —
    // never restarts because of it. `undefined` means the fork cannot mount.
    const filesTree = createFilesTreeSurface(props, filesTreeT)
    return absolutePath === undefined
      ? createElement(WorkspaceFoldersAction, { panel, pickDirectory, sessionId: paneSessionId, subscribeSession, t, worktrees: worktreeClient, compact: true })
      : createElement(RootSwitcher, { primaryPath: absolutePath, panel, pickDirectory, sessionId: paneSessionId, subscribeSession, t, worktrees: worktreeClient, openInApp: openInApp?.adapter, filesTree, nativeTree: nativeTreeRenderer((props as { renderFactorySlot?: unknown }).renderFactorySlot) })
  }))
  // Optional: the document preview's navigator seat exists only on runtimes
  // whose `ui-sidebar-files` draws the Folder-toggle tree (0.2.2-alpha.3+);
  // `slots.inject` swallows the registration where the surface never
  // declares the slot — exactly the runtimes where the problem cannot
  // exist. The occupant is invisible: it watches the preview's content row
  // for the native navigator's aside and, while the previewed file sits
  // under an available additional root, lends the aside's body to the same
  // forked tree the Files page uses — with the native navigator's reveal
  // (ancestors expanded, the file's row marked current and scrolled into
  // view) and its replace-tab open route reproduced.
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: NAVIGATOR_SLOT_ID, order: 50,
    store: filesTreeSeats.store,
    inject: filesTreeSeats.inject,
  }, function DocumentActionsOccupant(props) {
    const absolutePath = (props as { readonly absolutePath?: string } | undefined)?.absolutePath
    const filesTree = createFilesTreeSurface(props, filesTreeT)
    // No host path or no fork → no marker at all: the native navigator
    // keeps its tree untouched either way.
    if (absolutePath === undefined || filesTree === undefined) return null
    return createElement(NavigatorRetarget, {
      absolutePath,
      sessionId: (props as { readonly sessionId?: string } | undefined)?.sessionId,
      panel,
      filesTree,
      nativeTree: nativeTreeRenderer((props as { renderFactorySlot?: unknown }).renderFactorySlot),
    })
  }))
  // The workspace row's `...` / context menu gains "Manage workspace folders…".
  // Registration is soft on `contextMenus`; the entry itself is enabled only
  // while every dependency (host channel, a live workspace record, upstream
  // navigation, and the footer-owned dialog) is present.
  // Optional services are read per resolve/run, not captured here: the
  // workspace controller and ui-workspace may activate after this entry (the
  // panel's own picker/session reads follow the same rule).
  installWorkspaceMenu(ctx, {
    panel,
    workspaces: () => readService<WorkspacesClient>(ctx, 'workspaces'),
    uiWorkspace: () => readService<UiWorkspaceClient>(ctx, 'uiWorkspace'),
    sessions: () => readService(ctx, 'sessions'),
    dialog: dialogController,
    t,
  })
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
