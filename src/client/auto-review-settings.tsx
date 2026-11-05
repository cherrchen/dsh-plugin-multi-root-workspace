import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconWarningOutlineRegular, Switch, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutoReviewForm } from '../compat/auto-review-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/**
 * Full-opacity hold for the card's message toasts — the same window upstream
 * gives a refusal banner, since these strings name what broke rather than
 * reporting a one-line limit.
 */
const TOAST_HOLD_MS = 8000

type ToastKind = 'load' | 'diagnostic' | 'write'

/**
 * The optional Auto Review row of the plugin settings card.
 *
 * Its switch is the Loader row's own enablement — the same write the Plugin
 * Manager's row switch performs — so the card can never disagree with the row
 * list about whether the companion is on. Feedback is a transient `Toast`
 * banner, never inline text: state-driven messages (a failed read, an entry
 * diagnostic) fire on entry and clear when their source resolves, while write
 * outcomes report once and fade. The row stays hidden entirely on hosts
 * without the `pluginManager` namespace or when the composition does not list
 * the optional entry.
 */
export function AutoReviewSettingsCard({ form, t }: { form: AutoReviewForm; t: Translate }) {
  const snapshot = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const toastSeq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; kind: ToastKind; text: string } | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const showToast = useCallback((kind: ToastKind, text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, kind, text })
  }, [])
  const dismissToast = useCallback((kind: ToastKind) => {
    setToast(current => current?.kind === kind ? null : current)
  }, [])

  const status = snapshot.status
  const diagnostic = status === 'ready' ? snapshot.row?.diagnostic : undefined
  useEffect(() => {
    if (status === 'error') showToast('load', t('autoReview.loadFailed'))
    else dismissToast('load')
  }, [status, t, showToast, dismissToast])
  useEffect(() => {
    if (diagnostic !== undefined && diagnostic !== '') showToast('diagnostic', diagnostic)
    else dismissToast('diagnostic')
  }, [diagnostic, showToast, dismissToast])

  if (status === 'unavailable') return null
  const row = status === 'ready' ? snapshot.row : undefined
  if (status === 'ready' && row === undefined) return null
  return (
    <div className="mrfw-skillsSettings">
      <div className="mrfw-skillsSettingsText">
        <div className="mrfw-settingsTitleRow">
          <span className="mrfw-skillsSettingsTitle">{t('autoReview.title')}</span>
          <Tag tone="info">{t('autoReview.experimental')}</Tag>
        </div>
        <div className="mrfw-skillsSettingsDescription">{t('autoReview.hint')}</div>
      </div>
      <Switch
        label={t('autoReview.title')}
        checked={row?.enabled ?? false}
        disabled={busy || row?.writable !== true}
        onChange={enabled => {
          setBusy(true)
          void form.setEnabled(enabled)
            .then(result => {
              if (!mounted.current) return
              if (result === 'restart-required') showToast('write', t('autoReview.restartRequired'))
              else if (result === 'failed') showToast('write', t('autoReview.settingsFailed'))
            })
            .catch(() => {
              if (mounted.current) showToast('write', t('autoReview.settingsFailed'))
            })
            .finally(() => {
              if (mounted.current) setBusy(false)
            })
        }}
      />
      {toast === null ? null : (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          holdMs={TOAST_HOLD_MS}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
