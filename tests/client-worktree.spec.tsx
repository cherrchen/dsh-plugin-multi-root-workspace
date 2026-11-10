// @vitest-environment jsdom
/** The worktree prompt overlay and the two-switch plugin card. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreePromptView } from '../src/contract.ts'
import { WorktreePrompt } from '../src/client/WorktreePrompt.tsx'
import { WorkspaceFoldersDialog } from '../src/client/WorkspaceFoldersAction.tsx'
import { PanelError, type PanelClient } from '../src/client/panel-client.ts'
import type { RootsView } from '../src/contract.ts'
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
  remaining: 2,
  viewRevision: 'v1',
}

const MAIN: WorktreePromptView = {
  id: 'm1',
  key: 'main-checkout\u0000/tmp/main/.git',
  kind: 'main-checkout',
  path: '/tmp/main',
  primaryRoot: '/tmp/main',
  access: 'inherit',
  effectiveAccess: 'read-write',
  remaining: 2,
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

/** The multi-candidate shape on the first call, then a real long poll. */
function listThenWait(prompts: readonly WorktreePromptView[] = [PROMPT, MAIN]): WorktreeClient['wait'] {
  let calls = 0
  return async (_sessionId, _seen, signal) => {
    calls++
    if (calls === 1) return { status: 'prompts', prompts, viewRevision: 'v1' }
    return await pendingWait(signal)
  }
}

function fakeClient(overrides: Partial<WorktreeClient> = {}): WorktreeClient {
  const listeners = new Set<(sessionId: string) => void>()
  const base: WorktreeClient = {
    wait: async () => pendingWait(),
    prompt: async () => ({ prompts: [], viewRevision: 'v1' }),
    resolve: async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }),
    reset: async () => ({ cleared: true }),
    cleanup: async () => { throw new Error('unexpected cleanup') },
    notify: sessionId => { for (const listener of [...listeners]) listener(sessionId) },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { ...base, ...overrides }
}

function renderPrompt(client: WorktreeClient, previewOnly: boolean, subscribeEnabled?: (listener: () => void) => () => void) {
  return render(<WorktreePrompt
    client={client}
    sessionId={() => 's1'}
    subscribeSession={() => () => {}}
    t={t}
    previewOnly={previewOnly}
    {...(subscribeEnabled === undefined ? {} : { subscribeEnabled })} />)
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
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const client = fakeClient({ wait: promptThenWait(), resolve })
    renderPrompt(client, false)
    await screen.findByRole('dialog', { name: 'worktree.title' })
    fireEvent.click(screen.getByText('worktree.add'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1'], 'add', undefined))
  })

  it('renders the checkbox list when several candidates are visible', async () => {
    renderPrompt(fakeClient({ wait: listThenWait() }), false)
    await screen.findByRole('dialog', { name: 'worktree.listTitle' })
    expect(screen.getByText('/tmp/wt')).toBeDefined()
    expect(screen.getByText('/tmp/main')).toBeDefined()
    expect(screen.getByText('worktree.kind.worktree')).toBeDefined()
    expect(screen.getByText('worktree.kind.main-checkout')).toBeDefined()
    expect(screen.getByText('worktree.mainSeparate')).toBeDefined()
    const boxes = screen.getAllByRole('checkbox')
    // The linked checkout is pre-selected; the main checkout stays an explicit
    // opt-in because it grants the source tree.
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('adds the checked rows in one batch', async () => {
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ wait: listThenWait(), resolve }), false)
    await screen.findByRole('dialog', { name: 'worktree.listTitle' })
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1'], 'add', undefined))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sends only the rows the operator selected', async () => {
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ wait: listThenWait(), resolve }), false)
    await screen.findByRole('dialog', { name: 'worktree.listTitle' })
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[0]!)
    fireEvent.click(boxes[1]!)
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['m1'], 'add', undefined))
  })

  it('keeps a refused row visible, unchecked, and reports its code', async () => {
    const resolve = vi.fn(async () => ({
      viewRevision: 'v2',
      prompts: [PROMPT, MAIN],
      resolved: [],
      skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
    }))
    renderPrompt(fakeClient({ wait: listThenWait(), resolve }), false)
    await screen.findByRole('dialog', { name: 'worktree.listTitle' })
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(screen.getByText(/worktree.rowError/)).toBeDefined())
    expect(screen.getByText(/error.worktree\/prompt-stale/)).toBeDefined()
    const boxes = screen.getAllByRole('checkbox')
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
  })

  it('uses the main-checkout copy for a single main checkout prompt', async () => {
    renderPrompt(fakeClient({ wait: promptThenWait(MAIN) }), false)
    const dialog = await screen.findByRole('dialog', { name: 'worktree.mainTitle' })
    expect(dialog).toBeDefined()
    expect(screen.getByText('/tmp/main')).toBeDefined()
    expect(screen.getByText('worktree.mainSeparate')).toBeDefined()
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

  it('remounts its wait when the settings switch is turned back on', async () => {
    let calls = 0
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => {
      calls++
      if (calls === 1) throw new PanelError('worktree/not-enabled', 'off')
      if (calls === 2) return { status: 'prompt' as const, prompt: PROMPT, viewRevision: 'v1' }
      return await pendingWait(signal)
    })
    let settingsListener: (() => void) | undefined
    renderPrompt(fakeClient({ wait }), true, listener => {
      settingsListener = listener
      return () => { settingsListener = undefined }
    })
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { settingsListener?.() })
    const dialog = await screen.findByRole('dialog', { name: 'worktree.title' })
    expect(dialog).toBeDefined()
    // The loop immediately mounts a `seen` wait after rendering the prompt.
    expect(wait).toHaveBeenCalledTimes(3)
  })

  it('aborts an open wait and sends no replacement while the form is disabled', async () => {
    let enabled = true
    let settingsListener: (() => void) | undefined
    const wait = vi.fn(promptThenWait())
    render(<WorktreePrompt client={fakeClient({ wait })} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={t} previewOnly
      readEnabled={() => enabled} subscribeEnabled={listener => {
        settingsListener = listener
        return () => { settingsListener = undefined }
      }} />)
    await screen.findByRole('dialog')
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(2))
    const signal = wait.mock.calls[1]![2]!
    act(() => { enabled = false; settingsListener?.() })
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('remounts after an explicit panel action wakes it from lost', async () => {
    let calls = 0
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => {
      calls++
      if (calls === 1) return { status: 'lost' as const, viewRevision: 'v1' }
      if (calls === 2) return { status: 'prompt' as const, prompt: PROMPT, viewRevision: 'v2' }
      return await pendingWait(signal)
    })
    const client = fakeClient({ wait })
    renderPrompt(client, true)
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { client.notify?.('another-session') })
    expect(wait).toHaveBeenCalledTimes(1)
    act(() => { client.notify?.('s1') })
    const dialog = await screen.findByRole('dialog', { name: 'worktree.title' })
    expect(dialog).toBeDefined()
    expect(wait).toHaveBeenCalledTimes(3)
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

describe('panel cleanup controls', () => {
  it('asks in place and cleans up the exact eligible ids', async () => {
    const view: RootsView = {
      primaryRoot: '/main',
      roots: [{
        ordinal: 1, id: 'r1', path: '/deleted-wt', addedAt: '2026-11-09', state: 'missing', access: 'inherit',
        worktree: { adminId: 'id', path: '/deleted-wt', state: 'directory-missing', cleanupEligible: true },
      }],
      limit: 16,
      count: 1,
      worktreeCleanupCount: 1,
    }
    const empty: RootsView = { ...view, roots: [], count: 0, worktreeCleanupCount: 0 }
    const panel = { call: async (endpoint: string) => endpoint === 'list' ? view : view } as unknown as PanelClient
    const cleanup = vi.fn(async () => ({ removed: ['r1'], skipped: [], roots: empty }))
    const worktrees = fakeClient({ cleanup })
    render(<WorkspaceFoldersDialog
      panel={panel}
      pickDirectory={undefined}
      t={t}
      sessionId={() => 's1'}
      onClose={() => {}}
      worktrees={worktrees} />)
    const batch = await screen.findByText('worktree.cleanupBatch')
    fireEvent.click(batch)
    // The confirmation is inline, not a second overlay dialog.
    expect(screen.getByText('worktree.cleanupConfirm')).toBeDefined()
    fireEvent.click(screen.getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledWith('s1', ['r1']))
    await waitFor(() => expect(screen.queryByText('/deleted-wt')).toBeNull())
  })

  it('wakes the overlay after an explicit list can re-activate a lost workspace', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    const notify = vi.fn()
    render(<WorkspaceFoldersDialog
      panel={panel}
      pickDirectory={undefined}
      t={t}
      sessionId={() => 's1'}
      onClose={() => {}}
      worktrees={fakeClient({ notify })} />)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('s1'))
  })
})

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

  it('shows the worktree switch off by default with the experimental tag', () => {
    const snapshot = { value: undefined, status: 'ready' as const, writable: true, revision: 1 }
    const empty = (): SkillsForm => ({
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate: async () => true,
    })
    render(<BundleSettingsCard form={empty()} worktreeForm={empty()} t={t} />)
    expect(screen.getByText('worktree.experimental')).toBeDefined()
    const switches = screen.getAllByRole('switch')
    expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
    expect(switches[1]?.getAttribute('aria-checked')).toBe('false')
  })

  it('still renders a worktree-only card when the Skills row is absent', () => {
    const writes: boolean[] = []
    render(<BundleSettingsCard worktreeForm={fakeForm(async value => { writes.push(value); return true })} t={t} />)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByText('worktree.globalHint')).toBeDefined()
  })
})
