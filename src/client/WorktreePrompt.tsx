/**
 * The worktree suggestion overlay.
 *
 * Mounted once on the shell's overlay slot. It long-polls `worktreePromptWait`
 * for the current session and renders the server's view: a single confirmation
 * when exactly one candidate is visible, or a checkbox list when several are.
 * The server decides what is visible; this component never invents an eligible
 * candidate, and it never sends a path.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/WorktreePrompt
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorktreePromptView } from '../contract.ts'
import { errorKeyOf, PanelError } from './panel-client.ts'
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
  /**
   * The live worktree-settings subscription. Turning the switch back on must
   * remount the wait loop of THIS session; without it the overlay that stopped
   * on `worktree/not-enabled` would stay silent until the page remounts.
   */
  readonly readEnabled?: (() => boolean) | undefined
  readonly subscribeEnabled?: ((listener: () => void) => () => void) | undefined
}

/** One rendered view: the single confirmation or the multi-candidate list. */
type PromptView =
  | { readonly mode: 'single'; readonly prompt: WorktreePromptView }
  | { readonly mode: 'list'; readonly prompts: readonly WorktreePromptView[] }

/** Resolve after a delay, or early when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
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

/**
 * The prompt overlay.
 * @param props - the composed slot props.
 * @returns the dialog, or nothing while no prompt is visible.
 */
export function WorktreePrompt(props: WorktreePromptProps): ReactNode {
  const { client, sessionId, subscribeSession, t, previewOnly } = props
  const { readEnabled, subscribeEnabled } = props
  const [currentSession, setCurrentSession] = useState<string | undefined>(() => sessionId())
  const [view, setView] = useState<PromptView | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [skippedCount, setSkippedCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [dontRemind, setDontRemind] = useState(false)
  const [tick, setTick] = useState(0)
  const mounted = useRef(true)
  /**
   * The view revision whose contents are already in `view`. The long poll can
   * win a race against the resolve response and deliver the SAME revision; it
   * must not overwrite the post-resolve selection/errors.
   */
  const appliedRevision = useRef<string | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The session share changes independently of this component; the loop must
  // follow the live session, never a value captured at mount time.
  useEffect(() => {
    const update = () => setCurrentSession(sessionId())
    update()
    return subscribeSession(update)
  }, [sessionId, subscribeSession])

  // Two explicit signals can restart a wait loop that stopped on
  // `worktree/not-enabled` (the switch was turned back on) or on `lost` (an
  // explicit panel list re-activated the workspace on the host).
  useEffect(() => {
    if (client?.subscribe === undefined) return
    return client.subscribe(session => {
      if (session === currentSession) {
        appliedRevision.current = undefined
        setTick(value => value + 1)
      }
    })
  }, [client, currentSession])
  useEffect(() => {
    if (subscribeEnabled === undefined) return
    return subscribeEnabled(() => {
      appliedRevision.current = undefined
      setTick(value => value + 1)
    })
  }, [subscribeEnabled])

  useEffect(() => {
    if (client === undefined || currentSession === undefined || currentSession === '' || readEnabled?.() === false) {
      setView(undefined)
      return
    }
    let cancelled = false
    let controller: AbortController | undefined
    let seen: { seenViewRevision?: string } = {}
    let transientFailures = 0
    const run = async (): Promise<void> => {
      while (!cancelled) {
        controller = new AbortController()
        let result
        try {
          result = await client.wait(currentSession, seen, controller.signal)
          transientFailures = 0
        } catch (failure: unknown) {
          if (cancelled) return
          if (failure instanceof PanelError && failure.code === 'worktree/not-enabled') {
            setView(undefined)
            return
          }
          // `session-not-found` and `not-available` are often transient during
          // session creation/reconnect. Retry with a bounded backoff instead of
          // going silent until the operator opens the panel.
          if (failure instanceof PanelError
            && (failure.code === 'worktree/session-not-found' || failure.code === 'worktree/not-available')) {
            transientFailures += 1
            if (transientFailures > 15) {
              setView(undefined)
              return
            }
          } else {
            transientFailures = 0
          }
          const backoff = new AbortController()
          const stop = () => backoff.abort()
          controller.signal.addEventListener('abort', stop, { once: true })
          await delay(2000, backoff.signal)
          controller.signal.removeEventListener('abort', stop)
          continue
        }
        if (cancelled) return
        // A wait that raced the resolve may report the revision the resolve
        // already applied; keep that post-resolve state intact.
        if ((result.status === 'prompt' || result.status === 'prompts' || result.status === 'stale')
          && appliedRevision.current !== undefined && result.viewRevision === appliedRevision.current) {
          seen = { seenViewRevision: result.viewRevision }
          continue
        }
        switch (result.status) {
          case 'prompt':
            setView({ mode: 'single', prompt: result.prompt })
            setRowErrors(new Map())
            setSkippedCount(0)
            appliedRevision.current = result.viewRevision
            seen = { seenViewRevision: result.viewRevision }
            break
          case 'prompts':
            setView({ mode: 'list', prompts: result.prompts })
            setSelected(previous => reconcileSelection(previous, result.prompts, new Map()))
            setRowErrors(new Map())
            setSkippedCount(0)
            appliedRevision.current = result.viewRevision
            seen = { seenViewRevision: result.viewRevision }
            break
          case 'timeout':
            seen = { seenViewRevision: result.viewRevision }
            break
          case 'stale':
            setView(undefined)
            setRowErrors(new Map())
            setSkippedCount(0)
            appliedRevision.current = result.viewRevision
            seen = { seenViewRevision: result.viewRevision }
            break
          case 'unactivated':
          case 'lost':
            setView(undefined)
            return
        }
      }
    }
    void run()
    return () => { cancelled = true; controller?.abort() }
  }, [client, currentSession, readEnabled, tick])

  const resolve = useCallback(async (action: 'add' | 'dismiss', ids: readonly string[]) => {
    if (client === undefined || currentSession === undefined || view === undefined || ids.length === 0) return
    const rows = view.mode === 'single' ? [view.prompt] : view.prompts
    setBusy(true)
    setError(undefined)
    try {
      const answer = await client.resolve(currentSession, ids, action, action === 'dismiss' ? dontRemind : undefined)
      if (!mounted.current) return
      appliedRevision.current = answer.viewRevision
      const errors = rowErrorMap(rows, answer.skipped)
      setRowErrors(errors)
      setSkippedCount(answer.skipped.length)
      setDontRemind(false)
      if (answer.prompts.length === 0) {
        setView(undefined)
        setSelected(new Set())
      } else if (answer.prompts.length === 1) {
        setView({ mode: 'single', prompt: answer.prompts[0]! })
        setSelected(new Set())
      } else {
        setView({ mode: 'list', prompts: answer.prompts })
        setSelected(previous => reconcileSelection(previous, answer.prompts, errors))
      }
    } catch (failure: unknown) {
      if (!mounted.current) return
      if (failure instanceof PanelError && failure.code === 'worktree/prompt-stale') {
        // The candidate changed; let the wait deliver the current view again.
        setView(undefined)
        setRowErrors(new Map())
        setSelected(new Set())
        setTick(value => value + 1)
      } else {
        setError(failure instanceof PanelError ? failure.code : 'fallback')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [client, currentSession, view, dontRemind])

  if (view === undefined) return null
  const singlePrompt = view.mode === 'single' ? view.prompt : undefined
  const listRows = view.mode === 'list' ? view.prompts : []
  const effective = effectiveLabel((singlePrompt ?? listRows[0])?.effectiveAccess ?? 'unavailable', t)
  const mainCheckout = singlePrompt?.kind === 'main-checkout'
  const rows = singlePrompt === undefined ? listRows : [singlePrompt]
  const checked = rows.filter(row => selected.has(row.key))
  const close = () => {
    setView(undefined)
    setRowErrors(new Map())
    setSkippedCount(0)
    setError(undefined)
    setDontRemind(false)
  }

  return (
    <Modal
      open
      onClose={close}
      title={singlePrompt !== undefined
        ? t(mainCheckout ? 'worktree.mainTitle' : 'worktree.title')
        : t('worktree.listTitle', { count: rows.length })}
      description={singlePrompt !== undefined
        ? t(mainCheckout ? 'worktree.mainDescription' : 'worktree.description', {
            path: singlePrompt.path,
            effective,
            remaining: singlePrompt.remaining,
          })
        : t('worktree.listDescription', { effective })}
      closeLabel={t('panel.close')}
      footer={(
        <>
          {previewOnly ? (
            <button type="button" className="mrfw-btn mrfw-btnOutline" onClick={close}>{t('worktree.previewClose')}</button>
          ) : singlePrompt !== undefined ? (
            <>
              <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => { void resolve('dismiss', [singlePrompt.id]) }}>{t('worktree.dismiss')}</button>
              <button type="button" className="mrfw-btn mrfw-btnPrimary" disabled={busy} onClick={() => { void resolve('add', [singlePrompt.id]) }}>{t('worktree.add')}</button>
            </>
          ) : (
            <>
              <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => { void resolve('dismiss', rows.map(row => row.id)) }}>{t('worktree.notNow')}</button>
              <button type="button" className="mrfw-btn mrfw-btnPrimary" disabled={busy || checked.length === 0} onClick={() => { void resolve('add', checked.map(row => row.id)) }}>{t('worktree.addSelected', { count: checked.length })}</button>
            </>
          )}
        </>
      )}
    >
      {singlePrompt !== undefined ? (
        <div className="mrfw-worktreePrompt">
          <code className="mrfw-rootPath">{singlePrompt.path}</code>
          <p className="mrfw-note">{t(mainCheckout ? 'worktree.mainPolicy' : 'worktree.policy')}</p>
          <p className="mrfw-note">{t(mainCheckout ? 'worktree.mainShared' : 'worktree.shared')}</p>
          {mainCheckout ? <p className="mrfw-note">{t('worktree.mainSeparate')}</p> : null}
          {rowErrors.has(singlePrompt.key)
            ? <p role="alert" className="mrfw-alert">{t('worktree.rowError')}: {t(errorKeyOf(rowErrors.get(singlePrompt.key)!))}</p>
            : null}
          {previewOnly ? <p className="mrfw-note">{t('worktree.previewOnly')}</p> : null}
          {previewOnly || error !== undefined ? null : (
            <label className="mrfw-note">
              <input type="checkbox" checked={dontRemind} disabled={busy} onChange={event => { setDontRemind(event.currentTarget.checked) }} />
              {t('worktree.dontRemind')}
            </label>
          )}
          {error === undefined ? null : <p role="alert" className="mrfw-alert">{t(errorKeyOf(error))}</p>}
        </div>
      ) : (
        <div className="mrfw-worktreeList">
          {skippedCount > 0 ? <p role="alert" className="mrfw-alert">{t('worktree.skipped', { count: skippedCount })}</p> : null}
          {rows.map(row => {
            const isMain = row.kind === 'main-checkout'
            return (
              <div key={row.key} className="mrfw-worktreeRow">
                <label className="mrfw-worktreeRowHead">
                  <input
                    type="checkbox"
                    checked={selected.has(row.key)}
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
                  <span className="mrfw-worktreeKind">{t(isMain ? 'worktree.kind.main-checkout' : 'worktree.kind.worktree')}</span>
                  <code className="mrfw-rootPath">{row.path}</code>
                </label>
                {isMain ? <p className="mrfw-note">{t('worktree.mainPolicy')}</p> : null}
                {isMain ? <p className="mrfw-note">{t('worktree.mainSeparate')}</p> : null}
                {rowErrors.has(row.key) ? <p role="alert" className="mrfw-alert">{t('worktree.rowError')}: {t(errorKeyOf(rowErrors.get(row.key)!))}</p> : null}
              </div>
            )
          })}
          {previewOnly ? <p className="mrfw-note">{t('worktree.previewOnly')}</p> : null}
          {previewOnly ? null : (
            <label className="mrfw-note">
              <input type="checkbox" checked={dontRemind} disabled={busy} onChange={event => { setDontRemind(event.currentTarget.checked) }} />
              {t('worktree.dontRemindShown')}
            </label>
          )}
          {error === undefined ? null : <p role="alert" className="mrfw-alert">{t(errorKeyOf(error))}</p>}
        </div>
      )}
    </Modal>
  )
}

/** Localize one effective-access value. */
function effectiveLabel(access: WorktreePromptView['effectiveAccess'], t: Translate): string {
  return access === 'read-only' ? t('effective.read-only')
    : access === 'read-write' ? t('effective.read-write')
      : access === 'full-access' ? t('effective.full-access')
        : t('effective.unavailable')
}
