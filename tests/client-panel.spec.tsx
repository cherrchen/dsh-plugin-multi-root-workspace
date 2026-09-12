// @vitest-environment jsdom
/**
 * The panel, driven the way the browser drives it: the real client entry is
 * applied to a stub client context, the registered component is rendered, and
 * every action is observed through the stub Connection channel.
 *
 * The stub is deliberate — the panel's contract IS the channel, and asserting
 * the exact (channel, endpoint, payload) triples is what keeps the browser half
 * and the host half from drifting apart. The host side of each endpoint is
 * covered by `tests/command.spec.ts` and by the behavior smoke.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_CHANNEL, type PanelRequest, type RevealedView, type RootView, type RootsView } from '../src/contract.ts'
import * as client from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

// The jsdom environment has no file-URL `import.meta.url`, so the repository
// root comes from the runner's working directory (vitest runs at the root).
const REPO_ROOT = process.cwd()

/** One captured channel call. */
interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: PanelRequest
}

/** One slot registration the plugin made. */
interface Registration {
  readonly options: { name: string; id?: string; order?: number; label?: unknown; locale?: string }
  readonly component: () => unknown
}

/** The stub client context, plus what the plugin did with it. */
interface Harness {
  readonly ctx: unknown
  readonly calls: Call[]
  readonly registrations: Registration[]
  readonly dictionaries: { ns: string; dicts: Record<string, unknown> }[]
  setView: (view: RootsView) => void
  setFailure: (failure: { code: string; message: string } | undefined) => void
  /** What the next `reveal` answers (the real host answers a `RevealedView`). */
  setRevealed: (value: unknown) => void
}

const ROOT_A: RootView = { id: 'a', path: '/repos/payments', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', alias: 'payments' }
const ROOT_B: RootView = { id: 'b', path: '/repos/website', addedAt: '2026-09-12T00:00:00.000Z', state: 'missing', detail: 'gone' }
const ROOT_C: RootView = {
  id: 'c',
  path: '/repos/swapped',
  addedAt: '2026-09-12T00:00:00.000Z',
  state: 'redirected',
  detail: 'the path now resolves to "/repos/other"',
}

/** Apply the real client entry to a recording stub context. */
function mount(): Harness {
  const calls: Call[] = []
  const registrations: Registration[] = []
  const dictionaries: { ns: string; dicts: Record<string, unknown> }[] = []
  let view: RootsView = { primaryRoot: '/repos/primary', roots: [ROOT_A, ROOT_B] }
  let failure: { code: string; message: string } | undefined
  let revealed: unknown = { revealed: '/repos/payments' } satisfies RevealedView
  const picked: string | null = '/repos/picked'

  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: PanelRequest) => {
        calls.push({ channel, endpoint, payload })
        if (failure !== undefined) return { ok: false, error: failure }
        // One shape per endpoint, exactly as the host sends them: `reveal`
        // answers with the revealed path, everything else with the whole view.
        // Answering a list for every endpoint is what used to hide the mismatch.
        return { ok: true, value: endpoint === 'reveal' ? revealed : view }
      },
    },
  }
  const ctx = {
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (ns: string, dicts: Record<string, unknown>) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      // The real service resolves the live locale per call; for the spec the
      // namespace-qualified key is enough to observe which copy is used.
      bind: (ns: string) => (key: string) => `${ns}.${key}`,
    },
    slots: {
      inject: (name: string, callback: () => unknown) => {
        expect(name).toBe('sidebar.footer.action')
        callback()
        return () => {}
      },
      register: (options: Registration['options'], component: () => unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'connection') return connection
      if (name === 'uiWorkspace') return { pickDirectory: async () => picked }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ current: 'session-1' }) } }
      return undefined
    },
  }
  client.apply(ctx as never)
  return {
    ctx,
    calls,
    registrations,
    dictionaries,
    setView: next => { view = next },
    setFailure: next => { failure = next },
    setRevealed: next => { revealed = next },
  }
}

/**
 * Render the component the plugin registered. The registered value is a
 * component function, so it is wrapped in an element: React does not accept a
 * bare function as a child.
 * @param harness - the mounted harness whose registration to render.
 */
function renderPanel(harness: Harness): void {
  render(createElement(harness.registrations[0]!.component as never))
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
})

afterEach(() => {
  // Vitest runs without globals, so the auto-cleanup hook is never installed.
  cleanup()
  vi.restoreAllMocks()
})

describe('the client entry', () => {
  it('declares the services it needs', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers its dictionaries for both languages under its own namespace', () => {
    const harness = mount()
    expect(NS).toBe('multiRootWorkspace')
    expect(harness.dictionaries[0]?.ns).toBe(NS)
    expect(Object.keys(harness.dictionaries[0]?.dicts ?? {}).sort()).toEqual(['en', 'zh'])
  })

  it('registers into the sidebar footer action with a localized label thunk', () => {
    const harness = mount()
    const registration = harness.registrations[0]
    expect(registration?.options.name).toBe('sidebar.footer.action')
    expect(registration?.options.id).toBe(client.SLOT_ID)
    expect(registration?.options.order).toBe(50)
    expect(registration?.options.locale).toBe(NS)
    const label = registration?.options.label
    expect(typeof label).toBe('function')
    expect((label as () => string)()).toBe(`${NS}.action.label`)
  })

  it('registers nothing when no sidebar declares the slot', () => {
    const ctx = {
      effect: () => () => {},
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots: { inject: () => () => {}, register: () => () => {} },
      get: () => undefined,
    }
    expect(() => { client.apply(ctx as never) }).not.toThrow()
  })
})

describe('the panel dialog', () => {
  it('reads the roots view for the current session and lists both roots', async () => {
    const harness = mount()
    renderPanel(harness)

    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))

    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })
    expect(harness.calls[0]).toEqual({ channel: PANEL_CHANNEL, endpoint: 'list', payload: { sessionId: 'session-1' } })
    expect(screen.getByText('/repos/primary')).toBeTruthy()
    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.getByText(`${NS}.state.missing`)).toBeTruthy()
  })

  it('removes, reorders, and re-aliases a root through the channel', async () => {
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.moveDown` })[0]!)
    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'move')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'move')?.payload).toEqual({ sessionId: 'session-1', id: 'a' })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.alias` })[0]!)
    const input = screen.getByPlaceholderText(`${NS}.panel.aliasPlaceholder`)
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.aliasSave` }))
    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'alias')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'alias')?.payload).toEqual({
      sessionId: 'session-1',
      id: 'a',
      alias: 'renamed',
    })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.remove` })[0]!)
    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'remove')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'remove')?.payload).toEqual({ sessionId: 'session-1', id: 'a' })
  })

  it('adds through the composed picker, then through the manual path field', async () => {
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.add` }))
    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'add')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'add')?.payload).toEqual({
      sessionId: 'session-1',
      path: '/repos/picked',
    })

    const manual = screen.getByPlaceholderText(`${NS}.panel.addManual`)
    fireEvent.change(manual, { target: { value: '/repos/typed' } })
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.addConfirm` }))
    await waitFor(() => { expect(harness.calls.filter(call => call.endpoint === 'add')).toHaveLength(2) })
    // The confirm button submits the TYPED path. It used to submit whatever the
    // picker had returned, because both entry points shared one function.
    expect(harness.calls.filter(call => call.endpoint === 'add')[1]?.payload).toEqual({
      sessionId: 'session-1',
      path: '/repos/typed',
    })
    expect(screen.getByPlaceholderText(`${NS}.panel.addManual`)).toHaveProperty('value', '')
  })

  it('keeps a rejected manual path in the field', async () => {
    const harness = mount()
    harness.setFailure({ code: 'missing', message: 'host prose' })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(`${NS}.error.missing`) })

    const manual = screen.getByPlaceholderText(`${NS}.panel.addManual`)
    fireEvent.change(manual, { target: { value: '/repos/typo' } })
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.addConfirm` }))

    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'add')).toBe(true) })
    expect(screen.getByPlaceholderText(`${NS}.panel.addManual`)).toHaveProperty('value', '/repos/typo')
  })

  it('submits the typed path from the Enter key too', async () => {
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    const manual = screen.getByPlaceholderText(`${NS}.panel.addManual`)
    fireEvent.change(manual, { target: { value: '/repos/entered' } })
    fireEvent.keyDown(manual, { key: 'Enter' })

    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'add')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'add')?.payload).toEqual({
      sessionId: 'session-1',
      path: '/repos/entered',
    })
  })

  it('leaves the manual field alone when the operator opens the picker', async () => {
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.change(screen.getByPlaceholderText(`${NS}.panel.addManual`), { target: { value: '/repos/typed' } })
    fireEvent.click(screen.getByRole('button', { name: `${NS}.panel.add` }))

    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'add')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'add')?.payload).toEqual({
      sessionId: 'session-1',
      path: '/repos/picked',
    })
    // The picker path and the typed path are two different actions; the typed
    // text is neither submitted nor cleared by the picker.
    expect(screen.getByPlaceholderText(`${NS}.panel.addManual`)).toHaveProperty('value', '/repos/typed')
  })

  it('reveals and copies a path from the row actions', async () => {
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.reveal` })[0]!)
    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'reveal')).toBe(true) })
    expect(harness.calls.find(call => call.endpoint === 'reveal')?.payload).toEqual({ sessionId: 'session-1', id: 'a' })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.copyPath` })[0]!)
    await waitFor(() => { expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/repos/payments') })
    await waitFor(() => { expect(screen.getByText(`${NS}.panel.copied`)).toBeTruthy() })
  })

  it('does not report an error when a reveal succeeds', async () => {
    // The host answers `{ revealed }` for this endpoint. Parsing that as a roots
    // view is what made every successful reveal paint a failure.
    const harness = mount()
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.reveal` })[0]!)

    await waitFor(() => { expect(harness.calls.some(call => call.endpoint === 'reveal')).toBe(true) })
    // No failure is painted, and the list survives a reveal untouched.
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(screen.getByText('/repos/payments')).toBeTruthy()
    expect(harness.calls.filter(call => call.endpoint === 'list')).toHaveLength(1)
  })

  it('reports a reveal whose answer is not a reveal result', async () => {
    const harness = mount()
    harness.setRevealed({ primaryRoot: '/repos/primary', roots: [] })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByText('/repos/payments')).toBeTruthy() })

    fireEvent.click(screen.getAllByRole('button', { name: `${NS}.panel.reveal` })[0]!)

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(`${NS}.error.fallback`) })
  })

  it('renders a redirected root as its own state', async () => {
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', roots: [ROOT_C] })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))

    await waitFor(() => { expect(screen.getByText(`${NS}.state.redirected`)).toBeTruthy() })
  })

  it('localizes a failure by its code instead of showing host prose', async () => {
    const harness = mount()
    harness.setFailure({ code: 'nested', message: 'host prose the panel must not show' })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(`${NS}.error.nested`) })
    expect(screen.queryByText(/host prose/)).toBeNull()
  })

  it('falls back to the generic message for a code this build does not know', async () => {
    const harness = mount()
    harness.setFailure({ code: 'brand/new-code', message: 'unexpected' })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(`${NS}.error.fallback`) })
  })

  it('shows the store failure the host reported', async () => {
    const harness = mount()
    harness.setView({ primaryRoot: '/repos/primary', roots: [], unavailable: 'multi_root_workspace: file is not valid JSON' })
    renderPanel(harness)
    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))

    await waitFor(() => {
      expect(screen.getByText(/file is not valid JSON/)).toBeTruthy()
    })
  })

  it('renders a working entry without any panel client (no Connection in this surface)', async () => {
    const registrations: Registration[] = []
    const ctx = {
      effect: (callback: () => unknown) => { callback(); return () => {} },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: Registration['options'], component: () => unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      get: () => undefined,
    }
    client.apply(ctx as never)
    render(createElement(registrations[0]!.component as never))

    fireEvent.click(screen.getByRole('button', { name: /action.label/ }))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
  })
})

describe('the panel copy', () => {
  it('keeps the shipped Chinese copy in the source of truth for the bundle', () => {
    // The dictionaries live in the host-visible source tree so both the spec and
    // the bundle read one definition.
    const source = readFileSync(join(REPO_ROOT, 'src/client/locales.ts'), 'utf8')
    expect(source).toContain(zh['panel.title'])
    expect(source).toContain(en['panel.title'])
    expect(Object.keys(zh).length).toBeGreaterThan(20)
  })
})
