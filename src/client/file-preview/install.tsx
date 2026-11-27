/**
 * The remote file preview's host integration (ADR-0053 P5): one singleton
 * installation that owns the preview resource provider, the tab-type
 * definition, the keyed body registration, the book's session bookkeeping,
 * and the `RemotePreviewIntegration` P6 calls to route opens.
 *
 * Every host service is reached structurally (`ctx.get`/`ctx.inject` slices
 * in this file — no deep import): a host without `resources`,
 * `sidebarRightTabs`, `sidebarRight` or the pane-tab seat simply never
 * mounts the preview, and a failed/absent registration disables ONLY this
 * surface — the Files tree is untouched.
 *
 * The resource stream carries lifetime facts only (`{ available: true }`,
 * then one coded error on grant death): upstream retains the last `ok`
 * value on failure frames, so byte frames would smuggle stale content —
 * content reads stay on `RemotePreviewBook`'s content views (P4).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/install
 */
import { createElement, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteFilesError, type RemoteFilesFailureCode } from '../../remote/files-contract.ts'
import { REMOTE_PREVIEW_KIND, REMOTE_PREVIEW_RESOURCE_TYPE, remoteFileAddress, remoteFileId } from './resource-address.ts'
import type { RemotePreviewBook, RemotePreviewRecord } from './resource-book.ts'
import type { SshFilesIdentity } from './authorization.ts'
import { RemotePreviewViewer } from './Viewer.tsx'
import { RemotePreviewFolder } from './Folder.tsx'
import { createFilesTreeSurface } from '../files-tree/adapter.tsx'
import type { createFilesTreeSeats } from '../files-tree/adapter.tsx'
import { REMOTE_FILES_FAILURE_GROUPS } from '../files-tree/providers/ssh.ts'

/** The registered tab-type definition id — also the keyed body slot's key. */
const DEFINITION_ID = 'multi-root-remote-preview'

/** A canonical v4 mint used only to probe the tab registry — never a record. */
const SENTINEL_ADDRESS = remoteFileAddress('00000000-0000-4000-8000-000000000000')!

/** The tab-info slice the body reads — a structural subset of the framework's. */
export interface PreviewTabInfo {
  readonly panel: { readonly id: TabId; readonly isFloating: boolean }
  readonly tab: {
    readonly id: TabId
    readonly contentId: string
    readonly visible: boolean
    readonly signal: AbortSignal
    readonly actions: { bindCommands(commands: { refresh?: () => void }): () => void }
    /** The replacing open's navigation params — carries the Folder-open marker. */
    readonly navigation?: { readonly params?: unknown } | undefined
  }
}

/** What P6 calls to route a remote file into a preview tab. */
export interface RemotePreviewIntegration {
  /** Whether an open for this session would actually reach a live preview tab. */
  canRoute(sessionId: string): boolean
  /** Register + route one remote file; silently no-ops where routing is unavailable. */
  open(identity: SshFilesIdentity, relativePath: string, label: string, replaceTab?: TabId): void
}

/** One resource-stream frame — lifetime facts only, never content. */
type PreviewFrame =
  | { readonly ok: true; readonly value: { readonly available: true } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } }

/** The `resources` service slice this surface registers against. */
interface ResourcesSlice {
  register(provider: {
    readonly protocol: string
    readonly open: (address: string, context: { readonly signal: AbortSignal }) => AsyncIterable<PreviewFrame>
  }): () => void
}

/** The `sidebarRightTabs` viewer registry slice. */
interface ViewerTabsSlice {
  register(definition: {
    readonly id: string
    readonly kind: string
    readonly priority: string
    readonly keepMounted: boolean
    readonly patterns: readonly string[]
    readonly canOpen: (address: string) => boolean
    readonly title: (address: string) => string
  }): () => void
  candidates(address: string): readonly { readonly id?: unknown }[]
}

/** The `sidebarRight` controller's open slice. */
interface SidebarRightSlice {
  openResourceIn?(sessionId: string, address: string, options?: { readonly replaceTab?: TabId; readonly params?: unknown }): void
}

/** The `slots` service slice for the keyed body seat. */
interface SlotsSlice {
  inject(key: string, callback: () => () => void): () => void
  register(
    options: { readonly name: string; readonly key: string; readonly store?: unknown; readonly inject?: unknown },
    body: (props: PreviewBodyProps) => ReactNode,
  ): () => void
}

/** The composed props the body actually reads. */
interface PreviewBodyProps {
  readonly sessionId?: string | undefined
  readonly useTabInfo?: (() => PreviewTabInfo) | undefined
}

const DEAD_SIGNAL = ((): AbortSignal => {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
})()

/** The synthetic tab info for a surface that binds no `useTabInfo` — dead by construction. */
const FALLBACK_INFO: PreviewTabInfo = {
  panel: { id: '' as TabId, isFloating: false },
  tab: {
    id: '' as TabId,
    contentId: '',
    visible: false,
    signal: DEAD_SIGNAL,
    actions: { bindCommands: () => () => {} },
  },
}

const fallbackUseTabInfo = (): PreviewTabInfo => FALLBACK_INFO

function basenameOf(relativePath: string): string {
  const parts = relativePath.split('/')
  return parts[parts.length - 1]! === '' ? relativePath : parts[parts.length - 1]!
}

function frameOf(failure: RemoteFilesError): PreviewFrame {
  return { ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable } }
}

/** The group → plugin-dictionary fallback for compositions binding no localizer. */
const FALLBACK_LOCALIZE = (code: RemoteFilesFailureCode): string => `remoteFiles.error.${REMOTE_FILES_FAILURE_GROUPS[code]}`

export interface RemotePreviewDeps {
  readonly book: RemotePreviewBook
  readonly currentSession: () => string | undefined
  readonly subscribeSession: (listener: () => void) => () => void
  readonly t: TranslateNS<'multiRootWorkspace'>
  /** The `sidebarFiles` translate the Folder's tree surface binds. */
  readonly filesTreeT: Parameters<typeof createFilesTreeSurface>[1]
  readonly seats: ReturnType<typeof createFilesTreeSeats>
}

/**
 * Install the preview surface. Registrations live inside `ctx.inject`
 * scopes so each service's own lifetime owns them; the returned connector
 * routes opens and is what P6 binds to the Files row.
 */
export function installRemotePreview(ctx: ClientContext, deps: RemotePreviewDeps): RemotePreviewIntegration {
  const { book, t } = deps
  let resourcesReady = false
  let tabsReady = false
  let bodyReady = false
  const readService = <T,>(name: string): T | undefined =>
    (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined
  const injectServices = ctx as unknown as {
    inject(names: readonly string[], callback: (scope: ClientContext) => void): void
  }
  const scopeGet = <T,>(scope: ClientContext, name: string): T | undefined =>
    (scope as unknown as { get(key: string): unknown }).get(name) as T | undefined
  const scopeEffect = (scope: ClientContext, body: () => () => void, label: string): void => {
    (scope as unknown as { effect(body: () => () => void, label: string): void }).effect(body, label)
  }

  // The provider: pin the record for the stream's lifetime, emit the
  // available marker, then one coded error if the grant dies under the pin.
  const open = async function* (address: string, context: { readonly signal: AbortSignal }): AsyncGenerator<PreviewFrame> {
    const signal = context.signal
    const record = book.pin(address, signal)
    if (record === undefined) {
      if (!signal.aborted) yield frameOf(new RemoteFilesError('root-unregistered'))
      return
    }
    const combined = AbortSignal.any([signal, record.signal])
    if (!combined.aborted) yield { ok: true, value: { available: true } }
    await new Promise<void>(resolve => {
      if (combined.aborted) {
        resolve()
        return
      }
      combined.addEventListener('abort', () => { resolve() }, { once: true })
    })
    if (record.signal.aborted && !signal.aborted) {
      const reason: unknown = record.signal.reason
      yield frameOf(reason instanceof RemoteFilesError ? reason : new RemoteFilesError('root-unregistered'))
    }
  }

  injectServices.inject(['resources'], scope => {
    const service = scopeGet<ResourcesSlice>(scope, 'resources')
    if (service === undefined || typeof service.register !== 'function') return
    scopeEffect(scope, () => {
      try {
        const dispose = service.register({ protocol: REMOTE_PREVIEW_RESOURCE_TYPE, open })
        resourcesReady = true
        return () => {
          resourcesReady = false
          dispose()
        }
      } catch {
        // Another provider already owns the protocol — no preview, no break.
        return () => {}
      }
    }, 'multi-root workspace: remote preview resource')
  })

  injectServices.inject(['sidebarRightTabs'], scope => {
    const service = scopeGet<ViewerTabsSlice>(scope, 'sidebarRightTabs')
    if (service === undefined || typeof service.register !== 'function' || typeof service.candidates !== 'function') return
    scopeEffect(scope, () => {
      try {
        const dispose = service.register({
          id: DEFINITION_ID,
          kind: REMOTE_PREVIEW_KIND,
          priority: 'extension',
          keepMounted: false,
          patterns: [`dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/[\\s\\S]+`],
          canOpen: address => remoteFileId(address) !== undefined,
          title: address => {
            const sessionId = deps.currentSession()
            const record = sessionId === undefined ? undefined : book.get(address, sessionId)
            return record === undefined ? t('preview.title') : basenameOf(record.relativePath)
          },
        })
        tabsReady = true
        return () => {
          tabsReady = false
          dispose()
        }
      } catch {
        return () => {}
      }
    }, 'multi-root workspace: remote preview tab type')
  })

  // The keyed body seat — the same store/inject shares the Files seats
  // declare, per the P1 probe wiring. It is consumed ONLY inside the
  // preview services' inject scope: a trimmed composition that has neither
  // `resources` nor `sidebarRightTabs` never touches the preview-specific
  // slot at all, and a host without a slots service simply never renders a
  // body.
  injectServices.inject(['resources', 'sidebarRightTabs'], scope => {
    const slots = (scope as unknown as { readonly slots?: SlotsSlice }).slots
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
    slots.inject('sidebar.right.pane.tab', () => {
      let dispose: () => void
      try {
        dispose = slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: DEFINITION_ID,
            store: deps.seats.store,
            inject: deps.seats.inject,
          },
          function RemotePreviewBody(props: PreviewBodyProps): ReactNode {
            const useTabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo : fallbackUseTabInfo
            const info = useTabInfo()
            // The Folder navigator's tree surface — rebuilt per render like
            // the Files-page callers do; every member it composes is a
            // framework-stable prop. `undefined` keeps the body file-only.
            const surface = createFilesTreeSurface(props as Parameters<typeof createFilesTreeSurface>[0], deps.filesTreeT, deps.seats)
            const client = deps.seats.remoteFiles
            const renderFolder = surface === undefined || client === undefined
              ? undefined
              : (record: RemotePreviewRecord): ReactNode => createElement(RemotePreviewFolder, {
                record,
                info,
                surface,
                client,
                preview: integration,
                localize: deps.seats.remoteFilesLocalize ?? FALLBACK_LOCALIZE,
              })
            return createElement(RemotePreviewViewer, {
              sessionId: props.sessionId,
              info,
              book,
              currentSession: deps.currentSession,
              subscribeSession: deps.subscribeSession,
              t,
              renderFolder,
            })
          },
        )
      } catch {
        // A genuine registration fault disables only this optional surface.
        return () => {}
      }
      bodyReady = true
      return () => {
        bodyReady = false
        dispose()
      }
    })
  })

  // Book lifetime: disposed with this context; a session switch stops the
  // previous session's content views without touching its records.
  ctx.effect(() => {
    let previous = deps.currentSession()
    const unsubscribe = deps.subscribeSession(() => {
      const next = deps.currentSession()
      const before = previous
      previous = next
      if (before !== undefined && before !== next) book.stopSession(before)
    })
    return () => {
      unsubscribe()
      book.dispose()
    }
  }, 'multi-root workspace: remote preview book')

  const canRoute = (sessionId: string): boolean => {
    try {
      if (!resourcesReady || !tabsReady || !bodyReady) return false
      if (deps.currentSession() !== sessionId) return false
      const sidebar = readService<SidebarRightSlice>('sidebarRight')
      if (typeof sidebar?.openResourceIn !== 'function') return false
      if (typeof globalThis.crypto?.randomUUID !== 'function') return false
      const tabs = readService<ViewerTabsSlice>('sidebarRightTabs')
      return tabs?.candidates(SENTINEL_ADDRESS).some(candidate => candidate.id === DEFINITION_ID) === true
    } catch {
      return false
    }
  }

  const integration: RemotePreviewIntegration = {
    canRoute,
    open(identity: SshFilesIdentity, relativePath: string, label: string, replaceTab?: TabId): void {
      if (!canRoute(identity.sessionId)) return
      let address: string | undefined
      try {
        address = book.register(identity, relativePath, label)
        if (address === undefined) return
        const tabs = readService<ViewerTabsSlice>('sidebarRightTabs')
        const claimed = tabs?.candidates(address).some(candidate => candidate.id === DEFINITION_ID) === true
        const sidebar = claimed ? readService<SidebarRightSlice>('sidebarRight') : undefined
        if (!claimed || typeof sidebar?.openResourceIn !== 'function') {
          book.forgetUnpinned(address)
          return
        }
        // A replace-in-place open — only ever the Folder's own tree — marks
        // the fresh tab so its Folder mounts open instead of closed.
        sidebar.openResourceIn(identity.sessionId, address, replaceTab === undefined ? {} : { replaceTab, params: { mrfwFolder: true } })
      } catch {
        // A thrown mint/route never escapes the gesture; only a minted
        // address gets forgotten (TTL covers the rest).
        if (address !== undefined) book.forgetUnpinned(address)
      }
    },
  }
  return integration
}
