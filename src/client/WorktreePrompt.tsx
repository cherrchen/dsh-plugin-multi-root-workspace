/**
 * The worktree suggestion overlay.
 *
 * Mounted once on the shell's overlay slot. The trigger model is "one read-only
 * check per session activation + a persistent non-modal notice + an explicit
 * Dialog" (ADR-0039 第二十次修订):
 *
 * - becoming the current session runs exactly one
 *   `prompt(session, { fresh: true })`; a non-empty answer shows the notice,
 *   an empty answer or ANY failure shows nothing and is never retried;
 * - the Dialog and its long poll `wait` start only after the operator presses
 *   "View"; closing it aborts the poll and writes no prompt state;
 * - reminder decisions travel as ids plus a mode, never as paths or keys.
 *
 * The overlay stays silent on every other event: re-mounting the same session,
 * turning the settings switch back on, and the Workspace Folders panel's list
 * are capability/refresh signals, not prompt triggers. When the switch turns
 * off, the notice and the Dialog are hidden and their in-flight requests are
 * aborted.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/WorktreePrompt
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorktreeAccess, WorktreeAccessEntry, WorktreePromptView, WorktreeSnoozeMode } from '../contract.ts'
import {
  IconAccessInherit,
  IconAccessReadOnly,
  IconAccessReadWrite,
  IconChevronDown,
  IconWorkspaceTree,
} from '../compat/client-icons.ts'
import { errorKeyOf, PanelError } from './panel-client.ts'
import { noticeStyle, useNoticePlacement } from './notice-placement.ts'
import { onWorktreePromptRequest } from './worktree-prompt-bus.ts'
import type { WorktreeClient } from './worktree-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/** The composed props of the overlay occupant. */
export interface WorktreePromptProps {
  readonly client: WorktreeClient | undefined
  readonly sessionId: () => string | undefined
  readonly subscribeSession: (listener: () => void) => (() => void) | undefined
  readonly t: Translate
  /** Phase P3: preview only — the confirmation stays disabled until P4 lands. */
  readonly previewOnly: boolean
  /** Whether the experimental feature is enabled; absent means "unknown, treat as on". */
  readonly readEnabled?: (() => boolean) | undefined
  /**
   * The live worktree-settings subscription. It only ever HIDES: a switch that
   * turned off closes the notice and the Dialog and aborts their requests, and
   * turning it back on never re-runs the automatic check.
   */
  readonly subscribeEnabled?: ((listener: () => void) => () => void) | undefined
}

/** The persistent notice and the session that was shown it. */
interface NoticeState {
  readonly session: string
  readonly prompts: readonly WorktreePromptView[]
}

/** The Dialog's own snooze vocabulary: the three wire modes plus "permanent". */
type DialogLaterMode = WorktreeSnoozeMode | 'permanent'

/** The per-row access choices the selector offers; inherit is the default. */
const ACCESS_CHOICES: readonly WorktreeAccess[] = ['inherit', 'read-only', 'read-write']

/** The i18n key naming one access choice (the panel's own vocabulary). */
function accessKeyOf(access: WorktreeAccess): 'panel.accessInherit' | 'panel.accessReadOnly' | 'panel.accessReadWrite' {
  return access === 'inherit' ? 'panel.accessInherit'
    : access === 'read-only' ? 'panel.accessReadOnly'
      : 'panel.accessReadWrite'
}

/** The access icon for one choice, or undefined on releases that lack the glyph. */
function AccessIcon(props: { readonly access: WorktreeAccess }): ReactNode {
  const Icon = props.access === 'read-only'
    ? IconAccessReadOnly
    : props.access === 'read-write' ? IconAccessReadWrite : IconAccessInherit
  return Icon === undefined ? null : <Icon size={14} />
}

/** Keep each surviving row's chosen access; new rows start at inherit. */
function reconcileAccesses(
  previous: ReadonlyMap<string, WorktreeAccess>,
  prompts: readonly WorktreePromptView[],
): Map<string, WorktreeAccess> {
  const next = new Map<string, WorktreeAccess>()
  for (const prompt of prompts) next.set(prompt.key, previous.get(prompt.key) ?? 'inherit')
  return next
}

/** The i18n key naming one Dialog snooze choice. */
function snoozeKeyOf(mode: DialogLaterMode): 'worktree.snooze.until-new-worktree' | 'worktree.snooze.7d' | 'worktree.snooze.30d' | 'worktree.snooze.permanent' {
  return mode === 'until-new-worktree' ? 'worktree.snooze.until-new-worktree'
    : mode === '7d' ? 'worktree.snooze.7d'
      : mode === '30d' ? 'worktree.snooze.30d' : 'worktree.snooze.permanent'
}

/** The basename of an absolute path (the row's display name). */
function pathName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** Reconcile the checked keys after the server sent a new visible list. */
function reconcileSelection(
  previous: ReadonlySet<string>,
  prompts: readonly WorktreePromptView[],
  errors: ReadonlyMap<string, string>,
): Set<string> {
  const next = new Set<string>()
  for (const prompt of prompts) {
    if (errors.has(prompt.key)) continue
    // A worktree checkout is pre-selected; the main checkout grants the source
    // tree and stays an explicit opt-in.
    if (previous.has(prompt.key) || prompt.kind === 'worktree') next.add(prompt.key)
  }
  return next
}

/** Map the server's skipped ids back to stable row keys. */
function rowErrorMap(
  rows: readonly WorktreePromptView[],
  skipped: readonly { readonly id: string; readonly key?: string | undefined; readonly code: string }[],
): Map<string, string> {
  const byId = new Map(rows.map(row => [row.id, row]))
  const errors = new Map<string, string>()
  for (const entry of skipped) {
    const key = entry.key ?? byId.get(entry.id)?.key
    if (key !== undefined) errors.set(key, entry.code)
  }
  return errors
}

/** The stable row keys of the ids a resolve refused, resolved from the rows shown. */
function skippedKeys(
  shown: readonly WorktreePromptView[],
  skipped: readonly { readonly id: string; readonly key?: string | undefined; readonly code: string }[],
): Set<string> {
  const byId = new Map(shown.map(row => [row.id, row]))
  const keys = new Set<string>()
  for (const entry of skipped) {
    const key = entry.key ?? byId.get(entry.id)?.key
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * The prompt overlay.
 * @param props - the composed slot props.
 * @returns the notice and/or the Dialog, or nothing while neither is visible.
 */
export function WorktreePrompt(props: WorktreePromptProps): ReactNode {
  const { client, sessionId, subscribeSession, t, previewOnly } = props
  const { readEnabled, subscribeEnabled } = props
  const [currentSession, setCurrentSession] = useState<string | undefined>(() => sessionId())
  const [notice, setNotice] = useState<NoticeState | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [rows, setRows] = useState<readonly WorktreePromptView[] | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [skippedCount, setSkippedCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [laterMode, setLaterMode] = useState<DialogLaterMode>('until-new-worktree')
  const [laterOpen, setLaterOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [accessByKey, setAccessByKey] = useState<ReadonlyMap<string, WorktreeAccess>>(() => new Map())
  const [accessMenuKey, setAccessMenuKey] = useState<string | undefined>(undefined)
  const placement = useNoticePlacement(notice !== undefined)

  const mounted = useRef(true)
  /** The session whose activation already consumed its one automatic check. */
  const checkedSession = useRef<string | undefined>(undefined)
  /** The session the last activation effect observed; undefined until mounted. */
  const observedSession = useRef<{ readonly value: string | undefined } | undefined>(undefined)
  /**
   * The freshness token of everything the UI currently owns. A result whose
   * epoch is not current — session switched, switch turned off, Dialog closed —
   * must never move the UI.
   */
  const workEpoch = useRef(0)
  const freshAbort = useRef<AbortController | undefined>(undefined)
  const dialogAbort = useRef<AbortController | undefined>(undefined)
  /** The session the Dialog was opened for; it is never anything else. */
  const dialogSession = useRef<string | undefined>(undefined)
  /** The revision already delivered to the Dialog's long poll. */
  const seenRevision = useRef<string | undefined>(undefined)
  /**
   * The revision whose contents are already adopted. A resolve answers with a
   * new revision and (re)renders the remaining rows; a wait that raced it can
   * deliver that SAME revision and must not overwrite the post-resolve state.
   */
  const appliedRevision = useRef<string | undefined>(undefined)
  /** The live session resolver, read inside async callbacks. */
  const sessionIdRef = useRef(sessionId)
  const readEnabledRef = useRef(readEnabled)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Both signals are read live: a subscription callback may run between renders.
  useEffect(() => { sessionIdRef.current = sessionId; readEnabledRef.current = readEnabled })

  // The session share changes independently of this component; the overlay
  // must follow the live session, never a value captured at mount time.
  useEffect(() => {
    const update = (): void => { setCurrentSession(sessionId()) }
    update()
    return subscribeSession(update)
  }, [sessionId, subscribeSession])

  // A session change ends everything the previous session's UI owned: abort
  // both in-flight requests, hide the notice and the Dialog, and forget the
  // Dialog's transient state. The next session gets its own activation below.
  useEffect(() => {
    const session = currentSession
    const previous = observedSession.current
    if (previous === undefined) {
      observedSession.current = { value: session }
      return
    }
    if (previous.value === session) return
    observedSession.current = { value: session }
    workEpoch.current += 1
    freshAbort.current?.abort()
    freshAbort.current = undefined
    dialogAbort.current?.abort()
    dialogAbort.current = undefined
    dialogSession.current = undefined
    setNotice(undefined)
    setDialogOpen(false)
    setRows(undefined)
    setSelected(new Set())
    setRowErrors(new Map())
    setSkippedCount(0)
    setError(undefined)
    setBusy(false)
    setLaterMode('until-new-worktree')
    setLaterOpen(false)
    setSnoozeOpen(false)
    setAccessByKey(new Map())
    setAccessMenuKey(undefined)
    // "From empty to a valid session" is a fresh activation later: forget that
    // an earlier visit to the same id consumed its check.
    if (session === undefined || session === '') checkedSession.current = undefined
  }, [currentSession])

  // The ONE automatic trigger: a valid session becomes current and the
  // feature is not known to be off. Fresh is a pure query, so a duplicate mount
  // (React StrictMode) only repeats a read — the checkedSession ref keeps the
  // notice single.
  useEffect(() => {
    const session = currentSession
    if (client === undefined || session === undefined || session === '') return
    if (checkedSession.current === session) return
    checkedSession.current = session
    if (readEnabledRef.current?.() === false) return
    const controller = new AbortController()
    freshAbort.current?.abort()
    freshAbort.current = controller
    const epoch = ++workEpoch.current
    void (async () => {
      let answer: Awaited<ReturnType<WorktreeClient['prompt']>>
      try {
        answer = await client.prompt(session, { fresh: true }, controller.signal)
      } catch {
        // Any failure — not-enabled, not-available, session-not-found, a
        // transport error — is silence. There is no retry and no backoff.
        return
      }
      if (!mounted.current || controller.signal.aborted || epoch !== workEpoch.current) return
      if (sessionIdRef.current() !== session) return
      if (answer.prompts.length === 0) return
      setNotice({ session, prompts: answer.prompts })
      void client.seen(session, answer.prompts.map(prompt => prompt.id)).catch(() => {})
    })()
  }, [client, currentSession])

  // The settings switch is a capability gate, never a prompt trigger. Turning
  // it off hides what it made possible; turning it back on does nothing.
  useEffect(() => {
    if (subscribeEnabled === undefined) return
    return subscribeEnabled(() => {
      if (readEnabledRef.current?.() !== false) return
      workEpoch.current += 1
      freshAbort.current?.abort()
      freshAbort.current = undefined
      dialogAbort.current?.abort()
      dialogAbort.current = undefined
      dialogSession.current = undefined
      setNotice(undefined)
      setDialogOpen(false)
      setRows(undefined)
      setSelected(new Set())
      setRowErrors(new Map())
      setSkippedCount(0)
      setError(undefined)
      setBusy(false)
      setLaterMode('until-new-worktree')
      setLaterOpen(false)
      setSnoozeOpen(false)
      setAccessByKey(new Map())
      setAccessMenuKey(undefined)
    })
  }, [subscribeEnabled])

  /** Close the Dialog and abort its long poll immediately (X, Escape, mask). */
  const closeDialog = useCallback(() => {
    workEpoch.current += 1
    dialogAbort.current?.abort()
    dialogAbort.current = undefined
    dialogSession.current = undefined
    setDialogOpen(false)
    setRows(undefined)
    setSelected(new Set())
    setRowErrors(new Map())
    setSkippedCount(0)
    setError(undefined)
    setBusy(false)
    setLaterMode('until-new-worktree')
    setLaterOpen(false)
    setSnoozeOpen(false)
    setAccessByKey(new Map())
    setAccessMenuKey(undefined)
  }, [])

  // The Dialog's whole lifetime. It starts only after "View" set dialogOpen:
  // one full prompt, the seen claim, then the long poll whose result replaces
  // the rows. Closing the Dialog (or a session/settings change) runs the
  // cleanup and aborts the poll. No wait is ever mounted otherwise.
  useEffect(() => {
    if (!dialogOpen || client === undefined) return
    const session = dialogSession.current
    if (session === undefined || session !== currentSession) return
    if (sessionIdRef.current() !== session) return
    const controller = new AbortController()
    dialogAbort.current = controller
    const epoch = ++workEpoch.current
    let cancelled = false
    const adopt = (prompts: readonly WorktreePromptView[], revision: string): void => {
      seenRevision.current = revision
      appliedRevision.current = revision
      setRows(prompts)
      setSelected(previous => reconcileSelection(previous, prompts, new Map()))
      setAccessByKey(previous => reconcileAccesses(previous, prompts))
      setRowErrors(new Map())
      setSkippedCount(0)
      setError(undefined)
    }
    const run = async (): Promise<void> => {
      let answer: Awaited<ReturnType<WorktreeClient['prompt']>>
      try {
        answer = await client.prompt(session, undefined, controller.signal)
      } catch {
        if (!cancelled && !controller.signal.aborted && mounted.current) closeDialog()
        return
      }
      if (cancelled || controller.signal.aborted || epoch !== workEpoch.current) return
      if (sessionIdRef.current() !== session) return
      // The notice claimed candidates, but the Dialog renders the full visible
      // list; an empty one means there is nothing to confirm after all.
      if (answer.prompts.length === 0) { closeDialog(); return }
      adopt(answer.prompts, answer.viewRevision)
      void client.seen(session, answer.prompts.map(prompt => prompt.id)).catch(() => {})
      while (!cancelled) {
        let result: Awaited<ReturnType<WorktreeClient['wait']>>
        const seen = seenRevision.current === undefined ? {} : { seenViewRevision: seenRevision.current }
        try {
          result = await client.wait(session, seen, controller.signal)
        } catch {
          if (!cancelled && !controller.signal.aborted && mounted.current) closeDialog()
          return
        }
        if (cancelled || controller.signal.aborted) return
        if (epoch !== workEpoch.current || sessionIdRef.current() !== session) return
        // A wait that raced the resolve may report the revision the resolve
        // already applied; keep that post-resolve state intact.
        if ((result.status === 'prompt' || result.status === 'prompts' || result.status === 'stale')
          && appliedRevision.current !== undefined && result.viewRevision === appliedRevision.current) {
          seenRevision.current = result.viewRevision
          continue
        }
        switch (result.status) {
          case 'prompt':
            adopt([result.prompt], result.viewRevision)
            void client.seen(session, [result.prompt.id]).catch(() => {})
            break
          case 'prompts':
            adopt(result.prompts, result.viewRevision)
            void client.seen(session, result.prompts.map(prompt => prompt.id)).catch(() => {})
            break
          case 'timeout':
            seenRevision.current = result.viewRevision
            break
          case 'stale':
          case 'lost':
          case 'unactivated':
            closeDialog()
            return
        }
      }
    }
    void run()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, closeDialog, currentSession, dialogOpen])

  /** Complete an add batch and adopt the server's remaining view. */
  const confirmAdd = useCallback(async (ids: readonly string[]): Promise<void> => {
    const session = dialogSession.current
    if (client === undefined || session === undefined || !dialogOpen || rows === undefined || ids.length === 0) return
    const visible = rows
    const byId = new Map(visible.map(row => [row.id, row]))
    const accesses: WorktreeAccessEntry[] = ids.map(id => ({
      id,
      access: accessByKey.get(byId.get(id)?.key ?? '') ?? 'inherit',
    }))
    const epoch = workEpoch.current
    setBusy(true)
    setError(undefined)
    try {
      const answer = await client.resolve(session, ids, 'add', { accesses })
      if (!mounted.current || epoch !== workEpoch.current || sessionIdRef.current() !== session) return
      appliedRevision.current = answer.viewRevision
      seenRevision.current = answer.viewRevision
      const errors = rowErrorMap(visible, answer.skipped)
      setRowErrors(errors)
      setSkippedCount(answer.skipped.length)
      if (answer.prompts.length === 0) { closeDialog(); return }
      setRows(answer.prompts)
      setSelected(previous => reconcileSelection(previous, answer.prompts, errors))
      setAccessByKey(previous => reconcileAccesses(previous, answer.prompts))
    } catch (failure: unknown) {
      if (!mounted.current || epoch !== workEpoch.current || sessionIdRef.current() !== session) return
      if (failure instanceof PanelError && failure.code === 'worktree/not-enabled') { closeDialog(); return }
      setError(failure instanceof PanelError ? failure.code : 'fallback')
    } finally {
      if (mounted.current && epoch === workEpoch.current) setBusy(false)
    }
  }, [accessByKey, client, closeDialog, dialogOpen, rows])

  /** Apply the Dialog's merged "later / do not remind" choice to every row. */
  const applyLater = useCallback(async (): Promise<void> => {
    const session = dialogSession.current
    if (client === undefined || session === undefined || !dialogOpen || rows === undefined) return
    const visible = rows
    const ids = visible.map(row => row.id)
    if (ids.length === 0) return
    const epoch = workEpoch.current
    setBusy(true)
    setError(undefined)
    try {
      const answer = laterMode === 'permanent'
        ? await client.resolve(session, ids, 'dismiss', { dontRemind: true })
        : await client.snooze(session, ids, { mode: laterMode })
      if (!mounted.current || epoch !== workEpoch.current || sessionIdRef.current() !== session) return
      appliedRevision.current = answer.viewRevision
      seenRevision.current = answer.viewRevision
      if (answer.skipped.length === 0) { closeDialog(); return }
      // A candidate can change between rendering the Dialog and submitting the
      // choice; the host then reports that row in `skipped` instead of failing
      // the request, and NOTHING was recorded for it. Closing here would both
      // lose the operator's decision and leave the `seen` claim hiding the
      // candidate for the rest of this Host lifetime, so keep the Dialog open
      // with the refreshed rows and the per-row failure, like `confirmAdd`.
      const errors = rowErrorMap(visible, answer.skipped)
      setRowErrors(errors)
      setSkippedCount(answer.skipped.length)
      if (answer.prompts.length === 0) { closeDialog(); return }
      setRows(answer.prompts)
      setSelected(previous => reconcileSelection(previous, answer.prompts, errors))
      setAccessByKey(previous => reconcileAccesses(previous, answer.prompts))
    } catch (failure: unknown) {
      if (!mounted.current || epoch !== workEpoch.current || sessionIdRef.current() !== session) return
      if (failure instanceof PanelError && failure.code === 'worktree/not-enabled') { closeDialog(); return }
      setError(failure instanceof PanelError ? failure.code : 'fallback')
    } finally {
      if (mounted.current && epoch === workEpoch.current) setBusy(false)
    }
  }, [client, closeDialog, dialogOpen, laterMode, rows])

  /** Open the Dialog for one live session and end the notice's lifecycle. */
  const openDialogFor = useCallback((session: string) => {
    // Opening the Dialog ends the notice's lifecycle immediately: a toast
    // completion still in flight must never touch it afterwards.
    workEpoch.current += 1
    setNotice(undefined)
    dialogSession.current = session
    setRows(undefined)
    setSelected(new Set())
    setRowErrors(new Map())
    setSkippedCount(0)
    setError(undefined)
    setBusy(false)
    setLaterMode('until-new-worktree')
    setLaterOpen(false)
    setSnoozeOpen(false)
    setAccessByKey(new Map())
    setAccessMenuKey(undefined)
    setDialogOpen(true)
  }, [])

  /** Open the Dialog for the notice's session: only "View" reaches this. */
  const openDialog = useCallback(() => {
    const current = notice
    if (client === undefined || current === undefined) return
    if (current.session !== currentSession || sessionIdRef.current() !== current.session) return
    openDialogFor(current.session)
  }, [client, currentSession, notice, openDialogFor])

  /** Open the Dialog from the panel's manual entry for the live session. */
  const openWorktreePrompt = useCallback(() => {
    const session = currentSession
    if (client === undefined || session === undefined || session === '') return
    if (sessionIdRef.current() !== session) return
    if (readEnabledRef.current?.() === false) return
    openDialogFor(session)
  }, [client, currentSession, openDialogFor])

  useEffect(() => onWorktreePromptRequest(openWorktreePrompt), [openWorktreePrompt])

  /**
   * Record the notice's reminder delay; only the lifecycle that showed the
   * notice may close or shrink it afterwards.
   */
  const snoozeNotice = useCallback((mode: WorktreeSnoozeMode) => {
    const current = notice
    if (client === undefined || current === undefined) { setNotice(undefined); return }
    if (current.session !== currentSession || sessionIdRef.current() !== current.session) { setNotice(undefined); return }
    const epoch = workEpoch.current
    void (async () => {
      let answer: Awaited<ReturnType<WorktreeClient['snooze']>>
      try {
        answer = await client.snooze(current.session, current.prompts.map(prompt => prompt.id), { mode })
      } catch {
        // A transport/authority failure is still silence for the activation that
        // showed this notice: it closes and this Host never retries it
        // automatically. But a completion after the session/settings lifecycle
        // moved on owns nothing — clearing the CURRENT notice would hide a new
        // activation's candidates that `seen` already claimed for this Host.
        if (!mounted.current || epoch !== workEpoch.current) return
        setNotice(undefined)
        return
      }
      if (!mounted.current || epoch !== workEpoch.current || sessionIdRef.current() !== current.session) return
      if (answer.skipped.length === 0) { setNotice(undefined); return }
      // The host refused some rows (they changed since the notice rendered) and
      // recorded no delay for them. Keep the notice for exactly those rows,
      // with their refreshed ids, so the operator can pick a delay again
      // instead of losing the candidate for this Host lifetime.
      const refused = skippedKeys(current.prompts, answer.skipped)
      const remaining = answer.prompts.filter(prompt => refused.has(prompt.key))
      setNotice(remaining.length === 0 ? undefined : { session: current.session, prompts: remaining })
    })()
  }, [client, currentSession, notice])

  const visibleNotice = notice !== undefined && notice.session === currentSession ? notice : undefined
  const dialogRows = dialogOpen && rows !== undefined && rows.length > 0
    && dialogSession.current === currentSession ? rows : undefined
  if (visibleNotice === undefined && dialogRows === undefined) return null

  const singlePrompt = dialogRows !== undefined && dialogRows.length === 1 ? dialogRows[0] : undefined
  const multi = dialogRows !== undefined && dialogRows.length > 1
  const mainCheckout = singlePrompt?.kind === 'main-checkout'
  const checked = dialogRows === undefined ? [] : dialogRows.filter(row => selected.has(row.key))
  const accessOf = (row: WorktreePromptView): WorktreeAccess => accessByKey.get(row.key) ?? 'inherit'

  return (
    <>
      {visibleNotice === undefined ? null : (
        <section
          className="mrfw-notice"
          data-placement={placement?.placement ?? 'hero'}
          data-compact={placement?.compact === true ? 'true' : undefined}
          aria-label={t('worktree.toastLabel')}
          style={placement === undefined ? { visibility: 'hidden' } : noticeStyle(placement)}
        >
          <div className="mrfw-noticeBody">
            <span className="mrfw-noticeIcon" aria-hidden="true"><IconWorkspaceTree size={16} /></span>
            <p className="mrfw-noticeText" role="status" aria-live="polite">{t('worktree.toast', { count: visibleNotice.prompts.length })}</p>
          </div>
          <div className="mrfw-noticeActions" role="group" aria-label={t('worktree.toastActions')}>
            <Button variant="primary" size="sm" className="mrfw-noticeAction" onClick={openDialog}>{t('worktree.toastView')}</Button>
            <span className="mrfw-noticeSplit">
              <Button
                variant="ghost"
                size="sm"
                className="mrfw-noticeAction mrfw-noticeSplitText"
                onClick={() => { snoozeNotice('until-new-worktree') }}
              >
                {t('worktree.toastLater')}
              </Button>
              <Menu
                open={snoozeOpen}
                anchor={(
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mrfw-noticeAction mrfw-noticeSplitToggle"
                    aria-label={t('worktree.toastLaterOptions')}
                    aria-haspopup="menu"
                    aria-expanded={snoozeOpen}
                    onClick={() => { setSnoozeOpen(value => !value) }}
                  >
                    <IconChevronDown size={12} />
                  </Button>
                )}
                items={[
                  { id: 'until-new-worktree', label: t('worktree.snooze.until-new-worktree') },
                  { id: '7d', label: t('worktree.snooze.7d') },
                  { id: '30d', label: t('worktree.snooze.30d') },
                ]}
                onSelect={id => {
                  setSnoozeOpen(false)
                  if (id === 'until-new-worktree' || id === '7d' || id === '30d') snoozeNotice(id)
                }}
                onClose={() => { setSnoozeOpen(false) }}
                side="bottom"
                align="end"
                portal
              />
            </span>
          </div>
        </section>
      )}
      {dialogRows === undefined ? null : (
        <Modal
          open
          onClose={closeDialog}
          className="mrfw-worktreeDialog"
          title={singlePrompt !== undefined
            ? t(mainCheckout ? 'worktree.mainTitle' : 'worktree.title')
            : t('worktree.listTitle', { count: dialogRows.length })}
          closeLabel={t('panel.close')}
          footer={previewOnly ? (
            <Button variant="outline" size="sm" onClick={closeDialog}>{t('worktree.previewClose')}</Button>
          ) : (
            <div className="mrfw-worktreeFooter">
              <Menu
                open={laterOpen}
                onClose={() => { setLaterOpen(false) }}
                items={(['until-new-worktree', '7d', '30d', 'permanent'] as const).map(mode => ({
                  id: mode,
                  label: t(snoozeKeyOf(mode)),
                }))}
                onSelect={id => {
                  setLaterOpen(false)
                  setLaterMode(id as DialogLaterMode)
                }}
                anchor={(
                  <Button
                    variant="outline"
                    size="sm"
                    className="mrfw-worktreeLater"
                    disabled={busy}
                    aria-label={t('worktree.snoozeLabel')}
                    aria-haspopup="menu"
                    aria-expanded={laterOpen}
                    onClick={() => { setLaterOpen(value => !value) }}
                  >
                    {t(snoozeKeyOf(laterMode))}
                    <IconChevronDown size={12} />
                  </Button>
                )}
                side="bottom"
                align="start"
                portal
              />
              <div className="mrfw-worktreeFooterEnd">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void applyLater() }}>
                  {singlePrompt !== undefined ? t('worktree.dismiss') : t('worktree.notNow')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || (singlePrompt === undefined && checked.length === 0)}
                  onClick={() => {
                    if (singlePrompt !== undefined) void confirmAdd([singlePrompt.id])
                    else void confirmAdd(checked.map(row => row.id))
                  }}
                >
                  {singlePrompt !== undefined
                    ? t('worktree.add')
                    : t('worktree.addSelected', { count: checked.length })}
                </Button>
              </div>
            </div>
          )}
        >
          <div className="mrfw-worktreeList">
            {skippedCount > 0 ? <p role="alert" className="mrfw-alert">{t('worktree.skipped', { count: skippedCount })}</p> : null}
            {dialogRows.map(row => {
              const isMain = row.kind === 'main-checkout'
              const access = accessOf(row)
              const accessOpen = accessMenuKey === row.key
              const checkedNow = selected.has(row.key)
              const text = (
                <span className="mrfw-worktreeRowText">
                  <span className="mrfw-worktreeRowNameLine">
                    <span className="mrfw-worktreeRowName" title={row.path}>{pathName(row.path)}</span>
                    <span className="mrfw-worktreeKind">{t(isMain ? 'worktree.kind.main-checkout' : 'worktree.kind.worktree')}</span>
                    {row.branch === undefined
                      ? null
                      : <span className="mrfw-worktreeBranch" title={row.branch}>{row.branch}</span>}
                  </span>
                  <code className="mrfw-rootPath">{row.path}</code>
                  {isMain ? <p className="mrfw-note">{t('worktree.mainPolicy')}</p> : null}
                  {isMain ? <p className="mrfw-note">{t('worktree.mainSeparate')}</p> : null}
                  {isMain && access !== 'read-only' ? <p className="mrfw-note">{t('worktree.mainShared')}</p> : null}
                </span>
              )
              return (
                <div key={row.key} className="mrfw-worktreeRow" data-selected={multi && checkedNow ? 'true' : undefined}>
                  {multi ? (
                    <label className="mrfw-worktreeRowMain">
                      <input
                        type="checkbox"
                        checked={checkedNow}
                        disabled={busy}
                        onChange={event => {
                          const next = event.currentTarget.checked
                          setSelected(previous => {
                            const copy = new Set(previous)
                            if (next) copy.add(row.key)
                            else copy.delete(row.key)
                            return copy
                          })
                        }} />
                      {text}
                    </label>
                  ) : (
                    <div className="mrfw-worktreeRowMain">{text}</div>
                  )}
                  <Menu
                    open={accessOpen}
                    onClose={() => { setAccessMenuKey(undefined) }}
                    items={ACCESS_CHOICES.map(choice => ({
                      id: 'access:' + choice,
                      label: t(accessKeyOf(choice)),
                      icon: <AccessIcon access={choice} />,
                      disabled: busy || choice === access,
                    }))}
                    onSelect={id => {
                      setAccessMenuKey(undefined)
                      const choice = id.slice('access:'.length) as WorktreeAccess
                      setAccessByKey(previous => {
                        const next = new Map(previous)
                        next.set(row.key, choice)
                        return next
                      })
                    }}
                    anchor={(
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mrfw-worktreeAccess"
                        disabled={busy}
                        aria-label={t('worktree.accessLabel') + ': ' + t(accessKeyOf(access))}
                        aria-haspopup="menu"
                        aria-expanded={accessOpen}
                        onClick={() => { setAccessMenuKey(current => current === row.key ? undefined : row.key) }}
                      >
                        <AccessIcon access={access} />
                        <span className="mrfw-worktreeAccessLabel">{t(accessKeyOf(access))}</span>
                        <IconChevronDown size={12} />
                      </Button>
                    )}
                    side="bottom"
                    align="end"
                    portal
                  />
                  {rowErrors.has(row.key)
                    ? <p role="alert" className="mrfw-worktreeRowError">{t('worktree.rowError')}: {t(errorKeyOf(rowErrors.get(row.key)!))}</p>
                    : null}
                </div>
              )
            })}
            {previewOnly ? <p className="mrfw-note">{t('worktree.previewOnly')}</p> : null}
            {error === undefined ? null : <p role="alert" className="mrfw-alert">{t(errorKeyOf(error))}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
