// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillsSettingsCard, installSkillsSettingsCard } from '../src/client/skills-settings.tsx'
import { namespaceSource, namespaceSkillRule, installSkillsClient } from '../src/client/skills.tsx'
import { SkillsClient } from '../src/client/skills-client.ts'
import { bindSkillsForm, registerNamespaceRule } from '../src/compat/skills-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'
const t: Translate = key => key
const cleanups: (() => void)[] = []
afterEach(() => { cleanup(); for (const stop of cleanups.splice(0).reverse()) stop() })

describe('namespaced Web Skills', () => {
  it('completes /root: queries and inserts the full literal reference without internal IDs', async () => {
    const client = new SkillsClient({ rpc: { call: async () => ({ ok: true, value: { sessionId: 'a', generation: 1, enabled: true, skills: [
      { name: 'root:review', description: 'Review', modelInvocable: true }, { name: 'root:user-only', description: 'User', modelInvocable: false },
    ] } }) } }); cleanups.push(() => client.dispose())
    const opened: string[] = []
    const source = namespaceSource(client, t, (session, name) => opened.push(`${session}/${name}`))
    const candidates = await source.candidates({ sessionId: 'a' }, { query: 'root:', signal: new AbortController().signal })
    expect(candidates.map(row => row.name)).toEqual(['root:review', 'root:user-only'])
    expect(source.onPick({ candidate: candidates[0]! })).toEqual({ text: '/root:review ' })
    expect(source.openReference({ sessionId: 'a' }, { ref: '/root:review' })).toBe(true)
    expect(opened).toEqual(['a/root:review'])
    expect(namespaceSkillRule.match('before /root:review after', 0)?.data.name).toBe('root:review')
    expect(namespaceSkillRule.match('before /root:review after', 20)).toBeUndefined()
  })

  it('degrades on old hosts without a UserTextRule registry', () => {
    expect(registerNamespaceRule({ get: () => ({}) } as never, namespaceSkillRule)).toBeUndefined()
    let registered: unknown
    const stop = registerNamespaceRule({ get: () => ({ userText: { register: (rule: unknown) => { registered = rule; return () => {} } } }) } as never, namespaceSkillRule)
    expect(registered).toBe(namespaceSkillRule); stop?.()
  })

  it('uses the correct namespace/row and registers one package card on either form shape', () => {
    for (const modern of [false, true]) {
      const selected: string[] = [], registrations: { name: string; key: string }[] = []
      const form = { getSnapshot: () => ({ value: { enabled: true }, status: 'ready', writable: true }), subscribe: () => () => {}, mutate: async () => true }
      const services: Record<string, unknown> = modern ? { configForms: { get: (id: string) => { selected.push(id); return form } } } : { settingsScope: { bind: ({ namespace }: { namespace: string }) => { selected.push(namespace); return form } } }
      const ctx = { get: (name: string) => services[name], inject: (names: string[], callback: (ctx: unknown) => unknown) => { if (names.every(name => name in services)) { const stop = callback(ctx); if (typeof stop === 'function') cleanups.push(stop as () => void) } },
        slots: { inject: (name: string, callback: () => unknown) => { if (name === 'plugins.bundle.config') callback(); return () => {} }, register: (options: { name: string; key: string }) => { registrations.push(options); return () => {} } },
        effect: (setup: () => unknown) => { const stop = setup(); if (typeof stop === 'function') cleanups.push(stop as () => void) },
      }
      expect(bindSkillsForm(ctx as never)).toBe(form)
      installSkillsSettingsCard(ctx as never, t)
      expect(selected.every(key => key === 'multi-root-skills')).toBe(true)
      expect(registrations).toEqual([{ name: 'plugins.bundle.config', key: '@dsh-electron/dsh-plugin-multi-root-workspace', inject: expect.any(Function) }])
    }
  })

  it('renders sent references and loads preview through its Session-addressed RPC', async () => {
    const seats: { options: { key: string; inject?: (id: string) => object }; component: any }[] = []
    const calls: { endpoint: string; payload: any }[] = []
    const connection = { rpc: { call: async (_channel: string, endpoint: string, payload: any, signal?: AbortSignal) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'skillsChanges') return await new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }) })
      return { ok: true, value: endpoint === 'skillsList' ? { sessionId: payload.sessionId, generation: 1, enabled: true, skills: [] }
        : { sessionId: payload.sessionId, generation: 1, enabled: true, name: payload.name, content: 'PREVIEW BODY' } }
    } } }
    const services: Record<string, unknown> = { connection, uiConversation: { userText: { register: () => () => {} } } }
    const ctx = { get: (key: string) => services[key], inject: (names: string[], callback: (ctx: unknown) => unknown) => { if (names.every(name => name in services)) { const stop = callback(ctx); if (typeof stop === 'function') cleanups.push(stop as () => void) } },
      slots: { inject: (_name: string, callback: () => unknown) => { callback(); return () => {} }, register: (options: any, component: any) => { seats.push({ options, component }); return () => {} } },
      effect: (setup: () => unknown) => { const stop = setup(); if (typeof stop === 'function') cleanups.push(stop as () => void) },
    }
    installSkillsClient(ctx as never, t, () => () => {})
    const seat = seats.find(seat => seat.options.key === 'multi-root-skill')!
    const Component = seat.component
    render(<Component node={{ data: { name: 'root:review' } }} interactive {...seat.options.inject!('message-session')} />)
    fireEvent.click(screen.getByRole('button', { name: '/root:review' }))
    expect(await screen.findByText('PREVIEW BODY')).toBeDefined()
    expect(calls.find(call => call.endpoint === 'skillsPreview')?.payload).toEqual({ sessionId: 'message-session', name: 'root:review' })
    expect(screen.getByText('skills.referenceHint')).toBeDefined()
  })

  it('renders an accessible global toggle and writes only enabled with its revision fence', async () => {
    const writes: unknown[] = []
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async (...args: unknown[]) => { writes.push(args); return true } }
    const snapshot = { value: { enabled: true }, status: 'ready', writable: true, revision: 7 }
    render(<SkillsSettingsCard form={form} t={t} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'skills.globalEnable' }))
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['enabled'], value: false }], 7]]))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
