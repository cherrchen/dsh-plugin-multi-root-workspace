// @vitest-environment jsdom
/** The worktree notice/Dialog overlay and the two-switch plugin card. */
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RootView, RootsView, WorktreePromptView } from '../src/contract.ts'
import { WORKTREE_EMPTY_NOTICE_HOLD_MS, WorktreePrompt } from '../src/client/WorktreePrompt.tsx'
import { WorkspaceFoldersDialog } from '../src/client/WorkspaceFoldersAction.tsx'
import { RootSwitcher } from '../src/client/RootSwitcher.tsx'
import { PanelError, type PanelClient } from '../src/client/panel-client.ts'
import { BundleSettingsCard } from '../src/client/skills-settings.tsx'
import { createWorktreeClient, type WorktreeClient } from '../src/client/worktree-client.ts'
import { onWorktreePromptRequest, requestWorktreePrompt } from '../src/client/worktree-prompt-bus.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SkillsForm } from '../src/compat/skills-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = key => key
/** A translator that keeps its parameters, so a test can see the notice count. */
const tWithParams: Translate = (key, params) =>
  params === undefined ? key : key + ':' + Object.values(params).join(',')
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const PROMPT: WorktreePromptView = {
  id: 'p1',
  key: 'worktree\u0000/wt',
  kind: 'worktree',
  path: '/tmp/wt',
  primaryRoot: '/tmp/main',
  access: 'inherit',
  effectiveAccess: 'read-write',
  branch: 'feature/notice',
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
  branch: 'main',
  remaining: 2,
  viewRevision: 'v1',
}

/** A second worktree row, used to make one session's candidate set countable. */
const OTHER: WorktreePromptView = {
  ...PROMPT,
  id: 'p2',
  key: 'worktree\u0000/wt2',
  path: '/tmp/wt2',
}

/** A candidate list larger than the contract's 64-id request cap. */
function manyPrompts(count = 65): WorktreePromptView[] {
  return Array.from({ length: count }, (_, index) => ({
    ...PROMPT,
    id: `p${index}`,
    key: `worktree\u0000/wt${index}`,
    path: `/tmp/wt${index}`,
  }))
}

/** One full prompt answer, as the host builds it. */
function answer(prompts: readonly WorktreePromptView[], viewRevision = 'v1') {
  return Promise.resolve({ prompts, viewRevision })
}

/** A long poll that never answers; only abort settles it. */
function pendingWait(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) { reject(new Error('aborted')); return }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/** The full client surface the new overlay talks to. */
function fakeClient(overrides: Partial<WorktreeClient> = {}): WorktreeClient {
  return {
    prompt: async () => answer([]),
    seen: async () => ({ seen: 0 }),
    wait: (_sessionId, _seen, signal) => pendingWait(signal),
    resolve: async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }),
    snooze: async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }),
    reset: async () => ({ cleared: true }),
    cleanup: async () => { throw new Error('unexpected cleanup') },
    ...overrides,
  }
}

/** The composed props the shell.overlay registration supplies. */
function renderPrompt(client: WorktreeClient, previewOnly = false) {
  return render(<WorktreePrompt
    client={client}
    sessionId={() => 's1'}
    subscribeSession={() => () => {}}
    t={t}
    previewOnly={previewOnly} />)
}

/** Open the notice's "remind me later" menu and pick one mode. */
async function chooseSnooze(mode: 'until-new-worktree' | '7d' | '30d'): Promise<void> {
  fireEvent.click(await screen.findByLabelText('worktree.toastLaterOptions'))
  fireEvent.click(await screen.findByText('worktree.snooze.' + mode))
}

/** Choose a reminder mode from the Dialog's official dropdown. */
async function chooseDialogSnooze(mode: 'until-new-worktree' | '7d' | '30d' | 'permanent'): Promise<void> {
  fireEvent.click(await screen.findByLabelText('worktree.snoozeLabel'))
  fireEvent.click(await screen.findByText('worktree.snooze.' + mode))
}

/** Render the overlay and open the Dialog through the notice's View action. */
async function openDialog(client: WorktreeClient, previewOnly = false): Promise<void> {
  renderPrompt(client, previewOnly)
  const view = await screen.findByText('worktree.toastView')
  fireEvent.click(view)
  await screen.findByRole('dialog')
}

interface SessionHarness {
  readonly read: () => string | undefined
  readonly subscribe: (listener: () => void) => () => void
  readonly switchTo: (session: string | undefined) => void
}

function sessionHarness(initial: string | undefined): SessionHarness {
  let current = initial
  let listener: (() => void) | undefined
  return {
    read: () => current,
    subscribe: (next) => {
      listener = next
      return () => { listener = undefined }
    },
    switchTo: (session) => {
      current = session
      act(() => { listener?.() })
    },
  }
}

describe('worktree notice: the one automatic check', () => {
  it('shows a non-modal notice for a non-empty fresh answer and claims the ids', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const seen = vi.fn(async () => ({ seen: 2 }))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    render(<WorktreePrompt client={fakeClient({ prompt, seen, wait })} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={tWithParams} previewOnly={false} />)
    expect(await screen.findByText('worktree.toast:2')).toBeDefined()
    // The notice is not a dialog: no backdrop, no focus trap, no aria-modal.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('s1', { fresh: true }, expect.any(AbortSignal))
    await waitFor(() => expect(seen).toHaveBeenCalledWith('s1', ['p1', 'm1']))
    // The Dialog's long poll never runs before the operator asks to view.
    expect(wait).not.toHaveBeenCalled()
  })

  it('stays silent for an empty fresh answer and calls no wait', async () => {
    const prompt = vi.fn(async () => answer([]))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    renderPrompt(fakeClient({ prompt, wait }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('worktree.toast')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(wait).not.toHaveBeenCalled()
  })

  it('renders nothing and sends no request without a client', async () => {
    render(<WorktreePrompt client={undefined} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={t} previewOnly={false} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByText('worktree.toast')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays silent without a session and never calls the host', async () => {
    const prompt = vi.fn(async () => answer([]))
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={() => undefined}
      subscribeSession={() => () => {}} t={t} previewOnly={false} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompt).not.toHaveBeenCalled()
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })

  it('never retries a failed automatic check', async () => {
    const prompt = vi.fn(async () => { throw new PanelError('worktree/session-not-found', 'gone') })
    renderPrompt(fakeClient({ prompt }))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })

  it('keeps the neutral notice copy for a single main-checkout candidate', async () => {
    const prompt = vi.fn(async () => answer([MAIN]))
    renderPrompt(fakeClient({ prompt }))
    expect(await screen.findByText('worktree.toast')).toBeDefined()
    expect(screen.getByText('worktree.toastView')).toBeDefined()
  })

  it('shows a notice beyond 64 candidates and claims its ids in request-sized batches', async () => {
    const prompts = manyPrompts()
    const calls: { endpoint: string; payload: { promptIds?: readonly string[] } }[] = []
    const connection = {
      rpc: {
        async call(_channel: string, endpoint: string, payload: { promptIds?: readonly string[] }) {
          calls.push({ endpoint, payload })
          if (endpoint === 'worktreePrompt') return { ok: true, value: { prompts, viewRevision: 'v1' } }
          if (endpoint === 'worktreePromptSeen') return { ok: true, value: { seen: payload.promptIds?.length ?? 0 } }
          throw new Error('unexpected endpoint ' + endpoint)
        },
      },
    } as unknown as ConnectionHandle
    render(<WorktreePrompt client={createWorktreeClient(connection)} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={tWithParams} previewOnly={false} />)
    // A response is allowed to carry the full visible list; only its ids travel
    // back in requests, where the contract caps every batch at 64.
    expect(await screen.findByText('worktree.toast:65')).toBeDefined()
    await waitFor(() => expect(calls.filter(call => call.endpoint === 'worktreePromptSeen')).toHaveLength(2))
    expect(calls.filter(call => call.endpoint === 'worktreePromptSeen').map(call => call.payload.promptIds?.length))
      .toEqual([64, 1])
  })
})

describe('worktree notice: View opens the Dialog', () => {
  it('lists every visible candidate and starts the long poll only after View', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const seen = vi.fn(async () => ({ seen: 2 }))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    const client = fakeClient({ prompt, seen, wait })
    await openDialog(client)
    expect(screen.getByRole('dialog', { name: 'worktree.listTitle' })).toBeDefined()
    expect(screen.getByText('/tmp/wt')).toBeDefined()
    expect(screen.getByText('/tmp/main')).toBeDefined()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[1]![0]).toBe('s1')
    expect(prompt.mock.calls[1]![1]).toBeUndefined()
    expect(seen).toHaveBeenCalledWith('s1', ['p1', 'm1'])
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    expect(wait.mock.calls[0]![0]).toBe('s1')
  })

  it('opens a single confirmation as one row with its branch and access selector', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    await openDialog(fakeClient({ prompt }))
    expect(screen.getByRole('dialog', { name: 'worktree.title' })).toBeDefined()
    expect(screen.getByText('/tmp/wt')).toBeDefined()
    expect(screen.getByText('wt')).toBeDefined()
    expect(screen.getByText('feature/notice')).toBeDefined()
    expect(screen.getByLabelText('worktree.accessLabel: panel.accessInherit')).toBeDefined()
    expect(screen.getByText('worktree.add')).toBeDefined()
  })

  it('keeps the main-checkout disclosure in its single row', async () => {
    const prompt = vi.fn(async () => answer([MAIN]))
    await openDialog(fakeClient({ prompt }))
    expect(screen.getByRole('dialog', { name: 'worktree.mainTitle' })).toBeDefined()
    expect(screen.getByText('/tmp/main')).toBeDefined()
    expect(screen.getByText('worktree.mainPolicy')).toBeDefined()
    expect(screen.getByText('worktree.mainSeparate')).toBeDefined()
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
  })

  it('pre-selects worktree rows and leaves the main checkout an explicit opt-in', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    await openDialog(fakeClient({ prompt }))
    const boxes = screen.getAllByRole('checkbox')
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('adds only the rows the operator selected', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    await openDialog(fakeClient({ prompt, resolve }))
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[0]!)
    fireEvent.click(boxes[1]!)
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['m1'], 'add', {
      accesses: [{ id: 'm1', access: 'inherit' }],
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sends the access chosen for each selected row', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    await openDialog(fakeClient({ prompt, resolve }))
    const accessButtons = screen.getAllByLabelText('worktree.accessLabel: panel.accessInherit')
    fireEvent.click(accessButtons[0]!)
    fireEvent.click(await screen.findByText('panel.accessReadOnly'))
    expect(screen.getByText('panel.accessReadOnly')).toBeDefined()
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1'], 'add', {
      accesses: [{ id: 'p1', access: 'read-only' }],
    }))
  })

  it('preserves an unchecked worktree across a branch update and a shrink to one row', async () => {
    const firstUpdate = Promise.withResolvers<Awaited<ReturnType<WorktreeClient['wait']>>>()
    const secondUpdate = Promise.withResolvers<Awaited<ReturnType<WorktreeClient['wait']>>>()
    const wait = vi.fn(fakeClient().wait)
      .mockReturnValueOnce(firstUpdate.promise)
      .mockReturnValueOnce(secondUpdate.promise)
    const resolve = vi.fn(fakeClient().resolve)
    await openDialog(fakeClient({ prompt: () => answer([PROMPT, MAIN]), wait, resolve }))
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    fireEvent.click(screen.getAllByLabelText('worktree.accessLabel: panel.accessInherit')[0]!)
    fireEvent.click(await screen.findByText('panel.accessReadOnly'))

    await act(async () => firstUpdate.resolve({
      status: 'prompts', prompts: [PROMPT, { ...MAIN, branch: 'release' }], viewRevision: 'v2',
    }))
    expect(screen.getByText('release')).toBeDefined()
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false)

    await act(async () => secondUpdate.resolve({ status: 'prompt', prompt: PROMPT, viewRevision: 'v3' }))
    const remaining = screen.getByRole<HTMLInputElement>('checkbox')
    const add = screen.getByRole<HTMLButtonElement>('button', { name: 'worktree.add' })
    expect(remaining.checked).toBe(false)
    expect(add.disabled).toBe(true)
    fireEvent.click(remaining)
    fireEvent.click(add)
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1'], 'add', {
      accesses: [{ id: 'p1', access: 'read-only' }],
    }))
  })

  it('renders the detected branch and drops the old description line', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    await openDialog(fakeClient({ prompt }))
    expect(screen.getAllByText('feature/notice').length).toBe(1)
    expect(screen.queryByText('worktree.listDescription')).toBeNull()
    expect(screen.getByRole('dialog').className).toContain('mrfw-worktreeDialog')
  })

  it('keeps a refused row visible, unchecked, and reports its code', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const resolve = vi.fn(async () => ({
      viewRevision: 'v2',
      prompts: [PROMPT, MAIN],
      resolved: [],
      skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
    }))
    await openDialog(fakeClient({ prompt, resolve }))
    fireEvent.click(screen.getByText('worktree.addSelected'))
    await waitFor(() => expect(screen.getByText(/worktree.rowError/)).toBeDefined())
    expect(screen.getByText(/error.worktree\/prompt-stale/)).toBeDefined()
    const boxes = screen.getAllByRole('checkbox')
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
  })

  it('closes on lost and stops polling', async () => {
    let calls = 0
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async () => {
      calls += 1
      return { status: 'lost' as const, viewRevision: 'v2' }
    })
    await openDialog(fakeClient({ prompt, wait }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const after = calls
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(after)
  })

  it('closes the Dialog without retrying when the long poll raises a PanelError', async () => {
    let calls = 0
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async () => {
      calls += 1
      throw new PanelError('worktree/inactive', 'gone')
    })
    await openDialog(fakeClient({ prompt, wait }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(1)
  })

  it('closes the Dialog on a stale long poll instead of remounting it', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async () => ({ status: 'stale' as const, viewRevision: 'v2', reason: 'empty' }))
    await openDialog(fakeClient({ prompt, wait }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const after = wait.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(wait.mock.calls.length).toBe(after)
  })

  it('previews without a write button and closes through the preview action', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    await openDialog(fakeClient({ prompt }), true)
    expect(screen.getByRole('dialog', { name: 'worktree.title' })).toBeDefined()
    expect(screen.getByText('worktree.previewOnly')).toBeDefined()
    expect(screen.getByText('worktree.previewClose')).toBeDefined()
    expect(screen.queryByText('worktree.add')).toBeNull()
    expect(screen.queryByLabelText('worktree.snoozeLabel')).toBeNull()
  })
})

describe('worktree notice: presentation and accessibility', () => {
  it('is a labeled region whose live status holds only the copy', async () => {
    renderPrompt(fakeClient({ prompt: async () => answer([PROMPT]) }))
    const region = await screen.findByRole('region', { name: 'worktree.toastLabel' })
    expect(region.getAttribute('data-placement')).toBe('hero')
    expect(region.getAttribute('role')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('worktree.toast')
    expect(screen.getByRole('group', { name: 'worktree.toastActions' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'worktree.toastView' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'worktree.toastLater' })).toBeDefined()
    expect(screen.getByLabelText('worktree.toastLaterOptions')).toBeDefined()
    // The close badge is its own control, not a member of the action group:
    // screen readers must not announce it as one of the suggestion actions.
    const actions = screen.getByRole('group', { name: 'worktree.toastActions' })
    const close = screen.getByRole('button', { name: 'worktree.toastClose' })
    expect(actions.contains(close)).toBe(false)
    // The badge is self-drawn: no primitive size/variant attributes,
    // which is what keeps it a circle instead of the compact rounded control.
    expect(close.getAttribute('data-size')).toBeNull()
    expect(close.getAttribute('data-variant')).toBeNull()
  })

  it('applies the default delay from the split text half', async () => {
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt: async () => answer([PROMPT]), snooze }))
    fireEvent.click(await screen.findByRole('button', { name: 'worktree.toastLater' }))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: 'until-new-worktree' }))
    await waitFor(() => expect(screen.queryByText('worktree.snooze.7d')).toBeNull())
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
  })

  it('opens the snooze menu from the chevron half, exposes its state, and closes after a pick', async () => {
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt: async () => answer([PROMPT]), snooze }))
    const trigger = await screen.findByLabelText('worktree.toastLaterOptions')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByText('worktree.snooze.7d')).toBeDefined()
    fireEvent.click(screen.getByText('worktree.snooze.7d'))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: '7d' }))
    await waitFor(() => expect(screen.queryByText('worktree.snooze.7d')).toBeNull())
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
  })

  it('takes the compact form for a coarse pointer', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    renderPrompt(fakeClient({ prompt: async () => answer([PROMPT]) }))
    const region = await screen.findByRole('region', { name: 'worktree.toastLabel' })
    await waitFor(() => expect(region.getAttribute('data-compact')).toBe('true'))
    // The corner badge is part of the notice in both forms, not of the action row.
    expect(screen.getByRole('button', { name: 'worktree.toastClose' })).toBeDefined()
  })
})

describe('worktree notice: manual entry', () => {
  it('opens the suggestion dialog when the panel asks for it', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    renderPrompt(fakeClient({ prompt }))
    await screen.findByText('worktree.toast')
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    await screen.findByRole('dialog')
    await waitFor(() => expect(prompt.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })
})

describe('worktree notice: the operator closes or delays it', () => {
  it('snoozes with the default until-new-worktree mode and writes no registration', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt, snooze, resolve }))
    await chooseSnooze('until-new-worktree')
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: 'until-new-worktree' }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    expect(resolve).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['7d', '30d'] as const)('snoozes with the %s mode', async mode => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt, snooze }))
    await chooseSnooze(mode)
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1', 'm1'], { mode }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
  })

  it('a failed snooze still closes the notice without retrying', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const snooze = vi.fn(async () => { throw new PanelError('worktree/not-enabled', 'off') })
    renderPrompt(fakeClient({ prompt, snooze }))
    await chooseSnooze('7d')
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(snooze).toHaveBeenCalledTimes(1)
  })

  it('keeps a new session notice when the previous session snooze fails', async () => {
    const session = sessionHarness('s1')
    let rejectSnooze: ((reason?: unknown) => void) | undefined
    const snooze = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['snooze']>>>((_resolve, reject) => {
      rejectSnooze = reject
    }))
    const prompt = vi.fn(async (sessionId: string) => answer(sessionId === 's1' ? [PROMPT] : [MAIN, OTHER]))
    render(<WorktreePrompt client={fakeClient({ prompt, snooze })} sessionId={session.read}
      subscribeSession={session.subscribe} t={tWithParams} previewOnly={false} />)
    await chooseSnooze('7d')
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: '7d' }))
    session.switchTo('s2')
    await screen.findByText('worktree.toast:2')
    // s1's request settles only after s2 has shown its own notice. It must not
    // clear a notice its lifecycle no longer owns: s2's candidates were already
    // claimed through `seen`, so the operator would never see them again.
    await act(async () => { rejectSnooze?.(new PanelError('worktree/prompt-stale', 'stale')) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByText('worktree.toast:2')).toBeDefined()
  })

  it('keeps a re-shown notice when an earlier snooze succeeds after a session round trip', async () => {
    const session = sessionHarness('s1')
    let finishSnooze: ((answer: Awaited<ReturnType<WorktreeClient['snooze']>>) => void) | undefined
    const snooze = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['snooze']>>>((resolve) => {
      finishSnooze = resolve
    }))
    const prompt = vi.fn(async (sessionId: string) => answer(sessionId === 's1' ? [PROMPT] : []))
    render(<WorktreePrompt client={fakeClient({ prompt, snooze })} sessionId={session.read}
      subscribeSession={session.subscribe} t={tWithParams} previewOnly={false} />)
    await chooseSnooze('7d')
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: '7d' }))
    session.switchTo('s2')
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
    prompt.mockImplementation(async (sessionId: string) => answer(sessionId === 's1' ? [MAIN, OTHER] : []))
    session.switchTo('s1')
    await screen.findByText('worktree.toast:2')
    // The old snooze belongs to the first s1 activation. Its completion must not
    // close the notice the second activation owns, even though the session id is
    // the same again.
    await act(async () => {
      finishSnooze?.({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] })
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByText('worktree.toast:2')).toBeDefined()
  })

  it('closes the notice on × without recording a delay or a dismissal', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const seen = vi.fn(async () => ({ seen: 1 }))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt, seen, snooze, resolve }))
    await screen.findByText('worktree.toast')
    await waitFor(() => expect(seen).toHaveBeenCalledWith('s1', ['p1']))
    fireEvent.click(screen.getByRole('button', { name: 'worktree.toastClose' }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(snooze).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    // Closing records nothing: the display itself already claimed the candidates.
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('keeps a ×-closed notice closed when an in-flight reminder completion lands', async () => {
    let finishSnooze: ((answer: Awaited<ReturnType<WorktreeClient['snooze']>>) => void) | undefined
    const snooze = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['snooze']>>>((resolve) => {
      finishSnooze = resolve
    }))
    renderPrompt(fakeClient({ prompt: async () => answer([PROMPT]), snooze }))
    // The request starts from the split text half and stays in flight; the
    // notice only closes once the host answers.
    fireEvent.click(await screen.findByRole('button', { name: 'worktree.toastLater' }))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: 'until-new-worktree' }))
    fireEvent.click(screen.getByRole('button', { name: 'worktree.toastClose' }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    // A skipped row would normally keep the notice alive for a retry; the ×
    // belongs to a lifecycle that ended, so its completion owns nothing.
    const refreshed: WorktreePromptView = { ...PROMPT, id: 'p2', viewRevision: 'v2' }
    await act(async () => {
      finishSnooze?.({
        viewRevision: 'v2',
        prompts: [refreshed],
        resolved: [],
        skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
      })
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })

  it('keeps the notice for a reminder choice the host skipped so it can be retried', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const refreshed: WorktreePromptView = { ...PROMPT, id: 'p2', viewRevision: 'v2' }
    const snooze = vi.fn(async () => ({
      viewRevision: 'v2',
      prompts: [refreshed],
      resolved: [],
      skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
    }))
    renderPrompt(fakeClient({ prompt, snooze }))
    await chooseSnooze('7d')
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))
    // Nothing was delayed: the notice must stay for the still-unresolved
    // candidate (with its refreshed id) instead of silently hiding it for the
    // rest of this Host lifetime.
    await waitFor(() => expect(screen.getByText('worktree.toast')).toBeDefined())
    expect(screen.getByText('worktree.toastView')).toBeDefined()
  })
})

describe('worktree Dialog: later / do not remind', () => {
  it('turns the permanent option into one dismiss-with-dontRemind batch', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    await openDialog(fakeClient({ prompt, resolve, snooze }))
    await chooseDialogSnooze('permanent')
    fireEvent.click(screen.getByText('worktree.notNow'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1', 'm1'], 'dismiss', { dontRemind: true }))
    expect(snooze).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('turns the 7d option into one snooze batch', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    await openDialog(fakeClient({ prompt, resolve, snooze }))
    await chooseDialogSnooze('7d')
    fireEvent.click(screen.getByText('worktree.notNow'))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1', 'm1'], { mode: '7d' }))
    expect(resolve).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('reports a failed later batch inside the Dialog and keeps it open', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const resolve = vi.fn(async () => { throw new PanelError('worktree/prompt-stale', 'stale') })
    await openDialog(fakeClient({ prompt, resolve }))
    await chooseDialogSnooze('permanent')
    fireEvent.click(screen.getByText('worktree.dismiss'))
    await waitFor(() => expect(screen.getByText('error.worktree/prompt-stale')).toBeDefined())
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('keeps a skipped later-batch row in the Dialog with its refreshed id', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const refreshed: WorktreePromptView = { ...PROMPT, id: 'p2', viewRevision: 'v2' }
    const snooze = vi.fn(async () => ({
      viewRevision: 'v2',
      prompts: [refreshed],
      resolved: [],
      skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
    }))
    await openDialog(fakeClient({ prompt, snooze }))
    await chooseDialogSnooze('7d')
    fireEvent.click(screen.getByText('worktree.dismiss'))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: '7d' }))
    // The row changed while the Dialog was open and the host applied no delay:
    // closing would lose the choice and keep the `seen` claim hiding the
    // candidate. Keep the refreshed row plus the failure for a retry.
    await waitFor(() => expect(screen.getByText(/worktree.rowError/)).toBeDefined())
    expect(screen.getByText(/error.worktree\/prompt-stale/)).toBeDefined()
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('keeps a partially skipped permanent batch open with the failure reported', async () => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const refreshed: WorktreePromptView = { ...PROMPT, id: 'p2', viewRevision: 'v2' }
    const resolve = vi.fn(async () => ({
      viewRevision: 'v2',
      prompts: [refreshed, { ...MAIN, id: 'm2', viewRevision: 'v2' }],
      resolved: [],
      skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
    }))
    await openDialog(fakeClient({ prompt, resolve }))
    await chooseDialogSnooze('permanent')
    fireEvent.click(screen.getByText('worktree.notNow'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1', 'm1'], 'dismiss', { dontRemind: true }))
    await waitFor(() => expect(screen.getByText(/worktree.skipped/)).toBeDefined())
    expect(screen.getByRole('dialog')).toBeDefined()
  })
  it('closes the Dialog when the host answers that the feature is off', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const resolve = vi.fn(async () => { throw new PanelError('worktree/not-enabled', 'off') })
    await openDialog(fakeClient({ prompt, resolve }))
    await chooseDialogSnooze('permanent')
    fireEvent.click(screen.getByText('worktree.dismiss'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('worktree overlay: completion ownership', () => {
  it('keeps the new Dialog open when an earlier add completes after a session round trip', async () => {
    const session = sessionHarness('s1')
    let finishAdd: ((answer: Awaited<ReturnType<WorktreeClient['resolve']>>) => void) | undefined
    const resolve = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['resolve']>>>((done) => {
      finishAdd = done
    }))
    const prompt = vi.fn(async (sessionId: string) => answer(sessionId === 's1' ? [PROMPT] : []))
    render(<WorktreePrompt client={fakeClient({ prompt, resolve })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('worktree.add'))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    session.switchTo('s2')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    session.switchTo('s1')
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    // The first add belongs to the first s1 activation. Its zero-row answer
    // would close the Dialog in the old completion, whose session check passes.
    await act(async () => {
      finishAdd?.({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] })
    })
    await new Promise(done => setTimeout(done, 20))
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('keeps the new Dialog open when an earlier later-batch completes after a session round trip', async () => {
    const session = sessionHarness('s1')
    let finishSnooze: ((answer: Awaited<ReturnType<WorktreeClient['snooze']>>) => void) | undefined
    const snooze = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['snooze']>>>((done) => {
      finishSnooze = done
    }))
    const prompt = vi.fn(async (sessionId: string) => answer(sessionId === 's1' ? [PROMPT] : []))
    render(<WorktreePrompt client={fakeClient({ prompt, snooze })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('worktree.dismiss'))
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))
    session.switchTo('s2')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    session.switchTo('s1')
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    await act(async () => {
      finishSnooze?.({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] })
    })
    await new Promise(done => setTimeout(done, 20))
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('keeps a notice closed by the Dialog when a pending snooze reports a skipped row', async () => {
    let finishSnooze: ((answer: Awaited<ReturnType<WorktreeClient['snooze']>>) => void) | undefined
    const snooze = vi.fn(() => new Promise<Awaited<ReturnType<WorktreeClient['snooze']>>>((done) => {
      finishSnooze = done
    }))
    const prompt = vi.fn(async () => answer([PROMPT, OTHER]))
    renderPrompt(fakeClient({ prompt, snooze }))
    await chooseSnooze('7d')
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))
    // Opening the Dialog owns the notice's epoch from here on.
    fireEvent.click(screen.getByText('worktree.toastView'))
    await screen.findByRole('dialog')
    await act(async () => {
      finishSnooze?.({
        viewRevision: 'v2',
        prompts: [PROMPT, OTHER],
        resolved: [],
        skipped: [{ id: 'p1', key: PROMPT.key, code: 'worktree/prompt-stale' }],
      })
    })
    await new Promise(done => setTimeout(done, 20))
    expect(screen.queryByText('worktree.toastLater')).toBeNull()
    expect(screen.getByRole('dialog')).toBeDefined()
  })
})

describe('worktree overlay: session and settings lifetime', () => {
  it('aborts the old session check and runs a new one after a session switch', async () => {
    const session = sessionHarness('s1')
    const prompt = vi.fn((sessionId: string, _query?: { fresh?: boolean }, signal?: AbortSignal) => {
      if (sessionId === 's1') return pendingWait(signal)
      return answer([PROMPT])
    })
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    const firstSignal = prompt.mock.calls[0]![2]
    session.switchTo('s2')
    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    expect(await screen.findByText('worktree.toast')).toBeDefined()
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
    expect(prompt.mock.calls[1]![0]).toBe('s2')
    expect(prompt.mock.calls[1]![1]).toEqual({ fresh: true })
  })

  it('closes the notice when the session switches away', async () => {
    const session = sessionHarness('s1')
    const prompt = vi.fn(async () => answer([PROMPT]))
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    await screen.findByText('worktree.toast')
    prompt.mockImplementation(async () => answer([]))
    session.switchTo('s2')
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    // Two prompts: the first session's, then s2's (empty) activation.
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
  })

  it('closes the Dialog and aborts its wait when the session switches', async () => {
    const session = sessionHarness('s1')
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    render(<WorktreePrompt client={fakeClient({ prompt, wait })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    const waitSignal = wait.mock.calls[0]![2]
    session.switchTo('s2')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(waitSignal?.aborted).toBe(true)
    const after = wait.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(wait.mock.calls.length).toBe(after)
  })

  it('hides the notice when the settings switch turns off and does not re-check on enable', async () => {
    let enabled = true
    let settingsListener: (() => void) | undefined
    const prompt = vi.fn(async () => answer([PROMPT]))
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={t} previewOnly={false}
      readEnabled={() => enabled}
      subscribeEnabled={(listener) => { settingsListener = listener; return () => { settingsListener = undefined } }} />)
    await screen.findByText('worktree.toast')
    act(() => { enabled = false; settingsListener?.() })
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    act(() => { enabled = true; settingsListener?.() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })

  it('aborts an open Dialog wait when the settings switch turns off', async () => {
    let enabled = true
    let settingsListener: (() => void) | undefined
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    render(<WorktreePrompt client={fakeClient({ prompt, wait })} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={t} previewOnly={false}
      readEnabled={() => enabled}
      subscribeEnabled={(listener) => { settingsListener = listener; return () => { settingsListener = undefined } }} />)
    fireEvent.click(await screen.findByText('worktree.toastView'))
    await screen.findByRole('dialog')
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    const waitSignal = wait.mock.calls[0]![2]
    act(() => { enabled = false; settingsListener?.() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(waitSignal?.aborted).toBe(true)
  })

  it('closes the Dialog and aborts the in-flight wait on an explicit close', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    // The preview's close action is the Dialog's state-free explicit close: it
    // aborts the wait without writing any prompt decision.
    await openDialog(fakeClient({ prompt, wait }), true)
    await waitFor(() => expect(wait).toHaveBeenCalledTimes(1))
    const waitSignal = wait.mock.calls[0]![2]
    fireEvent.click(screen.getByText('worktree.previewClose'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(waitSignal?.aborted).toBe(true)
    const after = wait.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(wait.mock.calls.length).toBe(after)
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a single notice under React StrictMode', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const seen = vi.fn(async () => ({ seen: 1 }))
    render(<StrictMode>
      <WorktreePrompt client={fakeClient({ prompt, seen })} sessionId={() => 's1'}
        subscribeSession={() => () => {}} t={t} previewOnly={false} />
    </StrictMode>)
    await screen.findByText('worktree.toast')
    expect(screen.getAllByText('worktree.toast').length).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prompt.mock.calls.length).toBeLessThanOrEqual(2)
    await waitFor(() => expect(seen).toHaveBeenCalled())
  })
})

/** One confirmed-missing tracked worktree row the cleanup flow may remove. */
function deletedRoot(ordinal: number, id: string): RootView {
  return {
    ordinal,
    id,
    path: `/deleted/${id}`,
    addedAt: '2026-11-09T00:00:00.000Z',
    state: 'missing',
    access: 'inherit',
    worktree: { adminId: `admin-${id}`, path: `/deleted/${id}`, state: 'directory-missing', cleanupEligible: true },
  }
}

/** A plain available additional root: no worktree facts, full action set. */
const AVAILABLE_ROOT: RootView = {
  ordinal: 1,
  id: 'available',
  path: '/available',
  addedAt: '2026-09-12T00:00:00.000Z',
  state: 'available',
  access: 'inherit',
}

/** Build a roots view whose cleanup count follows the eligible rows. */
function cleanableView(roots: readonly RootView[], overrides: Partial<RootsView> = {}): RootsView {
  const eligible = roots.filter(root => root.worktree?.cleanupEligible === true).length
  return {
    primaryRoot: '/main',
    roots,
    limit: 16,
    count: roots.length,
    ...(eligible > 0 ? { worktreeCleanupCount: eligible } : {}),
    ...overrides,
  }
}

/** Render the panel with one canned view and a scripted worktree client. */
function renderManager(view: RootsView, worktrees: WorktreeClient, onClose: () => void = () => {}): void {
  render(<WorkspaceFoldersDialog
    panel={{ call: async () => view } as unknown as PanelClient}
    pickDirectory={undefined}
    t={t}
    sessionId={() => 's1'}
    onClose={onClose}
    worktrees={worktrees} />)
}

/** The cleanup confirmation's accessible name (the translator is an identity). */
const CLEANUP_TITLE = 'worktree.cleanupTitle'

/** The cleanup confirmation currently on screen. */
function cleanupDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: CLEANUP_TITLE })
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

/** One cleanup answer carrying the view the host would return afterwards. */
function cleanupAnswer(roots: RootsView, removed: readonly string[] = []) {
  return { removed, skipped: [] as { id: string; code: string }[], roots }
}

describe('panel cleanup controls', () => {
  it('offers a manual worktree entry beside Retry and asks the overlay to open', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    const onClose = vi.fn()
    const request = vi.fn(() => true)
    const stop = onWorktreePromptRequest(request)
    try {
      render(<WorkspaceFoldersDialog
        panel={panel}
        pickDirectory={undefined}
        t={t}
        sessionId={() => 's1'}
        onClose={onClose}
        worktrees={fakeClient()}
        worktreePromptEnabled={() => true} />)
      const entry = await screen.findByRole('button', { name: 'worktree.panelOpen' })
      fireEvent.click(entry)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledExactlyOnceWith('s1')
    } finally {
      stop()
    }
  })

  it('hides the manual worktree entry when the feature is off', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    render(<WorkspaceFoldersDialog
      panel={panel}
      pickDirectory={undefined}
      t={t}
      sessionId={() => 's1'}
      onClose={() => {}}
      worktrees={fakeClient()}
      worktreePromptEnabled={() => false} />)
    await waitFor(() => expect(screen.getByText('/main')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'worktree.panelOpen' })).toBeNull()
  })

  it('seats the batch action on the additional section title and out of the footer', async () => {
    renderManager(cleanableView([deletedRoot(1, 'r1')]), fakeClient())
    const batch = await screen.findByText('worktree.cleanupBatch')
    // The entry belongs to the rows it acts on, not to the footer control row.
    expect(batch.closest('.mrfw-sectionTitleRow')).not.toBeNull()
    expect(batch.closest('.mrfw-sectionTitleRowAction')).not.toBeNull()
    expect(batch.closest('.mrfw-sectionAction')).not.toBeNull()
    expect(batch.closest('.mrfw-actions')).toBeNull()
    // Nothing destructive is left in the footer.
    expect(document.querySelector('.mrfw-actions .mrfw-btnDanger')).toBeNull()
    expect(screen.getByRole('button', { name: 'panel.retry' })).toBeTruthy()
  })

  it('renders no batch action while no tracked root is cleanup-eligible', async () => {
    renderManager(cleanableView([AVAILABLE_ROOT]), fakeClient())
    await waitFor(() => { expect(screen.getByText('/available')).toBeTruthy() })
    expect(screen.queryByText('worktree.cleanupBatch')).toBeNull()
  })

  it('confirms in a host Modal and cleans up the exact eligible ids', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    const cleanup = vi.fn(async () => cleanupAnswer(cleanableView([]), ['r1']))
    renderManager(view, fakeClient({ cleanup }))
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    // The confirmation is the host Modal layered over the panel, not an inline note.
    const dialog = cleanupDialog()
    expect(within(dialog).getByText('worktree.cleanupConfirm')).toBeTruthy()
    expect(within(dialog).getByText('worktree.pathReuse')).toBeTruthy()
    expect(within(dialog).getByText('worktree.cleanupDo')).toBeTruthy()
    expect(within(dialog).getByText('panel.aliasCancel')).toBeTruthy()
    expect(document.querySelector('.mrfw-body > .mrfw-note[role="alert"]')).toBeNull()
    fireEvent.click(within(dialog).getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledWith('s1', ['r1']))
    await waitFor(() => expect(screen.queryByText('/deleted/r1')).toBeNull())
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
  })

  it('opens the shared confirmation from a row delete and submits only that id', async () => {
    const view = cleanableView([deletedRoot(1, 'r1'), deletedRoot(2, 'r2')])
    const cleanup = vi.fn(async () => cleanupAnswer(cleanableView([]), ['r2']))
    renderManager(view, fakeClient({ cleanup }))
    await screen.findByText('worktree.cleanupBatch')
    const deletes = screen.getAllByRole('button', { name: 'worktree.cleanup' })
    expect(deletes).toHaveLength(2)
    // The row's red delete is reachable by name and title.
    expect(deletes[1]!.getAttribute('title')).toBe('worktree.cleanup')
    expect(deletes[1]!.getAttribute('aria-label')).toBe('worktree.cleanup')
    fireEvent.click(deletes[1]!)
    const dialog = cleanupDialog()
    // One id discloses the singular path-reuse risk.
    expect(within(dialog).getByText('worktree.pathReuse')).toBeTruthy()
    expect(within(dialog).queryByText('worktree.pathReuseMany')).toBeNull()
    fireEvent.click(within(dialog).getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledWith('s1', ['r2']))
  })

  it('opens the same confirmation from the row menu cleanup item', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    renderManager(view, fakeClient())
    await screen.findByText('worktree.cleanupBatch')
    fireEvent.click(screen.getByRole('button', { name: 'panel.more' }))
    fireEvent.click(screen.getByText('worktree.cleanup'))
    expect(cleanupDialog()).toBeTruthy()
  })

  it('collapses a cleanup-eligible row to name, access, path, delete and menu', async () => {
    const root: RootView = { ...deletedRoot(1, 'r1'), skillsEnabled: true }
    renderManager(cleanableView([root]), fakeClient())
    await screen.findByText('worktree.cleanupBatch')
    // Kept: display name, access badge, copyable path, delete, menu.
    const row = document.querySelector('.mrfw-row:not(.mrfw-rowBare)') as HTMLElement
    expect(within(row).getByText('r1')).toBeTruthy()
    expect(within(row).getByText('access.inherit')).toBeTruthy()
    expect(within(row).getByText('/deleted/r1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'worktree.cleanup' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'panel.more' })).toBeTruthy()
    // Removed: both status lines, the inline risk note, re-register, skills, reveal.
    expect(screen.queryByText('state.missing')).toBeNull()
    expect(screen.queryByText('worktree.state.directory-missing')).toBeNull()
    expect(screen.queryByText('worktree.pathReuse')).toBeNull()
    expect(screen.queryByRole('button', { name: 'panel.reRegister' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'panel.skills' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'panel.reveal' })).toBeNull()
  })

  it('leaves non-eligible rows with their status text and ordinary actions', async () => {
    const changed: RootView = {
      ordinal: 1,
      id: 'changed',
      path: '/changed-wt',
      addedAt: '2026-11-09T00:00:00.000Z',
      state: 'missing',
      access: 'read-only',
      skillsEnabled: true,
      worktree: { adminId: 'a', path: '/changed-wt', state: 'changed', cleanupEligible: false },
    }
    // A directory-missing worktree that is NOT cleanup-eligible keeps the
    // ordinary row: only cleanupEligible === true collapses.
    const missing: RootView = {
      ...changed,
      ordinal: 2,
      id: 'ineligible',
      path: '/ineligible-missing',
      worktree: { adminId: 'b', path: '/ineligible-missing', state: 'directory-missing', cleanupEligible: false },
    }
    renderManager(cleanableView([changed, missing]), fakeClient())
    await waitFor(() => { expect(screen.getByText('/changed-wt')).toBeTruthy() })
    expect(screen.getByText('worktree.state.changed')).toBeTruthy()
    expect(screen.getByText('worktree.state.directory-missing')).toBeTruthy()
    expect(screen.getByText('worktree.pathReused')).toBeTruthy()
    expect(screen.getAllByText('state.missing')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'panel.reRegister' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'panel.skills' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'panel.reveal' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'worktree.cleanup' })).toBeNull()
    expect(screen.queryByText('worktree.cleanupBatch')).toBeNull()
  })

  it('discloses the plural risk when the batch names more than one id', async () => {
    renderManager(cleanableView([deletedRoot(1, 'r1'), deletedRoot(2, 'r2')]), fakeClient())
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    const dialog = cleanupDialog()
    expect(within(dialog).getByText('worktree.pathReuseMany')).toBeTruthy()
    expect(within(dialog).queryByText('worktree.pathReuse')).toBeNull()
  })

  it('keeps the confirmation open and localizes a failed cleanup', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    const cleanup = vi.fn(async () => { throw new PanelError('worktree/not-eligible', 'host prose') })
    renderManager(view, fakeClient({ cleanup }))
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    const dialog = cleanupDialog()
    fireEvent.click(within(dialog).getByText('worktree.cleanupDo'))
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe('error.worktree/not-eligible')
    })
    // Still open, row untouched, host prose not shown, panel body alert clean.
    expect(cleanupDialog()).toBeTruthy()
    expect(screen.getByText('/deleted/r1')).toBeTruthy()
    expect(within(dialog).queryByText(/host prose/)).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Cancelling drops the local error together with the dialog.
    fireEvent.click(within(dialog).getByText('panel.aliasCancel'))
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('/deleted/r1')).toBeTruthy()
  })

  it('reports a failure in the panel body when the confirmation was dismissed mid-request', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    const pending = deferred<ReturnType<typeof cleanupAnswer>>()
    const cleanup = vi.fn(() => pending.promise)
    renderManager(view, fakeClient({ cleanup }))
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    const dialog = cleanupDialog()
    fireEvent.click(within(dialog).getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    // The fixed close control cannot cancel a submitted request: it only
    // dismisses the dialog, and the failure lands on the panel's own alert.
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
    await act(async () => { pending.reject(new PanelError('unavailable', 'socket closed')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('error.unavailable')
    expect(alert.textContent).toContain('socket closed')
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
  })

  it('disables cancel while the request runs and lets a dismiss keep the request alive', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    const pending = deferred<ReturnType<typeof cleanupAnswer>>()
    const cleanup = vi.fn(() => pending.promise)
    renderManager(view, fakeClient({ cleanup }))
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    const dialog = cleanupDialog()
    fireEvent.click(within(dialog).getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    // The footer's cancel cannot be used while the deletion is submitted.
    expect((within(dialog).getByRole('button', { name: 'panel.aliasCancel' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
    await act(async () => { pending.resolve(cleanupAnswer(cleanableView([]), ['r1'])) })
    await waitFor(() => expect(screen.queryByText('/deleted/r1')).toBeNull())
    // Dismissing the dialog did not cancel or duplicate the request.
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('adopts an answer that lands after the confirmation was dismissed and does not reopen it', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    const pending = deferred<ReturnType<typeof cleanupAnswer>>()
    const cleanup = vi.fn(() => pending.promise)
    renderManager(view, fakeClient({ cleanup }))
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    fireEvent.click(within(cleanupDialog()).getByText('worktree.cleanupDo'))
    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    fireEvent.click(within(cleanupDialog()).getByRole('button', { name: 'panel.close' }))
    await act(async () => { pending.resolve(cleanupAnswer(cleanableView([]), ['r1'])) })
    await waitFor(() => expect(screen.queryByText('/deleted/r1')).toBeNull())
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
  })

  it('keeps exactly one confirmation on screen when the other layer opens', async () => {
    const view = cleanableView([deletedRoot(1, 'r1')])
    renderManager(view, fakeClient())
    await screen.findByText('worktree.cleanupBatch')
    // Open the access-upgrade layer, then the cleanup layer: the upgrade goes.
    fireEvent.click(screen.getByRole('button', { name: 'panel.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'panel.accessReadWrite' }))
    expect(screen.getByRole('dialog', { name: 'panel.accessUpgradeTitle' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'worktree.cleanup' }))
    expect(screen.queryByRole('dialog', { name: 'panel.accessUpgradeTitle' })).toBeNull()
    expect(cleanupDialog()).toBeTruthy()
    // And the reverse: opening the upgrade layer drops the cleanup one.
    fireEvent.click(screen.getByRole('button', { name: 'panel.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'panel.accessReadWrite' }))
    expect(screen.getByRole('dialog', { name: 'panel.accessUpgradeTitle' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: CLEANUP_TITLE })).toBeNull()
  })

  it('closes an open row menu when the confirmation opens', async () => {
    renderManager(cleanableView([deletedRoot(1, 'r1')]), fakeClient())
    await screen.findByText('worktree.cleanupBatch')
    fireEvent.click(screen.getByRole('button', { name: 'panel.more' }))
    expect(document.querySelector('[data-menu]')).not.toBeNull()
    // The menu's cleanup item, not the row's icon-only delete (same name).
    fireEvent.click(screen.getByText('worktree.cleanup'))
    expect(document.querySelector('[data-menu]')).toBeNull()
    expect(cleanupDialog()).toBeTruthy()
  })

  it('never closes the panel on Escape while the confirmation owns the keyboard', async () => {
    const onClose = vi.fn()
    renderManager(cleanableView([deletedRoot(1, 'r1')]), fakeClient(), onClose)
    fireEvent.click(await screen.findByText('worktree.cleanupBatch'))
    const panelDialog = document.querySelector('.mrfw-dialog') as HTMLElement
    fireEvent.keyDown(panelDialog, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(cleanupDialog()).toBeTruthy()
  })

  it('does not run the automatic worktree check when the panel renders', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    let listed = false
    const panel = { call: async () => { listed = true; return view } } as unknown as PanelClient
    const prompt = vi.fn(async () => answer([PROMPT]))
    render(<WorkspaceFoldersDialog
      panel={panel}
      pickDirectory={undefined}
      t={t}
      sessionId={() => 's1'}
      onClose={() => {}}
      worktrees={fakeClient({ prompt })} />)
    await waitFor(() => expect(listed).toBe(true))
    expect(prompt).not.toHaveBeenCalled()
    expect(screen.queryByText('worktree.toast')).toBeNull()
  })
})

describe('manual worktree discovery with no candidates', () => {
  /** Mount the overlay and let its one automatic check settle. */
  async function mountIdle(prompt: ReturnType<typeof vi.fn<WorktreeClient['prompt']>>): Promise<void> {
    renderPrompt(fakeClient({ prompt }))
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
  }

  it('announces an empty manual result with the info Toast and opens no Dialog', async () => {
    const prompt = vi.fn<WorktreeClient['prompt']>(async () => answer([]))
    await mountIdle(prompt)
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    const toast = await screen.findByRole('status')
    expect(toast.textContent).toBe('worktree.noCandidates')
    expect(toast.getAttribute('data-hold-ms')).toBe(String(WORKTREE_EMPTY_NOTICE_HOLD_MS))
    // The primitive's lowest-level form: no icon and no tone.
    expect(toast.querySelector('svg')).toBeNull()
    expect(toast.getAttribute('data-tone')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    // The manual entry performs its own non-fresh prompt after the auto check.
    expect(prompt).toHaveBeenLastCalledWith('s1', undefined, expect.anything())
  })

  it('stays silent for the automatic fresh check and the notice View race', async () => {
    const prompt = vi.fn<WorktreeClient['prompt']>(async (_session, options) => answer(options?.fresh === true ? [PROMPT] : []))
    renderPrompt(fakeClient({ prompt }))
    // The notice appears; the automatic check never shows the empty Toast.
    await screen.findByText('worktree.toast')
    expect(screen.queryByText('worktree.noCandidates')).toBeNull()
    fireEvent.click(screen.getByText('worktree.toastView'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The View path raced to an empty list: still silent.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.queryByText('worktree.noCandidates')).toBeNull()
  })

  it('stays silent when the manual prompt itself fails', async () => {
    const prompt = vi.fn<WorktreeClient['prompt']>(async (_session, options) => {
      if (options?.fresh === true) return answer([])
      throw new PanelError('unavailable', 'boom')
    })
    await mountIdle(prompt)
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses the Toast through its onDone and can announce again', async () => {
    const prompt = vi.fn<WorktreeClient['prompt']>(async () => answer([]))
    await mountIdle(prompt)
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    fireEvent.click(await screen.findByRole('status'))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    expect((await screen.findByRole('status')).textContent).toBe('worktree.noCandidates')
  })

  it('clears a shown Toast when the session changes', async () => {
    const session = sessionHarness('s1')
    const prompt = vi.fn<WorktreeClient['prompt']>(async () => answer([]))
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={session.read}
      subscribeSession={session.subscribe} t={t} previewOnly={false} />)
    await waitFor(() => expect(prompt).toHaveBeenCalled())
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    await screen.findByRole('status')
    act(() => { session.switchTo('s2') })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('clears a shown Toast when the feature is switched off', async () => {
    let enabled = true
    let settingsListener: (() => void) | undefined
    const prompt = vi.fn<WorktreeClient['prompt']>(async () => answer([]))
    render(<WorktreePrompt client={fakeClient({ prompt })} sessionId={() => 's1'}
      subscribeSession={() => () => {}} t={t} previewOnly={false}
      readEnabled={() => enabled}
      subscribeEnabled={(listener) => { settingsListener = listener; return () => { settingsListener = undefined } }} />)
    await waitFor(() => expect(prompt).toHaveBeenCalled())
    act(() => { expect(requestWorktreePrompt('s1')).toBe(true) })
    await screen.findByRole('status')
    act(() => { enabled = false; settingsListener?.() })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
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

/**
 * The Files-tab manager is a second entry to the same dialog: it is the only
 * path that constructs the dialog through `RootSwitcher`, so the worktree props
 * must travel through that component instead of only through the footer/Hero.
 */
describe('Files manager worktree entry', () => {
  it('keeps the Files manager open until its own session can open suggestions', async () => {
    const session = sessionHarness('s1')
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    const prompt = vi.fn<WorktreeClient['prompt']>(async (_session, options) => answer(options?.fresh ? [] : [PROMPT]))
    const worktrees = fakeClient({ prompt })
    render(<>
      <WorktreePrompt client={worktrees} sessionId={session.read} subscribeSession={session.subscribe} t={t} previewOnly={false} />
      <RootSwitcher primaryPath="/main" panel={panel} pickDirectory={undefined} sessionId={() => 's1'} t={t} worktrees={worktrees} />
    </>)
    fireEvent.click(document.querySelector('.mrfw-rootSwitchBtn')!)
    fireEvent.click(await screen.findByText('switcher.manage'))
    const entry = await screen.findByRole('button', { name: 'worktree.panelOpen' })

    session.switchTo('s2')
    fireEvent.click(entry)
    expect(screen.queryByRole('button', { name: 'worktree.panelOpen' })).toBe(entry)
    expect(prompt).not.toHaveBeenCalledWith('s2', undefined, expect.anything())

    session.switchTo('s1')
    fireEvent.click(entry)
    await screen.findByRole('dialog', { name: 'worktree.title' })
    expect(prompt).toHaveBeenCalledWith('s1', undefined, expect.anything())
    expect(screen.queryByRole('button', { name: 'worktree.panelOpen' })).toBeNull()
  })

  it('forwards the worktree props so the manager offers the manual suggestion entry', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    const request = vi.fn(() => true)
    const stop = onWorktreePromptRequest(request)
    try {
      render(<RootSwitcher
        primaryPath="/main"
        panel={panel}
        pickDirectory={undefined}
        sessionId={() => 's1'}
        t={t}
        worktrees={fakeClient()}
        worktreePromptEnabled={() => true} />)
      fireEvent.click(document.querySelector('.mrfw-rootSwitchBtn')!)
      fireEvent.click(await screen.findByText('switcher.manage'))
      const entry = await screen.findByRole('button', { name: 'worktree.panelOpen' })
      fireEvent.click(entry)
      expect(request).toHaveBeenCalledExactlyOnceWith('s1')
    } finally {
      stop()
    }
  })

  it('keeps the entry out of the manager when the feature is switched off', async () => {
    const view: RootsView = { primaryRoot: '/main', roots: [], limit: 16, count: 0 }
    const panel = { call: async () => view } as unknown as PanelClient
    render(<RootSwitcher
      primaryPath="/main"
      panel={panel}
      pickDirectory={undefined}
      sessionId={() => 's1'}
      t={t}
      worktrees={fakeClient()}
      worktreePromptEnabled={() => false} />)
    fireEvent.click(document.querySelector('.mrfw-rootSwitchBtn')!)
    fireEvent.click(await screen.findByText('switcher.manage'))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'worktree.panelOpen' })).toBeNull()
  })
})
