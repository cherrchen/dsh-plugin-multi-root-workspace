/**
 * The switcher spec's host-side harness, shared by the jsdom suite and the
 * real-browser GUI spec: the stub client context (Connection RPC,
 * `remote.workspaceFiles`, `sidebarRight`, sessions), the `mount` driver that
 * plays the slot framework's part for the real registered occupant, and the
 * `data-files-root`/`data-dockkit-content` pane fixture the takeover lookups
 * require. See `tests/client-switcher.spec.tsx` for the contract this mirrors.
 */

import { StrictMode, createElement, useSyncExternalStore, type ReactElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { OPEN_IN_APP_APPS_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import type { StoreInstance } from '@deepseek-ai/dsh-client-store'
import type { PanelRequest, RootView, RootsView } from '../../src/contract.ts'
import type { FilesState } from '../../src/client/files-tree/store.ts'
import * as client from '../../src/client/index.ts'
import type { RemotesView } from '../../src/remote/panel-contract.ts'
import type { RemoteFilesFailureCode, RemoteFilesListing } from '../../src/remote/files-contract.ts'

/** One captured channel call. */
export interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: PanelRequest
}

/** One captured workspaceFiles call (the forked tree's remote traffic). */
export interface TreeCall {
  readonly kind: 'list' | 'changes'
  readonly sessionId: string
  readonly path: string
}

/** One captured sidebarRight.openResourceIn call. */
export interface OpenCall {
  readonly sessionId: string
  readonly address: string
}

/** The frame a stub watch queue hands the verbatim `createWatch` loop. */
export type WatchFrame = { readonly kind: 'ready' } | { readonly kind: 'change' }

/** A parked per-directory watch the spec can feed frames into. */
export interface WatchControl {
  push: (frame: WatchFrame) => void
  stop: () => void
}

/**
 * The `workspaceFiles.changes` stub's product: yields `ready` once, then
 * whatever `push` feeds it, until `stop` parks it for good. The iterable
 * carries `stop` so the `$stream` stub's `dispose` can wake a parked reader.
 */
export function watchStub(control: WatchControl): AsyncIterable<WatchFrame> & { stop(): void } {
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

/**
 * The `$stream` supervisor's stand-in: iterates `open`'s frames once,
 * wrapping each as `{ value, accept }`. There is no reconnect supervision —
 * a stubbed stream that ends simply ends.
 */
export function streamStub(options: { name: string; open: (signal: AbortSignal) => AsyncIterable<WatchFrame>; ended: (accepted: boolean) => Error }) {
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

/** One slot registration the plugin made. */
export interface Registration {
  readonly options: {
    name: string
    id?: string
    order?: number
    locale?: string
    store?: { create(scopeKey?: string): StoreInstance<FilesState, never> }
    inject?: (sessionId: unknown, actions: unknown) => Record<string, unknown>
  }
  readonly component: (props?: unknown) => unknown
}

export const ROOT_A: RootView = { ordinal: 1, id: 'a', path: '/repos/payments', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-write', alias: 'payments' }
export const ROOT_B: RootView = { ordinal: 2, id: 'b', path: '/repos/website', addedAt: '2026-09-12T00:00:00.000Z', state: 'missing', access: 'read-only', detail: 'gone' }
export const ROOT_C: RootView = { ordinal: 3, id: 'c', path: '/repos/docs', addedAt: '2026-09-12T00:00:00.000Z', state: 'available', access: 'read-only', alias: 'docs' }

/** The stub client context, plus what the plugin did with it. */
export interface Harness {
  readonly calls: Call[]
  /** The forked tree's `workspaceFiles` traffic: `changes` opens, then `list`s. */
  readonly treeCalls: TreeCall[]
  /** Addresses the fork asked `sidebarRight.openResourceIn` to open. */
  readonly opens: OpenCall[]
  readonly registrations: Registration[]
  /** The `files.actions` occupant factory; call it with the slot owner. */
  readonly occupant: (owner?: { absolutePath?: string; renderFactorySlot?: unknown; useContextMenu?: unknown }) => unknown
  setView: (view: RootsView) => void
  setSession: (sessionId: string | undefined) => void
  setListFails: (fails: boolean) => void
  /** Hold the next search RPC until the returned release runs. */
  readonly holdSearch: () => () => void
  /** Make the search endpoint reject with a panel code, or answer normally when undefined. */
  setSearchFailure: (code: string | undefined) => void
  /** Flip the composed remote-tools settings form. */
  setRemoteEnabled: (enabled: boolean) => void
  /** The `remoteFiles.list` RPCs, in order (relativePath + authorization used). */
  readonly remoteListCalls: RemoteListCall[]
  /** The `remotes.waitForAuthorizationChange` RPCs, in order. */
  readonly remoteWaitCalls: { readonly authorization: string }[]
  /** Resolve every parked wait with `{unchanged:true}`. */
  readonly releaseWaits: () => void
}

/** Optional host services a spec can put behind `ctx.get`. */
export interface HostServices {
  readonly contextMenus?: unknown
  readonly sidebarRightTabs?: unknown
}

/**
 * The remote-plane stub behind `remotes`, `remoteFiles.list` and
 * `remotes.waitForAuthorizationChange`: a mutable fixture the test flips
 * mid-flight to simulate re-grants, outages and settings changes.
 */
export interface RemoteStub {
  /** The view `remotes` answers; `undefined` answers an unavailable-plane error. */
  view: RemotesView | undefined
  /** `remoteFiles.list` answers per request; a `{code}` answer is the coded failure; a Promise parks the call. */
  list: (request: { readonly relativePath: string; readonly authorization: string }) =>
    RemoteFilesListing | { readonly code: RemoteFilesFailureCode } | Promise<RemoteFilesListing | { readonly code: RemoteFilesFailureCode }>
  /** The lease behavior: park until `releaseWaits`, resolve unchanged, or fail with a code. */
  wait: 'park' | 'resolve' | { readonly code: RemoteFilesFailureCode }
}

/** One `remoteFiles.list` RPC the harness recorded. */
export interface RemoteListCall {
  readonly relativePath: string
  readonly authorization: string
}

/** Optional host capabilities the stub remote exposes. */
export interface MountOptions {
  /** Give the stub `workspaceFiles` the `0.2.2-rc.2` search method (the search seat's probe). */
  readonly workspaceSearch?: boolean
  /** A live remote-plane stub; absent means the legacy "no remote feature" composition. */
  readonly remotes?: RemoteStub
  /** Compose the modern remote-tools settings form, initially switched off. */
  readonly remoteForm?: boolean
}

/** Apply the real client entry to a recording stub context. */
export function mount(withConnection = true, services: HostServices = {}, options: MountOptions = {}): Harness {
  const calls: Call[] = []
  const treeCalls: TreeCall[] = []
  const opens: OpenCall[] = []
  const registrations: Registration[] = []
  const sessionListeners = new Set<() => void>()
  let view: RootsView = { primaryRoot: '/repos/primary', primaryName: 'Platform', roots: [ROOT_A, ROOT_B, ROOT_C], limit: 16, count: 3 }
  let currentSession: string | undefined = 'session-1'
  let listFails = false
  let searchFailure: string | undefined
  let searchGate: Promise<void> | undefined
  let remoteEnabledFlag = false
  const remoteListeners = new Set<() => void>()
  const remoteForm = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 0, value: { enabled: remoteEnabledFlag } }),
    subscribe: (listener: () => void) => { remoteListeners.add(listener); return () => { remoteListeners.delete(listener) } },
    mutate: async () => true,
  }
  const remoteListCalls: RemoteListCall[] = []
  const remoteWaitCalls: { readonly authorization: string }[] = []
  const waitReleases: (() => void)[] = []
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: PanelRequest, signal?: AbortSignal) => {
        calls.push({ channel, endpoint, payload })
        // The remote-plane endpoints answer only while a RemoteStub is armed;
        // without one they take the legacy branch below, whose RootsView
        // cannot parse as a RemotesView — exactly the "no remote feature"
        // composition the discovery path degrades on.
        if (endpoint === 'remotes' && options.remotes !== undefined) {
          return options.remotes.view === undefined
            ? { ok: false, error: { code: 'provider-unavailable', message: 'the remote control plane is down' } }
            : { ok: true, value: options.remotes.view }
        }
        if (endpoint === 'remoteFiles.list' && options.remotes !== undefined) {
          const requested = payload as { readonly relativePath: string; readonly authorization: string }
          remoteListCalls.push({ relativePath: requested.relativePath, authorization: requested.authorization })
          const outcome = await options.remotes.list(requested)
          return 'code' in outcome
            ? { ok: false, error: { code: outcome.code, message: outcome.code } }
            : { ok: true, value: outcome }
        }
        if (endpoint === 'remotes.waitForAuthorizationChange' && options.remotes !== undefined) {
          remoteWaitCalls.push({ authorization: (payload as { readonly authorization: string }).authorization })
          const behavior = options.remotes.wait
          if (behavior === 'park') {
            return await new Promise((resolve, reject) => {
              waitReleases.push(() => { resolve({ ok: true, value: { unchanged: true } }) })
              signal?.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { code: 'cancelled' })) }, { once: true })
            })
          }
          return typeof behavior === 'object'
            ? { ok: false, error: { code: behavior.code, message: behavior.code } }
            : { ok: true, value: { unchanged: true } }
        }
        if (endpoint === 'list' && listFails) {
          return { ok: false, error: { code: 'registry-contended', message: 'registry busy' } }
        }
        if (endpoint === 'search') {
          const gate = searchGate
          if (gate !== undefined) await gate
          if (searchFailure !== undefined) {
            return { ok: false, error: { code: searchFailure, message: searchFailure + ' happened' } }
          }
          const requested = (payload as { readonly rootId?: string }).rootId
          const root = requested === 'c' ? '/repos/docs' : requested === 'a' ? '/repos/payments' : '/repos/primary'
          return { ok: true, value: { root, matches: [], truncated: false, incomplete: false } }
        }
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
      ...(options.workspaceSearch === true
        ? {
          search: async (_sessionId: string, _request: { readonly query: string }) => ({
            ok: true as const,
            value: { root: '/repos/payments', matches: [], truncated: false, incomplete: false },
          }),
        }
        : {}),
    },
    $stream: streamStub,
  }
  const ctx = {
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // The Files-pane switcher spec does not exercise the workspace menu. The
    // settings card's dynamic injection resolves immediately only when this
    // harness is asked to compose the modern remote-tools form.
    inject: (services: readonly string[], callback: (scope: unknown) => unknown) => {
      if (options.remoteForm === true && services.includes('configForms')) {
        const out = callback(ctx)
        return typeof out === 'function' ? out : () => {}
      }
      return () => {}
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
      if (name === 'connection') return withConnection ? connection : undefined
      if (name === 'remote') return remote
      // `remote.workspaceFiles` is a nested service — lazyFilesRemote reads it
      // through the inject-free `ctx.get`, so the stub serves it by name.
      if (name === 'remote.workspaceFiles') return remote.workspaceFiles
      if (name === 'sidebarRight') {
        return { openResourceIn: (sessionId: string, address: string) => { opens.push({ sessionId, address }) } }
      }
      if (name === 'contextMenus') return services.contextMenus
      if (name === 'sidebarRightTabs') return services.sidebarRightTabs
      if (name === 'configForms') return options.remoteForm === true
        ? { get: (entryId: string) => entryId === 'multi-root-remote-tools' ? remoteForm : undefined }
        : undefined
      if (name === 'sessions') {
        return {
          list: {
            subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
            getSnapshot: () => ({ current: currentSession }),
          },
        }
      }
      return undefined
    },
  }
  client.apply(ctx as never)
  const registration = registrations.find(item => item.options.name === 'sidebar.right.tab.files.actions')
  if (registration === undefined) throw new Error('no files.actions registration')
  // What the slot framework synthesizes for a session-scoped registration
  // that declares a store and an inject factory: one minted instance, its
  // baked actions, the `useStore` hook bound to its snapshot source, and the
  // factory's face spread onto the composed props.
  const instance = registration.options.store?.create('session-1')
  const useStore = <S,>(selector: (state: FilesState) => S): S => useSyncExternalStore(
    notify => instance!.subscribe(notify),
    () => selector(instance!.getSnapshot()),
  )
  // The framework runs inject once per (registration, session binding) and
  // binds each `hooks` source to a `use<Name>` selector hook — this cache is
  // what lets a remounted occupant see the same selection and takeovers.
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
    registrations,
    // The registered component renders as a real React component under the
    // renderer (`jsx(Comp, props)`), so its hooks bind to its own fiber —
    // wrap it in an element rather than invoking it synchronously.
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
    setView: next => { view = next },
    setSession: next => {
      currentSession = next
      for (const listener of sessionListeners) listener()
    },
    setListFails: next => { listFails = next },
    holdSearch: () => {
      let release: (() => void) | undefined
      searchGate = new Promise<void>(resolve => { release = resolve })
      return () => {
        searchGate = undefined
        release?.()
      }
    },
    setSearchFailure: next => { searchFailure = next },
    setRemoteEnabled: next => {
      remoteEnabledFlag = next
      for (const listener of remoteListeners) listener()
    },
    remoteListCalls,
    remoteWaitCalls,
    releaseWaits: () => { for (const release of waitReleases.splice(0)) release() },
  }
}

/** Every search RPC the harness recorded, in call order. */
export function searchCalls(harness: Harness): Call[] {
  return harness.calls.filter(call => call.endpoint === 'search')
}

/** The payload fields of one search call this suite asserts on. */
export interface SearchPayload {
  readonly rootId?: string
  readonly query?: string
}

/** The pane fixtures this suite appended to `document.body`. */
export const appended: HTMLElement[] = []

/** One fetch the open-in-app fork issued (verb, url, decoded JSON body). */
export interface FetchCall {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

/**
 * Stub the open-in-app host routes the fork's controller fetches. The route
 * constants come from the installed shared module so the stub matches
 * whichever spelling the matrix version carries — document-relative from
 * 0.1.7-alpha.1 on, absolute before it.
 */
export function stubOpenInApp(apps: readonly string[] = ['finder', 'vscode']): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    calls.push({ method: init?.method ?? 'GET', url, ...(body === undefined ? {} : { body }) })
    if (url === OPEN_IN_APP_APPS_ROUTE) {
      return new Response(JSON.stringify({ apps }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const element of appended.splice(0)) element.remove()
})

/**
 * Render the occupant inside a header that mirrors the upstream Files pane,
 * itself inside a dockkit tab host. The returned `pane` is where the forked
 * tree must portal into. `wrapped` plays 0.2.3-alpha.1's Files page, which
 * puts the slot anchor inside a `.externalActions` box under the header;
 * without it the anchor is the header's direct child, as it was before.
 */
export function renderInPane(harness: Harness, owner: { absolutePath?: string; renderFactorySlot?: unknown; useContextMenu?: unknown } = { absolutePath: '/repos/primary' }, strictMode = false, modern = false, wrapped = false): {
  pane: HTMLElement
  host: HTMLElement
  header: HTMLElement
  unmount: () => void
  rerender: (occupant: ReactElement) => void
} {
  const host = document.createElement('section')
  host.setAttribute('data-dockkit-content', 'tab-1')
  const pane = document.createElement('div')
  pane.setAttribute(modern ? 'data-files-page' : 'data-files-root', '')
  const header = document.createElement('div')
  const path = document.createElement('span')
  path.setAttribute('data-files-path', '')
  const reload = document.createElement('button')
  reload.setAttribute('data-files-reload', '')
  header.append(path, reload)
  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'sidebar.right.tab.files.actions')
  if (wrapped) {
    const actions = document.createElement('div')
    actions.className = 'externalActions'
    actions.append(slot)
    header.append(actions)
  }
  const body = document.createElement('div')
  body.setAttribute(modern ? 'data-files-content' : 'data-files-body', '')
  pane.append(header, body)
  host.append(pane)
  document.body.append(host)
  appended.push(host)
  const occupant = harness.occupant(owner) as ReactElement
  const mounted = render(strictMode ? <StrictMode>{occupant}</StrictMode> : occupant, { container: wrapped ? slot : header })
  return {
    pane,
    host,
    header,
    unmount: () => { mounted.unmount() },
    rerender: next => { mounted.rerender(next) },
  }
}
