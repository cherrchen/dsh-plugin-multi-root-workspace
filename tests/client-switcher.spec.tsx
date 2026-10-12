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

import { useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import type { StoreInstance } from '@deepseek-ai/dsh-client-store'
import { PANEL_CHANNEL, type PanelRequest, type RootView, type RootsView } from '../src/contract.ts'
import type { FilesState } from '../src/client/files-tree/store.ts'
import * as client from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

/** One captured channel call. */
interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: PanelRequest
}

/** One captured workspaceFiles call (the forked tree's remote traffic). */
interface TreeCall {
  readonly kind: 'list' | 'changes'
  readonly sessionId: string
  readonly path: string
}

/** One captured sidebarRight.openResourceIn call. */
interface OpenCall {
  readonly sessionId: string
  readonly address: string
}

/** The frame a stub watch queue hands the verbatim `createWatch` loop. */
type WatchFrame = { readonly kind: 'ready' } | { readonly kind: 'change' }

/** A parked per-directory watch the spec can feed frames into. */
interface WatchControl {
  push: (frame: WatchFrame) => void
  stop: () => void
}

/**
 * The `workspaceFiles.changes` stub's product: yields `ready` once, then
 * whatever `push` feeds it, until `stop` parks it for good. The iterable
 * carries `stop` so the `$stream` stub's `dispose` can wake a parked reader.
 */
function watchStub(control: WatchControl): AsyncIterable<WatchFrame> & { stop(): void } {
  const queue: WatchFrame[] = [{ kind: 'ready' }]
  let wake: (() => void) | undefined
  let stopped = false
  control.push = frame => { queue.push(frame); wake?.() }
  control.stop = () => { stopped = true; wake?.() }
  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        while (!stopped) {
          while (queue.length > 0) yield queue.shift()!
          if (!stopped) await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
        }
      } finally { stopped = true }
    },
    stop: () => { control.stop() },
  }
}

/**
 * The `$stream` supervisor's stand-in: iterates `open`'s frames once,
 * wrapping each as `{ value, accept }`. There is no reconnect supervision —
 * a stubbed stream that ends simply ends.
 */
function streamStub(options: { name: string; open: (signal: AbortSignal) => AsyncIterable<WatchFrame>; ended: (accepted: boolean) => Error }) {
  const inner = options.open(new AbortController().signal) as AsyncIterable<WatchFrame> & { stop?: () => void }
  const iterator = inner[Symbol.asyncIterator]()
  let disposed = false
  const finish = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    inner.stop?.()
    await iterator.return?.()
  }
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        try {
          while (true) {
            const next = await iterator.next()
            if (next.done) return
            yield { value: next.value, accept(): void {} }
          }
        } finally { await finish() }
      })()
    },
    dispose: finish,
  }
}

/** One slot registration the plugin made. */
interface Registration {
  readonly options: {
    name: string
    id?: string
    order?: number
    locale?: string
    store?: { create(scopeKey?: string): StoreInstance<FilesState, never> }
    inject?: (sessionId: unknown, actions: unknown) => Record<string, unknown>
  }
  readonly component: (props?: unknown) => unknown
}

const ROOT_A: RootView = { ordinal: 1, id: 'a', path: '/repos/payments', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-write', alias: 'payments' }
const ROOT_B: RootView = { ordinal: 2, id: 'b', path: '/repos/website', addedAt: '2026-09-12T00:00:00.000Z', state: 'missing', access: 'read-only', detail: 'gone' }

/** The stub client context, plus what the plugin did with it. */
interface Harness {
  readonly calls: Call[]
  /** The forked tree's `workspaceFiles` traffic: `changes` opens, then `list`s. */
  readonly treeCalls: TreeCall[]
  /** Addresses the fork asked `sidebarRight.openResourceIn` to open. */
  readonly opens: OpenCall[]
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
  const treeCalls: TreeCall[] = []
  const opens: OpenCall[] = []
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
        return { ok: true, value: view }
      },
    },
  }
  const remote = {
    workspaceFiles: {
      list: async (sessionId: string, path: string) => {
        treeCalls.push({ kind: 'list', sessionId, path })
        return {
          ok: true,
          value: {
            path,
            truncated: false,
            entries: path === '/repos/payments'
              ? [{ name: 'src', type: 'directory' }, { name: 'notes.md', type: 'file' }]
              : [{ name: 'inner.ts', type: 'file' }],
          },
        }
      },
      changes: (sessionId: string, path: string) => {
        treeCalls.push({ kind: 'changes', sessionId, path })
        return watchStub({ push: () => {}, stop: () => {} })
      },
    },
    $stream: streamStub,
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
      register: (options: Registration['options'], component: (props?: unknown) => unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'connection') return withConnection ? connection : undefined
      if (name === 'remote') return remote
      // `remote.workspaceFiles` is a nested service — lazyFilesRemote reads it
      // through the inject-free `ctx.get`, so the stub serves it by name.
      if (name === 'remote.workspaceFiles') return remote.workspaceFiles
      if (name === 'sidebarRight') {
        return { openResourceIn: (sessionId: string, address: string) => { opens.push({ sessionId, address }) } }
      }
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
  // What the slot framework synthesizes for a session-scoped registration
  // that declares a store and an inject factory: one minted instance, its
  // baked actions, the `useStore` hook bound to its snapshot source, and the
  // factory's face spread onto the composed props.
  const instance = registration.options.store?.create('session-1')
  const useStore = <S,>(selector: (state: FilesState) => S): S => useSyncExternalStore(
    notify => instance!.subscribe(notify),
    () => selector(instance!.getSnapshot()),
  )
  return {
    calls,
    treeCalls,
    opens,
    registrations,
    occupant: owner => registration.component({
      sessionId: currentSession,
      useStore,
      actions: instance?.actions,
      ...registration.options.inject?.(currentSession, instance?.actions),
      ...owner,
    }),
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
 * Render the occupant inside a header that mirrors the upstream Files pane,
 * itself inside a dockkit tab host. The returned `pane` is where the forked
 * tree must portal into.
 */
function renderInPane(harness: Harness, owner = { absolutePath: '/repos/primary' }): { pane: HTMLElement } {
  const host = document.createElement('section')
  host.setAttribute('data-dockkit-content', 'tab-1')
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
  host.append(pane)
  document.body.append(host)
  appended.push(host)
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

  it('returns to the primary root when a refresh cannot revalidate the selection', async () => {
    const harness = mount()
    const { pane } = renderInPane(harness)
    await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'payments' }))
    await waitFor(() => { expect(switcherKind()).toBe('additional') })
    expect(pane.querySelector('.mrfw-ftBody')).not.toBeNull()

    // The next refresh cannot revalidate the roots at all: the takeover must
    // not keep the native primary tree hidden behind a stale selection.
    harness.setListFails(true)
    await openMenu()
    await waitFor(() => { expect(switcherKind()).toBe('primary') })
    expect(pane.querySelector('.mrfw-ftBody')).toBeNull()
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
