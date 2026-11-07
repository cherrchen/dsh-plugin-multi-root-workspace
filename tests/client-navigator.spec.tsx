// @vitest-environment jsdom
/**
 * The document-preview navigator's additional-root retarget, driven through
 * the real client entry: the registered `sidebar.right.tab.document.actions`
 * occupant is rendered inside a `[data-textpreview-url]` fixture, the
 * navigator aside is appended and removed the way the Folder toggle mounts
 * and unmounts it, and the takeover, reveal, replace-tab open route, and
 * close/reopen memory are observed through the stub Connection channel, the
 * stub `remote`/`sidebarRight` services, and the DOM.
 *
 * The preview fixture mirrors the upstream DOM shape the retarget reads —
 * `data-textpreview-url` (the tab's content id) on the preview root,
 * `data-textpreview-content` on the row the NavigatorSeat renders into,
 * `aside[data-files-navigator]` with a `[data-files-body]` inside it, and
 * `data-dockkit-content` on the tab host — because `closest` lookups and a
 * MutationObserver are what decide whether the forked tree exists at all.
 *
 * The harness plays the slot framework's part exactly as
 * `client-switcher.spec.tsx` does: it mints the registration's session
 * store, runs its `inject` factory, and spreads the result plus
 * `useStore`/`actions`/`sessionId` onto the composed props.
 */

import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
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
    // Even if a view ever listed the primary among its roots.
    const odd: RootsView = { primaryRoot: '/repos/primary', roots: [{ ordinal: 1, id: 'p', path: '/repos/primary', addedAt: 't', state: 'available', access: 'read-write' }], limit: 16, count: 1 }
    expect(rootForPath(odd, '/repos/primary/a.ts')).toBeUndefined()
  })

  it('locateFile walks listed levels and reports pending like upstream', () => {
    const tree = {
      root: '/r',
      levels: {
        '/r': { kind: 'ready' as const, level: { entries: [{ name: 'src', type: 'directory' as const }, { name: 'top.ts', type: 'file' as const }], truncated: false }, failure: undefined },
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

interface Harness {
  readonly calls: Call[]
  readonly treeCalls: TreeCall[]
  readonly opens: OpenCall[]
  readonly occupant: (owner?: { absolutePath?: string; sessionId?: string }) => unknown
}

function mount(): Harness {
  const calls: Call[] = []
  const treeCalls: TreeCall[] = []
  const opens: OpenCall[] = []
  const registrations: Registration[] = []
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
        return {
          ok: true,
          value: {
            path,
            truncated: false,
            entries: path === '/repos/payments'
              ? [{ name: 'src', type: 'directory' }, { name: 'notes.md', type: 'file' }]
              : [{ name: 'inner.ts', type: 'file' }],
          },
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

/**
 * Render the occupant inside a preview that mirrors the upstream scaffold:
 * `data-textpreview-url` on the root, `data-textpreview-content` on the row
 * the navigator seat renders into, all inside one dockkit tab host. The
 * `content` div is where the suite appends the navigator aside.
 */
function renderInPreview(harness: Harness, owner: { absolutePath?: string; sessionId?: string } = {}, file = PREVIEWED): {
  preview: HTMLElement
  header: HTMLElement
  content: HTMLElement
  host: HTMLElement
  unmount: () => void
} {
  const host = document.createElement('section')
  host.setAttribute('data-dockkit-content', 'tab-preview')
  const preview = document.createElement('div')
  preview.setAttribute('data-textpreview-url', file === '' ? '' : sessionFileAddress('session-1', file))
  const header = document.createElement('div')
  const content = document.createElement('div')
  content.setAttribute('data-textpreview-content', '')
  const body = document.createElement('div')
  body.setAttribute('data-textpreview-body', '')
  content.append(body)
  preview.append(header, content)
  host.append(preview)
  document.body.append(host)
  appended.push(host)
  const occupant = harness.occupant(owner) as ReactElement
  const mounted = render(occupant, { container: header })
  return { preview, header, content, host, unmount: () => { mounted.unmount() } }
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

describe('the preview navigator retarget', () => {
  it('takes over the aside, reveals the previewed file, and routes opens through replaceTab', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })

    // The marker lives in the header immediately; the panel list decides.
    await waitFor(() => {
      expect(harness.calls.some(call => call.channel === PANEL_CHANNEL && call.endpoint === 'list'
        && call.payload.sessionId === 'session-1')).toBe(true)
    })

    // Nothing happens before the Folder toggle mounts the aside.
    expect(document.querySelector('aside[data-mrfw-navigator]')).toBeNull()

    const { aside, body } = openNavigator(content)
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

  it('restores expansion and scroll across a navigator close and reopen', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: PREVIEWED })
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })

    const first = openNavigator(content)
    await waitFor(() => {
      expect(harness.treeCalls.some(call => call.kind === 'list' && call.path === '/repos/payments/src')).toBe(true)
    })
    await waitFor(() => {
      expect(first.aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })

    // The Folder toggle closes: the aside leaves, the takeover ends.
    act(() => { first.aside.remove() })
    await waitFor(() => { expect(first.aside.hasAttribute('data-mrfw-navigator')).toBe(false) })
    const listsAtClose = harness.treeCalls.filter(call => call.kind === 'list').length

    // Reopened: a fresh aside, a fresh bucket — and the expansion memory
    // restores `src` without any gesture (upstream's kept `expanded`).
    const second = openNavigator(content)
    await waitFor(() => { expect(second.aside.hasAttribute('data-mrfw-navigator')).toBe(true) })
    await waitFor(() => {
      expect(harness.treeCalls.filter(call => call.kind === 'list').length).toBeGreaterThan(listsAtClose)
      expect(harness.treeCalls.some(call => call.kind === 'list' && call.path === '/repos/payments/src'
        && harness.treeCalls.indexOf(call) >= listsAtClose)).toBe(true)
    })
    await waitFor(() => {
      expect(second.aside.querySelector('[data-files-path="/repos/payments/src/inner.ts"] [data-files-current]')).not.toBeNull()
    })
  })

  it('never touches the native navigator for files outside additional roots', async () => {
    const harness = mount()
    const { content } = renderInPreview(harness, { absolutePath: '/repos/primary/README.md' }, '/repos/primary/README.md')
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })
    const { aside } = openNavigator(content)
    await act(async () => {})
    expect(aside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(aside.querySelector('.mrfw-ftBody')).toBeNull()
    expect(harness.treeCalls.length).toBe(0)
  })

  it('refuses files under unavailable roots and other sessions', async () => {
    const harness = mount()
    // Under the 'missing' additional root: no takeover.
    const missing = renderInPreview(harness, { absolutePath: '/repos/website/a.ts' }, '/repos/website/a.ts')
    await waitFor(() => {
      expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true)
    })
    const firstAside = openNavigator(missing.content).aside
    await act(async () => {})
    expect(firstAside.hasAttribute('data-mrfw-navigator')).toBe(false)

    // A content id naming another session never takes this one over, even
    // though the owner path would match.
    const preview = document.createElement('div')
    preview.setAttribute('data-textpreview-url', sessionFileAddress('session-2', '/repos/payments/src/inner.ts'))
    const header = document.createElement('div')
    const content = document.createElement('div')
    content.setAttribute('data-textpreview-content', '')
    const host = document.createElement('section')
    host.setAttribute('data-dockkit-content', 'tab-other')
    preview.append(header, content)
    host.append(preview)
    document.body.append(host)
    appended.push(host)
    render(harness.occupant({ absolutePath: '/repos/payments/src/inner.ts' }) as ReactElement, { container: header })
    await act(async () => {})
    const secondAside = openNavigator(content).aside
    await act(async () => {})
    expect(secondAside.hasAttribute('data-mrfw-navigator')).toBe(false)
    expect(harness.treeCalls.length).toBe(0)
  })
})
