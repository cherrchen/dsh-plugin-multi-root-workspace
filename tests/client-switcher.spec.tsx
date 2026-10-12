// @vitest-environment jsdom
/**
 * The Files-tab root switcher, driven through the real client entry: the
 * registered occupant is rendered inside a `data-files-root` fixture and the
 * menu, the portal tree, and the degradation paths are observed through the
 * stub Connection channel and the DOM.
 *
 * The pane fixture mirrors the DOM shape the stylesheet relies on —
 * `data-files-root` on the pane, `data-files-path` / `data-files-reload` on
 * the header children, `data-files-body` on the tree area — because the
 * component's `closest('[data-files-root]')` lookup is what decides whether
 * the self-drawn tree exists at all.
 */

import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { PANEL_CHANNEL, type PanelRequest, type RootView, type RootsView } from '../src/contract.ts'
import * as client from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

/** One captured channel call. */
interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: PanelRequest
}

/** One slot registration the plugin made. */
interface Registration {
  readonly options: { name: string; id?: string; order?: number }
  readonly component: (owner?: unknown) => unknown
}

const ROOT_A: RootView = { ordinal: 1, id: 'a', path: '/repos/payments', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-write', alias: 'payments' }
const ROOT_B: RootView = { ordinal: 2, id: 'b', path: '/repos/website', addedAt: '2026-09-12T00:00:00.000Z', state: 'missing', access: 'read-only', detail: 'gone' }

/** The stub client context, plus what the plugin did with it. */
interface Harness {
  readonly calls: Call[]
  readonly registrations: Registration[]
  /** The `files.actions` occupant factory; call it with the slot owner. */
  readonly occupant: (owner?: { absolutePath?: string }) => unknown
  setView: (view: RootsView) => void
  setSession: (sessionId: string | undefined) => void
  setListFails: (fails: boolean) => void
}

/** Apply the real client entry to a recording stub context. */
function mount(withConnection = true): Harness {
  const calls: Call[] = []
  const registrations: Registration[] = []
  const sessionListeners = new Set<() => void>()
  let view: RootsView = { primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_A, ROOT_B], limit: 16, count: 2 }
  let currentSession: string | undefined = 'session-1'
  let listFails = false
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: PanelRequest) => {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'list' && listFails) {
          return { ok: false, error: { code: 'registry-contended', message: 'registry busy' } }
        }
        if (endpoint === 'files') {
          return {
            ok: true,
            value: {
              path: payload.path ?? '.',
              entries: payload.path === undefined || payload.path === '.'
                ? [{ name: 'src', type: 'directory' }, { name: 'notes.md', type: 'file' }]
                : [{ name: 'inner.ts', type: 'file' }],
              truncated: false,
            },
          }
        }
        if (endpoint === 'readFile') return { ok: true, value: { text: 'preview text', eof: true } }
        return { ok: true, value: view }
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
      register: (options: Registration['options'], component: (owner?: unknown) => unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'connection') return withConnection ? connection : undefined
      if (name === 'sessions') {
        return {
          list: {
            subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
            getSnapshot: () => ({ current: currentSession }),
          },
        }
      }
      return undefined
    },
  }
  client.apply(ctx as never)
  const registration = registrations.find(item => item.options.name === 'sidebar.right.tab.files.actions')
  if (registration === undefined) throw new Error('no files.actions registration')
  return {
    calls,
    registrations,
    occupant: registration.component,
    setView: next => { view = next },
    setSession: next => {
      currentSession = next
      for (const listener of sessionListeners) listener()
    },
    setListFails: next => { listFails = next },
  }
}

/** The pane fixtures this suite appended to `document.body`. */
const appended: HTMLElement[] = []

/** One fetch the open-in-app fork issued (verb, url, decoded JSON body). */
interface FetchCall {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

/**
 * Stub the open-in-app host routes the fork's controller fetches. The route
 * constants come from the installed shared module so the stub matches
 * whichever spelling the matrix version carries — document-relative from
 * 0.1.7-alpha.1 on, absolute before it.
 */
function stubOpenInApp(apps: readonly string[] = ['finder', 'vscode']): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    calls.push({ method: init?.method ?? 'GET', url, ...(body === undefined ? {} : { body }) })
    if (url === OPEN_IN_APP_APPS_ROUTE) {
      return new Response(JSON.stringify({ apps }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const element of appended.splice(0)) element.remove()
})

/**
 * Render the occupant inside a header that mirrors the upstream Files pane.
 * The returned `pane` is where the self-drawn tree must portal into.
 */
function renderInPane(harness: Harness, owner = { absolutePath: '/repos/primary' }): { pane: HTMLElement } {
  const pane = document.createElement('div')
  pane.setAttribute('data-files-root', '')
  const header = document.createElement('div')
  const path = document.createElement('span')
  path.setAttribute('data-files-path', '')
  const reload = document.createElement('button')
  reload.setAttribute('data-files-reload', '')
  header.append(path, reload)
  const body = document.createElement('div')
  body.setAttribute('data-files-body', '')
  pane.append(header, body)
  document.body.append(pane)
  appended.push(pane)
  render(harness.occupant(owner) as ReactElement, { container: header })
  return { pane }
}

function switcherKind(): string | null {
  return document.querySelector('.mrfw-rootSwitcher')?.getAttribute('data-root-kind') ?? null
}

async function openMenu(): Promise<void> {
  const toggle = document.querySelector<HTMLElement>('.mrfw-rootSwitchBtn')
  expect(toggle).not.toBeNull()
  fireEvent.click(toggle!)
  await screen.findByText(`${NS}.switcher.manage`)
}

describe('the Files-tab root switcher', () => {
  it('renders the primary root name and lists the session roots in its menu', async () => {
    const harness = mount()
    renderInPane(harness)

    // The mount fetch asks the host for this session's roots; the trigger
    // then shows the workspace title the host resolved.
    await waitFor(() => {
      expect(harness.calls[0]).toEqual({ channel: PANEL_CHANNEL, endpoint: 'list', payload: { sessionId: 'session-1' } })
    })
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    expect(switcherKind()).toBe('primary')

    await openMenu()
    const primary = screen.getByRole('button', { name: /panel\.primary/ })
    expect(primary.textContent).toContain('Platform')
    expect(primary).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'payments' })).toBeTruthy()
    // A missing root is annotated with its state and refused, not selectable.
    const missing = screen.getByRole('button', { name: /website/ })
    expect(missing).toHaveProperty('disabled', true)
    expect(missing.textContent).toContain(`${NS}.state.missing`)
  })

  it('shows the selected root full path between the trigger and the reload', async () => {
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // Primary selection: the path is the pane's workspace root — the same
    // value the hidden upstream label carried.
    const label = document.querySelector('.mrfw-switcherPath')
    expect(label?.getAttribute('title')).toBe('/repos/primary')

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    // Additional selection: the path follows the selected root.
    expect(document.querySelector('.mrfw-switcherPath')?.getAttribute('title')).toBe('/repos/payments')
  })

  it('selecting an additional root marks the switcher and portals the lazy tree into the pane', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))

    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    const tree = pane.querySelector('.mrfw-switcherTree')
    expect(tree).not.toBeNull()
    // The tree lazily lists the selected root through the files endpoint.
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'files'
        && call.payload.sessionId === 'session-1'
        && call.payload.path === '.'
        && call.payload.entry?.id === 'a')).toBe(true)
    })
    await waitFor(() => { expect(screen.getByText('▸ src')).toBeTruthy() })
    expect(screen.getByText('notes.md')).toBeTruthy()
    // The trigger now names the selected root.
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('payments')
  })

  it('offers a header reload while the take-over is on, and re-lists on click', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // The native reload covers the primary root — the switcher adds none.
    expect(document.querySelector('.mrfw-switcherReload')).toBeNull()

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('.mrfw-switcherTree')).not.toBeNull() })

    const reload = document.querySelector<HTMLElement>('.mrfw-switcherReload')
    expect(reload?.closest('.mrfw-rootSwitcher')).not.toBeNull()
    const filesBefore = harness.calls.filter(call => call.endpoint === 'files').length
    fireEvent.click(reload!)
    // The refresh is in place: the current rows stay while the refetch is
    // in flight — no loading-note flash.
    expect(pane.textContent).toContain('src')
    expect(pane.textContent).not.toContain(`${NS}.panel.loading`)
    await waitFor(() => {
      expect(harness.calls.filter(call => call.endpoint === 'files').length).toBeGreaterThan(filesBefore)
    })
    await waitFor(() => { expect(pane.textContent).toContain('src') })
    expect(pane.textContent).not.toContain(`${NS}.panel.loading`)
  })

  it('removes the portal tree when the selection returns to the primary root', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('.mrfw-switcherTree')).not.toBeNull() })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: /panel\.primary/ }))

    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-switcherTree')).toBeNull()
  })

  it('opens the Workspace Folders dialog from the trailing manage item', async () => {
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(harness.calls.length).toBeGreaterThanOrEqual(1) })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: `${NS}.switcher.manage` }))

    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
    // The dialog is the same manager: it reads the roots view for the session.
    expect(harness.calls.every(call => call.payload.sessionId === 'session-1')).toBe(true)
  })

  it('degrades to a menu-only switcher without a data-files-root ancestor', async () => {
    const harness = mount()
    render(harness.occupant({ absolutePath: '/repos/primary' }) as ReactElement)
    await waitFor(() => { expect(harness.calls.length).toBeGreaterThanOrEqual(1) })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))

    // The selection still applies to the menu state, but with no pane there
    // is nowhere to put the tree — the native layout is left alone.
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(document.querySelector('.mrfw-switcherTree')).toBeNull()
  })

  it('lists only the primary root and the manage entry without a connection', async () => {
    const harness = mount(false)
    renderInPane(harness)

    await openMenu()
    expect(screen.getByRole('button', { name: /panel\.primary/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${NS}.switcher.manage` })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'payments' })).toBeNull()
    expect(harness.calls).toHaveLength(0)
  })

  it('returns to the primary root when the selected root leaves a later view', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('.mrfw-switcherTree')).not.toBeNull() })

    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_B], limit: 16, count: 1 })
    // Opening the menu refetches; the stale selection must not survive it.
    await openMenu()
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-switcherTree')).toBeNull()
  })

  it('returns to the primary root when a refresh cannot revalidate the selection', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(pane.querySelector('.mrfw-switcherTree')).not.toBeNull()

    // The next refresh cannot revalidate the roots at all: the takeover must
    // not keep the native primary tree hidden behind a stale selection.
    harness.setListFails(true)
    await openMenu()
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-switcherTree')).toBeNull()
  })

  it('reconciles the selection when the folders manager closes', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(pane.querySelector('.mrfw-switcherTree')).not.toBeNull()

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: `${NS}.switcher.manage` }))
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })

    // The manager removed the selected root: its mutations live in the
    // dialog's own state, so closing it must re-list and drop the revoked
    // selection rather than keep browsing the stale grant.
    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_B], limit: 16, count: 1 })
    const listsBefore = harness.calls.filter(call => call.endpoint === 'list').length
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.close` }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await waitFor(() => {
      expect(harness.calls.filter(call => call.endpoint === 'list').length).toBeGreaterThan(listsBefore)
    })
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-switcherTree')).toBeNull()
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform')
  })

  it('resets the selection and refetches when the session changes', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })

    act(() => { harness.setSession('session-2') })

    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-switcherTree')).toBeNull()
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list' && call.payload.sessionId === 'session-2')).toBe(true)
    })
  })

  it('keeps the icon-only launcher when the slot owner carries no absolutePath', async () => {
    const harness = mount()
    render(harness.occupant() as ReactElement)
    const launcher = screen.getByRole('button', { name: /action.title/ })
    expect(launcher.closest('.mrfw-fileLauncher')).not.toBeNull()
    expect(launcher.textContent).toBe('')
  })
})

describe('the forked open-in-app control', () => {
  it('opens the selected additional root, never the primary one', async () => {
    const fetchCalls = stubOpenInApp()
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // Primary selection: the native button keeps the spot; the fork draws
    // nothing of its own — exactly upstream's presence, not a duplicate.
    expect(document.querySelector('[data-open-target="directory"]')).toBeNull()

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })

    // The fork is the same control: the data-open-target split button,
    // sitting inside the switcher where the native one was hidden.
    const split = await waitFor(() => {
      const found = document.querySelector('.mrfw-rootSwitcher [data-open-target="directory"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(split.classList.contains('mrfw-openSplit')).toBe(true)
    expect(fetchCalls.some(call => call.url === OPEN_IN_APP_APPS_ROUTE)).toBe(true)

    // The main half launches the preferred app on the SELECTED root —
    // /repos/payments, not the pane's /repos/primary.
    const main = split.querySelector<HTMLElement>('.mrfw-openMain')!
    fireEvent.click(main)
    await waitFor(() => {
      expect(fetchCalls.some(call => call.url === OPEN_IN_APP_OPEN_ROUTE
        && call.method === 'POST'
        && (call.body as { app?: string; path?: string }).path === '/repos/payments')).toBe(true)
    })
    const open = fetchCalls.find(call => call.url === OPEN_IN_APP_OPEN_ROUTE)!
    expect((open.body as { app: string }).app).toBe('finder')
    expect(fetchCalls.every(call => (call.body as { path?: string } | undefined)?.path !== '/repos/primary')).toBe(true)
  })

  it('lists the installed applications in the chevron menu and launches the picked one', async () => {
    const fetchCalls = stubOpenInApp()
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    const chevron = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.mrfw-openChevron')
      expect(found).not.toBeNull()
      return found!
    })

    fireEvent.click(chevron)
    // Menu rows read upstream's own namespace: open-in-app.app.* keys.
    const row = await screen.findByRole('button', { name: /app\.vscode/ })
    fireEvent.click(row)
    await waitFor(() => {
      expect(fetchCalls.some(call => call.url === OPEN_IN_APP_OPEN_ROUTE
        && (call.body as { app?: string }).app === 'vscode'
        && (call.body as { path?: string }).path === '/repos/payments')).toBe(true)
    })
  })

  it('draws no button when the host reports no applications — upstream same absence', async () => {
    stubOpenInApp([])
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    // The component still mounts; with no resolved app it returns null,
    // byte-identical to upstream's own empty-catalog behavior.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[data-open-target="directory"]')).toBeNull()
  })
})
