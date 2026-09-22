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
 *
 * Styling is the host's, not this file's: the elements carry `mrfw-*` classes
 * resolved by the stylesheet the client entry injects (`styles.ts`), and every
 * color in that sheet is a host `--dsw-*` token, so the panel inherits the
 * native look — sidebar trigger, modal card, capsule buttons — in both themes
 * without naming a single color here (see ADR-0006).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/WorkspaceFoldersAction
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEdit,
  IconEllipsis,
  IconFolderClose,
  IconFolderOpen,
  IconPlus,
  IconTrash,
} from '../compat/client-icons.ts'
import { errorKeyOf, PanelError, type PanelClient } from './panel-client.ts'
import type { Key } from './locales.ts'
import type { RootEntryView, RootState, RootView, RootsView } from '../contract.ts'

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

/** The visual family of one capsule button, mirroring the host Button kit. */
type ActionVariant = 'ghost' | 'outline' | 'primary' | 'danger'

const VARIANT_CLASS: Record<ActionVariant, string> = {
  ghost: 'mrfw-btnGhost',
  outline: 'mrfw-btnOutline',
  primary: 'mrfw-btnPrimary',
  danger: 'mrfw-btnDanger',
}

/** One small capsule button matching the panel's own styling. */
function Action(props: {
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  return (
    <button
      type="button"
      className={`mrfw-btn ${VARIANT_CLASS[variant]}`}
      onClick={props.onClick}
      disabled={props.disabled === true}
    >
      {props.children}
    </button>
  )
}

/**
 * One icon-only button (a host "iconButton"): a fixed square of the capsule
 * family whose meaning travels in `title`/`aria-label` instead of text.
 */
function IconButton(props: {
  onClick: () => void
  icon: ReactNode
  label: string
  disabled?: boolean
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  return (
    <button
      type="button"
      className={`mrfw-btn mrfw-iconBtn ${VARIANT_CLASS[variant]}`}
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled === true}
    >
      {props.icon}
    </button>
  )
}

/** The 16px close glyph of the dialog's header button. */
function CloseIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** The locale key for one reported root state. */
function stateKey(state: RootState): Key {
  switch (state) {
    case 'available': return 'state.available'
    case 'missing': return 'state.missing'
    case 'redirected': return 'state.redirected'
    case 'invalid': return 'state.invalid'
  }
}

/** The final segment of an absolute path, on either platform separator. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(segment => segment !== '')
  return segments[segments.length - 1] ?? path
}

/**
 * The primary text of one row: the stored alias when set, otherwise the
 * directory's own name — the display the registration was added with.
 */
function displayNameOf(root: RootView): string {
  return root.alias ?? basename(root.path)
}

/** The sidebar footer action plus the dialog it opens. */
export function WorkspaceFoldersAction(props: WorkspaceFoldersActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  const rail = props.wide === false
  return (
    <>
      {/* The row wrapper mirrors the host `.triggerRow`: its 2px side overhang
          (`calc(100% + 4px)` + negative margins) is what puts this row's icon
          on the same 18px ink line as the Settings gear below it. */}
      <div className={rail ? 'mrfw-triggerRow mrfw-railRow' : 'mrfw-triggerRow'}>
        <button
          type="button"
          className={rail ? 'mrfw-trigger mrfw-triggerRail' : 'mrfw-trigger'}
          title={props.t('action.title')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className="mrfw-triggerIcon" aria-hidden="true"><IconFolderClose size={rail ? 18 : 16} /></span>
          {rail ? null : <span className="mrfw-triggerLabel">{props.t('action.label')}</span>}
        </button>
      </div>
      {open ? <WorkspaceFoldersDialog {...props} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

/** State of one dialog instance. */
interface DialogState {
  readonly view: RootsView | undefined
  readonly error: PanelError | undefined
  readonly busy: boolean
  /** True when the client has no current session and must not call the host. */
  readonly noSession: boolean
}

function entryOf(root: RootView): RootEntryView {
  return { ordinal: root.ordinal, id: root.id, path: root.path, addedAt: root.addedAt }
}

function rowKey(root: RootView): string {
  return `${root.ordinal}\u0000${root.id}\u0000${root.path}\u0000${root.addedAt}`
}

/**
 * The dialog: reads the view once per open, then after every mutation.
 *
 * Two shapes travel back over the channel, and they are handled separately on
 * purpose: every mutating endpoint answers with the whole refreshed view, while
 * `reveal` answers with the path it revealed and leaves the list untouched
 * (see `contract.ts`). Treating a reveal answer as a roots view is exactly the
 * contract mismatch this split removes.
 */
function WorkspaceFoldersDialog(props: WorkspaceFoldersActionProps & { onClose: () => void }): ReactNode {
  const { panel, t } = props
  const [state, setState] = useState<DialogState>({
    view: undefined,
    error: undefined,
    busy: false,
    noSession: false,
  })
  const [manualPath, setManualPath] = useState('')
  const [aliasFor, setAliasFor] = useState<string | undefined>(undefined)
  const [aliasDraft, setAliasDraft] = useState('')
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const requestEpoch = useRef(0)
  const mounted = useRef(true)

  useEffect(() => () => {
    mounted.current = false
    requestEpoch.current += 1
  }, [])

  const requestBase = useCallback((): { sessionId: string } | undefined => {
    const current = props.sessionId?.()
    return current === undefined || current === '' ? undefined : { sessionId: current }
  }, [props.sessionId])

  // The dialog is modal: it takes focus when it opens, Escape closes it, and
  // Tab cycles within it instead of escaping into the sidebar behind it.
  useEffect(() => { dialogRef.current?.focus() }, [])
  const onDialogKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      // A row menu owns Escape while it is open: its own listener closes just
      // the menu, and this handler must not close the dialog underneath it.
      if (menuFor !== undefined) return
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])'),
    ).filter(element => !element.hasAttribute('disabled'))
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = dialog.ownerDocument.activeElement
    if (event.shiftKey && (active === first || !(active instanceof HTMLElement) || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !(active instanceof HTMLElement) || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const refresh = useCallback(async () => {
    if (panel === undefined) {
      setState({
        view: undefined,
        error: new PanelError('unavailable', 'no connection'),
        busy: false,
        noSession: false,
      })
      return
    }
    const base = requestBase()
    if (base === undefined) {
      setState({ view: undefined, error: undefined, busy: false, noSession: true })
      return
    }
    const epoch = ++requestEpoch.current
    setState(previous => ({ ...previous, busy: true, noSession: false }))
    try {
      const view = await panel.call('list', base)
      if (!mounted.current || epoch !== requestEpoch.current) return
      setState({ view, error: undefined, busy: false, noSession: false })
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current) return
      setState({ view: undefined, error: asPanelError(error), busy: false, noSession: false })
    }
  }, [panel, requestBase])

  useEffect(() => { void refresh() }, [refresh])

  /**
   * Submit one change to the host and adopt the view it answers with.
   * @returns whether the host accepted it (the caller decides whether to clear
   *   the input it came from).
   */
  const mutate = useCallback(async (endpoint: 'add' | 'remove' | 'alias' | 'move', payload: Record<string, unknown>): Promise<boolean> => {
    if (panel === undefined) return false
    const base = requestBase()
    if (base === undefined) {
      setState({ view: undefined, error: undefined, busy: false, noSession: true })
      return false
    }
    const epoch = ++requestEpoch.current
    setState(previous => ({ ...previous, busy: true, noSession: false }))
    try {
      const view = await panel.call(endpoint, { ...base, ...payload })
      if (!mounted.current || epoch !== requestEpoch.current) return false
      setState({ view, error: undefined, busy: false, noSession: false })
      return true
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current) return false
      setState(previous => ({ ...previous, error: asPanelError(error), busy: false }))
      return false
    }
  }, [panel, requestBase])

  /**
   * Open the composed picker and add whatever it returns. A picker that is not
   * composed, or a dialog the operator dismissed, adds nothing — it never falls
   * back to the manual field, because the operator who clicked "Add folder…"
   * asked for the picker, not for the text they may have typed earlier.
   */
  const addViaPicker = useCallback(async () => {
    if (props.pickDirectory === undefined) return
    let picked: string | null = null
    try {
      picked = await props.pickDirectory()
    } catch (error: unknown) {
      setState(previous => ({ ...previous, error: asPanelError(error) }))
      return
    }
    if (picked === null || picked.trim() === '') return
    await mutate('add', { path: picked })
  }, [mutate, props])

  /**
   * Add the path in the manual field — the one the operator typed. The picker
   * plays no part here: this is the entry point the confirm button and the
   * Enter key use.
   */
  const addManualPath = useCallback(async () => {
    const path = manualPath.trim()
    if (path === '') return
    // Cleared only on success: a rejected path stays in the field so the operator
    // can fix it instead of retyping it.
    if (await mutate('add', { path })) setManualPath('')
  }, [manualPath, mutate])

  /** Reveal one root: the answer is the revealed path, not a new view. */
  const reveal = useCallback(async (root: RootView) => {
    if (panel === undefined) return
    const base = requestBase()
    if (base === undefined) {
      setState({ view: undefined, error: undefined, busy: false, noSession: true })
      return
    }
    const epoch = ++requestEpoch.current
    setState(previous => ({ ...previous, busy: true, noSession: false }))
    try {
      await panel.call('reveal', { ...base, entry: entryOf(root) })
      if (!mounted.current || epoch !== requestEpoch.current) return
      setState(previous => ({ ...previous, error: undefined, busy: false }))
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current) return
      setState(previous => ({ ...previous, error: asPanelError(error), busy: false }))
    }
  }, [panel, requestBase])

  const copyPath = useCallback(async (root: RootView) => {
    try {
      await navigator.clipboard.writeText(root.path)
      const key = rowKey(root)
      setCopiedId(key)
      setState(previous => ({ ...previous, error: undefined }))
      window.setTimeout(() => { setCopiedId(current => (current === key ? undefined : current)) }, 1500)
    } catch (error: unknown) {
      // A clipboard refusal is the browser environment's, not the host's, so it
      // is reported here with its own code rather than left silent.
      setCopiedId(undefined)
      setState(previous => ({
        ...previous,
        error: new PanelError('copy-failed', error instanceof Error ? error.message : String(error)),
      }))
    }
  }, [])

  const move = useCallback(async (root: RootView, before: RootView | undefined) => {
    await mutate('move', before === undefined
      ? { entry: entryOf(root) }
      : { entry: entryOf(root), beforeEntry: entryOf(before) })
  }, [mutate])

  const roots = state.view?.roots ?? []
  return (
    <div className="mrfw-overlay" role="presentation">
      <div
        className="mrfw-mask"
        role="presentation"
        onClick={event => { if (event.target === event.currentTarget) props.onClose() }}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="mrfw-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('panel.title')}
      >
        <div className="mrfw-header">
          <h2 className="mrfw-title">{t('panel.title')}</h2>
          <button
            type="button"
            className="mrfw-close"
            title={t('panel.close')}
            aria-label={t('panel.close')}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="mrfw-body">
          {state.noSession ? (
            <p className="mrfw-note">{t('panel.noSession')}</p>
          ) : (
            <>
          <p className="mrfw-description">{t('panel.subtitle')}</p>

          {state.error === undefined ? null : (
            <p role="alert" className="mrfw-alert">
              {t(errorKeyOf(state.error.code))}
              {(state.error.code === 'unavailable' || state.error.code === 'panel/internal') ? ` (${state.error.message})` : ''}
            </p>
          )}
          {state.view?.unavailable === undefined ? null : (
            <p role="alert" className="mrfw-alert">{state.view.unavailable}</p>
          )}

          <section className="mrfw-section">
            <div className="mrfw-sectionTitleRow">
              <span className="mrfw-sectionTitle">{t('panel.primary')}</span>
              <span className="mrfw-sectionNote">{t('panel.primaryNote')}</span>
            </div>
            <div className="mrfw-row mrfw-rowBare">
              <div className="mrfw-rootText">
                <span className="mrfw-rootName">
                  {state.view === undefined ? '…' : (state.view.primaryName ?? basename(state.view.primaryRoot))}
                </span>
                <span className="mrfw-rootPath">{state.view?.primaryRoot ?? '…'}</span>
              </div>
            </div>
          </section>

          <section className="mrfw-section">
            <div className="mrfw-sectionTitleRow">
              <span className="mrfw-sectionTitle">{t('panel.additional')}</span>
            </div>
            {state.view === undefined ? <p className="mrfw-note">{t('panel.loading')}</p> : null}
            {state.view !== undefined && roots.length === 0 ? (
              <p className="mrfw-note">
                {t('panel.empty')} {t('panel.emptyHint')}
              </p>
            ) : null}
            {roots.map((root, index) => {
              const key = rowKey(root)
              return <div key={key} className="mrfw-row">
                <div className="mrfw-rootText">
                  <span className="mrfw-rootName">{displayNameOf(root)}</span>
                  <span className="mrfw-rootPath">{root.path}</span>
                </div>
                {root.state === 'available' ? null : (
                  <span title={root.detail} className="mrfw-stateWarn">
                    {t(stateKey(root.state))}
                  </span>
                )}
                <IconButton
                  onClick={() => { void copyPath(root) }}
                  icon={<IconCopy />}
                  label={copiedId === key ? t('panel.copied') : t('panel.copyPath')}
                />
                <IconButton
                  disabled={state.busy}
                  onClick={() => { void reveal(root) }}
                  icon={<IconFolderOpen />}
                  label={t('panel.reveal')}
                />
                <IconButton
                  disabled={state.busy || index === 0}
                  onClick={() => { void move(root, roots[index - 1]) }}
                  icon={<IconChevronUp />}
                  label={t('panel.moveUp')}
                />
                <IconButton
                  disabled={state.busy || index === roots.length - 1}
                  onClick={() => { void move(root, roots[index + 2]) }}
                  icon={<IconChevronDown />}
                  label={t('panel.moveDown')}
                />
                <Menu
                  open={menuFor === key}
                  onClose={() => { setMenuFor(undefined) }}
                  items={[
                    { id: 'rename', label: t('panel.rename'), icon: <IconEdit /> },
                    { id: 'remove', label: t('panel.remove'), icon: <IconTrash />, danger: true, disabled: state.busy },
                  ]}
                  onSelect={(id) => {
                    setMenuFor(undefined)
                    if (id === 'rename') {
                      setAliasFor(key)
                      setAliasDraft(root.alias ?? '')
                    }
                    if (id === 'remove') void mutate('remove', { entry: entryOf(root) })
                  }}
                  portal
                  align="end"
                  closeOnPointerLeave
                  anchor={(
                    <IconButton
                      disabled={state.busy}
                      onClick={() => { setMenuFor(current => (current === key ? undefined : key)) }}
                      icon={<IconEllipsis />}
                      label={t('panel.more')}
                    />
                  )}
                />
                {aliasFor === key ? (
                  <span className="mrfw-aliasEditor">
                    <input
                      autoFocus
                      className="mrfw-input mrfw-inputInline"
                      value={aliasDraft}
                      placeholder={t('panel.aliasPlaceholder')}
                      onChange={event => { setAliasDraft(event.target.value) }}
                    />
                    <Action disabled={state.busy} onClick={() => { void mutate('alias', { entry: entryOf(root), alias: aliasDraft }); setAliasFor(undefined) }}>
                      {t('panel.aliasSave')}
                    </Action>
                    <Action onClick={() => { setAliasFor(undefined) }}>{t('panel.aliasCancel')}</Action>
                  </span>
                ) : null}
              </div>
            })}
          </section>
            </>
          )}

          <div className="mrfw-actions">
            {state.noSession || props.pickDirectory === undefined ? null : (
              <IconButton
                variant="outline"
                disabled={state.busy}
                onClick={() => { void addViaPicker() }}
                icon={<IconPlus />}
                label={t('panel.add')}
              />
            )}
            {state.noSession ? null : (
              <>
            <input
              className="mrfw-input"
              value={manualPath}
              placeholder={t('panel.addManual')}
              onChange={event => { setManualPath(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter') void addManualPath() }}
            />
            <Action onClick={() => { void addManualPath() }} disabled={state.busy || manualPath.trim() === ''} variant="primary">
              {t('panel.addConfirm')}
            </Action>
              </>
            )}
            <Action onClick={() => { void refresh() }} disabled={state.busy} variant="outline">{t('panel.retry')}</Action>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Normalize any thrown value into a `PanelError` the dialog can render. */
function asPanelError(error: unknown): PanelError {
  if (error instanceof PanelError) return error
  return new PanelError('fallback', error instanceof Error ? error.message : String(error))
}
