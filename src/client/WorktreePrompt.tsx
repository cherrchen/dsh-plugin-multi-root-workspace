/**
 * The worktree suggestion overlay.
 *
 * Mounted once on the shell's overlay slot. It long-polls `worktreePromptWait`
 * for the current session and renders exactly one prompt at a time: the
 * confirmation the ADR requires before ANY root is registered. The server
 * decides what is visible; this component never invents an eligible candidate.
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
}

/** Resolve after a delay, or early when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/**
 * The prompt overlay.
 * @param props - the composed slot props.
 * @returns the dialog, or nothing while no prompt is visible.
 */
export function WorktreePrompt(props: WorktreePromptProps): ReactNode {
  const { client, sessionId, subscribeSession, t, previewOnly } = props
  const [currentSession, setCurrentSession] = useState<string | undefined>(() => sessionId())
  const [prompt, setPrompt] = useState<WorktreePromptView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [dontRemind, setDontRemind] = useState(false)
  const [tick, setTick] = useState(0)
  const mounted = useRef(true)

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

  useEffect(() => {
    if (client === undefined || currentSession === undefined || currentSession === '') {
      setPrompt(undefined)
      return
    }
    let cancelled = false
    let controller: AbortController | undefined
    let seen: { seenPromptId?: string; seenViewRevision?: string } = {}
    const run = async (): Promise<void> => {
      while (!cancelled) {
        controller = new AbortController()
        let result
        try {
          result = await client.wait(currentSession, seen, controller.signal)
        } catch (failure: unknown) {
          if (cancelled) return
          if (failure instanceof PanelError && (failure.code === 'worktree/not-enabled'
            || failure.code === 'worktree/not-available' || failure.code === 'worktree/session-not-found')) {
            setPrompt(undefined)
            return
          }
          const backoff = new AbortController()
          const stop = () => backoff.abort()
          controller.signal.addEventListener('abort', stop, { once: true })
          await delay(2000, backoff.signal)
          controller.signal.removeEventListener('abort', stop)
          continue
        }
        if (cancelled) return
        switch (result.status) {
          case 'prompt':
            setPrompt(result.prompt)
            setError(undefined)
            seen = { seenPromptId: result.prompt.id, seenViewRevision: result.viewRevision }
            break
          case 'timeout':
            seen = { ...(seen.seenPromptId === undefined ? {} : { seenPromptId: seen.seenPromptId }), seenViewRevision: result.viewRevision }
            break
          case 'stale':
            setPrompt(undefined)
            seen = {}
            break
          case 'unactivated':
          case 'lost':
            setPrompt(undefined)
            return
        }
      }
    }
    void run()
    return () => { cancelled = true; controller?.abort() }
  }, [client, currentSession, tick])

  const resolve = useCallback(async (action: 'add' | 'dismiss') => {
    if (client === undefined || currentSession === undefined || prompt === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await client.resolve(currentSession, prompt.id, action, action === 'dismiss' ? dontRemind : undefined)
      if (!mounted.current) return
      setPrompt(undefined)
      setDontRemind(false)
      setTick(value => value + 1)
    } catch (failure: unknown) {
      if (!mounted.current) return
      if (failure instanceof PanelError && failure.code === 'worktree/prompt-stale') {
        setPrompt(undefined)
        setTick(value => value + 1)
      } else {
        setError(failure instanceof PanelError ? failure.code : 'fallback')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [client, currentSession, prompt, dontRemind])

  if (prompt === undefined) return null
  const common = prompt.kind === 'git-common'
  const effective = prompt.effectiveAccess === 'read-only' ? t('effective.read-only')
    : prompt.effectiveAccess === 'read-write' ? t('effective.read-write')
      : prompt.effectiveAccess === 'full-access' ? t('effective.full-access')
        : t('effective.unavailable')
  return (
    <Modal
      open
      onClose={() => { setPrompt(undefined) }}
      title={t(common ? 'worktree.commonTitle' : 'worktree.title')}
      description={t(common ? 'worktree.commonDescription' : 'worktree.description', {
        path: prompt.path,
        effective,
        remaining: prompt.remaining,
      })}
      closeLabel={t('panel.close')}
      footer={(
        <>
          {previewOnly ? (
            <button type="button" className="mrfw-btn mrfw-btnOutline" onClick={() => { setPrompt(undefined) }}>{t('worktree.previewClose')}</button>
          ) : (
            <>
              <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => { void resolve('dismiss') }}>{t('worktree.dismiss')}</button>
              <button type="button" className="mrfw-btn mrfw-btnPrimary" disabled={busy} onClick={() => { void resolve('add') }}>{t('worktree.add')}</button>
            </>
          )}
        </>
      )}
    >
      <div className="mrfw-worktreePrompt">
        <code className="mrfw-rootPath">{prompt.path}</code>
        <p className="mrfw-note">{t(common ? 'worktree.commonPolicy' : 'worktree.policy')}</p>
        <p className="mrfw-note">{t(common ? 'worktree.commonShared' : 'worktree.shared')}</p>
        {previewOnly ? <p className="mrfw-note">{t('worktree.previewOnly')}</p> : null}
        {previewOnly || error !== undefined ? null : (
          <label className="mrfw-note">
            <input type="checkbox" checked={dontRemind} disabled={busy} onChange={event => { setDontRemind(event.currentTarget.checked) }} />
            {t('worktree.dontRemind')}
          </label>
        )}
        {error === undefined ? null : <p role="alert" className="mrfw-alert">{t(errorKeyOf(error))}</p>}
      </div>
    </Modal>
  )
}
