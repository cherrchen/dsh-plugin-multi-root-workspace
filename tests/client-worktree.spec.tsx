// @vitest-environment jsdom
/** The worktree prompt overlay and the two-switch plugin card. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreePromptView } from '../src/contract.ts'
import { WorktreePrompt } from '../src/client/WorktreePrompt.tsx'
import { BundleSettingsCard } from '../src/client/skills-settings.tsx'
import type { WorktreeClient } from '../src/client/worktree-client.ts'
import type { SkillsForm } from '../src/compat/skills-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = (key) => key
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PROMPT: WorktreePromptView = {
  id: 'p1',
  key: 'worktree\u0000/wt',
  kind: 'worktree',
  path: '/tmp/wt',
  primaryRoot: '/tmp/main',
  access: 'inherit',
  effectiveAccess: 'read-write',
  remaining: 1,
  viewRevision: 'v1',
}

function pendingWait(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/** One prompt on the first call, then a real long poll (as the host behaves). */
function promptThenWait(seenPrompt: WorktreePromptView = PROMPT): WorktreeClient['wait'] {
  let calls = 0
  return async (_sessionId, _seen, signal) => {
    calls++
    if (calls === 1) return { status: 'prompt', prompt: seenPrompt, viewRevision: 'v1' }
    return await pendingWait(signal)
  }
}

function fakeClient(overrides: Partial<WorktreeClient> = {}): WorktreeClient {
  const base: WorktreeClient = {
    wait: async () => pendingWait(),
    prompt: async () => ({ viewRevision: 'v1' }),
    resolve: async () => ({ viewRevision: 'v2' }),
    reset: async () => ({ cleared: true }),
  }
  return { ...base, ...overrides }
}

function renderPrompt(client: WorktreeClient, previewOnly: boolean) {
  return render(<WorktreePrompt client={client} sessionId={() => 's1'} subscribeSession={() => () => {}} t={t} previewOnly={previewOnly} />)
}

describe('worktree prompt overlay', () => {
  it('renders the confirmation preview with the path and effective access', async () => {
    const client = fakeClient({ wait: promptThenWait() })
    renderPrompt(client, true)
    const dialog = await screen.findByRole('dialog', { name: 'worktree.title' })
    expect(dialog).toBeDefined()
    expect(screen.getByText('/tmp/wt')).toBeDefined()
    expect(screen.getByText('worktree.previewOnly')).toBeDefined()
    expect(screen.queryByText('worktree.add')).toBeNull()
    expect(screen.getByText('worktree.previewClose')).toBeDefined()
  })

  it('confirms through the client when writes are enabled', async () => {
    const resolve = vi.fn(async () => ({ viewRevision: 'v2' }))
    const client = fakeClient({ wait: promptThenWait(), resolve })
    renderPrompt(client, false)
    await screen.findByRole('dialog', { name: 'worktree.title' })
    fireEvent.click(screen.getByText('worktree.add'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', 'p1', 'add', undefined))
  })

  it('closes on lost and stops polling', async () => {
    let calls = 0
    const client = fakeClient({
      wait: async () => {
        calls++
        return calls === 1
          ? { status: 'prompt', prompt: PROMPT, viewRevision: 'v1' }
          : { status: 'lost', viewRevision: 'v2' }
      },
    })
    renderPrompt(client, true)
    await screen.findByRole('dialog', { name: 'worktree.title' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const after = calls
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(after)
  })

  it('stays silent when the session is missing', async () => {
    const wait = vi.fn(async () => ({ status: 'timeout' as const, viewRevision: 'v1' }))
    render(<WorktreePrompt client={fakeClient({ wait })} sessionId={() => undefined} subscribeSession={() => () => {}} t={t} previewOnly />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(wait).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

function fakeForm(mutate: (value: boolean) => Promise<boolean>): SkillsForm {
  let value = true
  let snapshot = { value: { enabled: value }, status: 'ready', writable: true, revision: 1 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops) => {
      const next = Boolean(ops[0]?.value)
      const ok = await mutate(next)
      if (ok) {
        value = next
        snapshot = { value: { enabled: value }, status: 'ready', writable: true, revision: 1 }
        for (const listener of listeners) listener()
      }
      return ok
    },
  }
}

describe('plugin detail switches', () => {
  it('renders the worktree switch next to Skills and writes only its own form', async () => {
    const skillsWrites: boolean[] = []
    const worktreeWrites: boolean[] = []
    render(<BundleSettingsCard
      form={fakeForm(async value => { skillsWrites.push(value); return true })}
      worktreeForm={fakeForm(async value => { worktreeWrites.push(value); return true })}
      t={t} />)
    expect(screen.getByText('skills.globalEnable')).toBeDefined()
    expect(screen.getByText('worktree.globalEnable')).toBeDefined()
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)
    fireEvent.click(switches[1]!)
    await waitFor(() => expect(worktreeWrites).toEqual([false]))
    expect(skillsWrites).toEqual([])
    fireEvent.click(switches[0]!)
    await waitFor(() => expect(skillsWrites).toEqual([false]))
    expect(worktreeWrites).toEqual([false])
  })

  it('still renders a worktree-only card when the Skills row is absent', () => {
    const writes: boolean[] = []
    render(<BundleSettingsCard worktreeForm={fakeForm(async value => { writes.push(value); return true })} t={t} />)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByText('worktree.globalHint')).toBeDefined()
  })
})
