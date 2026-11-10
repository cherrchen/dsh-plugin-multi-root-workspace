/**
 * The "Manage workspace folders…" entry on the upstream workspace row.
 *
 * Upstream publishes every workspace row's `...` and context-menu gesture as
 * the `workspace` context-menu target (`{ workspaceId, path, displayTitle }`).
 * This module adds one action at `order: 150` — between upstream's rename
 * (100), the open-in-app entry (200) and delete (300) — and routes it to the
 * Workspace Folders dialog the sidebar footer owns (see ADR-0038).
 *
 * The dialog's requests are session-derived (ADR-0008), so the entry cannot
 * simply open it: it first decides which session the dialog should manage.
 * When the current session already belongs to the clicked workspace, that is
 * the current session; otherwise the target workspace's blank session is
 * opened or reused through `uiWorkspace.openWorkspace`, and only after the
 * awaited navigation confirms that session became current does the dialog
 * open. A superseded navigation therefore never opens a dialog for a session
 * that is no longer current.
 *
 * Every dependency is optional on a trimmed composition: `contextMenus` /
 * `slots` and the keyed `contextMenu.icon` slot decide whether the entry
 * exists at all, and `panel`, `workspaces`, `uiWorkspace.openWorkspace` and
 * the footer dialog host decide whether it is enabled.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/workspace-menu
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconWorkspaceTree, type PanelIcon } from '../compat/client-icons.ts'
import { currentSessionIdOf, mainViewRetentionOf } from '../compat/client-session.ts'
import type { PanelClient } from './panel-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import type { WorkspaceFoldersDialogController } from './workspace-folders-dialog.ts'

/** The contribution id; also the `contextMenu.icon` key. */
const MENU_ID = 'multi-root-workspace.manage-folders'

/** The action id inside this contribution. */
const ACTION_ID = 'manage'

/** The workspace list face this module reads. Structural on purpose. */
export interface WorkspacesClient {
  readonly list: {
    getSnapshot(): {
      readonly items: readonly {
        readonly workspaceId: string
        readonly sessionIds: readonly string[]
      }[]
    }
  }
}

/**
 * The optional `uiWorkspace` face. Only `openWorkspace` matters here;
 * `pickDirectory` is typed so the same read can serve both call sites.
 */
export interface UiWorkspaceClient {
  readonly pickDirectory?: () => Promise<string | null>
  /**
   * Open or reuse a Workspace's blank Session.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - receives the selected Session before selection.
   * @returns completion; a superseded request resolves without selecting.
   */
  readonly openWorkspace?: (
    workspaceId: string,
    beforeOpen?: (sessionId: string) => void,
  ) => Promise<void>
}

/** Everything the menu contribution needs from the client entry. */
export interface WorkspaceMenuDeps {
  readonly panel: PanelClient | undefined
  /**
   * The workspace list, read through a thunk rather than captured at apply:
   * the controller may activate after this plugin's entry, exactly like
   * `uiWorkspace` and `sessions` (the panel already reads those per call).
   */
  readonly workspaces: () => WorkspacesClient | undefined
  /** The optional `uiWorkspace` service, read per request for the same reason. */
  readonly uiWorkspace: () => UiWorkspaceClient | undefined
  /**
   * The client Session Controller, read per request. The menu needs its
   * retention probe, not just the catalog: a blank the navigation just created
   * is retained synchronously but may be listed only later.
   */
  readonly sessions: () => unknown
  readonly dialog: WorkspaceFoldersDialogController
  readonly t: Translate
}

/**
 * The structural slice of the optional context-menu generation this module
 * uses. The `@deepseek-ai/dsh-client-ui-context-menu` package does not exist
 * before DSH `0.2.2-alpha.3` (the same boundary as the slot), so this plugin
 * must not depend on it as a package: the CI upgrade matrix rewrites every
 * `@deepseek-ai/dsh*` devDependency to the target release and would fail to
 * install. Declaring the tiny surface locally keeps the integration optional
 * and the support matrix installable.
 */
interface MenuAction {
  readonly id: string
  readonly label: string
  readonly icon?: { readonly key: string }
  readonly disabled?: boolean
  readonly run?: () => void | Promise<void>
}

interface WorkspaceMenuTarget {
  readonly workspaceId: string
}

interface MenuContribution {
  readonly id: string
  readonly target: 'workspace'
  readonly order: number
  resolve(target: WorkspaceMenuTarget): readonly MenuAction[]
}

interface MenuContextMenus {
  register(contribution: MenuContribution): () => void
}

interface MenuSlots {
  inject(key: string, callback: () => () => void): () => void
  register(options: { readonly name: string; readonly key: string }, component: PanelIcon): () => void
}

interface MenuScope {
  readonly slots: MenuSlots
  readonly contextMenus: MenuContextMenus
  effect(callback: () => () => void, label: string): () => void
}

/**
 * Install the workspace-row menu contribution.
 *
 * Registration is soft: no `contextMenus` service means no entry and no error.
 * The keyed `contextMenu.icon` slot is the gate for the whole contribution,
 * not just its glyph — a runtime without it (every release before
 * `0.2.2-alpha.3`) gets no menu change at all.
 * @param ctx - the client root context.
 * @param deps - the optional services and the footer dialog controller.
 */
export function installWorkspaceMenu(ctx: ClientContext, deps: WorkspaceMenuDeps): void {
  const menuContext = ctx as unknown as {
    inject(names: readonly string[], callback: (scope: unknown) => void): () => void
  }
  menuContext.inject(['contextMenus', 'slots'], (rawScope) => {
    const scope = rawScope as MenuScope
    // The keyed icon slot is the gate for the whole UI change, not just for
    // the glyph: it arrived with the extensible context-menu generation
    // (0.2.2-alpha.3) and is absent from every earlier supported release.
    // Registering the action without it would make this branch's entry appear
    // on a runtime it was never designed for. On those releases the slot is
    // never declared, so `slots.inject` never runs the body and the plugin
    // behaves as if this menu change did not exist.
    scope.slots.inject('contextMenu.icon', () => {
      const disposeIcon = scope.slots.register({
        name: 'contextMenu.icon',
        key: MENU_ID,
      }, IconWorkspaceTree)
      const disposeMenu = scope.effect(() => scope.contextMenus.register({
        id: MENU_ID,
        target: 'workspace',
        order: 150,
        resolve: ({ workspaceId }) => [{
          id: ACTION_ID,
          label: deps.t('switcher.manage'),
          icon: { key: MENU_ID },
          disabled: !menuEnabled(deps, workspaceId),
          run: () => runWorkspaceMenu(deps, workspaceId),
        }],
      }), 'multi-root-workspace: workspace menu entry')
      return () => {
        disposeMenu()
        disposeIcon()
      }
    })
  })
}

/**
 * Whether the entry can act on this workspace right now.
 *
 * All four legs are required: a host channel, a live record for the clicked
 * workspace, the upstream navigation capability, and a mounted footer dialog.
 * There is deliberately no "current session belongs elsewhere" clause — the
 * navigation path exists exactly for that case.
 */
function menuEnabled(deps: WorkspaceMenuDeps, workspaceId: string): boolean {
  const workspace = workspaceOf(deps, workspaceId)
  return deps.panel !== undefined
    && workspace !== undefined
    && typeof deps.uiWorkspace()?.openWorkspace === 'function'
    && deps.dialog.available.getSnapshot()
}

/** The live workspace record, if this composition has one. */
function workspaceOf(
  deps: WorkspaceMenuDeps,
  workspaceId: string,
): { readonly workspaceId: string; readonly sessionIds: readonly string[] } | undefined {
  return deps.workspaces()?.list.getSnapshot().items
    .find(item => item.workspaceId === workspaceId)
}

/**
 * The current session among one workspace's members.
 *
 * The per-session retention probe is preferred and used exclusively when it
 * answers for at least one member: the catalog can lag behind a selection the
 * navigation just made (and can also still name the previous workspace's
 * session). Without the probe, the catalog is the only supported source.
 */
function currentSessionIn(
  deps: WorkspaceMenuDeps,
  sessionIds: readonly string[],
): string | undefined {
  const sessions = deps.sessions()
  let probed = false
  for (const sessionId of sessionIds) {
    const retained = mainViewRetentionOf(sessions, sessionId)
    if (retained === undefined) continue
    probed = true
    if (retained) return sessionId
  }
  if (probed) return undefined
  const current = currentSessionIdOf(sessions)
  return current !== undefined && sessionIds.includes(current) ? current : undefined
}

/**
 * Open the dialog for the clicked workspace, navigating first when needed.
 *
 * The current-session branch is the common one: opening the manager for the
 * workspace the user is already in must not create or switch sessions.
 * Otherwise the target workspace's blank is opened/reused and the dialog is
 * pinned to the session the upstream navigation actually selected.
 */
async function runWorkspaceMenu(
  deps: WorkspaceMenuDeps,
  workspaceId: string,
): Promise<void> {
  // A menu resolution can be stale: the footer may have unmounted, the target
  // workspace may have been deleted, or the host channel may have gone away
  // between opening the menu and selecting the action. Re-check before any
  // navigation, so a vanished dialog host never leaves the user on a new
  // session with nothing on screen.
  if (!menuEnabled(deps, workspaceId)) return

  const workspace = workspaceOf(deps, workspaceId)
  if (workspace !== undefined) {
    const current = currentSessionIn(deps, workspace.sessionIds)
    if (current !== undefined) {
      deps.dialog.open(current)
      return
    }
  }

  const uiWorkspace = deps.uiWorkspace()
  if (uiWorkspace?.openWorkspace === undefined) return

  let targetSessionId: string | undefined
  try {
    // Call as a method: `UiWorkspaceService.openWorkspace` reads `this`. A
    // detached function reference throws synchronously, which the catch below
    // would otherwise turn into "nothing happened".
    await uiWorkspace!.openWorkspace!(workspaceId, (id) => { targetSessionId = id })
  } catch {
    // The upstream navigation already reports a refused creation through its
    // own Workspace notice; a second message from this entry would duplicate
    // it. A rejected navigation is simply "no dialog".
    return
  }

  // `beforeOpen` runs before the selection is committed, and a later
  // navigation can supersede this one between that commit and this
  // continuation. Only a target that actually became current may receive the
  // dialog — otherwise closing it would leave the user on another session
  // while the dialog still claims the old one.
  if (targetSessionId === undefined) return
  const sessions = deps.sessions()
  const retained = mainViewRetentionOf(sessions, targetSessionId)
  if (retained === false) return
  // Older surfaces without a retention probe fall back to the catalog. When
  // the probe exists, a `false` above is authoritative: the target may still
  // be the stale catalog's `current`, but the later navigation released it.
  if (retained === undefined && currentSessionIdOf(sessions) !== targetSessionId) return

  deps.dialog.open(targetSessionId)
}
