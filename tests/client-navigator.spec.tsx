// @vitest-environment jsdom
/**
 * The document-preview navigator's additional-root retarget, driven through
 * the real client entry: the registered `sidebar.right.tab.document.actions`
 * occupant is rendered inside a `[data-textpreview-url]` fixture, the
 * navigator aside is appended and removed the way the Folder toggle mounts
 * and unmounts it, and the takeover, reveal, replace-tab open route, and
 * pane-record memory are observed through the stub Connection channel, the
 * stub `remote`/`sidebarRight` services, and the DOM.
 *
 * The preview fixture mirrors the upstream DOM shape the retarget reads —
 * `data-textpreview-url` (the tab's content id) on the preview root,
 * `data-textpreview-content` on the row the NavigatorSeat renders into,
 * `aside[data-files-navigator={paneId}]` with a `[data-files-body]` inside
 * it, and the dockkit tab host: one `section` carrying BOTH
 * `data-dockkit-content` (its tab id) and `data-dockkit-pane` (the pane
 * its tab is selected in), inside one `div.tabCell` — the real DockLayout
 * shape, where a non-empty pane has no element of its own and the pane id
 * rides on the selected tab's host. `replaceTab` mints a new tab inside
 * the same pane, and the suite replays that by unmounting one cell and
 * mounting another carrying the same pane id — or, for a pane that truly
 * dies, mounting nothing at all.
 *
 * The harness plays the slot framework's part exactly as
 * `client-switcher.spec.tsx` does: it mints the registration's session
 * store, runs its `inject` factory, and spreads the result plus
 * `useStore`/`actions`/`sessionId` onto the composed props.
 */

import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { StoreInstance } from '@deepseek-ai/dsh-client-store'
import { PANEL_CHANNEL, type PanelRequest, type RootView, type RootsView } from '../src/contract.ts'
import type { FilesState } from '../src/client/files-tree/store.ts'
import { locateFile, relativeUnderRoot, rootForPath, underRoot, windowsRoot } from '../src/client/files-tree/locate.ts'
import * as client from '../src/client/index.ts'

/* ── locate mechanics: the ported root/path rules, before any DOM ───────── */

describe('the navigator path mechanics', () => {
  it('underRoot distinguishes siblings, separators, and root kinds', () => {
    expect(underRoot('/repos/payments/src/a.ts', '/repos/payments')).toBe('src/a.ts')
    // No false prefix: `/repo-a` must not read as inside `/repo`.
    expect(underRoot('/repos/payments-other/x', '/repos/payments')).toBeUndefined()
    // Backslashes normalize before the prefix test.
    expect(underRoot('C:\\ws\\lib\\a.ts', 'C:/ws')).toBe('lib/a.ts')
    // POSIX roots are case-sensitive; Windows drive and UNC roots are not.
    expect(windowsRoot('/server/share')).toBe(false)
    expect(windowsRoot('C:/ws')).toBe(true)
    expect(windowsRoot('//server/share')).toBe(true)
    expect(underRoot('/Repos/Payments/x', '/repos/payments')).toBeUndefined()
    expect(underRoot('c:/WS/lib/a.ts', 'C:/ws')).toBe('lib/a.ts')
    expect(underRoot('//SERVER/Share/lib/a.ts', '//server/share')).toBe('lib/a.ts')
    // The root itself is not *under* the root.
    expect(underRoot('/repos/payments', '/repos/payments')).toBeUndefined()
  })

  it('relativeUnderRoot rejects dot segments and empty results', () => {
    expect(relativeUnderRoot('/r/a/b.ts', '/r')).toBe('a/b.ts')
    expect(relativeUnderRoot('/r/a/../b.ts', '/r')).toBeUndefined()
    expect(relativeUnderRoot('/r/a//b.ts', '/r')).toBeUndefined()
    expect(relativeUnderRoot('/r/a/./b.ts', '/r')).toBeUndefined()
    expect(relativeUnderRoot('/r', '/r')).toBeUndefined()
    expect(relativeUnderRoot('/elsewhere/a.ts', '/r')).toBeUndefined()
  })

  it('rootForPath picks the longest available root and skips others', () => {
    const inner: RootView = { ordinal: 1, id: 'inner', path: '/repos/payments', addedAt: 't', state: 'available', access: 'read-write' }
    const nested: RootView = { ordinal: 2, id: 'nested', path: '/repos/payments/sub', addedAt: 't', state: 'available', access: 'read-write' }
    const gone: RootView = { ordinal: 3, id: 'gone', path: '/repos/missing', addedAt: 't', state: 'missing', access: 'read-only' }
    const view: RootsView = { primaryRoot: '/repos/primary', roots: [inner, nested, gone], limit: 16, count: 3 }
    // The nested root wins the longest-prefix race.
    expect(rootForPath(view, '/repos/payments/sub/deep/a.ts')?.id).toBe('nested')
    expect(rootForPath(view, '/repos/payments/other/a.ts')?.id).toBe('inner')
    // Unavailable roots never own a file, even when the path nests.
    expect(rootForPath(view, '/repos/missing/a.ts')).toBeUndefined()
    // The primary root's own files and outside paths match nothing.
    expect(rootForPath(view, '/repos/primary/a.ts')).toBeUndefined()
    expect(rootForPath(view, '/elsewhere/a.ts')).toBeUndefined()
    // Even if a view ever listed the primary among its roots — normalized
    // spellings of the same directory compare equal too.
    const odd: RootsView = { primaryRoot: '/repos/primary/', roots: [{ ordinal: 1, id: 'p', path: '/repos/primary', addedAt: 't', state: 'available', access: 'read-write' }], limit: 16, count: 1 }
    expect(rootForPath(odd, '/repos/primary/a.ts')).toBeUndefined()
  })

  it('locateFile walks listed levels and reports pending like upstream', () => {
    const tree = {
      root: '/r',
      levels: {
        '/r': { kind: 'ready' as const, level: { entries: [{ name: 'src', type: 'directory' as const }, { name: 'top.ts', type: 'file' }], truncated: false }, failure: undefined },
        '/r/src': { kind: 'loading' as const },
      },
    }
    // Root level only: the file row exists there.
    expect(locateFile(tree, 'top.ts')).toEqual({ ancestors: [], current: '/r/top.ts', pending: false })
    // A directory on the way whose level is still listing reports pending.
    const deep = locateFile(tree, 'src/deep/a.ts')
    expect(deep.ancestors).toEqual([{ parent: '/r', path: '/r/src' }])
    expect(deep.current).toBeUndefined()
    expect(deep.pending).toBe(true)
    // An entry the listing does not carry ends the walk, no mark.
    expect(locateFile(tree, 'absent.ts').current).toBeUndefined()
    expect(locateFile(tree, 'absent.ts').pending).toBe(false)
  })
})

/* ── The takeover, driven through the registered occupant ───────────────── */

interface Call { readonly channel: string; readonly endpoint: string; readonly payload: PanelRequest }
interface TreeCall { readonly kind: 'list' | 'changes'; readonly sessionId: string; readonly path: string }
interface OpenCall { readonly sessionId: string; readonly address: string; readonly options?: { readonly replaceTab?: string } }
type WatchFrame = { readonly kind: 'ready' } | { readonly kind: 'change' }
interface WatchControl { push: (frame: WatchFrame) => void; stop: () => void }

function watchStub(control: WatchControl): AsyncIterable<WatchFrame> & { stop(): void } {
  const queue: WatchFrame[] = [{ kind: 'ready' }]
  let wake: (() => void) | undefined
  let stopped = false
  control.push = frame => { queue.push(frame); wake?.() }
  control.stop = () => { stopped = true; wake?.() }
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
    stop: () => { control.stop() },
  }
}

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

interface Registration {
  readonly options: {
    name: string
    id?: string
    store?: { create(scopeKey?: string): StoreInstance<FilesState, never> }
    inject?: (sessionId: unknown, actions: unknown) => Record<string, unknown>
  }
  readonly component: (props?: unknown) => unknown
}

const ROOT_A: RootView = { ordinal: 1, id: 'a', path: '/repos/payments', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-write', alias: 'payments' }
const ROOT_B: RootView = { ordinal: 2, id: 'b', path: '/repos/website', addedAt: '2026-09-12T00:00:00.000Z', state: 'missing', access: 'read-only', detail: 'gone' }

/** The stub listing's tree: `src` is the reveal path, `other/deep` is the off-path nested memory. */
const LISTINGS: Record<string, { name: string; type: 'file' | 'directory' }[]> = {
  '/repos/payments': [{ name: 'src', type: 'directory' }, { name: 'other', type: 'directory' }, { name: 'notes.md', type: 'file' }],
  '/repos/payments/src': [{ name: 'inner.ts', type: 'file' }],
  '/repos/payments/other': [{ name: 'deep', type: 'directory' }, { name: 'loose.md', type: 'file' }],
  '/repos/payments/other/deep': [{ name: 'x.ts', type: 'file' }],
}

interface Harness {
  readonly calls: Call[]
  readonly treeCalls: TreeCall[]
  readonly opens: OpenCall[]
  /** Every `takeover.save` the occupant issued, in order. */
  readonly saves: { key: string; snapshot: unknown }[]
  /** Hold the next `workspaceFiles.list` for a path until its release runs. */
  readonly holdList: (path: string) => () => void
  readonly occupant: (owner?: Record<string, unknown>) => unknown
}

function mount(): Harness {
  const calls: Call[] = []
  const treeCalls: TreeCall[] = []
  const opens: OpenCall[] = []
  const saves: { key: string; snapshot: unknown }[] = []
  const registrations: Registration[] = []
  const held = new Map<string, Promise<void>>()
  const view: RootsView = { primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_A, ROOT_B], limit: 16, count: 2 }
  const currentSession = 'session-1'
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: PanelRequest) => {
        calls.push({ channel, endpoint, payload })
        return { ok: true, value: view }
      },
    },
  }
  const remote = {
    workspaceFiles: {
      list: async (sessionId: string, path: string) => {
        treeCalls.push({ kind: 'list', sessionId, path })
        const gate = held.get(path)
        if (gate !== undefined) await gate
        return {
          ok: true,
          value: { path, truncated: false, entries: LISTINGS[path] ?? [{ name: 'inner.ts', type: 'file' }] },
        }
      },
      changes: (sessionId: string, path: string) => {
        treeCalls.push({ kind: 'changes', sessionId, path })
        return watchStub({ push: () => {}, stop: () => {} })
      },
    },
    $stream: streamStub,
  }
  const ctx = {
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: (ns: string) => (key: string) => `${ns}.${key}`,
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
      register: (options: Registration['options'], component: (props?: unknown) => unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'connection') return connection
      if (name === 'remote') return remote
      if (name === 'remote.workspaceFiles') return remote.workspaceFiles
      if (name === 'sidebarRight') {
        return {
          openResourceIn: (sessionId: string, address: string, options?: { readonly replaceTab?: string }) => {
            opens.push({ sessionId, address, options })
          },
        }
      }
      return undefined
    },
  }
  client.apply(ctx as never)
  const registration = registrations.find(item => item.options.name === 'sidebar.right.tab.document.actions')
  if (registration === undefined) throw new Error('no document.actions registration')
  const instance = registration.options.store?.create('session-1')
  const useStore = <S,>(selector: (state: FilesState) => S): S => useSyncExternalStore(
    notify => instance!.subscribe(notify),
    () => selector(instance!.getSnapshot()),
  )
  const injectProducts = new Map<unknown, Record<string, unknown>>()
  const hookCache = new WeakMap<object, unknown>()
  interface Source { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
  const bindHook = (source: Source): unknown => {
    let hook = hookCache.get(source)
    if (hook === undefined) {
      hook = <S,>(selector: (snapshot: unknown) => S): S => useSyncExternalStore(
        notify => source.subscribe(notify),
        () => selector(source.getSnapshot()),
      )
      hookCache.set(source, hook)
    }
    return hook
  }
  const injectedProps = (session: unknown): Record<string, unknown> => {
    let product = injectProducts.get(session)
    if (product === undefined) {
      const face = registration.options.inject?.(session, instance?.actions) ?? {}
      const { hooks, ...rest } = face
      product = { ...rest }
      const takeover = product.takeover as { save?: (key: string, snapshot: unknown) => void } | undefined
      if (takeover?.save !== undefined) {
        const original = takeover.save
        takeover.save = (key: string, snapshot: unknown) => { saves.push({ key, snapshot }); return original.call(takeover, key, snapshot) }
      }
      for (const [name, source] of Object.entries(hooks as Record<string, Source> | undefined ?? {})) {
        product[`use${name.charAt(0).toUpperCase()}${name.slice(1)}`] = bindHook(source)
      }
      injectProducts.set(session, product)
    }
    return product
  }
  return {
    calls,
    treeCalls,
    opens,
    saves,
    holdList: (path: string) => {
      let release: (() => void) | undefined
      held.set(path, new Promise<void>(resolve => { release = resolve }))
      return () => { held.delete(path); release?.() }
    },
    occupant: owner => createElement(
      registration.component as (props: Record<string, unknown>) => ReactElement,
      {
        sessionId: currentSession,
        useStore,
        actions: instance?.actions,
        ...injectedProps(currentSession),
        ...owner,
      },
    ),
  }
}

/** The preview fixtures this suite appended to `document.body`. */
const appended: HTMLElement[] = []
/** The rows `scrollIntoView` was invoked on, in order. */
const scrolled: HTMLElement[] = []

beforeEach(() => {
  Element.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this) }
})

afterEach(() => {
  cleanup()
  scrolled.length = 0
  for (const element of appended.splice(0)) element.remove()
})

/** The file the fixture previews: nested one directory under the additional root. */
const PREVIEWED = '/repos/payments/src/inner.ts'

interface PreviewMount {
  readonly cell: HTMLElement
  readonly preview: HTMLElement
  readonly header: HTMLElement
  readonly content: HTMLElement
  readonly host: HTMLElement
  readonly unmount: () => void
}

/**
 * Render the occupant inside a preview that mirrors the real DockLayout
 * scaffold: `data-textpreview-url` on the root, `data-textpreview-content`
 * on the row the navigator seat renders into, all inside one dockkit tab
 * host — a `section` carrying `data-dockkit-content` (its tab id) AND
 * `data-dockkit-pane` (the pane whose selected tab it is) inside one
 * `div.tabCell`. A non-empty pane has no element of its own; the pane id
 * moves with the selected host, and `replaceTab` swaps the whole cell.
 */
function renderInPreview(
  harness: Harness,
  owner: Record<string, unknown> = {},
  options: { file?: string; url?: string; tabId?: string; paneId?: string } = {},
): PreviewMount {
  const file = options.file ?? PREVIEWED
  const cell = document.createElement('div')
  cell.setAttribute('data-dockkit-host', 'dock')
  const host = document.createElement('section')
  host.setAttribute('data-dockkit-content', options.tabId ?? 'tab-preview')
  host.setAttribute('data-dockkit-pane', options.paneId ?? 'pane-1')
  const preview = document.createElement('div')
  preview.setAttribute('data-textpreview-url', options.url ?? sessionFileAddress('session-1', file))
  const header = document.createElement('div')
  const content = document.createElement('div')
  content.setAttribute('data-textpreview-content', '')
  const body = document.createElement('div')
  body.setAttribute('data-textpreview-body', '')
  content.append(body)
  preview.append(header, content)
  host.append(preview)
  cell.append(host)
  document.body.append(cell)
  appended.push(cell)
  const occupant = harness.occupant(owner) as ReactElement
  const mounted = render(occupant, { container: header })
  return { cell, preview, header, content, host, unmount: () => { mounted.unmount() } }
}

/** Append the native navigator aside to the preview's content row. */
function openNavigator(content: HTMLElement): { aside: HTMLElement; body: HTMLElement } {
  const aside = document.createElement('aside')
  aside.setAttribute('data-files-navigator', 'pane-1')
  aside.setAttribute('data-files-root', '/repos/primary')
  const body = document.createElement('div')
  body.setAttribute('data-files-body', '')
  aside.append(body)
  act(() => { content.append(aside) })
  return { aside, body }
}

/** The forked body the takeover portals into the aside. */
function forkBody(aside: HTMLElement): HTMLElement {
  const body = aside.querySelector<HTMLElement>('.mrfw-ftBody')
  expect(body).not.toBeNull()
  return body!
}

/** One directory row's expanded flag, by its path hook. */
function expanded(aside: HTMLElement, path: string): boolean | undefined {
  return aside.querySelector<HTMLElement>(`[data-files-path="${path}"] .mrfw-ftRow`)?.getAttribute('aria-expanded') === 'true'
    ? true
    : aside.querySelector(`[data-files-path="${path}"]`) === null ? undefined : false
}

/** Click one directory's row to toggle it, waiting for its child rows to land. */
async function expandDir(aside: HTMLElement, path: string, child: string): Promise<void> {
  const row = aside.querySelector<HTMLElement>(`[data-files-path="${path}"] .mrfw-ftRow`)
  expect(row).not.toBeNull()
  act(() => { row!.click() })
  await waitFor(() => { expect(aside.querySelector(`[data-files-path="${child}"]`)).not.toBeNull() })
}

describe('the preview navigator retarget', () => {
  it('takes over the aside, reveals the previewed file, and routes opens through replaceTab', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })

    // No aside → no list asked: the takeover cannot exist before the
    // Folder toggle mounts the navigator.
    expect(harness.calls.length).toBe(0)
    expect(document.querySelector('aside[data-mrfw-navigator]')).toBeNull()

    const { aside, body } = openNavigator(content)
    await waitFor(() => {
      expect(harness.calls.some(call => call.channel === PANEL_CHANNEL && call.endpoint === 'list'
        && call.payload.sessionId === 'session-1')).toBe(true)
    })
    await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })

    // The forked tree is portaled beside the (stylesheet-hidden) native body
    // and lists the additional root — the reveal then walks `src` open.
    await waitFor(() => { expect(aside.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })
    await waitFor(() => {
      expect(harness.treeCalls.some(call => call.kind === 'list' && call.path === '/repos/payments/src')).toBe(true)
    })

    // The previewed file's row is the current one — marked, and scrolled to.
    const current = await waitFor(() => {
      const row = aside.querySelector<HTMLElement>('[data-files-path="/repos/payments/src/inner.ts"] .mrfw-ftRow[data-files-current]')
      expect(row).not.toBeNull()
      return row!
    })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(scrolled.includes(current)).toBe(true)
    expect(body.isConnected).toBe(true)

    // A file picked in the taken-over tree replaces the preview's own tab —
    // the native navigator's `replaceTab: true` spelled to openResourceIn.
    const row = aside.querySelector<HTMLElement>('[data-files-path="/repos/payments/notes.md"] .mrfw-ftRow')
    expect(row).not.toBeNull()
    act(() => { row!.click() })
    expect(harness.opens.at(-1)?.sessionId).toBe('session-1')
    expect(harness.opens.at(-1)?.address).toContain('notes.md')
    expect(harness.opens.at(-1)?.options).toEqual({ replaceTab: 'tab-preview' })
  })

  it('restores nested off-path expansion across a navigator close and reopen', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
    const first = openNavigator(content)
    await waitFor(() => { expect(first.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(first.aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })

    // Expand a directory the reveal never walked — `other` and its nested
    // `other/deep` — so this test cannot pass on the reveal's own stepping.
    await expandDir(first.aside, '/repos/payments/other', '/repos/payments/other/deep')
    await expandDir(first.aside, '/repos/payments/other/deep', '/repos/payments/other/deep/x.ts')
    expect(expanded(first.aside, '/repos/payments/other/deep')).toBe(true)

    act(() => { first.aside.remove() })
    const callsAtClose = harness.treeCalls.length

    const second = openNavigator(content)
    await waitFor(() => { expect(second.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    // Both directories come back expanded — the nested one's `toggled`
    // write lands it in `expanded`, so the row draws open, and each level
    // is re-listed in saved order (parents first).
    await waitFor(() => {
      expect(expanded(second.aside, '/repos/payments/other')).toBe(true)
      expect(expanded(second.aside, '/repos/payments/other/deep')).toBe(true)
    })
    await waitFor(() => { expect(second.aside.querySelector('[data-files-path="/repos/payments/other/deep/x.ts"]')).not.toBeNull() })
    expect(harness.treeCalls.some((call, index) => call.kind === 'list' && call.path === '/repos/payments/other/deep'
      && index >= callsAtClose)).toBe(true)
  })

  it('survives a replaceTab-style remount: same pane, new preview tab', async () => {
    const harness = mount()
    const first = renderInPreview(harness, { absolutePath: PREVIEWED })
    const firstAside = openNavigator(first.content).aside
    await waitFor(() => { expect(firstAside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await expandDir(firstAside, '/repos/payments/other', '/repos/payments/other/deep')

    // Upstream's `replaceTab` closes the preview tab and mints a new one in
    // the same pane — one commit swaps the cells: the occupant unmounts,
    // the old tab host leaves, and the new host carries the same pane id.
    // The pane's carrier never disappears, so its record lives.
    first.unmount()
    first.cell.remove()

    const second = renderInPreview(harness, { absolutePath: '/repos/payments/other/loose.md' }, { tabId: 'tab-next', file: '/repos/payments/other/loose.md' })
    const secondAside = openNavigator(second.content).aside
    await waitFor(() => { expect(secondAside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    // The pane record carried the expansion across the tab's death.
    await waitFor(() => { expect(expanded(secondAside, '/repos/payments/other')).toBe(true) })
    // The new tab's opens replace ITS tab — the minted id, not the dead one.
    const row = secondAside.querySelector<HTMLElement>('[data-files-path="/repos/payments/notes.md"] .mrfw-ftRow')
    act(() => { row!.click() })
    expect(harness.opens.at(-1)?.options).toEqual({ replaceTab: 'tab-next' })
  })

  it('keeps a post-settle manual collapse collapsed — including a restored ancestor', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
    const { aside } = openNavigator(content)
    await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
    // The walk settled. Collapsing the revealed file's ancestor must stay
    // collapsed across later store updates — a settled walk never steps.
    const srcRow = aside.querySelector<HTMLElement>('[data-files-path="/repos/payments/src"] .mrfw-ftRow')
    act(() => { srcRow!.click() })
    await waitFor(() => { expect(expanded(aside, '/repos/payments/src')).toBe(false) })
    await expandDir(aside, '/repos/payments/other', '/repos/payments/other/deep')
    expect(expanded(aside, '/repos/payments/src')).toBe(false)
  })

  it('honors a collapse across navigator close/reopen for the same file', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
    const first = openNavigator(content)
    await waitFor(() => { expect(first.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(first.aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
    // The reader collapses the reveal's ancestor, then closes: the pane
    // record's `revealed` must suppress re-stepping on reopen — without it
    // the walk would reopen `src` as soon as its level lands.
    act(() => { first.aside.querySelector<HTMLElement>('[data-files-path="/repos/payments/src"] .mrfw-ftRow')!.click() })
    await waitFor(() => { expect(expanded(first.aside, '/repos/payments/src')).toBe(false) })
    act(() => { first.aside.remove() })
    const callsAtClose = harness.treeCalls.length

    const second = openNavigator(content)
    await waitFor(() => { expect(second.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    // The file is revealed already: `src` comes back as a row but stays
    // closed, and no listing is asked for it either.
    await waitFor(() => { expect(second.aside.querySelector('[data-files-path="/repos/payments/src"]')).not.toBeNull() })
    expect(expanded(second.aside, '/repos/payments/src')).toBe(false)
    expect(harness.treeCalls.some((call, index) => call.kind === 'list' && call.path === '/repos/payments/src'
      && index >= callsAtClose)).toBe(false)
  })

  it('restores the scroll offset saved at close once the body overflows', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
    const first = openNavigator(content)
    await waitFor(() => { expect(first.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => { expect(first.aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"]')).not.toBeNull() })
    // The live scroll mirror, fed by the body's own scroll event.
    const firstBody = forkBody(first.aside)
    firstBody.scrollTop = 40
    act(() => { firstBody.dispatchEvent(new Event('scroll')) })
    act(() => { first.aside.remove() })
    // The close-time save lands once the aside observer's microtask runs —
    // and it must carry the live offset, not the stale zero.
    await waitFor(() => {
      expect(harness.saves.some(save => (save.snapshot as { scrollTop?: number }).scrollTop === 40)).toBe(true)
    })

    // jsdom has no layout — give every element an overflow so the deferred
    // restore can land, then reopen.
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.clientHeight + 100 } })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 100 } })
    try {
      const second = openNavigator(content)
      await waitFor(() => { expect(second.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
      await waitFor(() => { expect(forkBody(second.aside).scrollTop).toBe(40) })
    } finally {
      if (originalHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalHeight)
      if (originalClient !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClient)
    }
  })

  it('cancels an in-flight reveal when the reader collapses mid-walk', async () => {
    const harness = mount()
    const release = harness.holdList('/repos/payments/src')
    try {
      const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
      const { aside } = openNavigator(content)
      await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
      // `src` opened for the walk but its level is held: the reveal is
      // pending — the reader's collapse now must stop it for good.
      await waitFor(() => { expect(expanded(aside, '/repos/payments/src')).toBe(true) })
      act(() => { aside.querySelector<HTMLElement>('[data-files-path="/repos/payments/src"] .mrfw-ftRow')!.click() })
      await waitFor(() => { expect(expanded(aside, '/repos/payments/src')).toBe(false) })
      release()
      await waitFor(() => {
        expect(harness.treeCalls.some(call => call.kind === 'list' && call.path === '/repos/payments/src')).toBe(true)
      })
      await act(async () => {})
      // The listing landed, the walk stayed dead: `src` remains closed.
      expect(expanded(aside, '/repos/payments/src')).toBe(false)
    } finally {
      release()
    }
  })

  it('hands the native tree Factory the current row and its ref', async () => {
    const harness = mount()
    const captured: { name: string; input: { current?: string; currentRef?: unknown } }[] = []
    const renderFactorySlot = (name: string, input: { current?: string; currentRef?: unknown }): null => {
      captured.push({ name, input })
      return null
    }
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED, renderFactorySlot })
    const { aside } = openNavigator(content)
    await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(captured.some(call => call.name === 'sidebar.files.tree' && call.input.current === '/repos/payments/src/inner.ts'
        && typeof call.input.currentRef === 'function')).toBe(true)
    })
  })

  it('never touches the native navigator for files outside additional roots', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: '/repos/primary/README.md' }, { file: '/repos/primary/README.md' })
    const { aside } = openNavigator(content)
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })
    await act(async () => {})
    expect(aside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(aside.querySelector('.mrfw-ftBody')).toBeNull()
    expect(harness.treeCalls.length).toBe(0)
  })

  it('refuses absolute-scope addresses and other sessions', async () => {
    const harness = mount()
    // An absolute-scope content id is not a session file: the retarget
    // cannot prove the preview belongs to this session and stands down,
    // exactly like upstream's `relativeFileOf` rejecting non-session scope.
    const absolute = renderInPreview(harness, { absolutePath: PREVIEWED }, { url: absoluteFileAddress(PREVIEWED) })
    const firstAside = openNavigator(absolute.content).aside
    await act(async () => {})
    expect(firstAside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(harness.calls.length).toBe(0)

    // A session file of ANOTHER session never takes this one over.
    const other = renderInPreview(harness, { absolutePath: PREVIEWED }, { url: sessionFileAddress('session-2', PREVIEWED), tabId: 'tab-other' })
    const secondAside = openNavigator(other.content).aside
    await act(async () => {})
    expect(secondAside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(harness.treeCalls.length).toBe(0)
  })

  it('refuses files under unavailable roots', async () => {
    const harness = mount()
    const missing = renderInPreview(harness, { absolutePath: '/repos/website/a.ts' }, { file: '/repos/website/a.ts' })
    const { aside } = openNavigator(missing.content)
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })
    await act(async () => {})
    expect(aside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(harness.treeCalls.length).toBe(0)
  })

  it('re-keys the takeover when the aside moves panes in place', async () => {
    const harness = mount()
    const first = renderInPreview(harness, { absolutePath: PREVIEWED })
    // Another selected tab keeps pane-1's carrier alive after the drag —
    // the source pane still exists while it holds other tabs.
    const sibling = document.createElement('section')
    sibling.setAttribute('data-dockkit-pane', 'pane-1')
    document.body.append(sibling)
    appended.push(sibling)
    const { aside } = openNavigator(first.content)
    await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
    await expandDir(aside, '/repos/payments/other', '/repos/payments/other/deep')

    // Dragging the preview to another pane rewrites both ids in place —
    // the same aside element and the same tab host, a new pane id on each.
    act(() => {
      aside.setAttribute('data-files-navigator', 'pane-2')
      first.host.setAttribute('data-dockkit-pane', 'pane-2')
    })
    // pane-2's record is its own — empty — so `other` stays closed while
    // the reveal opens `src` under the new pane's bookkeeping.
    await waitFor(() => {
      expect(aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
    expect(expanded(aside, '/repos/payments/other')).toBe(false)
    await waitFor(() => { expect(harness.saves.some(save => save.key === 'pane-2')).toBe(true) })

    // Dragging back lands on pane-1's kept record — its carrier, the
    // sibling host, never left the document.
    act(() => {
      aside.setAttribute('data-files-navigator', 'pane-1')
      first.host.setAttribute('data-dockkit-pane', 'pane-1')
    })
    await waitFor(() => { expect(expanded(aside, '/repos/payments/other')).toBe(true) })
  })

  it('drops the pane record when the pane leaves the layout — even before the body unmounts', async () => {
    const harness = mount()
    const first = renderInPreview(harness, { absolutePath: PREVIEWED })
    const { aside } = openNavigator(first.content)
    await waitFor(() => { expect(aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
    await expandDir(aside, '/repos/payments/other', '/repos/payments/other/deep')

    // The pane's last tab closed: its only carrier leaves the document
    // while the occupant's React tree still lives — detached, with no
    // cleanup yet. The death watch drops the record first, so the body's
    // unmount afterward cannot write a ghost back into the map.
    first.cell.remove()
    await act(async () => {})
    first.unmount()
    await act(async () => {})

    const second = renderInPreview(harness, { absolutePath: '/repos/payments/notes.md' }, { tabId: 'tab-next', file: '/repos/payments/notes.md' })
    const secondAside = openNavigator(second.content).aside
    await waitFor(() => { expect(secondAside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => { expect(secondAside.querySelector('[data-files-path="/repos/payments/other"]')).not.toBeNull() })
    // A pane that died keeps nothing: `other` never re-expands.
    expect(expanded(secondAside, '/repos/payments/other')).toBe(false)
  })
})
