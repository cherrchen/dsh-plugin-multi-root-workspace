// @vitest-environment jsdom
/**
 * The forked Files tree over the real store + face and a stub remote.
 *
 * `filesFace`/`createFilesStore` are the verbatim upstream seams — the spec
 * plays the slot framework: it mints the store instance, binds `useStore`
 * to it, hands the face's `start`/`toggle` to the component, and records
 * the `workspaceFiles` traffic and the addresses `onOpen` emits. The stub
 * `$stream` has no reconnect supervision: `changes` yields `ready` once,
 * then whatever the spec pushes, until the takeover signal aborts.
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { FilesTree } from '../src/client/files-tree/FilesTree.tsx'
import { createFilesStore, type FilesState } from '../src/client/files-tree/store.ts'
import { createList, createWatch, filesFace } from '../src/client/files-tree/face.ts'
import { lazyFilesRemote } from '../src/client/files-tree/adapter.tsx'

const SESSION = 'session-1' as SessionId
const TAB = 'tab-1' as TabId
const ROOT = '/repos/payments'

/** One captured workspaceFiles call. */
interface Call {
  readonly kind: 'list' | 'changes'
  readonly sessionId: string
  readonly path: string
}

/** The frame a stub watch queue hands the verbatim `createWatch` loop. */
type WatchFrame = { readonly kind: 'ready' } | { readonly kind: 'change' }

/** One parked per-directory watch the spec can feed frames into. */
interface Watch {
  push: (frame: WatchFrame) => void
  stop: () => void
}

/**
 * The `workspaceFiles.changes` stub's product: yields `ready` once, then
 * whatever `push` feeds it, until `stop` parks it for good. The iterable
 * carries `stop` so the `$stream` stub's `dispose` can wake a parked reader.
 */
function watchStub(watch: Watch): AsyncIterable<WatchFrame> & { stop(): void } {
  const queue: WatchFrame[] = [{ kind: 'ready' }]
  let wake: (() => void) | undefined
  let stopped = false
  watch.push = frame => { queue.push(frame); wake?.() }
  watch.stop = () => { stopped = true; wake?.() }
  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        while (!stopped) {
          while (queue.length > 0) yield queue.shift()!
          if (!stopped) await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
        }
      } finally { stopped = true }
    },
    stop: () => { watch.stop() },
  }
}

/**
 * The `$stream` supervisor's stand-in: iterates `open`'s frames once,
 * wrapping each as `{ value, accept }`. There is no reconnect supervision —
 * a stubbed stream that ends simply ends.
 */
function streamStub(options: { name: string; open: (signal: AbortSignal) => AsyncIterable<WatchFrame>; ended: (accepted: boolean) => Error }) {
  const inner = options.open(new AbortController().signal) as AsyncIterable<WatchFrame> & { stop?: () => void }
  const iterator = inner[Symbol.asyncIterator]()
  let disposed = false
  const finish = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    inner.stop?.()
    await iterator.return?.()
  }
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        try {
          while (true) {
            const next = await iterator.next()
            if (next.done) return
            yield { value: next.value, accept(): void {} }
          }
        } finally { await finish() }
      })()
    },
    dispose: finish,
  }
}

/** What one mounted tree gives the spec back. */
interface Harness {
  readonly calls: Call[]
  readonly watches: Map<string, Watch>
  /** `FilesTree`'s `onOpen` spy — receives `dsh-resource://file` addresses. */
  readonly onOpen: ReturnType<typeof vi.fn<(address: string) => void>>
  /** The verbatim face — `refresh` exercises the reload seam directly. */
  readonly face: { refresh: (tabId: TabId) => void }
  /** The takeover lifetime — aborting must forget the bucket and stop watches. */
  readonly controller: AbortController
  /** The minted store instance, for bucket assertions. */
  readonly snapshot: () => FilesState
}

/** Mount the fork over a real store and a stub remote. */
function mount(
  listImpl?: (path: string) => { ok: boolean; value?: unknown; error?: unknown } | Promise<{ ok: boolean; value?: unknown; error?: unknown }>,
  remoteOverride?: { workspaceFiles: unknown; $stream: unknown },
): Harness {
  const calls: Call[] = []
  const watches = new Map<string, Watch>()
  const onOpen = vi.fn<(address: string) => void>()
  const controller = new AbortController()
  const remote = remoteOverride ?? {
    workspaceFiles: {
      list: async (sessionId: string, path: string) => {
        calls.push({ kind: 'list', sessionId, path })
        const answer = await (listImpl?.(path) ?? {
          ok: true,
          value: {
            path,
            truncated: false,
            entries: path === ROOT
              ? [{ name: 'notes.md', type: 'file' }, { name: 'src', type: 'directory' }, { name: 'a.md', type: 'file' }]
              : [{ name: 'inner.ts', type: 'file' }],
          },
        })
        return answer
      },
      changes: (sessionId: string, path: string) => {
        calls.push({ kind: 'changes', sessionId, path })
        const watch: Watch = { push: () => {}, stop: () => {} }
        watches.set(path, watch)
        return watchStub(watch)
      },
    },
    $stream: streamStub,
  }
  const handle = createFilesStore()
  const instance = handle.create('spec')
  const face = filesFace(createList(remote as never), createWatch(remote as never))(SESSION, instance.actions)
  const useStore = <S,>(selector: (state: FilesState) => S): S => useSyncExternalStore(
    notify => instance.subscribe(notify),
    () => selector(instance.getSnapshot()),
  )
  const tree = (
    <FilesTree
      tabId={TAB}
      sessionId={SESSION}
      root={ROOT}
      signal={controller.signal}
      useStore={useStore}
      actions={instance.actions}
      start={face.start}
      toggle={face.toggle}
      onOpen={onOpen}
      t={(key: string) => key as never}
    />
  )
  render(tree as ReactElement)
  return { calls, watches, onOpen, face, controller, snapshot: () => instance.getSnapshot() }
}

afterEach(cleanup)

describe('the forked Files tree', () => {
  it('watches, then lists the selected root by absolute path — directories first', async () => {
    const harness = mount()
    // The verbatim DirectoryNode opens its watch first; the `ready` frame
    // dirties the node, which is what triggers the first listing.
    await waitFor(() => {
      expect(harness.calls).toContainEqual({ kind: 'changes', sessionId: 'session-1', path: ROOT })
      expect(harness.calls).toContainEqual({ kind: 'list', sessionId: 'session-1', path: ROOT })
    })
    // The endpoint's order is a listing fact; the tree orders directories
    // first, then files by name.
    await waitFor(() => {
      const names = [...document.querySelectorAll('.mrfw-ftName')].map(node => node.textContent)
      expect(names).toEqual(['src', 'a.md', 'notes.md'])
    })
    expect(document.querySelector('[data-files-entry="directory"][data-files-path="/repos/payments/src"]')).not.toBeNull()
    expect(document.querySelector('[data-files-entry="file"][data-files-path="/repos/payments/a.md"]')).not.toBeNull()
  })

  it('expands a directory lazily and collapses it again', async () => {
    const harness = mount()
    const row = await screen.findByRole('button', { name: 'src' })
    expect(harness.calls.some(call => call.kind === 'list' && call.path === `${ROOT}/src`)).toBe(false)

    fireEvent.click(row)
    await waitFor(() => {
      expect(harness.calls).toContainEqual({ kind: 'changes', sessionId: 'session-1', path: `${ROOT}/src` })
      expect(harness.calls).toContainEqual({ kind: 'list', sessionId: 'session-1', path: `${ROOT}/src` })
    })
    expect(await screen.findByRole('button', { name: 'inner.ts' })).toBeTruthy()

    // Collapsing hides the children; the loaded level survives in the store.
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'inner.ts' })).toBeNull() })
    expect(harness.snapshot().byTab[TAB]?.expanded).not.toContain(`${ROOT}/src`)
  })

  it('opens a file through a session file address whose path stays absolute', async () => {
    const harness = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }))
    // cwd is deliberately undefined — a session-relative address here would
    // resolve against the primary root. The leading `/` keeps it absolute.
    expect(harness.onOpen).toHaveBeenCalledWith('dsh-resource://file/session/session-1//repos/payments/notes.md')
  })

  it('refreshes the open tree in place through the face', async () => {
    const harness = mount()
    await screen.findByRole('button', { name: 'src' })
    const listed = () => harness.calls.filter(call => call.kind === 'list').length
    const before = listed()

    act(() => { harness.face.refresh(TAB) })
    // A ready level never drops back to the loading note during a relist.
    expect(screen.queryByText('loading')).toBeNull()
    await waitFor(() => { expect(listed()).toBeGreaterThan(before) })
    expect(screen.getByRole('button', { name: 'src' })).toBeTruthy()
  })

  it('re-lists automatically when the watch reports a change', async () => {
    const harness = mount()
    await screen.findByRole('button', { name: 'src' })
    const listed = () => harness.calls.filter(call => call.kind === 'list').length
    const before = listed()

    act(() => { harness.watches.get(ROOT)!.push({ kind: 'change' }) })
    await waitFor(() => { expect(listed()).toBeGreaterThan(before) })
  })

  it('surfaces a listing failure as the upstream failure row', async () => {
    mount(path => (path === ROOT
      ? { ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }
      : { ok: true, value: { path, truncated: false, entries: [] } }))
    const note = await screen.findByText('error.notFound')
    expect(note.getAttribute('data-files-row')).toBe('failed')
    expect(note.getAttribute('data-files-code')).toBe('workspace-file/not-found')
  })

  it('draws the upstream empty and truncated notes', async () => {
    mount(path => (path === ROOT
      ? { ok: true, value: { path, truncated: true, entries: [] } }
      : { ok: true, value: { path, truncated: false, entries: [] } }))
    expect(await screen.findByText('empty')).toBeTruthy()
    expect(await screen.findByText('truncated')).toBeTruthy()
  })

  it('forgets the bucket and closes the watch when the signal aborts', async () => {
    const harness = mount()
    await screen.findByRole('button', { name: 'src' })
    expect(harness.snapshot().byTab[TAB]).toBeDefined()

    act(() => { harness.controller.abort() })
    await waitFor(() => { expect(harness.snapshot().byTab[TAB]).toBeUndefined() })
    expect(document.querySelector('.mrfw-ftBody')).toBeNull()
    // The parked watch is disposed: a pushed frame can no longer list.
    const listed = harness.calls.filter(call => call.kind === 'list').length
    act(() => { harness.watches.get(ROOT)!.push({ kind: 'change' }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.filter(call => call.kind === 'list')).toHaveLength(listed)
  })
})

describe('the lazy remote seam', () => {
  // `remote.workspaceFiles` is a nested service: on the context proxy it is
  // inject-guarded, so lazyFilesRemote resolves it (and `remote`) through
  // `ctx.get`, which reads the service store without the inject requirement.
  // The verbatim face awaits `list` through `.then` with no `.catch`: any
  // rejection escaping the remote indirection dies inside DirectoryNode.task
  // and would pin the level at `loading` forever. lazyFilesRemote folds every
  // lookup failure into a settled RemoteResult so the row always surfaces.
  const ctxFor = (services: Record<string, unknown>): ClientContext =>
    ({ get: (name: string) => services[name] }) as unknown as ClientContext

  it('reaches the workspaceFiles namespace through ctx.get, past the inject guard', async () => {
    const ctx = ctxFor({
      remote: { $stream: streamStub },
      'remote.workspaceFiles': {
        list: async (sessionId: string, path: string) => ({
          ok: true,
          value: { path, truncated: false, entries: [{ name: 'file.md', type: 'file' }] },
        }),
        changes: () => watchStub({ push: () => {}, stop: () => {} }),
      },
    })
    mount(undefined, lazyFilesRemote(ctx) as never)
    expect(await screen.findByRole('button', { name: 'file.md' })).toBeTruthy()
  })

  it('surfaces a rejecting list as the failure row, never a stuck loading', async () => {
    const ctx = ctxFor({
      remote: { $stream: streamStub },
      'remote.workspaceFiles': {
        list: () => Promise.reject(new TypeError('cannot get property "remote.workspaceFiles" without inject')),
      },
    })
    mount(undefined, lazyFilesRemote(ctx) as never)
    const note = await screen.findByText('error.unavailable')
    expect(note.getAttribute('data-files-row')).toBe('failed')
    expect(note.getAttribute('data-files-code')).toBe('gateway/internal')
  })

  it('surfaces a remote without the workspaceFiles namespace instead of dying silently', async () => {
    mount(undefined, lazyFilesRemote(ctxFor({ remote: { $stream: streamStub } })) as never)
    const note = await screen.findByText('error.unavailable')
    expect(note.getAttribute('data-files-row')).toBe('failed')
    expect(note.getAttribute('data-files-code')).toBe('gateway/internal')
  })
})
