/**
 * The Workspace Folders panel: one sidebar footer action that opens a dialog
 * listing this session's workspace root and the additional roots registered for
 * it, with the actions the milestone requires — Add (through the composed
 * directory picker), Remove, Alias, Copy Path, and Reveal.
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
 * The dialog itself is also exported: the Files-tab root switcher opens the
 * same manager through its trailing menu item instead of carrying a second
 * dialog.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/WorkspaceFoldersAction
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconAccessInherit,
  IconAccessReadOnly,
  IconAccessReadWrite,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEdit,
  IconEllipsis,
  IconFolderOpen,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
} from '../compat/client-icons.ts'
import { errorKeyOf, PanelError, type PanelClient } from './panel-client.ts'
import type { Key } from './locales.ts'
import type { RootAccess, RootEntryView, RootState, RootView, RootsView } from '../contract.ts'

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
  readonly subscribeSession?: (listener: () => void) => () => void
  /** Whether the sidebar renders wide content (`false` in the icon rail). */
  readonly wide?: boolean
  /** Icon-only launcher in the upstream Files tab's public actions slot. */
  readonly compact?: boolean
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
  pressed?: boolean
  hint?: string
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  return (
    <button
      type="button"
      className={`mrfw-btn mrfw-iconBtn ${VARIANT_CLASS[variant]}`}
      title={props.hint ?? props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      disabled={props.disabled === true}
    >
      {props.icon}
    </button>
  )
}

/** A skill is a reusable instruction document; the star denotes its capability. */
function SkillsIcon({ enabled }: { enabled: boolean }): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13.5H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V7M4.5 4.5h5M4.5 7h3" />
      <path d="m11.5 8 .85 2.65L15 11.5l-2.65.85-.85 2.65-.85-2.65L8 11.5l2.65-.85Z" />
      {enabled ? null : <path d="m2 14 12-12" />}
    </svg>
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

/**
 * One path that copies itself: text that paints like the surrounding copy
 * and reveals a trailing icon on hover — clicking the text or the icon
 * copies the same canonical path. The accessible name swaps to "copied"
 * for the feedback window, the icon button's old recipe. Shared by the
 * primary row and every additional root.
 */
function PathCopy(props: {
  readonly path: string
  readonly copied: boolean
  readonly onCopy: () => void
  readonly t: Translate
}): ReactNode {
  return (
    <button
      type="button"
      className="mrfw-rootPath mrfw-pathCopy"
      title={props.path}
      aria-label={props.copied ? props.t('panel.copied') : props.t('panel.copyPath')}
      onClick={props.onCopy}
    >
      {props.path}
      <span className="mrfw-pathCopyIcon" aria-hidden="true"><IconCopy size={14} /></span>
    </button>
  )
}

/** The locale key for one reported root state. */
export function stateKey(state: RootState): Key {
  switch (state) {
    case 'available': return 'state.available'
    case 'missing': return 'state.missing'
    case 'redirected': return 'state.redirected'
    case 'invalid': return 'state.invalid'
  }
}

/** The locale key for one registration's access level. */
export function accessKey(access: RootAccess): Key {
  switch (access) {
    case 'inherit': return 'access.inherit'
    case 'read-only': return 'access.readOnly'
    case 'read-write': return 'access.readWrite'
  }
}

/**
 * Whether moving FROM `from` TO `to` could widen the agent's write authority
 * under some session mode. The three levels are not a total order — `inherit`
 * is weaker than `read-write` under a read-only session but never weaker
 * under the others — so the check is spelled out per pair rather than
 * computed from a rank. Only a widening change asks for confirmation.
 */
export function widensAccess(from: RootAccess, to: RootAccess): boolean {
  if (from === 'read-only') return to !== 'read-only'
  return (from === 'inherit' && to === 'read-write') || (from === 'read-write' && to === 'inherit')
}

/** The final segment of an absolute path, on either platform separator. */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(segment => segment !== '')
  return segments[segments.length - 1] ?? path
}

/**
 * The primary text of one row: the stored alias when set, otherwise the
 * directory's own name — the display the registration was added with.
 */
export function displayNameOf(root: RootView): string {
  return root.alias ?? basename(root.path)
}

/** Display-only path matching; the host remains the sole authority for grants. */
function workingRootOf(view: RootsView | undefined): string | undefined {
  if (view?.effectiveCwd === undefined) return undefined
  const normalize = (path: string): string => {
    const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\')
    const normalized = (windows ? path.replace(/\\/g, '/').toLowerCase() : path).replace(/\/+$/, '')
    return normalized || '/'
  }
  const cwd = normalize(view.effectiveCwd)
  // Longest boundary match is equivalent to walking up to the nearest listed root.
  return [view.primaryRoot, ...view.roots.map(root => root.path)]
    .filter(path => {
      const root = normalize(path)
      return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
    })
    .sort((a, b) => normalize(b).length - normalize(a).length)[0]
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
      <div className={props.compact ? 'mrfw-fileLauncher' : rail ? 'mrfw-triggerRow mrfw-railRow' : 'mrfw-triggerRow'}>
        <button
          type="button"
          className={props.compact ? 'mrfw-btn mrfw-btnGhost mrfw-iconBtn' : rail ? 'mrfw-trigger mrfw-triggerRail' : 'mrfw-trigger'}
          title={props.t('action.title')}
          aria-label={props.compact === true ? props.t('action.title') : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className="mrfw-triggerIcon" aria-hidden="true"><IconSettings size={rail ? 18 : 16} /></span>
          {rail || props.compact === true ? null : <span className="mrfw-triggerLabel">{props.t('action.label')}</span>}
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

/** The exact row reference the browsing endpoints and mutations carry. */
export function entryOf(root: RootView): RootEntryView {
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
export function WorkspaceFoldersDialog(props: WorkspaceFoldersActionProps & { onClose: () => void }): ReactNode {
  const { panel, t } = props
  const [state, setState] = useState<DialogState>({
    view: undefined,
    error: undefined,
    busy: false,
    noSession: false,
  })
  const [manualPath, setManualPath] = useState('')
  /** The access the Add controls register new roots with; `inherit` is the default. */
  const [addAccess, setAddAccess] = useState<RootAccess>('inherit')
  /**
   * Whether the operator actually picked a level. The select shows its default
   * before they do, and sending that default would be an explicit value the
   * operator never named: on a revive the registry upgrades a read-only record
   * to it. Only a chosen level may travel in the request.
   */
  const [accessChosen, setAccessChosen] = useState(false)
  const [accessMenuOpen, setAccessMenuOpen] = useState(false)
  /** The widening access change waiting on the confirmation's red button. */
  const [upgradeFor, setUpgradeFor] = useState<{ root: RootView; access: RootAccess } | undefined>(undefined)
  const [aliasFor, setAliasFor] = useState<string | undefined>(undefined)
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasField, setAliasField] = useState<'alias' | 'aliasId'>('alias')
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const requestEpoch = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestEpoch.current += 1
    }
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
      // An open menu or the upgrade confirmation owns Escape: its own
      // listener closes just that layer, and this handler must not close the
      // dialog underneath it — the portaled dropdown and Modal bubble their
      // events through this dialog's React tree too.
      if (menuFor !== undefined || accessMenuOpen || upgradeFor !== undefined) return
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.key !== 'Tab') return
    // While the upgrade confirmation owns the topmost modal, Tab belongs to
    // its own focus trap. The portaled Modal still bubbles keys through this
    // dialog's React tree (like Escape above), and trapping here would yank
    // focus to a control behind the active confirmation.
    if (upgradeFor !== undefined) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, input, select, [href], [tabindex]:not([tabindex="-1"])'),
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
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return
      setState({ view, error: undefined, busy: false, noSession: false })
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return
      setState({ view: undefined, error: asPanelError(error), busy: false, noSession: false })
    }
  }, [panel, requestBase])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let previous = props.sessionId?.()
    return props.subscribeSession?.(() => {
      const current = props.sessionId?.()
      if (current === previous) return
      previous = current
      requestEpoch.current += 1
      setState({ view: undefined, error: undefined, busy: false, noSession: current === undefined })
      setMenuFor(undefined)
      setAliasFor(undefined)
      void refresh()
    })
  }, [props.subscribeSession, props.sessionId, refresh])

  /**
   * Submit one change to the host and adopt the view it answers with.
   * @returns whether the host accepted it (the caller decides whether to clear
   *   the input it came from).
   */
  const mutate = useCallback(async (endpoint: 'add' | 'remove' | 'alias' | 'move' | 'setAccess' | 'setAliasId' | 'setSkillsEnabled', payload: Record<string, unknown>): Promise<boolean> => {
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
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return false
      setState({ view, error: undefined, busy: false, noSession: false })
      return true
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return false
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
    await mutate('add', { path: picked, ...(accessChosen ? { access: addAccess } : {}) })
  }, [mutate, props, addAccess, accessChosen])

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
    if (await mutate('add', { path, ...(accessChosen ? { access: addAccess } : {}) })) setManualPath('')
  }, [manualPath, mutate, addAccess, accessChosen])

  /**
   * Re-register one withheld or unusable root in place. The request carries
   * the stored path and deliberately NO access: `registry.add` treats the call
   * as a revive — it keeps the record's access, alias, and identity instead of
   * creating a new registration — which is also why the root limit must not
   * gate this button: a revive consumes no slot, and it is the panel's only
   * repair route for a redirected entry.
   */
  const reRegister = useCallback(async (root: RootView) => {
    await mutate('add', { path: root.path })
  }, [mutate])

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
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return
      setState(previous => ({ ...previous, error: undefined, busy: false }))
    } catch (error: unknown) {
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== base.sessionId) return
      setState(previous => ({ ...previous, error: asPanelError(error), busy: false }))
    }
  }, [panel, requestBase])

  const copyPath = useCallback(async (key: string, path: string) => {
    try {
      await navigator.clipboard.writeText(path)
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

  // Retained for a future drag-to-reorder interaction; no ordering controls are shown.
  const _move = useCallback(async (root: RootView, before: RootView | undefined) => {
    await mutate('move', before === undefined
      ? { entry: entryOf(root) }
      : { entry: entryOf(root), beforeEntry: entryOf(before) })
  }, [mutate])

  const roots = state.view?.roots ?? []
  // The host refuses the add as `root-limit-reached` anyway; disabling here is
  // what makes the refusal explain itself before the operator clicks.
  const atLimit = state.view !== undefined && state.view.count >= state.view.limit
  const IconAccessTrigger = addAccess === 'read-only' ? IconAccessReadOnly
    : addAccess === 'read-write' ? IconAccessReadWrite : IconAccessInherit
  // Captured as consts: narrowing does not reach the onCopy closures below.
  const primaryPath = state.view?.primaryRoot
  const workingRoot = workingRootOf(state.view)
  return (
    <>
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
          {state.view?.mode === undefined ? null : <p className="mrfw-note">
            {t('panel.mode')} {t(`mode.${state.view.mode}`)}
          </p>}
          {state.view?.toolAccessInvalid ? <p className="mrfw-note">{t('panel.invalidCap')}</p>
            : (state.view?.cappedTools?.length ?? 0) > 0 ? <p className="mrfw-note">
              {t('panel.toolCaps', { tools: state.view!.cappedTools!.join(', ') })}
            </p> : null}

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
                  <span className="mrfw-rootNameText">
                    {state.view === undefined ? '…' : (state.view.primaryName ?? basename(state.view.primaryRoot))}
                  </span>
                  {primaryPath !== undefined && workingRoot === primaryPath ? <span className="mrfw-cwdTag">{t('panel.currentAgentCwd')}</span> : null}
                </span>
                {primaryPath === undefined
                  ? <span className="mrfw-rootPath">…</span>
                  : (
                    <PathCopy
                      path={primaryPath}
                      copied={copiedId === 'primary'}
                      onCopy={() => { void copyPath('primary', primaryPath) }}
                      t={t}
                    />
                  )}
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
            {roots.map(root => {
              const key = rowKey(root)
              const IconAccess = root.access === 'read-only' ? IconAccessReadOnly
                : root.access === 'read-write' ? IconAccessReadWrite : IconAccessInherit
              return <div key={key} className="mrfw-row">
                <div className="mrfw-rootText">
                  <span className="mrfw-rootName">
                    <span className="mrfw-rootNameText">{displayNameOf(root)}</span>
                    {workingRoot === root.path ? <span className="mrfw-cwdTag">{t('panel.currentAgentCwd')}</span> : null}
                    {/* The access level rides beside the name as read-only
                        text; changing it stays behind the row's … menu. */}
                    <span className="mrfw-accessBadge">
                      {IconAccess === undefined ? null : <IconAccess size={14} />}
                      {root.effectiveAccess === undefined ? t(accessKey(root.access)) : t('panel.accessEffective', {
                        access: t(accessKey(root.access)),
                        effective: t(`effective.${root.effectiveAccess}`),
                      })}
                    </span>
                  </span>
                  <PathCopy
                    path={root.path}
                    copied={copiedId === key}
                    onCopy={() => { void copyPath(key, root.path) }}
                    t={t}
                  />
                </div>
                {root.state === 'available' ? null : (
                  <span title={root.detail} className="mrfw-stateWarn">
                    {t(stateKey(root.state))}
                  </span>
                )}
                {root.state === 'available' ? null : (
                  <IconButton
                    disabled={state.busy}
                    onClick={() => { void reRegister(root) }}
                    icon={<IconRefresh />}
                    label={t('panel.reRegister')}
                  />
                )}
                {root.skillsEnabled === undefined ? null : (
                  <IconButton
                    disabled={state.busy}
                    pressed={root.skillsEnabled}
                    onClick={() => { void mutate('setSkillsEnabled', { entry: entryOf(root), skillsEnabled: !root.skillsEnabled }) }}
                    icon={<SkillsIcon enabled={root.skillsEnabled} />}
                    label={t('panel.skills')}
                    hint={t(root.skillsEnabled ? 'panel.skillsEnabled' : 'panel.skillsDisabled')}
                  />
                )}
                <IconButton
                  disabled={state.busy}
                  onClick={() => { void reveal(root) }}
                  icon={<IconFolderOpen />}
                  label={t('panel.reveal')}
                />
                <Menu
                  open={menuFor === key}
                  onClose={() => { setMenuFor(undefined) }}
                  items={[
                    { id: 'rename', label: t('panel.rename'), icon: <IconEdit /> },
                    { id: 'alias-id', label: t('panel.aliasIdEdit'), disabled: state.busy },
                    { id: 'access:inherit', label: t('panel.accessInherit'), icon: IconAccessInherit === undefined ? undefined : <IconAccessInherit />, disabled: state.busy || root.access === 'inherit' },
                    { id: 'access:read-only', label: t('panel.accessReadOnly'), icon: IconAccessReadOnly === undefined ? undefined : <IconAccessReadOnly />, disabled: state.busy || root.access === 'read-only' },
                    { id: 'access:read-write', label: t('panel.accessReadWrite'), icon: IconAccessReadWrite === undefined ? undefined : <IconAccessReadWrite />, disabled: state.busy || root.access === 'read-write' },
                    { id: 'remove', label: t('panel.remove'), icon: <IconTrash />, danger: true, disabled: state.busy },
                  ]}
                  onSelect={(id) => {
                    setMenuFor(undefined)
                    if (id === 'alias-id') {
                      setAliasField('aliasId')
                      setAliasFor(key)
                      setAliasDraft(root.aliasId ?? '')
                    }
                    if (id === 'rename') {
                      setAliasField('alias')
                      setAliasFor(key)
                      setAliasDraft(root.alias ?? '')
                    }
                    if (id.startsWith('access:')) {
                      const access = id.slice('access:'.length) as RootAccess
                      // Widening what the agent may modify — under ANY session
                      // mode — asks first, through the confirmation layered
                      // over this dialog, not the browser's window.confirm.
                      if (widensAccess(root.access, access)) { setUpgradeFor({ root, access }); return }
                      void mutate('setAccess', { entry: entryOf(root), access })
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
                      placeholder={t(aliasField === 'aliasId' ? 'panel.aliasIdPlaceholder' : 'panel.aliasPlaceholder')}
                      onChange={event => { setAliasDraft(event.target.value) }}
                    />
                    <Action disabled={state.busy} onClick={() => { void mutate(aliasField === 'aliasId' ? 'setAliasId' : 'alias', { entry: entryOf(root), [aliasField]: aliasDraft }).then(ok => { if (ok) setAliasFor(undefined) }) }}>
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
                disabled={state.busy || atLimit}
                onClick={() => { void addViaPicker() }}
                icon={<IconPlus />}
                label={atLimit ? t('panel.limitReached') : t('panel.add')}
              />
            )}
            {state.noSession ? null : (
              <>
            <input
              className="mrfw-input"
              value={manualPath}
              placeholder={t('panel.addManual')}
              disabled={atLimit}
              onChange={event => { setManualPath(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter') void addManualPath() }}
            />
            {/* The access picker is the host's own anchored menu — the same
                dropdown kit the root switcher and the row menus use — not a
                native select. Only an explicit selection marks the level
                chosen, so the displayed default still travels in no request
                (accessChosen keeps its meaning). Opens upward: the row sits
                at the dialog's bottom edge. */}
            <Menu
              open={accessMenuOpen}
              onClose={() => { setAccessMenuOpen(false) }}
              className="mrfw-accessSelect"
              items={[
                {
                  id: 'inherit',
                  label: t('access.inherit'),
                  icon: IconAccessInherit === undefined ? undefined : <IconAccessInherit />,
                },
                {
                  id: 'read-write',
                  label: t('access.readWrite'),
                  icon: IconAccessReadWrite === undefined ? undefined : <IconAccessReadWrite />,
                },
                {
                  id: 'read-only',
                  label: t('access.readOnly'),
                  icon: IconAccessReadOnly === undefined ? undefined : <IconAccessReadOnly />,
                },
              ]}
              selectedId={addAccess}
              onSelect={(id) => {
                setAccessMenuOpen(false)
                if (id === 'inherit' || id === 'read-write' || id === 'read-only') {
                  setAccessChosen(true)
                  setAddAccess(id)
                }
              }}
              portal
              side="top"
              align="end"
              closeOnPointerLeave
              anchor={(
                <button
                  type="button"
                  className="mrfw-btn mrfw-btnOutline mrfw-accessTrigger"
                  title={t('panel.accessLabel')}
                  aria-label={t('panel.accessLabel')}
                  aria-haspopup="menu"
                  aria-expanded={accessMenuOpen}
                  disabled={state.busy || atLimit}
                  onClick={() => { setAccessMenuOpen(open => !open) }}
                >
                  {IconAccessTrigger === undefined ? null : <IconAccessTrigger />}
                  {t(accessKey(addAccess))}
                  {accessMenuOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                </button>
              )}
            />
            <Action
              onClick={() => { void addManualPath() }}
              disabled={state.busy || atLimit || manualPath.trim() === ''}
              variant="primary"
            >
              {t('panel.addConfirm')}
            </Action>
              </>
            )}
            {atLimit ? <span className="mrfw-note">{t('panel.limitReached')}</span> : null}
            <Action onClick={() => { void refresh() }} disabled={state.busy} variant="outline">{t('panel.retry')}</Action>
          </div>
        </div>
      </div>
    </div>
    {/* A widening access change asks first: a host-modal confirmation layered
        over this dialog — cancel or a mask click dismisses, the red button
        commits the setAccess mutation. Narrowing changes skip it entirely. */}
    <Modal
      open={upgradeFor !== undefined}
      onClose={() => { setUpgradeFor(undefined) }}
      title={t('panel.accessUpgradeTitle')}
      description={upgradeFor === undefined ? '' : t('panel.accessUpgradeConfirm', { access: t(accessKey(upgradeFor.access)) })}
      closeLabel={t('panel.close')}
      footer={(
        <>
          <Action onClick={() => { setUpgradeFor(undefined) }}>{t('panel.aliasCancel')}</Action>
          <Action
            variant="danger"
            disabled={state.busy}
            onClick={() => {
              const pending = upgradeFor
              setUpgradeFor(undefined)
              if (pending !== undefined) {
                void mutate('setAccess', { entry: entryOf(pending.root), access: pending.access })
              }
            }}
          >
            {t('panel.accessUpgradeDo')}
          </Action>
        </>
      )}
    />
    </>
  )
}

/** Normalize any thrown value into a `PanelError` the dialog can render. */
function asPanelError(error: unknown): PanelError {
  if (error instanceof PanelError) return error
  return new PanelError('fallback', error instanceof Error ? error.message : String(error))
}
