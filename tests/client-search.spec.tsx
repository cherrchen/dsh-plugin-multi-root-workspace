// @vitest-environment jsdom
/**
 * The additional-root search pane over the real search store, the real
 * preference book, and a stub remote: the bar, the host call it makes, the
 * results it draws, the failures it reports, and the hidden-entry filtering it
 * shares with the listed tree.
 *
 * The harness plays the slot framework's part exactly as the tree specs do —
 * it mints the registration's store, binds `useStore`/`useSearchState` to the
 * sources the adapter would hand over — and supplies the search seat with a
 * recording `run`, so every assertion is about the pane's behavior rather than
 * about a double of it.
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { createFilesStore, type FilesState } from '../src/client/files-tree/store.ts'
import { createList, createWatch, filesFace } from '../src/client/files-tree/face.ts'
import { createSearchPaneStore, searchStateKey, type SearchPaneStates } from '../src/client/files-tree/search-state.ts'
import { createSearchPreferenceBook } from '../src/client/files-tree/search-preferences.ts'
import { FilesPane } from '../src/client/files-tree/pane.tsx'
import type { FilesTreeSearchSeat, FilesTreeSurface } from '../src/client/files-tree/adapter.tsx'
import type { WorkspaceSearchAnswer, WorkspaceSearchRequest } from '../src/client/files-tree/search-client.ts'
import type { SearchMatch } from '../src/client/files-tree/search-tree.ts'
import { defaultRules, enabledPaths } from '../src/client/files-tree/search-rules.ts'

const SESSION = 'session-1' as SessionId
const TAB = 'tab-1' as TabId
const ROOT = '/repos/payments'
const KEY = searchStateKey(TAB, ROOT)
const ROOT_ID = 'root-a'

/** The exclusion paths the default preferences send. */
function defaultExcluded(): readonly string[] {
  return enabledPaths(defaultRules())
}

/** The frame a stub watch hands the verbatim `createWatch` loop. */
type WatchFrame = { readonly kind: 'ready' } | { readonly kind: 'change' }

/** One `workspaceFiles` call the stub remote recorded. */
interface TreeCall { readonly kind: 'list' | 'changes'; readonly path: string }

/** The stub watch: `ready` once, parked afterwards. */
function watchStub(): AsyncIterable<WatchFrame> & { stop(): void } {
  const queue: WatchFrame[] = [{ kind: 'ready' }]
  let stopped = false
  return {
    [Symbol.asyncIterator]: async function* () {
      while (!stopped) {
        while (queue.length > 0) yield queue.shift()!
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    },
    stop: () => { stopped = true },
  }
}

/** The supervisor stand-in the stub remote's `$stream` returns. */
function streamStub(options: { open: (signal: AbortSignal) => AsyncIterable<WatchFrame> }) {
  const inner = options.open(new AbortController().signal) as AsyncIterable<WatchFrame> & { stop?: () => void }
  const iterator = inner[Symbol.asyncIterator]()
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        while (true) {
          const next = await iterator.next()
          if (next.done) return
          yield { value: next.value, accept(): void {} }
        }
      })()
    },
    dispose: async () => { inner.stop?.(); await iterator.return?.() },
  }
}

/** What one mounted pane gives the spec back. */
interface Harness {
  /** Every search call the pane made, with the request it sent. */
  readonly runs: Array<{ readonly rootId: string; readonly request: WorkspaceSearchRequest }>
  readonly run: ReturnType<typeof vi.fn<(rootId: string, request: WorkspaceSearchRequest, signal: AbortSignal) => Promise<WorkspaceSearchAnswer>>>
  readonly pane: () => HTMLElement
  readonly store: ReturnType<typeof createSearchPaneStore>
  /** The addresses the surface was asked to open. */
  readonly onOpenFile: ReturnType<typeof vi.fn<(address: string) => void>>
  /** The element a fresh mount draws (the same surface and stores). */
  readonly element: () => ReactElement
  readonly unmount: () => void
}

/** One mounted pane, over a listing stub that answers `entries`. */
function mount(options: {
  readonly entries?: readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other' }[]
  readonly answer?: (request: WorkspaceSearchRequest) => Promise<WorkspaceSearchAnswer>
  readonly withSearch?: boolean
} = {}): Harness {
  const calls: TreeCall[] = []
  const runs: Harness['runs'] = []
  const entries = options.entries ?? [
    { name: 'src', type: 'directory' },
    { name: 'notes.md', type: 'file' },
    { name: '.hidden.md', type: 'file' },
  ]
  const remote = {
    workspaceFiles: {
      list: async (_sessionId: string, path: string) => {
        calls.push({ kind: 'list', path })
        return {
          ok: true as const,
          value: {
            path,
            truncated: false,
            entries: path === ROOT ? entries : [{ name: 'inner.ts', type: 'file' as const }],
          },
        }
      },
      changes: (_sessionId: string, path: string) => {
        calls.push({ kind: 'changes', path })
        return watchStub()
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
  const searchStore = createSearchPaneStore()
  const preferences = createSearchPreferenceBook(undefined)
  const useSearchState: SnapshotSelectorHook<SearchPaneStates> = <S,>(selector: (states: SearchPaneStates) => S): S =>
    useSyncExternalStore(notify => searchStore.snapshot.subscribe(notify), () => selector(searchStore.snapshot.getSnapshot()))
  const run = vi.fn(async (rootId: string, request: WorkspaceSearchRequest): Promise<WorkspaceSearchAnswer> => {
    runs.push({ rootId, request })
    if (options.answer !== undefined) return await options.answer(request)
    return { root: ROOT, matches: matchesFor(request.query), truncated: false, incomplete: false }
  })
  const search: FilesTreeSearchSeat = { useSearchState, store: searchStore, preferences, run }
  const surface: FilesTreeSurface = {
    sessionId: SESSION,
    useStore,
    actions: instance.actions,
    face,
    openFile: () => {},
    openFileIn: () => {},
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    useTreeSelection: (() => undefined) as never,
    selectRoot: () => {},
    takeover: { signal: () => new AbortController().signal, end: () => {}, saved: () => undefined, save: () => {} },
    menu: undefined,
    canOpen: undefined,
    useCanOpen: () => 0,
    search: options.withSearch === false ? undefined : search,
  }
  const controller = new AbortController()
  const onOpenFile = vi.fn<(address: string) => void>()
  const element = (): ReactElement => (
    <FilesPane
      filesTree={surface}
      stateKey={KEY}
      rootId={ROOT_ID}
      tabId={TAB}
      root={ROOT}
      signal={controller.signal}
      useStore={useStore}
      actions={instance.actions}
      onOpenFile={onOpenFile}
    />
  )
  const mounted = render(element())
  return {
    runs,
    run,
    pane: () => mounted.container,
    store: searchStore,
    onOpenFile,
    element,
    unmount: () => { mounted.unmount() },
  }
}

/** The matches a query answers with, in the shape the Host reports them. */
function matchesFor(query: string): readonly SearchMatch[] {
  return query === 'notes'
    ? [{ path: 'notes.md', type: 'file' }]
    : [{ path: 'src', type: 'directory' }, { path: 'src/inner.ts', type: 'file' }]
}

/** Open the search bar for the harness's record. */
async function openBar(harness: Harness): Promise<HTMLInputElement> {
  act(() => { harness.store.barOpen(KEY, true) })
  return await screen.findByRole('searchbox')
}

/** Type a query into the bar. */
async function type(harness: Harness, query: string): Promise<void> {
  const input = await openBar(harness)
  fireEvent.change(input, { target: { value: query } })
  await waitFor(() => { expect(harness.runs.length).toBeGreaterThan(0) })
}

afterEach(cleanup)

describe('the additional-root search pane', () => {
  it('draws no search surface when the host has no search seat', async () => {
    mount({ withSearch: false })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'src' })).toBeTruthy() })
    expect(document.querySelector('[data-files-search-status]')).toBeNull()
    expect(document.querySelector('.mrfw-fsBar')).toBeNull()
  })

  it('searches the selected root id with the workspace preferences', async () => {
    const harness = mount()
    await type(harness, '  notes  ')
    await waitFor(() => { expect(document.querySelector('[data-mrfw-files-results]')).not.toBeNull() })
    expect(harness.runs.at(-1)).toEqual({
      rootId: ROOT_ID,
      request: { query: 'notes', excludedPaths: defaultExcluded(), includeHidden: false, respectGitignore: true },
    })
  })

  it('draws the matches as an expanded tree with the query highlighted', async () => {
    const harness = mount()
    await type(harness, 'notes')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    expect(document.querySelector('mark')?.textContent).toBe('notes')
    expect(document.querySelector('[data-files-search-status]')?.textContent).toContain('search.results')
  })

  it('opens a result row through the absolute file address', async () => {
    const harness = mount()
    await type(harness, 'notes')
    const row = await screen.findByRole('button', { name: 'notes.md' })
    fireEvent.click(row)
    // cwd stays undefined: a session-relative address would open the primary
    // root's same-named file instead of this additional root's.
    expect(harness.onOpenFile).toHaveBeenCalledWith('dsh-resource://file/session/session-1//repos/payments/notes.md')
  })

  it('aborts the previous search when a newer query arrives', async () => {
    const controllers: AbortSignal[] = []
    const harness = mount({
      answer: request => new Promise((resolve) => { setTimeout(() => { resolve({ root: ROOT, matches: matchesFor(request.query), truncated: false, incomplete: false }) }, 5) }),
    })
    const input = await openBar(harness)
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    await waitFor(() => { expect(harness.runs.length).toBeGreaterThanOrEqual(2) })
    controllers.push(...harness.runs.map((_, index) => harness.run.mock.calls[index]![2]))
    expect(controllers[0]?.aborted).toBe(true)
    expect(controllers.at(-1)?.aborted).toBe(false)
  })

  it('draws the listed tree again, hidden entries filtered, when the query is blank', async () => {
    const harness = mount()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'notes.md' })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: '.hidden.md' })).toBeNull()
    await type(harness, 'notes')
    await waitFor(() => { expect(document.querySelector('[data-mrfw-files-results]')).not.toBeNull() })
    const input = await openBar(harness)
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => { expect(document.querySelector('[data-mrfw-files-results]')).toBeNull() })
    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '.hidden.md' })).toBeNull()
  })

  it('shows the eye toggle into the search preferences and re-runs with hidden entries included', async () => {
    const harness = mount()
    await type(harness, 'notes')
    expect(screen.queryByRole('button', { name: '.hidden.md' })).toBeNull()
    const eye = document.querySelector<HTMLElement>('[data-files-show-hidden]')!
    fireEvent.click(eye)
    await waitFor(() => { expect(harness.runs.at(-1)?.request.includeHidden).toBe(true) })
    // The same preference filters the listed tree: clearing the query draws
    // the hidden entry that the eye just revealed, without a relist.
    const input = await openBar(harness)
    fireEvent.change(input, { target: { value: '' } })
    expect(await screen.findByRole('button', { name: '.hidden.md' })).toBeTruthy()
  })

  it('reports an empty result with the filters that could hide matches', async () => {
    const harness = mount({ answer: async () => ({ root: ROOT, matches: [], truncated: false, incomplete: false }) })
    await type(harness, 'zzz')
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-empty"]')).not.toBeNull() })
    expect(document.querySelector('[data-files-search-hint]')).not.toBeNull()
    expect(document.querySelector('[data-files-row="search-truncated"]')).toBeNull()
  })

  it('reports truncation and an incomplete scan below the results', async () => {
    const harness = mount({
      answer: async () => ({ root: ROOT, matches: matchesFor('notes'), truncated: true, incomplete: true }),
    })
    await type(harness, 'notes')
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-truncated"]')).not.toBeNull() })
    expect(document.querySelector('[data-files-row="search-incomplete"]')).not.toBeNull()
  })

  it('reports a failed search and retries the same query', async () => {
    let attempt = 0
    const harness = mount({
      answer: async (request) => {
        attempt += 1
        if (attempt === 1) throw Object.assign(new Error('search unavailable'), { code: 'search-unavailable' })
        return { root: ROOT, matches: matchesFor(request.query), truncated: false, incomplete: false }
      },
    })
    await type(harness, 'notes')
    await waitFor(() => { expect(document.querySelector('[data-files-row="search-failed"]')).not.toBeNull() })
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-retry]')!)
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    expect(harness.runs.at(-1)?.request.query).toBe('notes')
  })

  it('keeps the open bar and its result across a body remount', async () => {
    const harness = mount()
    await type(harness, 'notes')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
    harness.unmount()
    render(harness.element())
    expect(await screen.findByRole('searchbox')).toBeTruthy()
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/notes.md"]')).not.toBeNull() })
  })

  it('moves the keyboard along the field and the result rows, and Escape clears', async () => {
    const harness = mount()
    await type(harness, 'src')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/src/inner.ts"]')).not.toBeNull() })
    const input = await openBar(harness)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe('/repos/payments/src')
    })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => { expect(input.value).toBe('') })
    expect(document.querySelector('[data-mrfw-files-results]')).toBeNull()
  })
})
