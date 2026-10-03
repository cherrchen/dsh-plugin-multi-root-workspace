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
it('lazily expands additional directories and renders a bounded file preview', async () => {
  const call = vi.fn(async (endpoint, payload) => endpoint === 'readFile' ? { text: 'hello extra', eof: false }
    : payload.path === '.' ? { path: '.', entries: [{ name: 'src', type: 'directory' }], truncated: false }
    : { path: 'src', entries: [{ name: 'app.ts', type: 'file' }], truncated: false })
  render(<RootFileTree panel={{ call } as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  expect(call).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Browse files'))
  fireEvent.click(await screen.findByText('▸ src'))
  fireEvent.click(await screen.findByText('app.ts'))
  expect(await screen.findByText('hello extra')).toBeDefined()
  expect(screen.getByText('Showing the first 200 lines')).toBeDefined()
  expect(call).toHaveBeenLastCalledWith('readFile', { sessionId: 'session', entry, path: 'src/app.ts' })
})
it('shows no session without sending a request', async () => {
  const call = vi.fn()
  render(<RootFileTree panel={{ call }} entry={entry} sessionId={() => undefined} t={t} />)
  fireEvent.click(screen.getByText('Browse files'))
  expect(await screen.findByText('No active session')).toBeDefined()
  expect(call).not.toHaveBeenCalled()
})
it('discards late results when the tree is closed', async () => {
  let settle!: (view: FilesView) => void
  const call = vi.fn(() => new Promise<FilesView>(resolve => { settle = resolve }))
  render(<RootFileTree panel={{ call } as unknown as PanelClient} entry={entry} sessionId={() => 'session'} t={t} />)
  fireEvent.click(screen.getByText('Browse files'))
  await waitFor(() => expect(call).toHaveBeenCalled())
  fireEvent.click(screen.getByText('Browse files'))
  settle({ path: '.', entries: [{ name: 'stale', type: 'file' }], truncated: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByText('stale')).toBeNull()
})
it('validates endpoint-specific responses and rejects path-like child names', async () => {
  const client = createPanelClient({ rpc: { call: async () => ({ ok: true, value: { path: '.', entries: [{ name: '../escape', type: 'file' }], truncated: false } }) } } as never)
  await expect(client.call('files', { sessionId: 'session', entry })).rejects.toMatchObject({ code: 'panel/bad-response' })
  await expect(client.call('readFile', { sessionId: 'session', entry })).rejects.toMatchObject({ code: 'panel/bad-response' })
})
