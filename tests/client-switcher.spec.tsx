// @vitest-environment jsdom
/**
 * The Files-tab root switcher, driven through the real client entry: the
 * registered occupant is rendered inside a `data-files-root` fixture and the
 * menu, the portal tree, and the degradation paths are observed through the
 * stub Connection channel, the stub `remote`/`sidebarRight` services, and the
 * DOM.
 *
 * The pane fixture mirrors the DOM shape the stylesheet and the takeover
 * rely on — `data-files-root` on the pane, `data-files-path` /
 * `data-files-reload` on the header children, `data-files-body` on the tree
 * area, `data-dockkit-content` on the tab host — because the component's
 * `closest` lookups are what decide whether the forked tree exists at all.
 *
 * The harness plays the slot framework's part for the occupant: it mints
 * the registration's session store, runs its `inject` factory, and spreads
 * the result plus `useStore`/`actions`/`sessionId` onto the props — the same
 * shares the upstream Files registration composes.
 */

import type { ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { PANEL_CHANNEL, type RootView } from '../src/contract.ts'
import { NS } from '../src/client/locales.ts'
import type { RemoteEndpointView, RemotesView } from '../src/remote/panel-contract.ts'
import type { RemoteFilesFailureCode, RemoteFilesListing } from '../src/remote/files-contract.ts'
import { ROOT_A, ROOT_B, mount, renderInPane, searchCalls, stubOpenInApp, type RemoteStub } from './support/switcher-harness.tsx'
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
  it('uses the host tree Factory in the newer Files page and routes its callbacks', async () => {
    const harness = mount()
    const factory = vi.fn((_name: string, _input: object, options: { fallback: ReactElement }) => options.fallback)
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factory }, false, true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    expect(switcherKind()).toBe('additional')
    expect(factory).toHaveBeenCalled()
    const call = factory.mock.calls.at(-1)!
    expect(call[0]).toBe('sidebar.files.tree')
    const input = call[1] as { root: string; entries: Array<{ path: string; name: string; meta: { kind: string } }>; onOpen: (entry: object) => void; onToggle: (entry: object) => void }
    expect(input.root).toBe('/repos/payments')
    const file = input.entries.find(entry => entry.path === '/repos/payments/notes.md')!
    expect(file.meta.kind).toBe('file')
    act(() => { input.onOpen(file) })
    expect(harness.opens.at(-1)?.address).toContain('notes.md')
    const directory = input.entries.find(entry => entry.path === '/repos/payments/src')!
    act(() => { input.onToggle(directory) })
    await waitFor(() => { expect(harness.treeCalls.some(call => call.path === '/repos/payments/src' && call.kind === 'list')).toBe(true) })
  })

  it('loads and browses additional roots after StrictMode replays mount effects', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness, undefined, true)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
  })

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

  it('wires the shrink hook onto the Menu anchor wrapper the header row sizes', async () => {
    const harness = mount()
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // The header row's flex item is Menu's anchor wrapper span, not the button;
    // the stylesheet's min-width: 0 has to land there, or the trigger keeps its
    // min-content width and paints over the reload/search controls in a narrow
    // header. This suite renders the stubbed primitives barrel (vitest aliases
    // it to tests/stubs/ui-primitives.tsx, which mirrors the real anchor span),
    // so the assertion pins OUR wiring against that contract — it cannot see an
    // upstream DOM change. The upstream side rests on the per-release survey of
    // Menu.className in ADR-0046 and on the real-GUI measurement there; the stub
    // deliberately keeps the same nesting so a stop in forwarding className
    // still turns this red.
    const trigger = document.querySelector('.mrfw-rootSwitchBtn')
    expect(trigger).not.toBeNull()
    const anchor = trigger!.parentElement
    expect(anchor?.classList.contains('mrfw-rootSwitchAnchor')).toBe(true)
    expect(anchor?.parentElement?.classList.contains('mrfw-rootSwitcher')).toBe(true)
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
    const tree = pane.querySelector('.mrfw-ftBody')
    expect(tree).not.toBeNull()
    // The tree watches, then lazily lists the selected root's absolute path
    // through workspaceFiles — the verbatim face's own call order.
    await waitFor(() => {
      expect(harness.treeCalls.some(call => call.kind === 'changes'
        && call.sessionId === 'session-1'
        && call.path === '/repos/payments')).toBe(true)
      expect(harness.treeCalls.some(call => call.kind === 'list'
        && call.sessionId === 'session-1'
        && call.path === '/repos/payments')).toBe(true)
    })
    // Upstream rows: directory entry hooks and icon+name buttons.
    await waitFor(() => {
      expect(pane.querySelector('[data-files-entry="directory"][data-files-path="/repos/payments/src"]')).not.toBeNull()
    })
    expect(screen.getByRole('button', { name: 'src' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeTruthy()
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
    await waitFor(() => { expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull() })

    const reload = document.querySelector<HTMLElement>('.mrfw-switcherReload')
    expect(reload?.closest('.mrfw-rootSwitcher')).not.toBeNull()
    const listedBefore = harness.treeCalls.filter(call => call.kind === 'list').length
    fireEvent.click(reload!)
    // The refresh is in place: the current rows stay while the relist is
    // in flight — a ready level never drops back to the loading note.
    expect(pane.textContent).toContain('src')
    expect(pane.textContent).not.toContain('sidebarFiles.loading')
    await waitFor(() => {
      expect(harness.treeCalls.filter(call => call.kind === 'list').length).toBeGreaterThan(listedBefore)
    })
    await waitFor(() => { expect(pane.textContent).toContain('src') })
    expect(pane.textContent).not.toContain('sidebarFiles.loading')
  })

  it('removes the portal tree when the selection returns to the primary root', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull() })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: /panel\.primary/ }))

    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-ftBody')).toBeNull()
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
    // is nowhere to put the tree — data-root-kind stays primary so the
    // native layout is left alone.
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(document.querySelector('.mrfw-ftBody')).toBeNull()
    // No remote traffic either: no pane means no takeover lifetime at all.
    expect(harness.treeCalls).toHaveLength(0)
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
    await waitFor(() => { expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull() })

    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_B], limit: 16, count: 1 })
    // Opening the menu refetches; the stale selection must not survive it.
    await openMenu()
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-ftBody')).toBeNull()
  })

  it('keeps the selected root while a refresh cannot answer — eviction needs an answered view', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()

    // The next refresh cannot revalidate the roots at all: an unanswered
    // list must not evict the persisted selection — remounts and transient
    // failures would otherwise drop it on every first pending moment. The
    // trigger keeps naming the stored row and the takeover keeps its rows;
    // the tree's own failure line reports the host fault.
    harness.setListFails(true)
    await openMenu()
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(switcherKind()).toBe('additional')
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('payments')
  })

  it('restores the selection and the same tree when the body remounts after a file opens', async () => {
    const harness = mount()
    const { pane, unmount } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull()
    })
    const traffic = harness.treeCalls.length

    // What a file open does upstream: the viewer tab takes the pane and
    // dockkit unmounts this tab's whole body — occupant subtree included —
    // while the tabHost section stays connected, the tab record unharmed.
    unmount()

    // The remounted occupant rejoins the SAME pane inside the same tabHost
    // section (a fresh header — the body's new subtree): the persisted
    // selection makes it additional-root again, and the takeover entry never
    // ended — so the bucket resumes with the same rows already drawn. The
    // reopened hold starts its watch again and re-lists the kept levels in
    // the background, exactly the native `hold` lifetime.
    const header2 = document.createElement('div')
    pane.prepend(header2)
    render(harness.occupant({ absolutePath: '/repos/primary' }) as ReactElement, { container: header2 })
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull()
    })
    await waitFor(() => { expect(harness.treeCalls.length).toBeGreaterThan(traffic) })
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('payments')
  })

  it('ends the takeover when the tabHost section leaves the document — the record really ended', async () => {
    const harness = mount()
    const { pane, host, unmount } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull()
    })

    // The whole section leaving the document is the tab record's real end —
    // the inject-side observer must end the entry, forgetting the bucket,
    // closing the watches, and dropping the persisted selection: a dead
    // owner's stored root must never greet the next owner of a recycled id.
    unmount()
    host.remove()
    await new Promise(resolve => setTimeout(resolve, 0))
    const traffic = harness.treeCalls.length

    // The reopened tab carries the same fixture id, but the dead owner's
    // selection is gone — the pane draws the primary root and no
    // additional-root listing resumes.
    renderInPane(harness)
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.treeCalls.length).toBe(traffic)
    expect(document.querySelectorAll('[data-files-path="/repos/payments/notes.md"]').length).toBe(0)
  })

  it('still ends the takeover when the hidden tab closes long after the body unmounted', async () => {
    const harness = mount()
    const { pane, host, unmount } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull()
    })

    // The body hid a while ago and its component is gone — no cleanup can
    // run — but the record's end is exactly what the inject-side observer is
    // for: removing the section now must still end the entry, and with it
    // the persisted selection a recycled tab id could otherwise inherit.
    unmount()
    await new Promise(resolve => setTimeout(resolve, 0))
    host.remove()
    await new Promise(resolve => setTimeout(resolve, 0))
    const traffic = harness.treeCalls.length

    renderInPane(harness)
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.treeCalls.length).toBe(traffic)
    expect(document.querySelectorAll('[data-files-path="/repos/payments/notes.md"]').length).toBe(0)
  })

  it('does not re-issue list on ordinary re-renders — the refresh callback stays stable', async () => {
    const harness = mount()
    const { pane, header, rerender } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    const lists = (): number => harness.calls.filter(call => call.endpoint === 'list').length
    await waitFor(() => { expect(lists()).toBe(1) })

    // The upstream tree's every store write re-renders the occupant. Each
    // such re-render used to rebuild paneSessionId — and refresh with it —
    // firing another list call. Memoized, the callback keeps its identity
    // and the refresh effect does not refire.
    for (let i = 0; i < 3; i += 1) {
      rerender(harness.occupant({ absolutePath: '/repos/primary' }) as ReactElement)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lists()).toBe(1)
    expect(pane.querySelector('.mrfw-rootSwitcher')).not.toBeNull()
    expect(header.querySelector('.mrfw-rootSwitcher')).not.toBeNull()
  })

  it('reconciles the selection when the folders manager closes', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()

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
    expect(pane.querySelector('.mrfw-ftBody')).toBeNull()
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform')
  })

  it('adopts the refreshed row when the manager renames the selected root', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('payments')

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: `${NS}.switcher.manage` }))
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })

    // The manager renamed the root: the row for the same id is still
    // available, but the captured selection must not keep the old alias —
    // closing re-lists and the switcher adopts the refreshed row.
    harness.setView({
      primaryRoot: '/repos/primary', primaryName: 'Platform',
      roots: [{ ...ROOT_A, alias: 'ledger' }, ROOT_B], limit: 16, count: 2,
    })
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.close` }))
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('ledger') })
    expect(switcherKind()).toBe('additional')
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()
  })

  it('keeps each pane bound to its own session when the global session changes', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })

    // The slot is session-scoped: an already mounted pane keeps its own
    // sessionId — a global session flip must neither re-list nor reset the
    // takeover, or session B's roots would render over session A's tree.
    act(() => { harness.setSession('session-2') })
    await waitFor(() => {
      expect(pane.querySelector('.mrfw-rootSwitcher')?.getAttribute('data-root-kind')).toBe('additional')
    })
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()
    expect(harness.calls.every(call => call.payload.sessionId === 'session-1')).toBe(true)

    // A new pane the framework mints for session-2 targets that registry.
    renderInPane(harness)
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

describe('the Files-tab switcher host-parity wiring', () => {
  /** A renderer stub that always draws the plugin's legacy fallback. */
  function factoryStub() {
    return vi.fn((_name: string, _input: object, options: { fallback: ReactElement }) => options.fallback)
  }

  /** Select the 'payments' additional root and wait for its rows to land. */
  async function selectPayments(pane: HTMLElement): Promise<void> {
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
  }

  it('forwards the occupant row menu into the host tree Factory with absolute targets', async () => {
    const getTriggerProps = vi.fn((_target: unknown) => ({ 'data-menu': 'row' }))
    const harness = mount(true)
    const factory = factoryStub()
    const { pane } = renderInPane(harness, {
      absolutePath: '/repos/primary',
      renderFactorySlot: factory,
      useContextMenu: () => ({ getTriggerProps }),
    }, false, true)
    await selectPayments(pane)
    const input = factory.mock.calls.at(-1)![1] as {
      rowTriggerProps?: (entry: { path: string }, kind: 'file' | 'directory') => unknown
    }
    expect(input.rowTriggerProps).toBeTypeOf('function')
    expect(input.rowTriggerProps!({ path: '/repos/payments/notes.md' }, 'file')).toEqual({ 'data-menu': 'row' })
    // Absolute paths are the whole point: the host contributions resolve them
    // through workspaceFiles.stat, which this plugin routes to the additional root.
    expect(getTriggerProps).toHaveBeenCalledWith({
      kind: 'file',
      value: { sessionId: 'session-1', path: '/repos/payments/notes.md' },
    })
    expect(getTriggerProps).toHaveBeenCalledWith({
      kind: 'directory',
      value: { sessionId: 'session-1', path: '/repos/payments/src' },
    })
  })

  it('leaves the row menu off a kind the host registers no contributions for', async () => {
    const getTriggerProps = vi.fn((_target: unknown) => ({ 'data-menu': 'row' }))
    const harness = mount(true, { contextMenus: { registeredKinds: { getSnapshot: () => ['file'] } } })
    const factory = factoryStub()
    const { pane } = renderInPane(harness, {
      absolutePath: '/repos/primary',
      renderFactorySlot: factory,
      useContextMenu: () => ({ getTriggerProps }),
    }, false, true)
    await selectPayments(pane)
    const input = factory.mock.calls.at(-1)![1] as {
      rowTriggerProps?: (entry: { path: string }, kind: 'file' | 'directory') => unknown
    }
    expect(input.rowTriggerProps!({ path: '/repos/payments/notes.md' }, 'file')).toEqual({ 'data-menu': 'row' })
    // An empty popup would be worse than the browser menu: directory has no
    // registered contribution on this host, so the row keeps its default.
    expect(input.rowTriggerProps!({ path: '/repos/payments/src' }, 'directory')).toBeUndefined()
  })

  it('degrades to no menu input when the occupant carries no menu hook', async () => {
    const harness = mount(true)
    const factory = factoryStub()
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factory }, false, true)
    await selectPayments(pane)
    const input = factory.mock.calls.at(-1)![1] as {
      rowTriggerProps?: unknown
      canOpen?: (entry: { path: string }) => boolean
    }
    expect('rowTriggerProps' in input).toBe(false)
    // A host without the viewer registry leaves every file openable — the
    // pre-registry native verdict, spelled through the provider's port.
    expect(input.canOpen?.({ path: '/repos/payments/notes.md' })).toBe(true)
  })

  it('hands the Factory the viewer registry verdict for absolute addresses', async () => {
    const harness = mount(true, {
      sidebarRightTabs: {
        candidates: (address: string) => address.endsWith('/notes.md') ? [{ id: 'documentPreview' }] : [],
        subscribe: () => () => {},
      },
    })
    const factory = factoryStub()
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factory }, false, true)
    await selectPayments(pane)
    const input = factory.mock.calls.at(-1)![1] as { canOpen?: (entry: { path: string }) => boolean }
    expect(input.canOpen).toBeTypeOf('function')
    expect(input.canOpen!({ path: '/repos/payments/notes.md' })).toBe(true)
    expect(input.canOpen!({ path: '/repos/payments/other.md' })).toBe(false)
  })
})


describe('the Files-tab search surface', () => {
  /** A renderer stub that always draws the plugin's legacy fallback. */
  function factoryStub() {
    return vi.fn((_name: string, _input: object, options: { fallback: ReactElement }) => options.fallback)
  }

  it('shows the search toggle and searches the selected root through the channel', async () => {
    const harness = mount(true, {}, { workspaceSearch: true })
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factoryStub() }, false, true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })

    const toggle = document.querySelector<HTMLElement>('[data-mrfw-files-search-toggle]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle!)
    const input = await screen.findByRole('searchbox')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    fireEvent.change(input, { target: { value: 'notes' } })
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'search'
        && (call.payload as { rootId?: string }).rootId === 'a'
        && (call.payload as { query?: string }).query === 'notes')).toBe(true)
    })
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-empty"]')).not.toBeNull() })
  })

  it('keeps the search toggle out on a host without the upstream search call', async () => {
    const harness = mount(true)
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factoryStub() }, false, true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    expect(document.querySelector('[data-mrfw-files-search-toggle]')).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('re-runs the active search when the header reload is clicked', async () => {
    const harness = mount(true, {}, { workspaceSearch: true })
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factoryStub() }, false, true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })

    fireEvent.click(document.querySelector<HTMLElement>('[data-mrfw-files-search-toggle]')!)
    const input = await screen.findByRole('searchbox')
    fireEvent.change(input, { target: { value: 'notes' } })
    const searchCalls = () => harness.calls.filter(call => call.endpoint === 'search')
    await waitFor(() => { expect(searchCalls().length).toBe(1) })

    // Search results replace the tree, so the face refresh alone is a no-op;
    // the header reload must re-run the same request for fresh matches.
    fireEvent.click(document.querySelector<HTMLElement>('.mrfw-switcherReload')!)
    await waitFor(() => { expect(searchCalls().length).toBe(2) })
    const last = searchCalls().at(-1)!
    expect(last.payload).toMatchObject({ rootId: 'a', query: 'notes' })
  })
})


describe('the Files-tab root switch search handoff', () => {
  /** A renderer stub that always draws the plugin's legacy fallback. */
  function factoryStub() {
    return vi.fn((_name: string, _input: object, options: { fallback: ReactElement }) => options.fallback)
  }

  /** Select one menu entry by its label. */
  async function selectRoot(name: string): Promise<void> {
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name }))
  }

  /** Open the pane's bar and type a query. */
  async function openBarAndSearch(query: string): Promise<void> {
    fireEvent.click(document.querySelector<HTMLElement>('[data-mrfw-files-search-toggle]')!)
    const input = await screen.findByRole('searchbox')
    fireEvent.change(input, { target: { value: query } })
  }

  it('never pairs the outgoing query with the incoming root id during a switch', async () => {
    const harness = mount(true, {}, { workspaceSearch: true })
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factoryStub() }, false, true)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await selectRoot('payments')
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    await openBarAndSearch('notes')
    await waitFor(() => { expect(searchCalls(harness)).toHaveLength(1) })
    expect(searchCalls(harness)[0]!.payload as SearchPayload).toMatchObject({ rootId: 'a', query: 'notes' })

    // A's answer is settled; hold any further request so a mismatched frame
    // cannot slip past as an immediate answer.
    const release = harness.holdSearch()
    try {
      await selectRoot('docs')
      // The click's act flushed effects: the unsynchronised shape would
      // already have sent A's query under C's root id here.
      expect(searchCalls(harness).some(call => (call.payload as SearchPayload).rootId === 'c')).toBe(false)
      await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/docs/inner.ts"]')).not.toBeNull() })
    } finally {
      release()
    }

    // C's own search surface opens on C's record and searches under C's id.
    await openBarAndSearch('guide')
    await waitFor(() => {
      expect(searchCalls(harness).some(call => (call.payload as SearchPayload).rootId === 'c'
        && (call.payload as SearchPayload).query === 'guide')).toBe(true)
    })
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-empty"]')).not.toBeNull() })
    const callsWithC = searchCalls(harness).length

    // Back to A: its query and its settled answer are still its own, and the
    // retained request identity means no replacement search runs.
    await selectRoot('payments')
    // The retained query draws its result body again (the tree is not listed
    // while a query is active), and the retained identity means no request.
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-empty"]')).not.toBeNull() })
    expect(searchCalls(harness)).toHaveLength(callsWithC)
  })

  it('keeps the outgoing root failure settled instead of clearing it into pending', async () => {
    const harness = mount(true, {}, { workspaceSearch: true })
    const { pane } = renderInPane(harness, { absolutePath: '/repos/primary', renderFactorySlot: factoryStub() }, false, true)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await selectRoot('payments')
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    harness.setSearchFailure('root-unavailable')
    await openBarAndSearch('notes')
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-failed"]')).not.toBeNull() })
    expect(searchCalls(harness)).toHaveLength(1)

    // Switching away must not re-request A's failed answer under another
    // root, and C's surface must never inherit A's failure.
    await selectRoot('docs')
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/docs/inner.ts"]')).not.toBeNull() })
    expect(document.querySelector('[data-files-row="search-failed"]')).toBeNull()
    expect(searchCalls(harness)).toHaveLength(1)

    // Back on A the failure is still settled and retryable — the failure view
    // survived the switch instead of becoming an unbounded pending spinner.
    await selectRoot('payments')
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-failed"]')).not.toBeNull() })
    harness.setSearchFailure(undefined)
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-retry]')!)
    await waitFor(() => { expect(searchCalls(harness)).toHaveLength(2) })
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-failed"]')).toBeNull() })
  })
})

describe('the narrow-header root name', () => {
  /** The observed resize callbacks, one per mounted switcher. */
  const observers: Array<() => void> = []
  /** Every observed element and the callback its observer registered. */
  const observed = new Map<Element, () => void>()
  /** The boxes the stubbed layout reports. */
  const layout = { switcherWidth: 400, openAnchorWidth: 0 }

  beforeEach(() => {
    observers.length = 0
    observed.clear()
    layout.switcherWidth = 400
    layout.openAnchorWidth = 0
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback) }
      observe(target: Element): void { observed.set(target, observers[observers.length - 1]!) }
      unobserve(): void {}
      disconnect(): void {}
    })
    // A deterministic stand-in for the offscreen canvas: 7px per code point.
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): { font: string; measureText: (text: string) => { width: number } } {
        return { font: '', measureText: text => ({ width: Array.from(text).length * 7 }) }
      }
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // Only the row and the open-in-app seat are measured; everything else
      // keeps the zero box jsdom gives it.
      const width = this.classList.contains('mrfw-rootSwitcher')
        ? layout.switcherWidth
        : this.classList.contains('mrfw-switcherOpen') ? layout.openAnchorWidth : 0
      return { left: 0, right: width, width, top: 0, bottom: 38, height: 38, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
  })

  afterEach(() => { vi.restoreAllMocks() })

  /** The label text the trigger currently renders. */
  const labelText = (): string | null => document.querySelector('.mrfw-rootSwitchLabel')?.textContent ?? null
  /** The tier the switcher reports. */
  const nameForm = (): string | null => document.querySelector('.mrfw-rootSwitcher')?.getAttribute('data-name-form') ?? null
  /** The trigger's full accessible name. */
  const accessibleName = (): string | null =>
    document.querySelector('.mrfw-rootSwitchBtn')?.getAttribute('aria-label') ?? null

  /** Play one header resize back to the component, as ResizeObserver would. */
  async function resize(width: number): Promise<void> {
    layout.switcherWidth = width
    await act(async () => { for (const callback of observers) callback() })
  }

  /**
   * Play one in-row control resize back to the component: only that element's
   * observer fires, exactly like a browser whose row width did not change.
   * @param element - the observed element that resized.
   */
  async function resizeElement(element: Element): Promise<void> {
    const callback = observed.get(element)
    expect(callback).toBeDefined()
    await act(async () => { callback?.() })
  }

  it('keeps the whole name, then both ends, then the head as the header narrows', async () => {
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'dsh-plugin-multi-root-workspace', roots: [], limit: 16, count: 0 })
    renderInPane(harness)
    await waitFor(() => { expect(labelText()).toBe('dsh-plugin-multi-root-workspace') })
    expect(nameForm()).toBe('full')

    await resize(210)
    await waitFor(() => { expect(nameForm()).toBe('middle') })
    const middle = labelText() ?? ''
    expect(middle).toContain('…')
    expect(middle.startsWith('dsh')).toBe(true)
    expect(middle.endsWith('workspace')).toBe(true)

    await resize(70)
    await waitFor(() => { expect(nameForm()).toBe('head') })
    expect(labelText()?.startsWith('dsh')).toBe(true)
    expect(labelText()?.endsWith('…')).toBe(true)

    // The accessible name is the root, never the truncated drawing.
    expect(accessibleName()).toBe('dsh-plugin-multi-root-workspace')
  })

  it('restores the whole name when a shorter root is selected', async () => {
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'dsh-plugin-multi-root-workspace', roots: [ROOT_A, ROOT_B], limit: 16, count: 2 })
    renderInPane(harness)
    await waitFor(() => { expect(labelText()).toBe('dsh-plugin-multi-root-workspace') })
    await resize(210)
    await waitFor(() => { expect(nameForm()).toBe('middle') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    await waitFor(() => { expect(labelText()).toBe('payments') })
    expect(nameForm()).toBe('full')
    expect(accessibleName()).toBe('payments')
  })

  it('keeps the whole name when the environment cannot measure text', async () => {
    // No offscreen canvas: the fallback measures the hidden probe, whose box is
    // zero in this DOM — nothing is known to be too wide, so nothing is cut.
    vi.unstubAllGlobals()
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'dsh-plugin-multi-root-workspace', roots: [], limit: 16, count: 0 })
    renderInPane(harness)
    await waitFor(() => { expect(labelText()).toBe('dsh-plugin-multi-root-workspace') })
    expect(nameForm()).toBe('full')
  })

  it('refits the name when the open-in-app control arrives after the catalog loads', async () => {
    // The fork draws nothing until its catalog resolves, then inserts the split
    // button into the row. The row itself does not resize, so the fit only hears
    // about the arrival through the seat's own resize observer.
    let releaseCatalog = (): void => {}
    const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === OPEN_IN_APP_APPS_ROUTE) {
        await catalog
        return new Response(JSON.stringify({ apps: ['finder', 'vscode'] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    const longRoot: RootView = {
      ordinal: 1, id: 'long', path: '/repos/dsh-plugin-multi-root-workspace-ssh',
      addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-write',
      alias: 'dsh-plugin-multi-root-workspace-ssh',
    }
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [longRoot], limit: 16, count: 1 })
    renderInPane(harness)
    await waitFor(() => { expect(labelText()).toBe('Platform') })
    await resize(220)

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'dsh-plugin-multi-root-workspace-ssh' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })

    // Catalog in flight: the seat is in the row at zero width and holds nothing.
    const seat = document.querySelector('.mrfw-switcherOpen')
    expect(seat).not.toBeNull()
    expect(seat?.children.length).toBe(0)
    const before = labelText() ?? ''
    expect(before).toContain('…')

    releaseCatalog()
    await waitFor(() => {
      expect(document.querySelector('[data-open-target="directory"]')).not.toBeNull()
    })
    // The control now occupies 43px of the row without the switcher resizing.
    layout.openAnchorWidth = 43
    await resizeElement(seat as HTMLElement)

    await waitFor(() => { expect(labelText()).not.toBe(before) })
    const after = labelText() ?? ''
    expect(after).toContain('…')
    expect(after.startsWith('dsh')).toBe(true)
    expect(after.length).toBeLessThan(before.length)
    expect(nameForm()).toBe('middle')
  })
})

describe('the Files-tab remote root switcher', () => {
  const TOKEN_A = 'a'.repeat(64)
  const TOKEN_B = 'b'.repeat(64)

  const remoteEndpoint = (over: Partial<RemoteEndpointView> = {}): RemoteEndpointView => ({
    environmentId: 'device', rootId: 'out', path: '/srv/root', platform: 'linux',
    displayName: 'Build Box',
    state: 'registered', actions: ['read'], transfers: [],
    capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    browseAuthorization: TOKEN_A,
    ...over,
  })

  const remoteView = (endpoints: readonly RemoteEndpointView[]): RemotesView => ({
    primaryRoot: '/repos/primary', mode: 'workspace-write',
    status: { state: 'ready' }, endpoints,
  })

  /** The remote tree's per-relativePath listings; a name may carry a literal backslash. */
  const listings: Record<string, { readonly name: string; readonly type: 'file' | 'directory' }[]> = {
    '': [
      { name: 'inner.ts', type: 'file' },
      { name: 'deep', type: 'directory' },
      { name: 'uni-名字.md', type: 'file' },
      { name: 'literal\\', type: 'directory' },
    ],
    'deep': [{ name: 'leaf.txt', type: 'file' }],
    'literal\\': [{ name: 'nested', type: 'directory' }, { name: 'leaf.md', type: 'file' }],
    'literal\\/nested': [{ name: 'bottom.txt', type: 'file' }],
  }

  const remoteStub = (over: Partial<RemoteStub> = {}): RemoteStub => ({
    view: remoteView([remoteEndpoint()]),
    list: ({ relativePath }) => ({ entries: listings[relativePath] ?? [], truncated: false }),
    wait: 'park',
    ...over,
  })

  const remoteRowPaths = (): string[] =>
    [...document.querySelectorAll('[data-files-path]')]
      .map(row => row.getAttribute('data-files-path') ?? '')
      .filter(path => path.startsWith('/mrfw'))

  /**
   * The menu toggle in the remote scenarios can race an async re-render
   * (discovery answers, an eviction): the dev-runtime event replay then
   * double-fires the click and the menu opens and immediately toggles shut.
   * Retry once after the churn settles — a jsdom/dev artifact, not a state
   * the component can produce on a real single click.
   */
  const openRemoteMenu = async (): Promise<void> => {
    const toggle = document.querySelector<HTMLElement>('.mrfw-rootSwitchBtn')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    try {
      await screen.findByText(`${NS}.switcher.manage`, undefined, { timeout: 400 })
    } catch {
      fireEvent.click(document.querySelector<HTMLElement>('.mrfw-rootSwitchBtn')!)
      await screen.findByText(`${NS}.switcher.manage`)
    }
  }

  it('offers remote rows in the menu, browses through remoteFiles.list only, and never touches local ports', async () => {
    const harness = mount(true, {}, { workspaceSearch: true, remotes: remoteStub() })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // Discovery alone never lists: no remoteFiles.list, no workspaceFiles
    // traffic toward the remote tree root.
    await openRemoteMenu()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' })).toBeTruthy()
    })
    expect(harness.remoteListCalls).toEqual([])
    expect(harness.treeCalls.filter(call => call.path.startsWith('/mrfw'))).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull()
      expect(pane.querySelector('[data-files-path="/mrfw/uni-名字.md"]')).not.toBeNull()
    })
    expect(switcherKind()).toBe('additional')
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('out · Build Box (device)')
    expect(harness.remoteListCalls).toEqual([{ relativePath: '', authorization: TOKEN_A }])
    // No pseudo watch: the remote provider has no `watch` port, so no
    // workspaceFiles.changes stream was ever opened for it.
    expect(harness.treeCalls.filter(call => call.kind === 'changes')).toEqual([])
    expect(harness.treeCalls.filter(call => call.path.startsWith('/mrfw'))).toEqual([])
    // No search seat, no open-in-app, and a file click opens nothing local.
    expect(document.querySelector('[data-mrfw-files-search-toggle]')).toBeNull()
    expect(document.querySelector('.mrfw-switcherOpen')).toBeNull()
    const opened = harness.opens.length
    fireEvent.click(screen.getByRole('button', { name: 'inner.ts' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(harness.opens.length).toBe(opened)
    // One parked authorization lease, not a filesystem watch.
    expect(harness.remoteWaitCalls).toEqual([{ authorization: TOKEN_A }])
  })

  it('labels a tokenless endpoint disabled and never selects it', async () => {
    const stub = remoteStub({ view: remoteView([
      remoteEndpoint(),
      remoteEndpoint({ rootId: 'stale', browseAuthorization: undefined, state: 'withheld' }),
    ]) })
    const harness = mount(true, {}, { remotes: stub })
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openRemoteMenu()
    const disabledRow = await screen.findByRole('button', {
      name: `stale · Build Box (device) · /srv/root · SSH · ${NS}.switcher.remoteDisabled`,
    })
    expect(disabledRow.getAttribute('disabled')).not.toBeNull()
    fireEvent.click(disabledRow)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform')
    expect(harness.remoteListCalls).toEqual([])
  })

  it('preserves literal backslash and unicode names in the RPC relative path', async () => {
    const harness = mount(true, {}, { remotes: remoteStub() })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/deep"]')).not.toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: 'deep' }))
    await waitFor(() => {
      expect(harness.remoteListCalls).toContainEqual({ relativePath: 'deep', authorization: TOKEN_A })
      expect(pane.querySelector('[data-files-path="/mrfw/deep/leaf.txt"]')).not.toBeNull()
    })
    // The directory name carries one literal backslash; the wire path must
    // carry it verbatim — never escaped, dropped, or folded.
    fireEvent.click(screen.getByRole('button', { name: 'literal\\' }))
    await waitFor(() => {
      expect(harness.remoteListCalls).toContainEqual({ relativePath: 'literal\\', authorization: TOKEN_A })
    })
    fireEvent.click(screen.getByRole('button', { name: 'nested' }))
    await waitFor(() => {
      expect(harness.remoteListCalls).toContainEqual({ relativePath: 'literal\\/nested', authorization: TOKEN_A })
      expect(remoteRowPaths()).toContain('/mrfw/literal\\/nested/bottom.txt')
    })
  })

  it('switches between primary, local and remote roots without mixing their trees', async () => {
    const harness = mount(true, {}, { remotes: remoteStub() })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    // Local additional root first, then remote: the local tree's provider
    // and bucket stay untouched by the remote selection.
    await openRemoteMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    const localTraffic = harness.treeCalls.length

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    expect(pane.querySelector('[data-files-path="/repos/payments/notes.md"]')).toBeNull()
    expect(harness.treeCalls.length).toBe(localTraffic)

    // Back to primary, then remote again: the remote bucket was retained
    // while visible (same grant, same provider key) and re-lists in place.
    await openRemoteMenu()
    fireEvent.click(screen.getByRole('button', { name: /primary/i }))
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    expect(remoteRowPaths()).toEqual([])

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
  })

  it('keeps two environments sharing one remote path in separate grants', async () => {
    const stub = remoteStub({ view: remoteView([
      remoteEndpoint(),
      remoteEndpoint({ environmentId: 'mirror', rootId: 'copy', displayName: 'Mirror', browseAuthorization: TOKEN_B }),
    ]) })
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'deep' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/deep/leaf.txt"]')).not.toBeNull() })

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'copy · Mirror (mirror) · /srv/root · SSH' }))
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('copy · Mirror (mirror)') })
    // A different environment's grant lists under its own token — the first
    // tree's expansion never bleeds into the second provider's bucket.
    await waitFor(() => {
      expect(harness.remoteListCalls).toContainEqual({ relativePath: '', authorization: TOKEN_B })
    })
    expect(harness.remoteListCalls).not.toContainEqual({ relativePath: 'deep', authorization: TOKEN_B })
    expect(harness.remoteWaitCalls).toContainEqual({ authorization: TOKEN_B })
  })

  it('drops the stale tree when the grant is re-minted, then browses under the new token', async () => {
    const stub = remoteStub()
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })

    // A re-grant mints a different browseAuthorization; the lease then
    // rejects with an authorization-class code — the takeover is
    // invalidated, the selection falls back to primary, never upgraded in
    // place, and the invalidated owner re-proves the remotes view.
    stub.view = remoteView([remoteEndpoint({ browseAuthorization: TOKEN_B })])
    stub.wait = { code: 'binding-changed' }
    act(() => { harness.releaseWaits() })
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    expect(remoteRowPaths()).toEqual([])

    // Re-selecting mounts a NEW provider under the new token: its bucket
    // cannot show the stale grant's expansion or rows.
    stub.wait = 'park'
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    expect(harness.remoteListCalls).toContainEqual({ relativePath: '', authorization: TOKEN_B })
    expect(harness.remoteWaitCalls).toContainEqual({ authorization: TOKEN_B })
  })

  it('drops the stale tree when a remotes.list refresh finds a re-minted token', async () => {
    const stub = remoteStub()
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })

    // No lease involved: the next remotes.list answer alone — a different
    // minted browseAuthorization — retires the record the moment the view
    // lands. No remote row may paint between the answer and the fallback.
    stub.view = remoteView([remoteEndpoint({ browseAuthorization: TOKEN_B })])
    await openRemoteMenu()
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    expect(remoteRowPaths()).toEqual([])
    // The replacement grant is never browsed under the old record: no list
    // call carries the new token until an explicit re-selection mints a new
    // provider under it.
    expect(harness.remoteListCalls.filter(call => call.authorization === TOKEN_B)).toEqual([])

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    expect(harness.remoteListCalls).toContainEqual({ relativePath: '', authorization: TOKEN_B })
  })

  it('ignores an invalidation callback from a superseded remote provider', async () => {
    // The root listing parks, so the remote provider is still open when the
    // selection moves to a local root; its late invalidation names the OLD
    // provider key and must not eject the newer local takeover or selection.
    let release: ((outcome: RemoteFilesListing | { readonly code: RemoteFilesFailureCode }) => void) | undefined
    const parked = new Promise<RemoteFilesListing | { readonly code: RemoteFilesFailureCode }>(resolve => { release = resolve })
    let first = true
    const stub = remoteStub({
      list: request => {
        if (first) { first = false; return parked }
        return { entries: listings[request.relativePath] ?? [], truncated: false }
      },
    })
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(harness.remoteListCalls).toContainEqual({ relativePath: '', authorization: TOKEN_A }) })

    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })

    // The superseded provider's late authorization-class failure resolves:
    // the keyed invalidate must be a no-op for the LIVE local takeover —
    // the selection and its rows stay exactly where the reader put them.
    release!({ code: 'root-identity-changed' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('payments')
    expect(pane.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull()
  })

  it('retires the remote tree when the authorization lease fails, and disables rows when the plane revokes tokens', async () => {
    const stub = remoteStub()
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    expect(harness.remoteWaitCalls).toEqual([{ authorization: TOKEN_A }])

    // The parked lease resolves unchanged; the NEXT lease fails with an
    // authorization-class code — the owner invalidates the takeover and
    // falls back to primary rather than drawing a stale tree.
    stub.wait = { code: 'root-identity-changed' }
    act(() => { harness.releaseWaits() })
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    expect(remoteRowPaths()).toEqual([])
    expect(harness.remoteWaitCalls.length).toBeGreaterThanOrEqual(2)

    // The settings-off shape: the remotes view stops minting tokens, so the
    // row degrades to a disabled entry and cannot grant a tree.
    stub.wait = 'park'
    stub.view = remoteView([remoteEndpoint({ browseAuthorization: undefined })])
    await openRemoteMenu()
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: `out · Build Box (device) · /srv/root · SSH · ${NS}.switcher.remoteDisabled`,
      })).toBeTruthy()
    })
    expect(harness.remoteListCalls.filter(call => call.authorization === TOKEN_A).length).toBe(1)
  })

  it('ends the remote takeover on hide and paints nothing cached on remount', async () => {
    const stub = remoteStub()
    const harness = mount(true, {}, { remotes: stub })
    const { pane, unmount } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    const waits = harness.remoteWaitCalls.length
    const lists = harness.remoteListCalls.length

    // Hiding ends the remote hold outright: the parked lease's caller
    // signal aborts and the bucket's rows are released — a hidden remote
    // tree runs no file I/O.
    unmount()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(harness.remoteWaitCalls.length).toBe(waits)

    // The remount restores the selection but draws nothing until the fresh
    // RemotesView re-mints the same authorization — no cached rows first.
    const header2 = document.createElement('div')
    pane.prepend(header2)
    render(harness.occupant({ absolutePath: '/repos/primary' }) as ReactElement, { container: header2 })
    expect(remoteRowPaths()).toEqual([])
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })
    expect(harness.remoteListCalls.length).toBeGreaterThan(lists)
    expect(harness.remoteWaitCalls.length).toBeGreaterThan(waits)
  })

  it('surfaces a listing failure in place and recovers on reload', async () => {
    let fail = false
    const stub = remoteStub({
      list: ({ relativePath }) => fail && relativePath === 'deep'
        ? { code: 'connection-lost' }
        : { entries: listings[relativePath] ?? [], truncated: false },
    })
    const harness = mount(true, {}, { remotes: stub })
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' }))
    await waitFor(() => { expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull() })

    // A transient outage on a child expansion reports the localized failure
    // row under that directory; the rest of the tree stays drawn.
    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'deep' }))
    await waitFor(() => {
      expect(pane.querySelector('[data-files-row="failed"]')).not.toBeNull()
    })
    expect(pane.querySelector('[data-files-path="/mrfw/inner.ts"]')).not.toBeNull()
    expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('out · Build Box (device)')

    fail = false
    const reload = document.querySelector<HTMLElement>('.mrfw-switcherReload')
    fireEvent.click(reload!)
    await waitFor(() => {
      expect(pane.querySelector('[data-files-path="/mrfw/deep/leaf.txt"]')).not.toBeNull()
    })
  })

  it('draws no remote rows while the remote plane is unavailable', async () => {
    const stub = remoteStub({ view: undefined })
    const harness = mount(true, {}, { remotes: stub })
    renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
    await openRemoteMenu()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'payments' })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: /SSH/ })).toBeNull()
    expect(harness.remoteListCalls).toEqual([])
  })
})
