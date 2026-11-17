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
  /** The workspace preference book this pane reads and writes. */
  readonly preferences: ReturnType<typeof createSearchPreferenceBook>
  /** The element a fresh mount draws (the same surface and stores). */
  readonly element: () => ReactElement
  /** Re-render in place with another root record — the same pane, another stateKey. */
  readonly update: (patch: Partial<PaneInputs>) => void
  readonly unmount: () => void
}

/** The root-record props one render uses; a root switch changes these, not the mount. */
interface PaneInputs {
  readonly stateKey: string
  readonly root: string
  readonly rootId: string
  readonly mode: 'page' | 'preview'
  readonly previewPath: string | undefined
}

/** One mounted pane, over a listing stub that answers `entries`. */
function mount(options: {
  readonly entries?: readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other' }[]
  readonly answer?: (request: WorkspaceSearchRequest) => Promise<WorkspaceSearchAnswer>
  readonly withSearch?: boolean
  readonly mode?: 'page' | 'preview' | undefined
  readonly previewPath?: string | undefined
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
  const inputs: PaneInputs = {
    stateKey: KEY,
    root: ROOT,
    rootId: ROOT_ID,
    mode: options.mode ?? 'page',
    previewPath: options.previewPath,
  }
  const element = (): ReactElement => (
    <FilesPane
      filesTree={surface}
      stateKey={inputs.stateKey}
      rootId={inputs.rootId}
      tabId={TAB}
      root={inputs.root}
      signal={controller.signal}
      useStore={useStore}
      actions={instance.actions}
      onOpenFile={onOpenFile}
      mode={inputs.mode}
      previewPath={inputs.previewPath}
    />
  )
  const mounted = render(element())
  return {
    runs,
    run,
    pane: () => mounted.container,
    store: searchStore,
    onOpenFile,
    preferences,
    element,
    update: (patch) => {
      Object.assign(inputs, patch)
      mounted.rerender(element())
    },
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
    // Record each request's signal state when it STARTS: the effect cleanup
    // aborts a request that already settled too, so asserting on the signal
    // after settle would race the 5ms answer.
    const abortedAtStart: boolean[] = []
    const harness = mount({
      answer: async () => {
        const signal = harness.run.mock.calls.at(-1)![2] as AbortSignal
        abortedAtStart.push(signal.aborted)
        await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        return { root: ROOT, matches: [], truncated: false, incomplete: false }
      },
    })
    const input = await openBar(harness)
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    await waitFor(() => { expect(harness.runs.length).toBe(2) })

    expect(abortedAtStart).toEqual([false, false])
    const first = harness.run.mock.calls[0]![2] as AbortSignal
    expect(first.aborted).toBe(true)
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


describe('the additional-root search review regressions', () => {
  it('saves an exclusion rule added through the settings panel when its toggle closes the panel', async () => {
    const harness = mount()
    await type(harness, 'notes')
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    const addInput = await screen.findByPlaceholderText('settings.add')
    fireEvent.change(addInput, { target: { value: 'dist' } })
    fireEvent.keyDown(addInput, { key: 'Enter' })
    expect(document.querySelector('[data-files-rule="dist"]')).not.toBeNull()

    // The same button that opened the panel closes it; closing must commit the
    // draft like Escape and a blur do, not silently drop the edit.
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    await waitFor(() => { expect(document.querySelector('[data-files-search-settings]')).toBeNull() })
    await waitFor(() => {
      expect(harness.preferences.source(ROOT).getSnapshot().rules.some(rule => rule.path === 'dist' && rule.enabled)).toBe(true)
    })
    await waitFor(() => { expect(harness.runs.at(-1)?.request.excludedPaths).toContain('dist') })
  })

  it('keeps the result expansion and scroll across a body remount', async () => {
    const harness = mount()
    await type(harness, 'src')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })

    // Collapse one result directory and scroll the result body: this is the
    // position a reader expects to find again after opening a file and coming
    // back (the Files body unmounts while the file tab is shown).
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    const results = document.querySelector<HTMLElement>('[data-mrfw-files-results]')!
    fireEvent.scroll(results, { target: { scrollTop: 96 } })
    await waitFor(() => { expect(harness.store.state(KEY).scrollTop).toBe(96) })
    expect(harness.store.state(KEY).expanded).not.toContain('/repos/payments/src')
    const runsBefore = harness.runs.length

    harness.unmount()
    render(harness.element())
    await screen.findByRole('searchbox')
    // The retained settled answer is reused: no replacement request, so the
    // collapse and the offset survive instead of being reset by `searched`.
    expect(harness.runs.length).toBe(runsBefore)
    expect(harness.store.state(KEY).expanded).not.toContain('/repos/payments/src')
    await waitFor(() => { expect(document.querySelector<HTMLElement>('[data-mrfw-files-results]')?.scrollTop).toBe(96) })
  })
})

/** Type a query in a preview pane, whose bar is drawn without a barOpen write. */
async function typeInPreview(harness: Harness, query: string): Promise<HTMLInputElement> {
  const input = await screen.findByRole('searchbox')
  fireEvent.change(input, { target: { value: query } })
  await waitFor(() => { expect(harness.runs.length).toBeGreaterThan(0) })
  return input
}

describe('the additional-root search pane in preview mode', () => {
  it('draws the bar from the mode alone and never takes the keyboard or the barOpen record', async () => {
    const harness = mount({ mode: 'preview' })
    const input = await screen.findByRole('searchbox')
    // Upstream's preview navigator draws the bar unconditionally and does not
    // focus it: opening the Folder must not steal the keyboard.
    expect(document.activeElement).not.toBe(input)
    expect(harness.store.state(KEY).barOpen).toBe(false)
    fireEvent.change(input, { target: { value: 'notes' } })
    await waitFor(() => { expect(harness.runs.length).toBe(1) })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => { expect(input.value).toBe('') })
    expect(harness.store.state(KEY).barOpen).toBe(false)
  })

  it('opens a result row through the supplied preview route', async () => {
    const harness = mount({ mode: 'preview' })
    await typeInPreview(harness, 'notes')
    const row = await screen.findByRole('button', { name: 'notes.md' })
    fireEvent.click(row)
    // The navigator supplies the replace-tab route; the pane itself only
    // reports the absolute address it was given.
    expect(harness.onOpenFile).toHaveBeenCalledWith('dsh-resource://file/session/session-1//repos/payments/notes.md')
  })

  it('marks the previewed file among the results on the legacy row path', async () => {
    const harness = mount({ mode: 'preview', previewPath: '/repos/payments/src/inner.ts' })
    await typeInPreview(harness, 'src')
    await waitFor(() => {
      expect(document.querySelector('[data-files-path="/repos/payments/src/inner.ts"]')).not.toBeNull()
    })
    const current = document.querySelector<HTMLElement>('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')
    expect(current).not.toBeNull()
    expect(current?.getAttribute('aria-current')).toBe('true')

    // A previewed file outside this root, or one the results do not include,
    // carries no mark.
    harness.update({ previewPath: '/repos/other/elsewhere.ts' })
    await waitFor(() => { expect(document.querySelector('[data-files-current]')).toBeNull() })
    harness.update({ previewPath: '/repos/payments/notes.md' })
    await waitFor(() => { expect(document.querySelector('[data-files-current]')).toBeNull() })
  })

  it('leaves the result rows unmarked in page mode', async () => {
    const harness = mount({ previewPath: '/repos/payments/src/inner.ts' })
    await type(harness, 'src')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/src/inner.ts"]')).not.toBeNull() })
    expect(document.querySelector('[data-files-current]')).toBeNull()
  })

  it('returns focus to the magnifier when the settings panel closes — page mode', async () => {
    const harness = mount()
    await openBar(harness)
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    const panel = await screen.findByRole('dialog')
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('[data-files-search-settings]')).toBeNull() })
    expect(document.activeElement).toBe(document.querySelector('[data-files-search-settings-toggle]'))
  })

  it('returns focus to the magnifier when the settings panel closes — preview mode', async () => {
    mount({ mode: 'preview' })
    await screen.findByRole('searchbox')
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    const panel = await screen.findByRole('dialog')
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('[data-files-search-settings]')).toBeNull() })
    expect(document.activeElement).toBe(document.querySelector('[data-files-search-settings-toggle]'))
  })

  it('moves the keyboard through the listed tree rows before a query — page mode', async () => {
    const harness = mount()
    const input = await openBar(harness)
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe('/repos/payments/src')
    })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    await waitFor(() => { expect(document.activeElement).toBe(input) })
  })

  it('moves the keyboard through the listed tree rows before a query — preview mode', async () => {
    mount({ mode: 'preview' })
    const input = await screen.findByRole('searchbox')
    await waitFor(() => { expect(document.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe('/repos/payments/src')
    })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    await waitFor(() => { expect(document.activeElement).toBe(input) })
  })

  it('drops the settings draft when the same pane switches roots', async () => {
    const harness = mount({ mode: 'preview' })
    await screen.findByRole('searchbox')
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    const addInput = await screen.findByPlaceholderText('settings.add')
    fireEvent.change(addInput, { target: { value: 'scratch-dir' } })
    fireEvent.keyDown(addInput, { key: 'Enter' })
    expect(document.querySelector('[data-files-rule="scratch-dir"]')).not.toBeNull()

    // Same pane mount (component state survives), another root record: the
    // draft must close uncommitted instead of landing in the new root's
    // preferences — or leaking back into the old root's.
    act(() => {
      harness.update({ stateKey: searchStateKey(TAB, '/repos/docs'), root: '/repos/docs', rootId: 'root-b' })
    })
    await waitFor(() => { expect(document.querySelector('[data-files-search-settings]')).toBeNull() })
    expect(harness.preferences.source('/repos/docs').getSnapshot().rules.some(rule => rule.path === 'scratch-dir')).toBe(false)
    expect(harness.preferences.source(ROOT).getSnapshot().rules.some(rule => rule.path === 'scratch-dir')).toBe(false)
  })

  it('keeps Escape from the document while the query is non-blank, and lets it through when blank', async () => {
    const harness = mount({ mode: 'preview' })
    const input = await typeInPreview(harness, 'notes')
    const seen: boolean[] = []
    const listener = (event: KeyboardEvent): void => { seen.push(event.defaultPrevented) }
    document.addEventListener('keydown', listener)
    try {
      fireEvent.keyDown(input, { key: 'Escape' })
      await waitFor(() => { expect(input.value).toBe('') })
      // The blank query is what lets the upstream face's document-level
      // Escape close the floating navigator. A non-blank one must not reach
      // the document at all.
      expect(seen).toEqual([])
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(seen).toEqual([false])
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('closes the settings panel first on Escape and leaves the query intact', async () => {
    const harness = mount({ mode: 'preview' })
    const input = await typeInPreview(harness, 'notes')
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!)
    const addInput = await screen.findByPlaceholderText('settings.add')
    const seen: boolean[] = []
    const listener = (): void => { seen.push(true) }
    document.addEventListener('keydown', listener)
    try {
      fireEvent.keyDown(addInput, { key: 'Escape' })
      await waitFor(() => { expect(document.querySelector('[data-files-search-settings]')).toBeNull() })
      expect(input.value).toBe('notes')
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('keeps the native accessibility structure', async () => {
    mount({ mode: 'preview' })
    await screen.findByRole('searchbox')
    const status = document.querySelector('[data-files-search-status]')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    const eye = document.querySelector<HTMLElement>('[data-files-show-hidden]')!
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(eye)
    await waitFor(() => { expect(eye.getAttribute('aria-pressed')).toBe('true') })
    const trigger = document.querySelector<HTMLElement>('[data-files-search-settings-toggle]')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('settings.title')
    await waitFor(() => { expect(trigger.getAttribute('aria-expanded')).toBe('true') })
  })

  it('marks its root with the stylesheet guard in both modes', async () => {
    for (const mode of ['page', 'preview'] as const) {
      const harness = mount({ mode })
      await waitFor(() => { expect(harness.pane().querySelector('[data-mrfw-files-pane]')).not.toBeNull() })
      const marker = harness.pane().querySelector('[data-mrfw-files-pane]')!
      expect(marker.classList.contains('mrfw-fsPane')).toBe(true)
      harness.unmount()
    }
  })
})
