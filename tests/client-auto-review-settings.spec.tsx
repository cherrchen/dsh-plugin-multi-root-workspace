// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_REVIEW_MODULE, installAutoReviewSettings, type AutoReviewForm, type AutoReviewSnapshot } from '../src/compat/auto-review-client.ts'
import { AutoReviewSettingsCard } from '../src/client/auto-review-settings.tsx'
import { BundleSettingsCard, installSkillsSettingsCard } from '../src/client/skills-settings.tsx'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'
const t: Translate = key => key
const cleanups: (() => void)[] = []
afterEach(() => { cleanup(); for (const stop of cleanups.splice(0).reverse()) stop() })

const ROW = { entryId: 'entry-auto-review', moduleName: AUTO_REVIEW_MODULE, enabled: false }

function remoteCtx(services: Record<string, unknown>) {
  const stops: (() => void)[] = []
  const ctx = {
    get: (name: string) => services[name],
    inject: (names: string[], callback: (ctx: unknown) => unknown) => {
      if (names.every(name => name in services)) {
        const stop = callback(ctx)
        if (typeof stop === 'function') stops.push(stop as () => void)
      }
    },
    effect: (setup: () => unknown) => { const stop = setup(); if (typeof stop === 'function') cleanups.push(stop as () => void) },
  }
  return { ctx, stops }
}

describe('auto-review settings form', () => {
  it('stays unavailable without the pluginManager namespace and attaches when it arrives', async () => {
    const pending: { names: string[]; callback: (ctx: unknown) => unknown }[] = []
    const services: Record<string, unknown> = {}
    const ctx = {
      get: (name: string) => services[name],
      inject: (names: string[], callback: (ctx: unknown) => unknown) => { pending.push({ names, callback }) },
    }
    const form = installAutoReviewSettings(ctx as never)
    expect(form.getSnapshot()).toEqual({ status: 'unavailable' })

    services['remote.pluginManager'] = {
      listPlugins: async () => ({ ok: true as const, value: [ROW] }),
      setPluginEnabled: async () => ({ ok: true as const, value: { application: 'applied' } }),
    }
    services.remote = { $on: () => () => {} }
    for (const { names, callback } of pending.splice(0)) {
      if (names.every(name => name in services)) {
        const stop = callback(ctx)
        if (typeof stop === 'function') cleanups.push(stop as () => void)
      }
    }
    await waitFor(() => expect(form.getSnapshot()).toMatchObject({ status: 'ready', row: { enabled: false } }))
  })

  it('reads the row state, writes through setPluginEnabled, and classifies the outcome', async () => {
    const writes: [string, boolean][] = []
    let application: string = 'applied'
    const services: Record<string, unknown> = {
      'remote.pluginManager': {
        listPlugins: async () => ({ ok: true as const, value: [ROW, { entryId: 'other', moduleName: 'other/pkg', enabled: true }] }),
        setPluginEnabled: async (id: string, enabled: boolean) => { writes.push([id, enabled]); return { ok: true as const, value: { application } } },
      },
      remote: { $on: (_event: string, _listener: () => void) => () => {} },
    }
    const { ctx } = remoteCtx(services)
    const form = installAutoReviewSettings(ctx as never)
    await waitFor(() => expect(form.getSnapshot()).toEqual({
      status: 'ready',
      row: { entryId: ROW.entryId, enabled: false, writable: true },
    }))
    expect(await form.setEnabled(true)).toBe('applied')
    expect(writes).toEqual([[ROW.entryId, true]])
    application = 'restart-required'
    expect(await form.setEnabled(false)).toBe('restart-required')
    application = 'overridden'
    expect(await form.setEnabled(true)).toBe('failed')
  })

  it('marks protected rows read-only and reports list failures', async () => {
    const services: Record<string, unknown> = {
      'remote.pluginManager': {
        listPlugins: async () => ({ ok: true as const, value: [{ ...ROW, readOnlyReason: 'management-required' }] }),
        setPluginEnabled: async () => ({ ok: false as const, error: { code: 'management-required' } }),
      },
      remote: { $on: () => () => {} },
    }
    const { ctx } = remoteCtx(services)
    const form = installAutoReviewSettings(ctx as never)
    await waitFor(() => expect(form.getSnapshot()).toEqual({
      status: 'ready',
      row: { entryId: ROW.entryId, enabled: false, writable: false },
    }))
    expect(await form.setEnabled(true)).toBe('failed')

    const failing = remoteCtx({
      'remote.pluginManager': { listPlugins: async () => ({ ok: false as const, error: { code: 'unknown' } }), setPluginEnabled: async () => ({ ok: true as const, value: {} }) },
      remote: { $on: () => () => {} },
    })
    const broken = installAutoReviewSettings(failing.ctx as never)
    await waitFor(() => expect(broken.getSnapshot()).toEqual({ status: 'error' }))
  })

  it('refreshes on plugin-manager/changed and detaches back to unavailable', async () => {
    let listener: (() => void) | undefined
    let enabled = false
    const services: Record<string, unknown> = {
      'remote.pluginManager': {
        listPlugins: async () => ({ ok: true as const, value: [{ ...ROW, enabled }] }),
        setPluginEnabled: async () => ({ ok: true as const, value: { application: 'applied' } }),
      },
      remote: { $on: (_event: string, fn: () => void) => { listener = fn; return () => {} } },
    }
    const { ctx, stops } = remoteCtx(services)
    const form = installAutoReviewSettings(ctx as never)
    await waitFor(() => expect(form.getSnapshot()).toMatchObject({ status: 'ready', row: { enabled: false } }))
    enabled = true
    listener?.()
    await waitFor(() => expect(form.getSnapshot()).toMatchObject({ row: { enabled: true } }))
    for (const stop of stops.splice(0)) stop()
    expect(form.getSnapshot()).toEqual({ status: 'unavailable' })
  })
})

describe('AutoReviewSettingsCard', () => {
  const formWith = (snapshot: AutoReviewSnapshot, setEnabled: AutoReviewForm['setEnabled'] = async () => 'applied') => ({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    setEnabled,
  })

  it('renders nothing while unavailable or when the row is absent', () => {
    const { container } = render(<AutoReviewSettingsCard form={formWith({ status: 'unavailable' })} t={t} />)
    expect(container.firstChild).toBeNull()
    const { container: absent } = render(<AutoReviewSettingsCard form={formWith({ status: 'ready' })} t={t} />)
    expect(absent.firstChild).toBeNull()
  })

  it('renders title, experimental tag, and an accessible off-by-default switch', () => {
    render(<AutoReviewSettingsCard form={formWith({
      status: 'ready',
      row: { entryId: ROW.entryId, enabled: false, writable: true },
    })} t={t} />)
    expect(screen.getByText('autoReview.title')).toBeTruthy()
    expect(screen.getByText('autoReview.experimental')).toBeTruthy()
    expect(screen.getByText('autoReview.hint')).toBeTruthy()
    const control = screen.getByRole('switch', { name: 'autoReview.title' })
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect((control as HTMLButtonElement).disabled).toBe(false)
  })

  it('writes enablement, shows restart notice, and surfaces failures', async () => {
    const results: ('restart-required' | 'failed')[] = ['restart-required', 'failed']
    const writes: boolean[] = []
    let snapshot: AutoReviewSnapshot = { status: 'ready', row: { entryId: 'e', enabled: true, writable: true } }
    const form: AutoReviewForm = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      setEnabled: async next => {
        writes.push(next)
        snapshot = { status: 'ready', row: { entryId: 'e', enabled: next, writable: true } }
        return results.shift() ?? 'applied'
      },
    }
    render(<AutoReviewSettingsCard form={form} t={t} />)
    fireEvent.click(screen.getByRole('switch', { name: 'autoReview.title' }))
    await waitFor(() => expect(screen.getByText('autoReview.restartRequired')).toBeTruthy())
    expect(writes).toEqual([false])
    fireEvent.click(screen.getByRole('switch', { name: 'autoReview.title' }))
    await waitFor(() => expect(screen.getByText('autoReview.settingsFailed')).toBeTruthy())
    expect(writes).toEqual([false, true])
  })

  it('keeps the switch disabled for read-only rows, loading, and error states', async () => {
    for (const snapshot of [
      { status: 'ready' as const, row: { entryId: 'e', enabled: true, writable: false } },
      { status: 'loading' as const },
      { status: 'error' as const },
    ]) {
      const { unmount } = render(<AutoReviewSettingsCard form={formWith(snapshot)} t={t} />)
      expect((screen.getByRole('switch', { name: 'autoReview.title' }) as HTMLButtonElement).disabled).toBe(true)
      unmount()
    }
    render(<AutoReviewSettingsCard form={formWith({ status: 'error' })} t={t} />)
    await waitFor(() => expect(screen.getByText('autoReview.loadFailed')).toBeTruthy())
  })

  it('reports the entry diagnostic through a toast', async () => {
    render(<AutoReviewSettingsCard form={formWith({
      status: 'ready',
      row: { entryId: 'e', enabled: true, writable: true, diagnostic: 'release mismatch' },
    })} t={t} />)
    await waitFor(() => expect(screen.getByText('release mismatch')).toBeTruthy())
  })
})

describe('BundleSettingsCard composition', () => {
  it('renders the skills row above the auto-review row in one cell', async () => {
    const skillsSnapshot = { value: { enabled: true }, status: 'ready', writable: true }
    const skillsForm = { getSnapshot: () => skillsSnapshot, subscribe: () => () => {}, mutate: async () => true }
    const autoSnapshot: AutoReviewSnapshot = { status: 'ready', row: { entryId: 'e', enabled: false, writable: true } }
    const autoForm: AutoReviewForm = {
      getSnapshot: () => autoSnapshot,
      subscribe: () => () => {},
      setEnabled: async () => 'applied',
    }
    render(<BundleSettingsCard form={skillsForm} autoReviewForm={autoForm} t={t} />)
    const titles = screen.getAllByText(/skills\.globalEnable|autoReview\.title/).map(node => node.textContent)
    expect(titles).toEqual(['skills.globalEnable', 'autoReview.title'])
  })

  it('registers the bundle card for auto-review alone and drops it when the namespace leaves', async () => {
    interface Registration { options: { name: string; key: string; inject: () => Record<string, unknown> }; component: unknown }
    const registrations: Registration[] = []
    const services: Record<string, unknown> = {
      'remote.pluginManager': {
        listPlugins: async () => ({ ok: true as const, value: [ROW] }),
        setPluginEnabled: async () => ({ ok: true as const, value: { application: 'applied' } }),
      },
      remote: { $on: () => () => {} },
    }
    const { ctx, stops } = remoteCtx(services)
    const mutable = ctx as { slots?: unknown }
    let disposed = 0
    mutable.slots = {
      inject: (name: string, callback: () => unknown) => { if (name === 'plugins.bundle.config') callback(); return () => { disposed++ } },
      register: (options: Registration['options'], component: unknown) => { registrations.push({ options, component }); return () => {} },
    }
    installSkillsSettingsCard(ctx as never, t)
    await waitFor(() => expect(registrations).toHaveLength(1))
    expect(registrations[0]!.options.name).toBe('plugins.bundle.config')
    expect(registrations[0]!.options.key).toBe('@dsh-electron/dsh-plugin-multi-root-workspace')
    const props = registrations[0]!.options.inject()
    expect(props.autoReviewForm).toBeDefined()
    expect(props.form).toBeUndefined()
    for (const stop of stops.splice(0)) stop()
    // The namespace leaving unregisters the card contribution.
    expect(disposed).toBe(1)
    expect(registrations).toHaveLength(1)
  })
})
