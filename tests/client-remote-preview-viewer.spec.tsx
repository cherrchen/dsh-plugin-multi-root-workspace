// @vitest-environment jsdom
/**
 * The remote preview Viewer's pin-readiness race (P8 rework): a body
 * mounted BEFORE the DSH resource occurrence pin lands must draw loading
 * without ever attempting a read, flip to ready autonomously when the
 * first pin arrives, expire when the pin dies — and never resurface
 * parked bytes while a fresh read is still in flight.
 *
 * The book is the REAL `RemotePreviewBook` over a deferred-RPC
 * authorization fake (its `wait` never settles; the lease is cleaned by
 * `dispose`) and a `RemoteFileContentClient` whose `read` the test
 * controls per call.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteFilesAuthorizationBook, type SshFilesIdentity } from '../src/client/file-preview/authorization.ts'
import { RemotePreviewBook } from '../src/client/file-preview/resource-book.ts'
import { RemotePreviewViewer } from '../src/client/file-preview/Viewer.tsx'
import type { PreviewTabInfo } from '../src/client/file-preview/install.tsx'
import type { RemoteFileContentClient } from '../src/client/remote-files-client.ts'
import type { RemoteFilesReadContent } from '../src/remote/files-contract.ts'

const t: TranslateNS<'multiRootWorkspace'> = key => key
afterEach(cleanup)

const SESSION = 's1' as SessionId
const IDENTITY: SshFilesIdentity = {
  sessionId: SESSION,
  root: { kind: 'remote', environmentId: 'dev', rootId: 'out' },
  incarnation: 'a'.repeat(64),
}
const enc = new TextEncoder()
const content = (text: string): RemoteFilesReadContent => {
  const bytes = enc.encode(text)
  return { kind: 'file', size: bytes.byteLength, complete: true, bytes }
}

/** Book over a never-settling lease and a per-call `read` fake. */
function harness(read: RemoteFileContentClient['read']) {
  const wait = vi.fn(() => Promise.withResolvers<void>().promise)
  const authorization = new RemoteFilesAuthorizationBook({ wait })
  const client: RemoteFileContentClient = { read: vi.fn(read) }
  const book = new RemotePreviewBook(client, authorization, () => SESSION)
  return { authorization, book, client }
}

const info = (address: string, signal: AbortSignal, visible: boolean): PreviewTabInfo => ({
  panel: { id: 'pane-1' as TabId, isFloating: false },
  tab: {
    id: 'tab-1' as TabId,
    contentId: address,
    visible,
    signal,
    actions: { bindCommands: () => () => {} },
  },
})

describe('the remote preview Code budget', () => {
  it('rechecks the budget on reload even if the user explicitly selected Code', async () => {
    const short = 'let x = 1;\n'
    const manyLines = 'x\n'.repeat(5000)
    const longLine = 'x'.repeat(128 * 1024 + 1)
    let source = short
    const { book, authorization } = harness(async () => content(source))
    const address = book.register(IDENTITY, 'source.ts', 'dev box')!
    book.pin(address, new AbortController().signal)
    const { container } = render(createElement(RemotePreviewViewer, props(book, info(address, new AbortController().signal, true))))
    const code = () => container.querySelector('[data-code-preview]')
    const plain = () => container.querySelector('[data-textpreview-plain]')
    const menu = () => screen.getByRole('button', { name: 'preview.openWith' })
    await waitFor(() => { expect(code()?.textContent).toBe(short) })
    fireEvent.click(menu())
    fireEvent.click(screen.getByText('preview.viewer.text'))
    expect(plain()?.textContent).toBe(short)
    fireEvent.click(menu())
    fireEvent.click(screen.getByText('preview.viewer.code'))
    expect(code()?.textContent).toBe(short)

    for (const next of [manyLines, longLine]) {
      source = next
      fireEvent.click(screen.getByRole('button', { name: 'preview.refresh' }))
      await waitFor(() => { expect(plain()?.textContent === next).toBe(true) })
      expect(code()).toBeNull()
      expect(screen.queryByRole('button', { name: 'preview.openWith' })).toBeNull()
    }
    book.dispose()
    authorization.dispose()
  })
})

const props = (book: RemotePreviewBook, tab: PreviewTabInfo) => ({
  sessionId: SESSION,
  info: tab,
  book,
  currentSession: () => SESSION,
  subscribeSession: () => () => {},
  t,
})

describe('the remote preview Viewer pin readiness', () => {
  it('loads without reading before the pin, reads once on it, and expires on pin death', async () => {
    const { book, authorization, client } = harness(async () => content('hello remote bytes'))
    const address = book.register(IDENTITY, 'notes.txt', 'dev box')!
    const tabSignal = new AbortController()
    render(createElement(RemotePreviewViewer, props(book, info(address, tabSignal.signal, true))))
    // Pre-pin: the record exists but the occurrence has not landed — a
    // mount must show loading WITHOUT attempting a read.
    expect(screen.getByText('preview.loading')).toBeTruthy()
    expect(client.read).not.toHaveBeenCalled()
    // The pin's arrival flips the body autonomously — one read, no reload.
    const pin = new AbortController()
    act(() => { book.pin(address, pin.signal) })
    await screen.findByText('hello remote bytes')
    expect(client.read).toHaveBeenCalledTimes(1)
    // Pin death retires the record: the bytes leave, expired copy shows.
    act(() => { pin.abort() })
    expect(screen.getByText('preview.expired')).toBeTruthy()
    expect(screen.queryByText('hello remote bytes')).toBeNull()
    book.dispose()
    authorization.dispose()
  })

  it('never resurfaces parked bytes while a fresh read is still loading', async () => {
    let call = 0
    const pending: PromiseWithResolvers<RemoteFilesReadContent>[] = []
    const { book, authorization, client } = harness((_request, _signal) => {
      call += 1
      if (call === 1) return Promise.resolve(content('first bytes'))
      const deferred = Promise.withResolvers<RemoteFilesReadContent>()
      pending.push(deferred)
      return deferred.promise
    })
    const address = book.register(IDENTITY, 'notes.txt', 'dev box')!
    const tabSignal = new AbortController()
    const pin = new AbortController()
    book.pin(address, pin.signal)
    const tab = (visible: boolean): PreviewTabInfo => info(address, tabSignal.signal, visible)
    const { rerender } = render(createElement(RemotePreviewViewer, props(book, tab(true))))
    await screen.findByText('first bytes')
    expect(client.read).toHaveBeenCalledTimes(1)
    // Park: hide the tab while bytes are presented.
    rerender(createElement(RemotePreviewViewer, props(book, tab(false))))
    expect(screen.queryByText('first bytes')).toBeNull()
    // Re-show: a fresh view mounts and reads — while it is pending the
    // parked bytes must stay gone and only the loading copy may show.
    rerender(createElement(RemotePreviewViewer, props(book, tab(true))))
    expect(screen.getByText('preview.loading')).toBeTruthy()
    expect(screen.queryByText('first bytes')).toBeNull()
    expect(screen.queryByText('second bytes')).toBeNull()
    expect(client.read).toHaveBeenCalledTimes(2)
    await act(async () => { pending[0]!.resolve(content('second bytes')) })
    await screen.findByText('second bytes')
    book.dispose()
    authorization.dispose()
  })
})
