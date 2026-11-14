// @vitest-environment jsdom
/** The worktree notice/Dialog overlay and the two-switch plugin card. */
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RootsView, WorktreePromptView } from '../src/contract.ts'
import { WorktreePrompt } from '../src/client/WorktreePrompt.tsx'
import { WorkspaceFoldersDialog } from '../src/client/WorkspaceFoldersAction.tsx'
import { PanelError, type PanelClient } from '../src/client/panel-client.ts'
import { BundleSettingsCard } from '../src/client/skills-settings.tsx'
import type { WorktreeClient } from '../src/client/worktree-client.ts'
import type { SkillsForm } from '../src/compat/skills-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = key => key
/** A translator that keeps its parameters, so a test can see the notice count. */
const tWithParams: Translate = (key, params) =>
  params === undefined ? key : key + ':' + Object.values(params).join(',')
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

  it('opens a single confirmation with the path and effective access copy', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    await openDialog(fakeClient({ prompt }))
    expect(screen.getByRole('dialog', { name: 'worktree.title' })).toBeDefined()
    expect(screen.getByText('/tmp/wt')).toBeDefined()
    expect(screen.getByText('worktree.policy')).toBeDefined()
    expect(screen.getByText('worktree.shared')).toBeDefined()
    expect(screen.getByText('worktree.add')).toBeDefined()
  })

  it('uses the main-checkout copy for a single main checkout candidate', async () => {
    const prompt = vi.fn(async () => answer([MAIN]))
    await openDialog(fakeClient({ prompt }))
    expect(screen.getByRole('dialog', { name: 'worktree.mainTitle' })).toBeDefined()
    expect(screen.getByText('/tmp/main')).toBeDefined()
    expect(screen.getByText('worktree.mainDescription')).toBeDefined()
    expect(screen.getByText('worktree.mainPolicy')).toBeDefined()
    expect(screen.getByText('worktree.mainSeparate')).toBeDefined()
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
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['m1'], 'add'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

describe('worktree notice: the operator closes or delays it', () => {
  it('snoozes with the default until-new-worktree mode and writes no registration', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    const resolve = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt, snooze, resolve }))
    const select = await screen.findByLabelText('worktree.toastLater')
    fireEvent.change(select, { target: { value: 'until-new-worktree' } })
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1'], { mode: 'until-new-worktree' }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    expect(resolve).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['7d', '30d'] as const)('snoozes with the %s mode', async mode => {
    const prompt = vi.fn(async () => answer([PROMPT, MAIN]))
    const snooze = vi.fn(async () => ({ viewRevision: 'v2', prompts: [], resolved: [], skipped: [] }))
    renderPrompt(fakeClient({ prompt, snooze }))
    const select = await screen.findByLabelText('worktree.toastLater')
    fireEvent.change(select, { target: { value: mode } })
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1', 'm1'], { mode }))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
  })

  it('the close button only dismisses the notice', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const snooze = vi.fn()
    const resolve = vi.fn()
    const wait = vi.fn(async (_sessionId: string, _seen: { seenViewRevision?: string }, signal?: AbortSignal) => pendingWait(signal))
    renderPrompt(fakeClient({ prompt, snooze, resolve, wait } as Partial<WorktreeClient>))
    await screen.findByLabelText('worktree.toastClose')
    fireEvent.click(screen.getByLabelText('worktree.toastClose'))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    expect(snooze).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })

  it('a failed snooze still closes the notice without retrying', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const snooze = vi.fn(async () => { throw new PanelError('worktree/not-enabled', 'off') })
    renderPrompt(fakeClient({ prompt, snooze }))
    const select = await screen.findByLabelText('worktree.toastLater')
    fireEvent.change(select, { target: { value: '7d' } })
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('worktree.toast')).toBeNull())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(snooze).toHaveBeenCalledTimes(1)
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
    fireEvent.change(await screen.findByLabelText('worktree.toastLater'), { target: { value: '7d' } })
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
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: 'permanent' } })
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
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: '7d' } })
    fireEvent.click(screen.getByText('worktree.notNow'))
    await waitFor(() => expect(snooze).toHaveBeenCalledWith('s1', ['p1', 'm1'], { mode: '7d' }))
    expect(resolve).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('reports a failed later batch inside the Dialog and keeps it open', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const resolve = vi.fn(async () => { throw new PanelError('worktree/prompt-stale', 'stale') })
    await openDialog(fakeClient({ prompt, resolve }))
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: 'permanent' } })
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
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: '7d' } })
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
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: 'permanent' } })
    fireEvent.click(screen.getByText('worktree.notNow'))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('s1', ['p1', 'm1'], 'dismiss', { dontRemind: true }))
    await waitFor(() => expect(screen.getByText(/worktree.skipped/)).toBeDefined())
    expect(screen.getByRole('dialog')).toBeDefined()
  })
  it('closes the Dialog when the host answers that the feature is off', async () => {
    const prompt = vi.fn(async () => answer([PROMPT]))
    const resolve = vi.fn(async () => { throw new PanelError('worktree/not-enabled', 'off') })
    await openDialog(fakeClient({ prompt, resolve }))
    fireEvent.change(screen.getByLabelText('worktree.snoozeLabel'), { target: { value: 'permanent' } })
    fireEvent.click(screen.getByText('worktree.dismiss'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    const panel = { call: async () => view } as unknown as PanelClient
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
