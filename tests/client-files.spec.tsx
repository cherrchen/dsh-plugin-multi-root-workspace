// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RootFileTree } from '../src/client/RootFileTree.tsx'
import { createPanelClient } from '../src/client/panel-client.ts'
import { en, type Key } from '../src/client/locales.ts'
import type { PanelClient } from '../src/client/panel-client.ts'
import type { FilesView } from '../src/contract.ts'

afterEach(cleanup)
const entry = { ordinal: 1, id: 'root', path: '/extra', addedAt: 'now' }
const t = (key: Key) => en[key]
it('lists the root outright and lazily expands directories with a bounded file preview', async () => {
  const call = vi.fn(async (endpoint, payload) => endpoint === 'readFile' ? { text: 'hello extra', eof: false }
    : payload.path === '.' ? { path: '.', entries: [{ name: 'src', type: 'directory' }], truncated: false }
    : { path: 'src', entries: [{ name: 'app.ts', type: 'file' }], truncated: false })
  render(<RootFileTree panel={{ call } as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  // The switcher's tree has no Browse gate: the root listing goes out on mount.
  await waitFor(() => expect(call).toHaveBeenCalledWith('files', { sessionId: 'session', entry, path: '.' }, expect.any(AbortSignal)))
  fireEvent.click(await screen.findByText('▸ src'))
  fireEvent.click(await screen.findByText('app.ts'))
  expect(await screen.findByText('hello extra')).toBeDefined()
  expect(screen.getByText('Showing the first 200 lines')).toBeDefined()
  expect(call).toHaveBeenLastCalledWith('readFile', { sessionId: 'session', entry, path: 'src/app.ts' }, expect.any(AbortSignal))
})
it('refreshes in place on a reload bump without flashing the loading note', async () => {
  const call = vi.fn(async (_endpoint: string, payload: { path?: string }) => ({
    path: payload.path ?? '.',
    entries: [{ name: 'src', type: 'directory' as const }],
    truncated: false,
  }))
  const view = render(<RootFileTree panel={{ call } as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  await screen.findByText('▸ src')
  view.rerender(<RootFileTree panel={{ call } as PanelClient} entry={entry} sessionId={() => 'session'} t={t} reload={1} />)
  // The existing rows stay while the refetch is in flight.
  expect(screen.getByText('▸ src')).toBeDefined()
  expect(screen.queryByText(en['panel.loading'])).toBeNull()
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(screen.getByText('▸ src')).toBeDefined()
})
it('shows no session without sending a request', async () => {
  const call = vi.fn()
  render(<RootFileTree panel={{ call }} entry={entry} sessionId={() => undefined} t={t} />)
  expect(await screen.findByText('No active session')).toBeDefined()
  expect(call).not.toHaveBeenCalled()
})
it('discards late results after the tree unmounts', async () => {
  let settle!: (view: FilesView) => void
  const call = vi.fn(() => new Promise<FilesView>(resolve => { settle = resolve }))
  const view = render(<RootFileTree panel={{ call } as unknown as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  await waitFor(() => expect(call).toHaveBeenCalled())
  view.unmount()
  settle({ path: '.', entries: [{ name: 'stale', type: 'file' }], truncated: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByText('stale')).toBeNull()
})
it('aborts an in-flight listing when the tree unmounts', async () => {
  let observed: AbortSignal | undefined
  const call = vi.fn((_endpoint: string, _payload: unknown, signal?: AbortSignal) => {
    observed = signal
    return new Promise<FilesView>(() => {})
  })
  const view = render(<RootFileTree panel={{ call } as unknown as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  await waitFor(() => expect(observed).toBeInstanceOf(AbortSignal))
  view.unmount()
  expect(observed?.aborted).toBe(true)
})
it('validates endpoint-specific responses and rejects path-like child names', async () => {
  const client = createPanelClient({ rpc: { call: async () => ({ ok: true, value: { path: '.', entries: [{ name: '../escape', type: 'file' }], truncated: false } }) } } as never)
  await expect(client.call('files', { sessionId: 'session', entry })).rejects.toMatchObject({ code: 'panel/bad-response' })
  await expect(client.call('readFile', { sessionId: 'session', entry })).rejects.toMatchObject({ code: 'panel/bad-response' })
})
