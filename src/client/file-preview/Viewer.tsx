/**
 * The remote file preview's body (ADR-0053 P5): a read-only per-file
 * inspection surface that reads through `RemotePreviewBook`'s bounded
 * content view — never through the resource stream, which carries only
 * lifetime facts. Read-only always: no editor, no model, no raw HTML.
 *
 * The chrome and content layout deliberately mirror the host's document
 * preview: the same 38px path header, viewer selector, wrap/reload/folder
 * tools, centered empty states, source/code/markdown bodies, and navigator
 * placement. Only the features the remote contract does not support are
 * absent (Host handoff such as open-in-app, watching, paging, and active
 * Markdown objects).
 *
 * The whole state machine is generation-fenced: rendered state is keyed to
 * `{record, sessionId, tab.signal, revision}` and any key drift falls back
 * synchronously, so a stale body can never present bytes belonging to a
 * dead record, a replaced record, or a superseded read.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/Viewer
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { FileTypeIcon, Menu, StateDot, Tooltip, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderClose, IconRefresh } from '../../compat/client-icons.ts'
import {
  PreviewCodeBlock, PreviewFolderOpenIcon, PreviewPathLabel, PreviewUnwrapIcon, PreviewWrapIcon, previewLanguageForPath,
} from '../../compat/remote-preview-primitives.ts'
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
/** Upstream's navigator geometry constants (ui-sidebar-files store/FileNavigator). */
const DEFAULT_NAVIGATOR_WIDTH = 260
const NAVIGATOR_MINIMUM = 180
const ROW_REMAINDER = 120
const PUSH_FROM = 560
const PREVIEW_MINIMUM = 320
const PUSH_MARGINS = 16
const FILL_BELOW = 400
const RESIZE_STEP = 16

/** Width memory by dockkit pane: replace-in-place tab ids change, the pane does not. */
const NAVIGATOR_WIDTHS = new Map<string, number>()

function navigatorGeometry(available: number | undefined, width: number): {
  readonly minimum: number
  readonly maximum: number
  readonly width: number
} {
  if (available === undefined) {
    const drawn = Math.max(NAVIGATOR_MINIMUM, width)
    return { minimum: NAVIGATOR_MINIMUM, maximum: drawn, width: drawn }
  }
  const maximum = Math.max(0, available - (available >= PUSH_FROM ? PUSH_MARGINS + PREVIEW_MINIMUM : ROW_REMAINDER))
  const minimum = Math.min(NAVIGATOR_MINIMUM, maximum)
  return { minimum, maximum, width: Math.min(Math.max(minimum, width), maximum) }
}

type NavigatorMode = 'push' | 'overlay' | 'fill'

function navigatorMode(rowWidth: number | undefined): NavigatorMode {
  if (rowWidth === undefined) return 'overlay'
  return rowWidth >= PUSH_FROM ? 'push' : rowWidth >= FILL_BELOW ? 'overlay' : 'fill'
}

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

// The host allocates line rows and highlight tokens. Bound both inputs before
// offering Code; plain text uses one text node for the same complete source.
const MAX_CODE_BYTES = 128 * 1024
const MAX_CODE_LINES = 4096

/** One viewer choice in the header's upstream-shaped selector. */
type ViewerChoice = (
  | { readonly id: 'code'; readonly language: string }
  | { readonly id: 'markdown' | 'text' }
) & {
  readonly title: string
  /** Whether the implementation consumes the document wrap preference. */
  readonly wrap: boolean
}

type TextPresentation = Exclude<PreviewPresentation, { kind: 'unsupported' }>

function codeLanguage(relativePath: string, { text, size }: TextPresentation): string | undefined {
  if (PreviewCodeBlock === undefined || size > MAX_CODE_BYTES) return undefined
  const language = previewLanguageForPath?.(relativePath)
  if (language === undefined) return undefined
  // Count the same LF-delimited rows the host draws (it trims a final LF).
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1 && index < text.length - 1; index = text.indexOf('\n', index + 1)) {
    if (++lines > MAX_CODE_LINES) return undefined
  }
  return language
}

/**
 * The remote analogue of the host registry's automatic ordering: a Markdown
 * document first, Code where the filename has a highlight grammar, then the
 * plain-text fallback. A Markdown file whose safe subset budget already made
 * the presentation fall back to text does not regain a Markdown choice.
 */
function viewerChoices(
  relativePath: string,
  presentation: TextPresentation | undefined,
  t: TranslateNS<'multiRootWorkspace'>,
): readonly ViewerChoice[] {
  if (presentation === undefined) return []
  const markdown = presentation.kind === 'markdown'
  const language = codeLanguage(relativePath, presentation)
  const choices: ViewerChoice[] = []
  if (markdown) choices.push({ id: 'markdown', title: t('preview.viewer.markdown'), wrap: false })
  if (language !== undefined) choices.push({ id: 'code', language, title: t('preview.viewer.code'), wrap: true })
  choices.push({ id: 'text', title: t('preview.viewer.text'), wrap: true })
  return choices
}

/**
 * The safe display path. It deliberately is not the remote absolute path:
 * the environment label and root id form a path-like prefix so the upstream
 * PathLabel can render the real filename with the same subdued-directory
 * typography while still disambiguating two remote roots.
 */
function displayPathOf(record: RemotePreviewRecord): string {
  const clean = (value: string): string => value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const label = clean(record.label) || record.identity.root.environmentId
  const root = clean(record.identity.root.rootId)
  return `${label}/${root}/${record.relativePath}`
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
  const [rendererId, setRendererId] = useState<string | undefined>(undefined)
  const [wrap, setWrap] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [shown, setShown] = useState<{ readonly key: ShownKey | undefined; readonly value: Shown }>(EMPTY_SHOWN)
  const onRefresh = useCallback((): void => { setRevision(v => v + 1) }, [])
  // A fresh record never inherits the previous one's viewer or wrap choice.
  useEffect(() => {
    setRendererId(undefined)
    setWrap(true)
    setMenuOpen(false)
  }, [record])
  // The Folder aside: a replace-in-place open marks the fresh tab's
  // navigation params, so a file opened FROM the Folder keeps it open.
  const folderId = useId()
  const [folderOpen, setFolderOpen] = useState(
    () => (info.tab.navigation?.params as { readonly mrfwFolder?: boolean } | undefined)?.mrfwFolder === true,
  )
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState<number | undefined>(undefined)
  const paneWidthKey = info.panel.id
  const [navigatorWidth, setNavigatorWidthState] = useState(() => NAVIGATOR_WIDTHS.get(paneWidthKey) ?? DEFAULT_NAVIGATOR_WIDTH)
  const [draggingNavigator, setDraggingNavigator] = useState(false)
  const navigatorDrag = useRef<{ readonly x: number; readonly width: number } | undefined>(undefined)
  const setNavigatorWidth = useCallback((width: number): void => {
    NAVIGATOR_WIDTHS.set(paneWidthKey, width)
    setNavigatorWidthState(width)
  }, [paneWidthKey])
  useEffect(() => {
    const element = workspaceRef.current
    if (element === null) return
    const measure = (): void => { setRowWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  const mode = navigatorMode(rowWidth)
  const geometry = navigatorGeometry(rowWidth, navigatorWidth)
  const clampNavigatorWidth = useCallback((next: number): number =>
    Math.min(Math.max(next, geometry.minimum), geometry.maximum), [geometry.minimum, geometry.maximum])

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

  const presentation = shownNow.kind === 'ready' ? shownNow.presentation : undefined
  const choices = useMemo(
    () => viewerChoices(record?.relativePath ?? '', presentation, t),
    [record?.relativePath, presentation, t],
  )
  const selected = choices.find(choice => choice.id === rendererId) ?? choices[0]
  const WrapIcon = wrap ? PreviewUnwrapIcon : PreviewWrapIcon
  const folderLabel = t(folderOpen ? 'preview.folderHide' : 'preview.folderShow')
  const path = record === undefined ? '' : displayPathOf(record)
  return (
    <section aria-label={t('preview.title')} data-mrfw-preview className="mrfw-preview">
      {record === undefined ? null : (
        <header className="mrfw-previewHead">
          {PreviewPathLabel === undefined
            ? <span className="mrfw-previewPath" title={path} data-textpreview-path>{path}</span>
            : <PreviewPathLabel path={path} className="mrfw-previewPath" data-textpreview-path />}
          {live && selected !== undefined && choices.length > 1 ? (
            <Menu
              open={menuOpen}
              anchor={(
                <button
                  type="button"
                  className={clsx('mrfw-previewTool', 'mrfw-previewViewerTool')}
                  aria-label={t('preview.openWith')}
                  title={selected.title}
                  data-document-viewer-menu
                  onClick={() => { setMenuOpen(value => !value) }}
                >
                  {selected.title}
                </button>
              )}
              items={choices.map(choice => ({ id: choice.id, label: choice.title }))}
              selectedId={selected.id}
              onSelect={(id) => { setRendererId(id); setMenuOpen(false) }}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              dense
            />
          ) : null}
          {live && selected?.wrap === true ? (
            <Tooltip label={t(wrap ? 'preview.wrap.disable' : 'preview.wrap.enable')} side="bottom" delayMs={500}>
              <button
                type="button"
                className="mrfw-previewTool"
                aria-pressed={wrap}
                aria-label={t('preview.wrap.aria')}
                data-textpreview-tool="wrap"
                onClick={() => { setWrap(value => !value) }}
              >
                {WrapIcon === undefined ? <span aria-hidden="true">↵</span> : <WrapIcon />}
              </button>
            </Tooltip>
          ) : null}
          {live ? (
            <Tooltip label={t('preview.refresh')} side="bottom" delayMs={500}>
              <button
                type="button"
                className="mrfw-previewTool"
                aria-label={t('preview.refresh')}
                data-textpreview-tool="reload"
                onClick={onRefresh}
              >
                <IconRefresh />
              </button>
            </Tooltip>
          ) : null}
          {record !== undefined && pinState !== 'expired' && props.renderFolder !== undefined ? (
            <Tooltip label={folderLabel} side="bottom" delayMs={500}>
              <button
                type="button"
                className="mrfw-previewTool mrfw-previewFolderTool"
                aria-label={folderLabel}
                aria-expanded={folderOpen}
                aria-controls={folderId}
                data-files-navigator-toggle
                onClick={() => { setFolderOpen(open => !open) }}
              >
                {folderOpen ? <PreviewFolderOpenIcon /> : <IconFolderClose />}
              </button>
            </Tooltip>
          ) : null}
        </header>
      )}
      <div ref={workspaceRef} className="mrfw-previewWorkspace" data-files-navigator-row>
        <div
          tabIndex={0}
          className={clsx('mrfw-previewContent', wrap && 'mrfw-previewWrap')}
          data-mrfw-preview-content
          data-mrfw-preview-state={shownNow.kind}
          data-textpreview-body
        >
          <PreviewContent
            shown={shownNow}
            renderer={selected}
            wrap={wrap}
            relativePath={record?.relativePath ?? ''}
            onRetry={onRefresh}
            t={t}
          />
        </div>
        {folderOpen && record !== undefined && pinState !== 'expired' && props.renderFolder !== undefined ? (
          <aside
            id={folderId}
            aria-label={t('preview.folder')}
            className={clsx('mrfw-previewFolder', `mrfw-previewFolder-${mode}`, draggingNavigator && 'mrfw-previewFolderDragging')}
            style={{ '--mrfw-files-navigator-width': `${geometry.width}px` } as CSSProperties}
            data-mrfw-preview-folder
            data-files-navigator-mode={mode}
          >
            {mode === 'fill' ? null : (
              <div
                className="mrfw-previewFolderSeparator"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('preview.folderResize')}
                aria-valuemin={geometry.minimum}
                aria-valuemax={geometry.maximum}
                aria-valuenow={geometry.width}
                tabIndex={0}
                data-files-navigator-resize
                onKeyDown={(event) => {
                  const next = event.key === 'ArrowLeft' ? geometry.width + RESIZE_STEP
                    : event.key === 'ArrowRight' ? geometry.width - RESIZE_STEP
                      : event.key === 'Home' ? geometry.minimum
                        : event.key === 'End' ? geometry.maximum
                          : undefined
                  if (next === undefined) return
                  event.preventDefault()
                  setNavigatorWidth(clampNavigatorWidth(next))
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  navigatorDrag.current = { x: event.clientX, width: geometry.width }
                  setDraggingNavigator(true)
                }}
                onPointerMove={(event) => {
                  const origin = navigatorDrag.current
                  if (origin === undefined) return
                  setNavigatorWidth(clampNavigatorWidth(origin.width + origin.x - event.clientX))
                }}
                onPointerUp={(event) => {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onLostPointerCapture={() => {
                  navigatorDrag.current = undefined
                  setDraggingNavigator(false)
                }}
              />
            )}
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
  readonly renderer: ViewerChoice | undefined
  readonly wrap: boolean
  readonly relativePath: string
  readonly onRetry: () => void
  readonly t: TranslateNS<'multiRootWorkspace'>
}): ReactNode {
  const { shown, t } = props
  switch (shown.kind) {
    case 'idle':
      return null
    case 'loading':
      return <LoadingStatus label={t('preview.loading')} />
    case 'expired':
      return <EmptyStatus path={props.relativePath} line={t('preview.expired')} />
    case 'unsupported':
      return <EmptyStatus path={props.relativePath} line={`${t('preview.unsupported')} ${t('preview.size', { bytes: formatSize(shown.size) })}`} />
    case 'error':
      return <EmptyStatus path={props.relativePath} line={shown.message} retry={t('preview.retry')} onRetry={props.onRetry} />
    case 'ready': {
      const presentation = shown.presentation
      if (presentation.text === '') return null
      if (props.renderer?.id === 'markdown' && presentation.kind === 'markdown') return <MarkdownDocument blocks={presentation.blocks} />
      if (props.renderer?.id === 'code') return <CodeDocument language={props.renderer.language} text={presentation.text} wrap={props.wrap} t={t} />
      return <PlainTextDocument text={presentation.text} />
    }
  }
}

/** Upstream's centered loading indicator: one state dot over the status line. */
function LoadingStatus({ label }: { readonly label: string }): ReactNode {
  return (
    <span className="mrfw-previewLoading" role="status" aria-label={label} data-document-loading>
      <StateDot state="ongoing" size={28} />
      <span>{label}</span>
    </span>
  )
}

/** A centered empty/failure state in the host document preview's shape. */
function EmptyStatus(props: {
  readonly path: string
  readonly line: string
  readonly retry?: string | undefined
  readonly onRetry?: (() => void) | undefined
}): ReactNode {
  const name = props.path.split('/').pop() ?? props.path
  return (
    <div className="mrfw-previewEmpty" data-textpreview-failed={props.retry === undefined ? undefined : 'read'}>
      <FileTypeIcon kind={classifyFileType(name)} size={36} className="mrfw-previewEmptyIcon" />
      <p className="mrfw-previewEmptyLine">{props.line}</p>
      {props.retry === undefined || props.onRetry === undefined ? null : (
        <button type="button" className="mrfw-previewRetry" data-textpreview-retry onClick={props.onRetry}>
          <IconRefresh size={14} />
          {props.retry}
        </button>
      )}
    </div>
  )
}

/** Plain source display: byte-exact text inside the host text document's inset. */
function PlainTextDocument({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="mrfw-previewTextDocument" data-textpreview-plain>
      <pre className="mrfw-previewPage"><code>{text}</code></pre>
    </div>
  )
}

/** Highlighted, line-numbered source through the host primitive when it exists. */
function CodeDocument(props: {
  readonly language: string
  readonly text: string
  readonly wrap: boolean
  readonly t: TranslateNS<'multiRootWorkspace'>
}): ReactNode {
  const { language, text, wrap, t } = props
  if (PreviewCodeBlock === undefined) return <PlainTextDocument text={text} />
  return (
    <div className="mrfw-previewCode" data-code-preview data-wrap={wrap}>
      <PreviewCodeBlock
        className="mrfw-previewCodeBlock"
        code={text}
        lang={language}
        wrap={wrap}
        lineNumbers
        copyLabel={t('preview.copy')}
        copiedLabel={t('preview.copied')}
        toolbarLabels={{
          codeLabel: t('preview.codeBlock.title'),
          wrapLabel: t('preview.codeBlock.wrap'),
          unwrapLabel: t('preview.codeBlock.unwrap'),
        }}
      />
    </div>
  )
}

/** The safe-subset document, wearing the host Markdown document's typography. */
function MarkdownDocument(props: { readonly blocks: readonly MarkdownBlock[] }): ReactNode {
  return (
    <div className="mrfw-previewMarkdown" data-document-markdown>
      <MarkdownBlocks blocks={props.blocks} />
    </div>
  )
}

/** Inline emphasis that cannot activate anything: strong, emphasis, and inline code only. */
function inlineMarkdown(text: string): ReactNode {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/u
  const parts = text.split(pattern)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('__') && part.endsWith('__') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={index}>{part.slice(1, -1)}</em>
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) return <em key={index}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })
}

/** The safe-subset blocks; every block's source text enters React as text, never as markup. */
function MarkdownBlocks(props: { readonly blocks: readonly MarkdownBlock[] }): ReactNode {
  return (
    <>
      {props.blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3'
            return <Tag key={index}>{inlineMarkdown(block.text)}</Tag>
          }
          case 'paragraph':
            return <p key={index}>{inlineMarkdown(block.text)}</p>
          case 'code':
            return <pre key={index} className="mrfw-previewMarkdownCode"><code>{block.text}</code></pre>
          case 'quote':
            return <blockquote key={index}><p>{inlineMarkdown(block.text)}</p></blockquote>
          case 'list':
            return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>
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
