// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BundleSettingsCard, installSkillsSettingsCard, RemoteSwitchRow } from '../src/client/skills-settings.tsx'
import * as Confirmation from '../src/compat/ops-confirmation.ts'
import { zh, en } from '../src/client/locales.ts'
import { OpsCompatibilitySettingsCard } from '../src/client/ops-settings.tsx'
import { bindSettingsForm, bindSkillsForm, type SkillsForm } from '../src/compat/skills-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'
const t: Translate = key => key
const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanup(); for (const stop of cleanups.splice(0).reverse()) stop() })

function opsForm(snapshot: { value?: { enabled?: boolean }; status: string; writable: boolean; revision?: number }, calls: unknown[] = []): SkillsForm & { listeners: (() => void)[] } {
  const listeners: (() => void)[] = []
  return {
    listeners,
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.push(listener); return () => {} },
    mutate: async (...args: unknown[]) => { calls.push(args); return true },
  } as never
}

describe('OPS compatibility settings card', () => {
  it('keeps the setting off until the warning is acknowledged and confirmed', async () => {
    const writes: unknown[] = []
    const form = opsForm({ value: { enabled: false }, status: 'ready', writable: true, revision: 3 }, writes)
    render(<OpsCompatibilitySettingsCard form={form} t={t} />)
    expect(screen.getByText('ops.experimental').getAttribute('data-tone')).toBe('info')
    const toggle = screen.getByRole('switch', { name: 'ops.compatibilityEnable' })
    expect(toggle.getAttribute('aria-checked')).not.toBe('true')
    fireEvent.click(toggle)
    expect(screen.getByRole('dialog', { name: 'ops.confirmTitle' })).not.toBeNull()
    expect(screen.getByText('ops.confirmDescription')).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(writes).toEqual([])
    const confirm = screen.getByRole('button', { name: 'ops.confirmEnable' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: 'ops.confirmAcknowledge' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['enabled'], value: true }], 3]]))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([{ status: 'loading', writable: true }, { status: 'ready', writable: false }])('disables the switch while unavailable', async (state) => {
    const form = opsForm({ value: { enabled: false }, status: state.status, writable: state.writable })
    render(<OpsCompatibilitySettingsCard form={form} t={t} />)
    expect((screen.getByRole('switch', { name: 'ops.compatibilityEnable' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides OPS when the host exposes no editable OPS namespace', () => {
    const form = opsForm({ status: 'unavailable', writable: true })
    render(<OpsCompatibilitySettingsCard form={form} t={t} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('ops.experimental')).toBeNull()
  })

  it('shows the OPS error when the write fails or throws', async () => {
    for (const outcome of [false, new Error('denied')]) {
      cleanup()
      const form = opsForm({ value: { enabled: false }, status: 'ready', writable: true })
      const impl = outcome instanceof Error ? async () => { throw outcome } : async () => false
      form.mutate = impl as never
      render(<OpsCompatibilitySettingsCard form={form} t={t} />)
      fireEvent.click(screen.getByRole('switch', { name: 'ops.compatibilityEnable' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'ops.confirmAcknowledge' }))
      fireEvent.click(screen.getByRole('button', { name: 'ops.confirmEnable' }))
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('ops.settingsFailed'))
    }
  })

  it.each(['cancel', 'close', 'escape', 'mask'])('keeps disabled without writing when dismissed by %s', method => {
    const writes: unknown[] = []
    render(<OpsCompatibilitySettingsCard form={opsForm({ value: { enabled: false }, status: 'ready', writable: true }, writes)} t={t} />)
    const toggle = screen.getByRole('switch', { name: 'ops.compatibilityEnable' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'ops.confirmAcknowledge' }))
    if (method === 'escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    else if (method === 'mask') fireEvent.click(screen.getByTestId('risk-confirmation-mask'))
    else fireEvent.click(screen.getByRole('button', { name: method === 'cancel' ? 'ops.confirmCancel' : 'ops.confirmClose' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(writes).toEqual([])
    fireEvent.click(toggle)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('turns an enabled setting off immediately without a confirmation', async () => {
    const writes: unknown[] = []
    render(<OpsCompatibilitySettingsCard form={opsForm({ value: { enabled: true }, status: 'ready', writable: true, revision: 4 }, writes)} t={t} />)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['enabled'], value: false }], 4]]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks enabling when the host cannot provide its warning dialog', () => {
    vi.spyOn(Confirmation, 'opsRiskConfirmation').mockReturnValue(undefined)
    const writes: unknown[] = []
    render(<OpsCompatibilitySettingsCard form={opsForm({ value: { enabled: false }, status: 'ready', writable: true }, writes)} t={t} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(writes).toEqual([])
  })

  it.each(['revision', 'unavailable', 'read-only', 'enabled', 'form'])('discards a pending confirmation when %s changes', change => {
    const writes: unknown[] = []
    let snapshot = { value: { enabled: false }, status: 'ready', writable: true, revision: 1 }
    const listeners: (() => void)[] = []
    const form = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.push(listener); return () => {} }, mutate: async (...args: unknown[]) => { writes.push(args); return true } }
    const { rerender } = render(<OpsCompatibilitySettingsCard form={form} t={t} />)
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('checkbox'))
    if (change === 'form') rerender(<OpsCompatibilitySettingsCard form={{ ...form }} t={t} />)
    else {
      snapshot = { ...snapshot, ...(change === 'revision' ? { revision: 2 } : change === 'unavailable' ? { status: 'unavailable' } : change === 'read-only' ? { writable: false } : { value: { enabled: true } }) }
      act(() => { for (const listener of listeners) listener() })
    }
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes).toEqual([])
  })

  it.each([zh, en])('displays the translated warning and acknowledgement', copy => {
    render(<OpsCompatibilitySettingsCard form={opsForm({ value: { enabled: false }, status: 'ready', writable: true })} t={key => copy[key as keyof typeof copy]} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByText(copy['ops.confirmDescription'])).not.toBeNull()
    expect(screen.getByRole('checkbox', { name: copy['ops.confirmAcknowledge'] })).not.toBeNull()
  })

  it('re-renders on snapshot updates', async () => {
    let snapshot: { value?: { enabled?: boolean }; status: string; writable: boolean; revision?: number } = { value: { enabled: false }, status: 'ready', writable: true, revision: 1 }
    const listeners: (() => void)[] = []
    const form = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.push(listener); return () => {} }, mutate: async () => true }
    render(<OpsCompatibilitySettingsCard form={form} t={t} />)
    snapshot = { value: { enabled: true }, status: 'ready', writable: true, revision: 2 }
    act(() => { for (const listener of listeners) listener() })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'ops.compatibilityEnable' }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('bundle settings coordinator', () => {
  it.each([true, false])('keeps the legacy card Skills-only and adds OPS on modern forms (modern=%s)', (modern) => {
    const selected: string[] = []
    const registrations: { name: string; key: string; component: unknown }[] = []
    const skillsForm = opsForm({ value: { enabled: true }, status: 'ready', writable: true })
    const ops = opsForm({ value: { enabled: false }, status: 'ready', writable: true })
    const unavailable = opsForm({ status: 'unavailable', writable: true })
    const services: Record<string, unknown> = modern
      ? { configForms: { get: (id: string) => { selected.push(id); return id === 'multi-root-skills' ? skillsForm : id === 'multi-root-ops-compatibility' ? ops : unavailable } } }
      : { settingsScope: { bind: ({ namespace }: { namespace: string }) => { selected.push(namespace); return namespace === 'multi-root-skills' ? skillsForm : ops } } }
    const ctx = {
      get: (name: string) => services[name],
      inject: (names: string[], callback: (ctx: unknown) => unknown) => { if (names.every(name => name in services)) { const stop = callback(ctx); if (typeof stop === 'function') cleanups.push(stop as () => void) } },
      slots: { inject: (_name: string, callback: () => unknown) => { callback(); return () => {} }, register: (options: { name: string; key: string }, component: unknown) => { registrations.push({ ...options, component }); return () => {} } },
      effect: (setup: () => unknown) => { const stop = setup(); if (typeof stop === 'function') cleanups.push(stop as () => void) },
    }
    expect(bindSettingsForm(ctx as never, 'multi-root-ops-compatibility')).toBe(ops)
    installSkillsSettingsCard(ctx as never, t)
    expect(selected).toContain('multi-root-skills')
    const bundle = registrations.filter(row => row.name === 'plugins.bundle.config')
    expect(bundle).toHaveLength(1)
    expect(bundle[0]!.key).toBe('@dsh-electron/dsh-plugin-multi-root-workspace')
    const items = registrations.filter(row => row.name === 'settings.plugin.item')
    expect(items.map(row => row.key).sort()).toEqual(modern ? ['multi-root-ops-compatibility', 'multi-root-skills'] : ['multi-root-skills'])
    const Bundle = bundle[0]!.component as typeof BundleSettingsCard
    const props = (bundle[0]! as { inject?: () => { form: SkillsForm; opsForm: SkillsForm; t: Translate } }).inject?.() ?? { form: skillsForm, opsForm: modern ? ops : undefined, t }
    render(<Bundle {...props} />)
    expect(screen.getByRole('switch', { name: 'skills.globalEnable' })).not.toBeNull()
    expect(screen.queryByRole('switch', { name: 'ops.compatibilityEnable' }) !== null).toBe(modern)
  })

  it('does not register an OPS settings item when the host omits its namespace', () => {
    const registrations: { name: string; key: string }[] = []
    const skills = opsForm({ value: { enabled: true }, status: 'ready', writable: true })
    const ops = opsForm({ status: 'unavailable', writable: true })
    const services = { configForms: { get: (id: string) => id === 'multi-root-skills' ? skills : ops } }
    const ctx = {
      get: (name: string) => name === 'configForms' ? services.configForms : undefined,
      inject: (names: string[], callback: (ctx: unknown) => unknown) => {
        if (names.every(name => name in services)) {
          const stop = callback(ctx); if (typeof stop === 'function') cleanups.push(stop as () => void)
        }
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: { name: string; key: string }) => { registrations.push(options); return () => {} },
      },
      effect: (setup: () => unknown) => { const stop = setup(); if (typeof stop === 'function') cleanups.push(stop as () => void) },
    }
    installSkillsSettingsCard(ctx as never, t)
    expect(registrations.map(row => row.key)).not.toContain('multi-root-ops-compatibility')
    expect(registrations.map(row => row.key)).toContain('multi-root-skills')
  })

  it('clicking each switch only mutates its own form', async () => {
    const skillsWrites: unknown[] = [], opsWrites: unknown[] = []
    const skillsForm = opsForm({ value: { enabled: true }, status: 'ready', writable: true, revision: 1 }, skillsWrites)
    const ops = opsForm({ value: { enabled: false }, status: 'ready', writable: true, revision: 2 }, opsWrites)
    render(<BundleSettingsCard form={skillsForm} opsForm={ops} t={t} />)
    fireEvent.click(screen.getByRole('switch', { name: 'ops.compatibilityEnable' }))
    expect(opsWrites).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: 'ops.confirmAcknowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'ops.confirmEnable' }))
    await waitFor(() => expect(opsWrites).toHaveLength(1))
    expect(skillsWrites).toEqual([])
    fireEvent.click(screen.getByRole('switch', { name: 'skills.globalEnable' }))
    await waitFor(() => expect(skillsWrites).toHaveLength(1))
    expect(opsWrites).toHaveLength(1)
  })

  it('renders only the OPS card when the Skills form is absent', () => {
    const ops = opsForm({ value: { enabled: false }, status: 'ready', writable: true })
    render(<BundleSettingsCard opsForm={ops} t={t} />)
    expect(screen.queryByRole('switch', { name: 'skills.globalEnable' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'ops.compatibilityEnable' })).not.toBeNull()
  })

  it('still binds the Skills namespace through the shared helper', () => {
    const ctx = { get: (name: string) => name === 'settingsScope' ? { bind: ({ namespace }: { namespace: string }) => ({ namespace }) } : undefined }
    expect(bindSkillsForm(ctx as never)).toEqual({ namespace: 'multi-root-skills' })
    expect(bindSettingsForm(ctx as never, 'multi-root-ops-compatibility')).toEqual({ namespace: 'multi-root-ops-compatibility' })
  })
})

describe('SSH remote-environments settings card', () => {
  it('carries the warning-tone tag and keeps the setting off until acknowledged and confirmed', async () => {
    const writes: unknown[] = []
    const form = opsForm({ value: { enabled: false }, status: 'ready', writable: true, revision: 3 }, writes)
    render(<RemoteSwitchRow form={form} t={t} />)
    expect(screen.getByText('remote.experimental').getAttribute('data-tone')).toBe('warning')
    const toggle = screen.getByRole('switch', { name: 'remote.settingsEnable' })
    expect(toggle.getAttribute('aria-checked')).not.toBe('true')
    fireEvent.click(toggle)
    expect(screen.getByRole('dialog', { name: 'remote.confirmTitle' })).not.toBeNull()
    expect(screen.getByText('remote.confirmDescription')).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(writes).toEqual([])
    const confirm = screen.getByRole('button', { name: 'remote.confirmEnable' }) as HTMLButtonElement
    fireEvent.click(confirm)
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: 'remote.confirmAcknowledge' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['enabled'], value: true }], 3]]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('turns an enabled setting off immediately without a confirmation', async () => {
    const writes: unknown[] = []
    render(<RemoteSwitchRow form={opsForm({ value: { enabled: true }, status: 'ready', writable: true, revision: 4 }, writes)} t={t} />)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['enabled'], value: false }], 4]]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides the row while unavailable and blocks enabling without the host warning dialog', () => {
    render(<RemoteSwitchRow form={opsForm({ status: 'unavailable', writable: true })} t={t} />)
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    vi.spyOn(Confirmation, 'remoteRiskConfirmation').mockReturnValue(undefined)
    const writes: unknown[] = []
    render(<RemoteSwitchRow form={opsForm({ value: { enabled: false }, status: 'ready', writable: true }, writes)} t={t} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(writes).toEqual([])
  })

  it('renders inside the bundle card and mutates only its own form', async () => {
    const remoteWrites: unknown[] = [], opsWrites: unknown[] = []
    const remote = opsForm({ value: { enabled: false }, status: 'ready', writable: true, revision: 1 }, remoteWrites)
    const ops = opsForm({ value: { enabled: false }, status: 'ready', writable: true, revision: 2 }, opsWrites)
    render(<BundleSettingsCard opsForm={ops} remoteForm={remote} t={t} />)
    fireEvent.click(screen.getByRole('switch', { name: 'remote.settingsEnable' }))
    expect(remoteWrites).toEqual([])
    fireEvent.click(screen.getByRole('checkbox', { name: 'remote.confirmAcknowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'remote.confirmEnable' }))
    await waitFor(() => expect(remoteWrites).toHaveLength(1))
    expect(opsWrites).toEqual([])
    expect(screen.getByRole('switch', { name: 'ops.compatibilityEnable' })).not.toBeNull()
  })
})
