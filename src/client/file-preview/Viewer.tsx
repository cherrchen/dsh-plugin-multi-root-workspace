/**
 * The remote file preview's body (ADR-0053 P5): a compact per-file
 * inspection surface that reads through `RemotePreviewBook`'s bounded
 * content view — never through the resource stream, which carries only
 * lifetime facts. Read-only always: no editor, no model, no raw HTML.
 *
 * The whole state machine is generation-fenced: rendered state is keyed to
 * `{record, sessionId, tab.signal, revision}` and any key drift falls back
 * synchronously, so a stale body can never present bytes belonging to a
 * dead record, a replaced record, or a superseded read.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/Viewer
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteFilesError, type RemoteFilesFailureCode } from '../../remote/files-contract.ts'
import { REMOTE_FILES_FAILURE_GROUPS } from '../files-tree/providers/ssh.ts'
import type { RemotePreviewBook, RemotePreviewRecord, RemotePreviewView } from './resource-book.ts'
import { previewPresentation, type MarkdownBlock, type PreviewPresentation } from './presentation.ts'
import type { PreviewTabInfo } from './install.tsx'

/** What the body presents; `data-mrfw-preview-state` carries `kind`. */
type Shown =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly presentation: Exclude<PreviewPresentation, { readonly kind: 'unsupported' }> }
  | { readonly kind: 'unsupported'; readonly size: number }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'expired' }

/** The identity a presented state belongs to — any drift invalidates it. */
interface ShownKey {
  readonly record: RemotePreviewRecord
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly revision: number
}

/** Read failures that mean the grant itself is gone — the expired copy, not an error line. */
const GRANT_CODES: ReadonlySet<RemoteFilesFailureCode> = new Set([
  'provider-unavailable',
  'capability-unsupported',
  'preview-not-authorized',
  'session-unavailable',
  'root-unregistered',
  'root-identity-changed',
  'binding-changed',
  'environment-changed',
])

/** `t` for a `remoteFiles.error.<group>` key — the fixed vocabulary groups. */
type RemoteT = (key: `remoteFiles.error.${string}`) => string

function formatSize(size: number): string {
  return new Intl.NumberFormat().format(size)
}

export interface RemotePreviewViewerProps {
  /** The session this tab's slot was composed for. */
  readonly sessionId: string | undefined
  /** The live tab information the slot framework bound. */
  readonly info: PreviewTabInfo
  /** The preview's address/pin/read book. */
  readonly book: RemotePreviewBook
  /** The active-session reader behind `book.get`'s scope. */
  readonly currentSession: () => string | undefined
  /** The active-session change subscription. */
  readonly subscribeSession: (listener: () => void) => () => void
  /** This plugin's dictionary. */
  readonly t: TranslateNS<'multiRootWorkspace'>
  /**
   * The Folder navigator's renderer (ADR-0053 P6): the install binds it
   * only where the Files-tree surface and the remote client exist — absent
   * keeps this body file-only and hides the Folder toggle entirely.
   */
  readonly renderFolder?: ((record: RemotePreviewRecord) => ReactNode) | undefined
}

/** The empty `shown` state — shared so its reference identity is stable. */
const EMPTY_SHOWN = { key: undefined, value: { kind: 'idle' } } as const satisfies {
  readonly key: ShownKey | undefined
  readonly value: Shown
}

export function RemotePreviewViewer(props: RemotePreviewViewerProps): ReactNode {
  const { book, info, t } = props
  const sessionId = props.sessionId
  const currentSession = props.currentSession
  const current = useSyncExternalStore(props.subscribeSession, currentSession, () => undefined)
  const active = sessionId !== undefined && current === sessionId
  const record = active ? book.get(info.tab.contentId, sessionId) : undefined
  // Pin readiness is the book's OWN observable, not the record signal's:
  // a body mounted before the DSH occurrence pin lands sees `pending`
  // (loading, no read attempted), flips to `ready` on the first pin, and
  // `expired` on retirement — even between session notifications.
  const subscribePin = useCallback((notify: () => void): (() => void) =>
    record === undefined ? () => {} : book.subscribePinState(record, notify), [book, record])
  const pinState = useSyncExternalStore(subscribePin, () => record === undefined ? 'expired' : book.pinState(record), () => 'expired' as const)
  const visible = info.tab.visible
  const tabSignal = info.tab.signal
  const live = active && visible && !tabSignal.aborted && record !== undefined && pinState === 'ready'

  const [revision, setRevision] = useState(0)
  const [source, setSource] = useState(false)
  const [shown, setShown] = useState<{ readonly key: ShownKey | undefined; readonly value: Shown }>(EMPTY_SHOWN)
  const onRefresh = useCallback((): void => { setRevision(v => v + 1) }, [])
  // A fresh record never inherits the previous one's source toggle.
  useEffect(() => { setSource(false) }, [record])
  // The Folder aside: a replace-in-place open marks the fresh tab's
  // navigation params, so a file opened FROM the Folder keeps it open.
  const folderId = useId()
  const [folderOpen, setFolderOpen] = useState(
    () => (info.tab.navigation?.params as { readonly mrfwFolder?: boolean } | undefined)?.mrfwFolder === true,
  )

  const keyFor: ShownKey | undefined = record !== undefined && sessionId !== undefined
    ? { record, sessionId, signal: tabSignal, revision }
    : undefined
  const currentKey = shown.key !== undefined && keyFor !== undefined
    && shown.key.record === keyFor.record && shown.key.sessionId === keyFor.sessionId
    && shown.key.signal === keyFor.signal && shown.key.revision === keyFor.revision
  const shownNow: Shown =
    !active || !visible ? { kind: 'idle' }
      : record === undefined || tabSignal.aborted || pinState === 'expired' ? { kind: 'expired' }
        : pinState === 'pending' ? { kind: 'loading' }
          : currentKey ? shown.value : { kind: 'loading' }

  // Mounted read: mount a content view on the pinned record, read through
  // it, and keep only a result whose record/generation is still current.
  useEffect(() => {
    if (!live || record === undefined || sessionId === undefined || keyFor === undefined) {
      // Nothing live: drop the stored state entirely — a parked or hidden
      // body can never resurface bytes from before the drop on re-show.
      setShown(EMPTY_SHOWN)
      return
    }
    const key = keyFor
    const target = record
    const controller = new AbortController()
    const mounted = ((): { readonly view: RemotePreviewView } | { readonly failure: Shown } => {
      try {
        return { view: book.mount(target.address, sessionId, tabSignal) }
      } catch (error: unknown) {
        const failure = error instanceof RemoteFilesError ? error : new RemoteFilesError('provider-unavailable')
        return { failure: failureShown(failure, t) }
      }
    })()
    if ('failure' in mounted) {
      setShown({ key, value: mounted.failure })
      return () => { controller.abort() }
    }
    const view = mounted.view
    setShown({ key, value: { kind: 'loading' } })
    const onViewDead = (): void => { setShown({ key, value: { kind: 'expired' } }) }
    view.signal.addEventListener('abort', onViewDead, { once: true })
    void view.read(controller.signal).then(
      content => {
        if (controller.signal.aborted || view.signal.aborted || currentSession() !== sessionId) return
        const presentation = previewPresentation(target.relativePath, content)
        setShown({
          key,
          value: presentation.kind === 'unsupported'
            ? { kind: 'unsupported', size: presentation.size }
            : { kind: 'ready', presentation },
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const failure = error instanceof RemoteFilesError ? error : new RemoteFilesError('provider-unavailable')
        setShown({ key, value: failureShown(failure, t) })
      },
    )
    return () => {
      view.signal.removeEventListener('abort', onViewDead)
      controller.abort()
      view.release()
    }
  }, [book, record, sessionId, tabSignal, visible, live, revision, currentSession, t])

  // Native refresh command while the page is live; a compatibility surface
  // without `bindCommands` simply keeps the in-body button only.
  const actions = info.tab.actions
  useEffect(() => {
    if (!live || typeof actions?.bindCommands !== 'function') return
    return actions.bindCommands({ refresh: onRefresh })
  }, [actions, live, onRefresh])

  const sizeNow = shownNow.kind === 'ready' ? shownNow.presentation.size
    : shownNow.kind === 'unsupported' ? shownNow.size : undefined
  return (
    <section aria-label={t('preview.title')} data-mrfw-preview className="mrfw-preview">
      {live && record !== undefined ? (
        <header className="mrfw-previewHead">
          <span className="mrfw-previewBadge">{t('preview.readOnly')}</span>
          <span className="mrfw-previewLabel">{record.label}</span>
          <span className="mrfw-previewRoot">{record.identity.root.rootId}</span>
          {sizeNow === undefined ? null : (
            <span className="mrfw-previewSize">{t('preview.size', { bytes: formatSize(sizeNow) })}</span>
          )}
          <span className="mrfw-previewPath">{record.relativePath}</span>
          {props.renderFolder === undefined ? null : (
            <button type="button" className="mrfw-previewAction" aria-expanded={folderOpen} aria-controls={folderId}
              onClick={() => { setFolderOpen(open => !open) }}>{t('preview.folder')}</button>
          )}
          <button type="button" className="mrfw-previewAction" onClick={onRefresh}>{t('preview.refresh')}</button>
        </header>
      ) : null}
      <div className="mrfw-previewWorkspace">
        <div tabIndex={0} className="mrfw-previewContent" data-mrfw-preview-content data-mrfw-preview-state={shownNow.kind}>
          <PreviewContent shown={shownNow} source={source} onToggleSource={() => { setSource(v => !v) }} t={t} />
        </div>
        {folderOpen && record !== undefined && pinState !== 'expired' && props.renderFolder !== undefined ? (
          <aside id={folderId} aria-label={t('preview.folder')} className="mrfw-previewFolder" data-mrfw-preview-folder>
            {props.renderFolder(record)}
          </aside>
        ) : null}
      </div>
    </section>
  )
}

/** The content region by machine state; status copy is the only live text. */
function PreviewContent(props: {
  readonly shown: Shown
  readonly source: boolean
  readonly onToggleSource: () => void
  readonly t: TranslateNS<'multiRootWorkspace'>
}): ReactNode {
  const { shown, t } = props
  switch (shown.kind) {
    case 'idle':
      return null
    case 'loading':
      return <p className="mrfw-previewStatus" aria-live="polite">{t('preview.loading')}</p>
    case 'expired':
      return <p className="mrfw-previewStatus" aria-live="polite">{t('preview.expired')}</p>
    case 'unsupported':
      return (
        <p className="mrfw-previewStatus" aria-live="polite">
          {t('preview.unsupported')} {t('preview.size', { bytes: formatSize(shown.size) })}
        </p>
      )
    case 'error':
      return <p className="mrfw-previewStatus" aria-live="polite">{shown.message}</p>
    case 'ready': {
      const presentation = shown.presentation
      if (presentation.text === '') return <p className="mrfw-previewStatus" aria-live="polite">{t('preview.empty')}</p>
      if (presentation.kind !== 'markdown') return <pre className="mrfw-previewSource"><code>{presentation.text}</code></pre>
      return (
        <div className="mrfw-previewMarkdown">
          <p className="mrfw-previewToggle">
            <button type="button" aria-pressed={props.source} className="mrfw-previewAction" onClick={props.onToggleSource}>
              {t('preview.showSource')}
            </button>
          </p>
          {props.source
            ? <pre className="mrfw-previewSource"><code>{presentation.text}</code></pre>
            : <MarkdownBlocks blocks={presentation.blocks} />}
        </div>
      )
    }
  }
}

/** The safe-subset blocks; every block's text is a literal React child. */
function MarkdownBlocks(props: { readonly blocks: readonly MarkdownBlock[] }): ReactNode {
  return (
    <>
      {props.blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4'
            return <Tag key={index} className="mrfw-previewHeading">{block.text}</Tag>
          }
          case 'paragraph':
            return <p key={index}>{block.text}</p>
          case 'code':
            return <pre key={index} className="mrfw-previewSource"><code>{block.text}</code></pre>
          case 'quote':
            return <blockquote key={index}><p>{block.text}</p></blockquote>
          case 'list':
            return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
        }
      })}
    </>
  )
}

/** The read failure → presented state mapping (grant failures become `expired`). */
function failureShown(failure: RemoteFilesError, t: TranslateNS<'multiRootWorkspace'>): Shown {
  if (GRANT_CODES.has(failure.code)) return { kind: 'expired' }
  const remoteT = t as unknown as RemoteT
  switch (failure.code) {
    case 'file-too-large': return { kind: 'error', message: t('preview.tooLarge') }
    case 'file-changed': return { kind: 'error', message: t('preview.changed') }
    case 'file-not-found': return { kind: 'error', message: t('preview.missing') }
    case 'not-regular-file': return { kind: 'error', message: t('preview.notRegular') }
    case 'cancelled': return { kind: 'idle' }
    default: return { kind: 'error', message: remoteT(`remoteFiles.error.${REMOTE_FILES_FAILURE_GROUPS[failure.code]}`) }
  }
}
