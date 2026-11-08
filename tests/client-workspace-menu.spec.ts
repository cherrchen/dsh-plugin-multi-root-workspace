// @vitest-environment jsdom
/**
 * The workspace-row "Manage workspace folders…" entry.
 *
 * Two layers are driven here:
 *
 * - the contribution itself, through the real `installWorkspaceMenu` and a
 *   minimal Cordis-shaped stub — this is where the enable/disable matrix and
 *   the navigation branches are asserted;
 * - the real client entry, once, to prove the wiring: the footer instance
 *   registers the dialog owner and the menu contribution receives the same
 *   controller, so a click really opens the footer dialog for the pinned
 *   session.
 */

import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_CHANNEL, type PanelRequest, type RootsView } from '../src/contract.ts'
import * as client from '../src/client/index.ts'
import { createWorkspaceFoldersDialogController } from '../src/client/workspace-folders-dialog.ts'
import {
  installWorkspaceMenu,
  type UiWorkspaceClient,
  type WorkspaceMenuDeps,
  type WorkspacesClient,
} from '../src/client/workspace-menu.ts'

/** The target the upstream workspace row publishes. */
interface Target {
  readonly workspaceId: string
  readonly path: string
  readonly displayTitle: string
}

/** One resolved action, as far as this spec reads it. */
interface Action {
  readonly id: string
  readonly label: string
  readonly icon?: { readonly key: string }
  readonly disabled?: boolean
  readonly run?: () => void | Promise<void>
}

/** One registered contribution. */
interface Contribution {
  readonly id: string
  readonly target: string
  readonly order: number
  resolve(target: Target): readonly Action[]
}

const TARGET_A: Target = { workspaceId: 'ws-a', path: '/repos/a', displayTitle: 'A' }
const TARGET_B: Target = { workspaceId: 'ws-b', path: '/repos/b', displayTitle: 'B' }
const TARGET_MISSING: Target = { workspaceId: 'ws-gone', path: '/repos/gone', displayTitle: 'Gone' }

const WORKSPACES: WorkspacesClient = {
  list: {
    getSnapshot: () => ({
      items: [
        { workspaceId: 'ws-a', sessionIds: ['session-a'] },
        { workspaceId: 'ws-b', sessionIds: ['session-b'] },
      ],
    }),
  },
}

/** The navigation capability; the default resolves to `session-b`. */
type OpenWorkspace = NonNullable<UiWorkspaceClient['openWorkspace']>

interface DepsOptions {
  /** `null` removes the host channel. */
  readonly panel?: WorkspaceMenuDeps['panel'] | null
  /** `null` removes the workspace list. */
  readonly workspaces?: WorkspacesClient | null
  /** `null` removes the whole uiWorkspace service. */
  readonly uiWorkspace?: UiWorkspaceClient | null
  readonly openWorkspace?: OpenWorkspace | null
  readonly current?: string | undefined
  /** What the current session becomes after a successful navigation. */
  readonly after?: string | false
  /** Initial sessions the retention probe reports as main-view-retained. */
  readonly retained?: readonly string[]
  /** Keep the catalog's `current` stale after navigation (row lag). */
  readonly staleList?: boolean
  /** `false` leaves the dialog without an owner (footer unmounted). */
  readonly owner?: boolean
}

/** A deps bundle plus the observations this spec makes. */
interface DepsHarness {
  readonly deps: WorkspaceMenuDeps
  readonly opened: string[]
  readonly calls: { workspaceId: string; hadBeforeOpen: boolean }[]
  readonly controller: ReturnType<typeof createWorkspaceFoldersDialogController>
  readonly releaseOwner: (() => void) | undefined
  setCurrent(id: string | undefined): void
}

/**
 * Build deps with a controllable current session and navigation.
 * @param options - which optional legs to remove or replace.
 */
function makeDeps(options: DepsOptions = {}): DepsHarness {
  const opened: string[] = []
  const controller = createWorkspaceFoldersDialogController()
  const releaseOwner = options.owner === false
    ? undefined
    : controller.registerOwner((id) => { opened.push(id ?? '<current>') })
  let current = options.current ?? 'session-a'
  const retained = new Set<string>(options.retained ?? (current === undefined ? [] : [current]))
  const calls: { workspaceId: string; hadBeforeOpen: boolean }[] = []
  const openWorkspace: OpenWorkspace | undefined = options.openWorkspace === null
    ? undefined
    : options.openWorkspace ?? (async (workspaceId, beforeOpen) => {
      calls.push({ workspaceId, hadBeforeOpen: beforeOpen !== undefined })
      const target = options.after === false ? undefined : options.after ?? 'session-b'
      beforeOpen?.(target ?? 'session-b')
      // The real navigation releases the previous main-view reference and
      // retains the new session synchronously; only the catalog can lag.
      retained.clear()
      if (target !== undefined) {
        retained.add(target)
        if (options.staleList !== true) current = target
      }
    })
  const workspaces = options.workspaces === null ? undefined : options.workspaces ?? WORKSPACES
  const uiWorkspace = options.uiWorkspace === null
    ? undefined
    : options.uiWorkspace ?? (openWorkspace === undefined ? {} : { openWorkspace })
  const sessions = {
    retainInfo: (id: string) => {
      const on = retained.has(id)
      return {
        getSnapshot: () => ({
          referenceCount: on ? 1 : 0,
          retainedBy: on ? { mainView: 1 } : {},
        }),
      }
    },
    list: { getSnapshot: () => ({ current }) },
  }
  const deps: WorkspaceMenuDeps = {
    panel: options.panel === null ? undefined : options.panel ?? ({} as never),
    // The entry reads optional services per resolve/run; the thunks model a
    // service that may activate after the client entry.
    workspaces: () => workspaces,
    uiWorkspace: () => uiWorkspace,
    sessions: () => sessions,
    dialog: controller,
    t: key => `t:${key}`,
  }
  return {
    deps,
    opened,
    calls,
    controller,
    releaseOwner,
    setCurrent: (id) => {
      current = id
      retained.clear()
      if (id !== undefined) retained.add(id)
    },
  }
}

/** A Cordis-shaped stub that records what `installWorkspaceMenu` registers. */
function install(
  deps: WorkspaceMenuDeps,
  options: { missing?: 'contextMenus' | 'slots'; iconSlot?: boolean } = {},
): { contributions: Contribution[]; icons: { key: string; component: unknown }[] } {
  const contributions: Contribution[] = []
  const icons: { key: string; component: unknown }[] = []
  const scope = {
    slots: {
      inject: (name: string, callback: () => unknown) => {
        if (name === 'contextMenu.icon' && options.iconSlot !== false) callback()
        return () => {}
      },
      register: (registration: { key: string }, component: unknown) => {
        icons.push({ key: registration.key, component })
        return () => {}
      },
    },
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    contextMenus: {
      register: (contribution: Contribution) => {
        contributions.push(contribution)
        return () => {}
      },
    },
  }
  const ctx = {
    inject: (names: string[], callback: (scope: unknown) => unknown) => {
      if (options.missing !== undefined && names.includes(options.missing)) return () => {}
      callback(scope)
      return () => {}
    },
  }
  installWorkspaceMenu(ctx as never, deps)
  return { contributions, icons }
}

/** The only action of the only contribution. */
function onlyAction(contributions: readonly Contribution[], target: Target): Action {
  const contribution = contributions[0]
  if (contribution === undefined) throw new Error('no workspace-menu contribution registered')
  const action = contribution.resolve(target)[0]
  if (action === undefined) throw new Error('no workspace-menu action resolved')
  return action
}

afterEach(() => { cleanup() })

describe('the workspace context-menu contribution', () => {
  it('registers one workspace contribution at order 150 with the manage label and icon key', () => {
    const { deps } = makeDeps()
    const { contributions, icons } = install(deps)
    expect(contributions).toHaveLength(1)
    expect(contributions[0]).toMatchObject({
      id: 'multi-root-workspace.manage-folders',
      target: 'workspace',
      order: 150,
    })
    expect(icons.map(icon => icon.key)).toEqual(['multi-root-workspace.manage-folders'])
    expect(icons[0]?.component).toBeDefined()
    expect(onlyAction(contributions, TARGET_A)).toMatchObject({
      id: 'manage',
      label: 't:switcher.manage',
      icon: { key: 'multi-root-workspace.manage-folders' },
      disabled: false,
    })
  })

  it('is disabled without a host channel', () => {
    const { deps } = makeDeps({ panel: null })
    expect(onlyAction(install(deps).contributions, TARGET_A).disabled).toBe(true)
  })

  it('is disabled when the workspace list is missing', () => {
    const { deps } = makeDeps({ workspaces: null })
    expect(onlyAction(install(deps).contributions, TARGET_A).disabled).toBe(true)
  })

  it('is disabled when the clicked workspace record no longer exists', () => {
    const { deps } = makeDeps()
    expect(onlyAction(install(deps).contributions, TARGET_MISSING).disabled).toBe(true)
  })

  it('is disabled when uiWorkspace has no openWorkspace capability', () => {
    const { deps } = makeDeps()
    const withoutNavigation: WorkspaceMenuDeps = {
      ...deps,
      uiWorkspace: () => ({}),
    }
    expect(onlyAction(install(withoutNavigation).contributions, TARGET_A).disabled).toBe(true)
  })

  it('is disabled while the footer dialog has no owner', () => {
    const { deps } = makeDeps({ owner: false })
    expect(onlyAction(install(deps).contributions, TARGET_A).disabled).toBe(true)
  })

  it('is enabled when every dependency is present', () => {
    const { deps } = makeDeps()
    expect(onlyAction(install(deps).contributions, TARGET_A).disabled).toBe(false)
  })

  it('reads optional services at resolve time, so late activation enables the entry', () => {
    // ui-workspace / the workspace controller may apply after this plugin's
    // entry. A captured snapshot would leave the entry disabled forever; the
    // thunks must see the services once they appear.
    const harness = makeDeps()
    const lateServices: {
      workspaces?: WorkspacesClient
      uiWorkspace?: UiWorkspaceClient
    } = {}
    const late: WorkspaceMenuDeps = {
      ...harness.deps,
      workspaces: () => lateServices.workspaces,
      uiWorkspace: () => lateServices.uiWorkspace,
    }
    const { contributions } = install(late)
    const contribution = contributions[0]
    if (contribution === undefined) throw new Error('no contribution')
    expect(contribution.resolve(TARGET_A)[0]?.disabled).toBe(true)
    lateServices.workspaces = WORKSPACES
    lateServices.uiWorkspace = { openWorkspace: async () => {} }
    const action = contribution.resolve(TARGET_A)[0]
    expect(action?.disabled).toBe(false)
    expect(harness.controller.available.getSnapshot()).toBe(true)
  })

  it('opens directly for a current session that belongs to the clicked workspace', async () => {
    const harness = makeDeps({ current: 'session-a' })
    const action = onlyAction(install(harness.deps).contributions, TARGET_A)
    await action.run?.()
    expect(harness.calls).toEqual([])
    expect(harness.opened).toEqual(['session-a'])
  })

  it('navigates first and opens for the session the navigation selected', async () => {
    const harness = makeDeps({ current: 'session-a' })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.calls).toEqual([{ workspaceId: 'ws-b', hadBeforeOpen: true }])
    expect(harness.opened).toEqual(['session-b'])
  })

  it('calls openWorkspace as a method so a class instance keeps its this', async () => {
    // `UiWorkspaceService.openWorkspace` reads `this`; extracting the method
    // and calling it bare threw synchronously and was silently swallowed.
    const harness = makeDeps({ current: 'session-a' })
    const calls: string[] = []
    const service = {
      marker: 'bound',
      async openWorkspace(
        this: { marker: string },
        workspaceId: string,
        beforeOpen?: (id: string) => void,
      ): Promise<void> {
        if (this.marker !== 'bound') throw new Error('unbound openWorkspace')
        calls.push(workspaceId)
        beforeOpen?.('session-b')
      },
    }
    const deps: WorkspaceMenuDeps = { ...harness.deps, uiWorkspace: () => service as UiWorkspaceClient }
    const action = onlyAction(install(deps).contributions, TARGET_B)
    await action.run?.()
    expect(calls).toEqual(['ws-b'])
  })

  it('opens after navigation even when the catalog has not listed the new session yet', async () => {
    // Regression: `ui-workspace` retains the newly selected blank
    // synchronously, but its catalog row can arrive later. Reading the list
    // alone made the menu believe the navigation never selected its target.
    const harness = makeDeps({ current: 'session-a', staleList: true })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.calls).toEqual([{ workspaceId: 'ws-b', hadBeforeOpen: true }])
    expect(harness.opened).toEqual(['session-b'])
  })

  it('opens directly when retention already names a member the catalog has not listed', async () => {
    const harness = makeDeps({ current: 'session-a', retained: ['session-b'] })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.calls).toEqual([])
    expect(harness.opened).toEqual(['session-b'])
  })

  it('does not open when the catalog still names the target but retention released it', async () => {
    const harness = makeDeps({
      current: 'session-b',
      retained: [],
      openWorkspace: async (_workspaceId, beforeOpen) => { beforeOpen?.('session-b') },
    })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.opened).toEqual([])
  })

  it('navigates when there is no current session', async () => {
    const harness = makeDeps({ current: undefined })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.calls).toEqual([{ workspaceId: 'ws-b', hadBeforeOpen: true }])
    expect(harness.opened).toEqual(['session-b'])
  })

  it('navigates for an orphaned current session instead of disabling the entry', async () => {
    const harness = makeDeps({ current: 'session-orphaned' })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    expect(action.disabled).toBe(false)
    await action.run?.()
    expect(harness.opened).toEqual(['session-b'])
  })

  it('does not open when openWorkspace rejects', async () => {
    const harness = makeDeps({
      current: 'session-a',
      openWorkspace: async () => { throw new Error('refused') },
    })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await expect(action.run?.()).resolves.toBeUndefined()
    expect(harness.opened).toEqual([])
  })

  it('does not open when a later navigation superseded the target', async () => {
    const harness = makeDeps({ current: 'session-a', after: false })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.calls).toEqual([{ workspaceId: 'ws-b', hadBeforeOpen: true }])
    expect(harness.opened).toEqual([])
  })

  it('does not open when the navigation never called beforeOpen', async () => {
    const harness = makeDeps({
      current: 'session-a',
      openWorkspace: async () => { /* superseded before selection */ },
    })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    await action.run?.()
    expect(harness.opened).toEqual([])
  })

  it('does not throw when the dialog owner disappeared between resolve and run', async () => {
    const harness = makeDeps({ current: 'session-a' })
    const action = onlyAction(install(harness.deps).contributions, TARGET_A)
    harness.releaseOwner?.()
    await expect(action.run?.()).resolves.toBeUndefined()
    expect(harness.opened).toEqual([])
  })

  it('does not navigate when the dialog host vanished after resolve', async () => {
    const harness = makeDeps({ current: 'session-a' })
    const action = onlyAction(install(harness.deps).contributions, TARGET_B)
    harness.releaseOwner?.()
    await action.run?.()
    expect(harness.calls).toEqual([])
    expect(harness.opened).toEqual([])
  })

  it('does not throw when the dialog owner itself throws', async () => {
    const harness = makeDeps({ owner: false })
    harness.controller.registerOwner(() => { throw new Error('owner failed') })
    const action = onlyAction(install(harness.deps).contributions, TARGET_A)
    await expect(action.run?.()).resolves.toBeUndefined()
  })

  it('registers nothing when contextMenus is absent', () => {
    const { deps } = makeDeps()
    expect(install(deps, { missing: 'contextMenus' }).contributions).toEqual([])
  })

  it('registers nothing when slots is absent', () => {
    const { deps } = makeDeps()
    expect(install(deps, { missing: 'slots' }).contributions).toEqual([])
  })

  it('registers nothing when the icon slot never declares', () => {
    // The icon slot is the gate for the entire UI change: on releases before
    // the extensible context-menu generation (0.2.2-alpha.3) neither the slot
    // nor the service exists, and this branch must behave as if it made no
    // menu change at all.
    const { deps } = makeDeps()
    const { contributions, icons } = install(deps, { iconSlot: false })
    expect(contributions).toEqual([])
    expect(icons).toEqual([])
  })
})

describe('client-entry wiring', () => {
  it('opens the footer dialog for the pinned session', async () => {
    const calls: { endpoint: string; payload: PanelRequest }[] = []
    const registrations: { options: { name: string }; component: (owner?: unknown) => unknown }[] = []
    const contributions: Contribution[] = []
    let current: string | undefined = 'session-a'
    const roots: RootsView = { primaryRoot: '/repos/a', roots: [], limit: 16, count: 0 }
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, payload: PanelRequest) => {
          calls.push({ endpoint, payload })
          return { ok: true, value: roots }
        },
      },
    }
    const ctx = {
      effect: (callback: () => unknown) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      locale: {
        register: () => () => {},
        bind: (ns: string) => (key: string) => `${ns}.${key}`,
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: { name: string }, component: (owner?: unknown) => unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      contextMenus: {
        register: (contribution: Contribution) => {
          contributions.push(contribution)
          return () => {}
        },
      },
      inject: (names: string[], callback: (scope: unknown) => unknown) => {
        // Cordis only runs the injected body once every named service exists.
        // `slots` and `contextMenus` are the services this spec itself
        // provides; optional Skills services are absent here, so their bodies
        // correctly stay unrun.
        const available = names.every(name => name === 'slots'
          || name === 'contextMenus'
          || ctx.get(name) !== undefined)
        if (!available) return () => {}
        callback(ctx)
        return () => {}
      },
      get: (name: string) => {
        if (name === 'connection') return connection
        if (name === 'uiWorkspace') {
          return {
            pickDirectory: async () => null,
            openWorkspace: async (_workspaceId: string, beforeOpen?: (id: string) => void) => {
              beforeOpen?.('session-b')
              current = 'session-b'
            },
          }
        }
        if (name === 'workspaces') return WORKSPACES
        if (name === 'sessions') {
          return { list: { getSnapshot: () => ({ current }), subscribe: () => () => {} } }
        }
        return undefined
      },
    }
    client.apply(ctx as never)

    const footer = registrations.find(registration => registration.options.name === 'sidebar.footer.action')
    expect(footer).toBeDefined()
    render(createElement(footer!.component as never))

    const action = onlyAction(contributions, TARGET_A)
    expect(action.disabled).toBe(false)
    await action.run?.()
    await screen.findByRole('dialog')
    await waitFor(() => {
      expect(calls.some(call => call.endpoint === 'list' && call.payload.sessionId === 'session-a')).toBe(true)
    })
    expect(calls[0]).toMatchObject({ endpoint: 'list', payload: { sessionId: 'session-a' } })
    expect(PANEL_CHANNEL).toBe('/multi-root-workspace')
  })
})
