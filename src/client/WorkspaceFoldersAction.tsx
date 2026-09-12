/**
 * The Workspace Folders panel: one sidebar footer action that opens a dialog
 * listing this session's workspace root and the additional roots registered for
 * it, with the actions the milestone requires — Add (through the composed
 * directory picker), Remove, Alias, Copy Path, Reveal, and reordering.
 *
 * Why a footer action and its own dialog, instead of a first-class panel: the
 * slots that can host a full panel (`sidebar.panellist` + the keyed `main`
 * panel) exist only in the pinned 0.1.5 surface, while `sidebar.footer.action`
 * exists in both supported runtimes — and `sidebar.workspaces` is a single slot
 * already owned by the workspace browser, so it cannot be extended in place.
 * Keeping the panel self-contained also keeps it style-independent: it renders
 * plain elements with inline styles, so it needs no CSS pipeline and no
 * component-library identity to be shared with the host.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/WorkspaceFoldersAction
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { asRootsView, errorKeyOf, PanelError, type PanelClient } from './panel-client.ts'
import type { Key } from './locales.ts'
import type { RootView, RootsView } from '../contract.ts'

/** Translate one key of this plugin's namespace. */
export type Translate = (key: Key, params?: Record<string, unknown>) => string

/** What the registered action receives from the plugin body. */
export interface WorkspaceFoldersActionProps {
  /** The channel client; absent when this composition has no host Connection. */
  readonly panel: PanelClient | undefined
  /** Opens the composed directory picker, when one is composed. */
  readonly pickDirectory: (() => Promise<string | null>) | undefined
  /** Bound translator for this plugin's namespace. */
  readonly t: Translate
  /**
   * The current session id, read when a request is built. A function rather
   * than a value because the selection changes while the panel stays mounted.
   */
  readonly sessionId?: () => string | undefined
  /** Whether the sidebar renders wide content (`false` in the icon rail). */
  readonly wide?: boolean
}

const BUTTON_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  padding: '6px 10px',
  border: '1px solid rgba(127, 127, 127, 0.35)',
  borderRadius: '6px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
} as const

const OVERLAY_STYLE = {
  position: 'fixed',
  inset: '0',
  zIndex: '40',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.35)',
} as const

const DIALOG_STYLE = {
  width: 'min(640px, 92vw)',
  maxHeight: '80vh',
  overflowY: 'auto',
  padding: '16px 18px',
  borderRadius: '10px',
  background: 'canvas',
  color: 'canvastext',
  border: '1px solid rgba(127, 127, 127, 0.35)',
  font: 'inherit',
} as const

const ROW_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 0',
  borderTop: '1px solid rgba(127, 127, 127, 0.2)',
} as const

const PATH_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.92em',
  wordBreak: 'break-all',
  flex: '1 1 240px',
} as const

/** One small button matching the panel's own styling. */
function Action(props: { onClick: () => void; children: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled === true}
      style={{ ...BUTTON_STYLE, width: 'auto', padding: '3px 8px' }}
    >
      {props.children}
    </button>
  )
}

/** The sidebar footer action plus the dialog it opens. */
export function WorkspaceFoldersAction(props: WorkspaceFoldersActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        title={props.t('action.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
        style={BUTTON_STYLE}
      >
        <span aria-hidden="true">🗂</span>
        {props.wide === false ? null : <span>{props.t('action.label')}</span>}
      </button>
      {open ? <WorkspaceFoldersDialog {...props} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

/** State of one dialog instance. */
interface DialogState {
  readonly view: RootsView | undefined
  readonly error: PanelError | undefined
  readonly busy: boolean
}

/** The dialog: reads the view once per open, then after every mutation. */
function WorkspaceFoldersDialog(props: WorkspaceFoldersActionProps & { onClose: () => void }): ReactNode {
  const { panel, t } = props
  const [state, setState] = useState<DialogState>({ view: undefined, error: undefined, busy: false })
  const [manualPath, setManualPath] = useState('')
  const [aliasFor, setAliasFor] = useState<string | undefined>(undefined)
  const [aliasDraft, setAliasDraft] = useState('')
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)

  const sessionId = props.sessionId?.()

  const refresh = useCallback(async () => {
    if (panel === undefined) {
      setState({ view: undefined, error: new PanelError('unavailable', 'no connection'), busy: false })
      return
    }
    setState(previous => ({ ...previous, busy: true }))
    try {
      const view = asRootsView(await panel.call('list', { ...(sessionId === undefined ? {} : { sessionId }) }))
      setState({ view, error: undefined, busy: false })
    } catch (error: unknown) {
      setState({ view: undefined, error: asPanelError(error), busy: false })
    }
  }, [panel, sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const mutate = useCallback(async (endpoint: Parameters<PanelClient['call']>[0], payload: Record<string, unknown>) => {
    if (panel === undefined) return
    setState(previous => ({ ...previous, busy: true }))
    try {
      const view = asRootsView(await panel.call(endpoint, { ...(sessionId === undefined ? {} : { sessionId }), ...payload }))
      setState({ view, error: undefined, busy: false })
    } catch (error: unknown) {
      setState(previous => ({ ...previous, error: asPanelError(error), busy: false }))
    }
  }, [panel, sessionId])

  const addDirectory = useCallback(async () => {
    let picked: string | null = null
    try {
      picked = props.pickDirectory === undefined ? null : await props.pickDirectory()
    } catch (error: unknown) {
      setState(previous => ({ ...previous, error: asPanelError(error) }))
      return
    }
    const path = picked ?? manualPath.trim()
    if (path === '') return
    await mutate('add', { path })
    setManualPath('')
  }, [manualPath, mutate, props])

  const copyPath = useCallback(async (root: RootView) => {
    try {
      await navigator.clipboard.writeText(root.path)
      setCopiedId(root.id)
      window.setTimeout(() => { setCopiedId(current => (current === root.id ? undefined : current)) }, 1500)
    } catch {
      setCopiedId(undefined)
    }
  }, [])

  const move = useCallback(async (root: RootView, beforeId: string | undefined) => {
    await mutate('move', beforeId === undefined ? { id: root.id } : { id: root.id, beforeId })
  }, [mutate])

  const roots = state.view?.roots ?? []
  return (
    <div style={OVERLAY_STYLE} role="presentation" onClick={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <div style={DIALOG_STYLE} role="dialog" aria-modal="true" aria-label={t('panel.title')}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: '1.05em' }}>{t('panel.title')}</h2>
          <span style={{ marginLeft: 'auto' }}>
            <Action onClick={props.onClose}>{t('panel.close')}</Action>
          </span>
        </div>
        <p style={{ margin: '0 0 10px', opacity: 0.75 }}>{t('panel.subtitle')}</p>

        {state.error === undefined ? null : (
          <p role="alert" style={{ color: 'crimson', margin: '0 0 10px' }}>
            {t(errorKeyOf(state.error.code))}
            {state.error.code === 'unavailable' ? ` (${state.error.message})` : ''}
          </p>
        )}
        {state.view?.unavailable === undefined ? null : (
          <p role="alert" style={{ color: 'crimson', margin: '0 0 10px' }}>{state.view.unavailable}</p>
        )}

        <section>
          <strong>{t('panel.primary')}</strong>
          <div style={{ ...ROW_STYLE, borderTop: 'none' }}>
            <span style={PATH_STYLE}>{state.view?.primaryRoot ?? '…'}</span>
            <span style={{ opacity: 0.7 }}>{t('panel.primaryNote')}</span>
          </div>
        </section>

        <section>
          <strong>{t('panel.additional')}</strong>
          {state.view === undefined ? <p>{t('panel.loading')}</p> : null}
          {state.view !== undefined && roots.length === 0 ? (
            <p style={{ opacity: 0.8 }}>
              {t('panel.empty')} {t('panel.emptyHint')}
            </p>
          ) : null}
          {roots.map((root, index) => (
            <div key={root.id} style={ROW_STYLE}>
              <span style={PATH_STYLE}>{root.path}</span>
              {root.alias === undefined ? null : <em>{root.alias}</em>}
              {root.state === 'available' ? null : (
                <span title={root.detail} style={{ color: 'darkorange' }}>
                  {t(root.state === 'missing' ? 'state.missing' : 'state.invalid')}
                </span>
              )}
              <Action onClick={() => { void copyPath(root) }}>{copiedId === root.id ? t('panel.copied') : t('panel.copyPath')}</Action>
              <Action onClick={() => { void mutate('reveal', { id: root.id }) }}>{t('panel.reveal')}</Action>
              <Action
                disabled={index === 0}
                onClick={() => { void move(root, roots[index - 1]?.id) }}
              >
                {t('panel.moveUp')}
              </Action>
              <Action
                disabled={index === roots.length - 1}
                onClick={() => { void move(root, roots[index + 2]?.id) }}
              >
                {t('panel.moveDown')}
              </Action>
              <Action
                onClick={() => {
                  setAliasFor(current => (current === root.id ? undefined : root.id))
                  setAliasDraft(root.alias ?? '')
                }}
              >
                {t('panel.alias')}
              </Action>
              <Action onClick={() => { void mutate('remove', { id: root.id }) }}>{t('panel.remove')}</Action>
              {aliasFor === root.id ? (
                <span style={{ display: 'flex', gap: '6px', flexBasis: '100%' }}>
                  <input
                    autoFocus
                    value={aliasDraft}
                    placeholder={t('panel.aliasPlaceholder')}
                    onChange={event => { setAliasDraft(event.target.value) }}
                    style={{ flex: '1 1 auto', padding: '3px 6px' }}
                  />
                  <Action onClick={() => { void mutate('alias', { id: root.id, alias: aliasDraft }); setAliasFor(undefined) }}>
                    {t('panel.aliasSave')}
                  </Action>
                  <Action onClick={() => { setAliasFor(undefined) }}>{t('panel.aliasCancel')}</Action>
                </span>
              ) : null}
            </div>
          ))}
        </section>

        <section style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <Action onClick={() => { void addDirectory() }} disabled={state.busy}>
              {props.pickDirectory === undefined ? t('panel.addManual') : t('panel.add')}
            </Action>
            <input
              value={manualPath}
              placeholder={t('panel.addManual')}
              onChange={event => { setManualPath(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter') void addDirectory() }}
              style={{ flex: '1 1 220px', padding: '3px 6px' }}
            />
            <Action onClick={() => { void addDirectory() }} disabled={state.busy || manualPath.trim() === ''}>
              {t('panel.addConfirm')}
            </Action>
            <Action onClick={() => { void refresh() }} disabled={state.busy}>{t('panel.retry')}</Action>
          </div>
        </section>
      </div>
    </div>
  )
}

/** Normalize any thrown value into a `PanelError` the dialog can render. */
function asPanelError(error: unknown): PanelError {
  if (error instanceof PanelError) return error
  return new PanelError('fallback', error instanceof Error ? error.message : String(error))
}


