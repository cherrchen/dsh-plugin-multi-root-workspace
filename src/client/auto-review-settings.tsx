import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutoReviewForm } from '../compat/auto-review-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/**
 * The optional Auto Review row of the plugin settings card.
 *
 * Its switch is the Loader row's own enablement — the same write the Plugin
 * Manager's row switch performs — so the card can never disagree with the row
 * list about whether the companion is on. The feature is experimental and the
 * row stays hidden entirely on hosts without the `pluginManager` namespace or
 * when the composition does not list the optional entry.
 */
export function AutoReviewSettingsCard({ form, t }: { form: AutoReviewForm; t: Translate }) {
  const snapshot = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  if (snapshot.status === 'unavailable') return null
  const row = snapshot.status === 'ready' ? snapshot.row : undefined
  if (snapshot.status === 'ready' && row === undefined) return null
  return (
    <div className="mrfw-skillsSettings">
      <div className="mrfw-skillsSettingsText">
        <div className="mrfw-settingsTitleRow">
          <span className="mrfw-skillsSettingsTitle">{t('autoReview.title')}</span>
          <Tag tone="info">{t('autoReview.experimental')}</Tag>
        </div>
        <div className="mrfw-skillsSettingsDescription">{t('autoReview.hint')}</div>
        {row?.diagnostic === undefined ? null : <div role="alert">{row.diagnostic}</div>}
        {snapshot.status === 'error' ? <div role="alert">{t('autoReview.loadFailed')}</div> : null}
        {error === undefined ? null : <div role="alert">{error}</div>}
        {notice === undefined ? null : <div className="mrfw-stateWarn">{notice}</div>}
      </div>
      <Switch
        label={t('autoReview.title')}
        checked={row?.enabled ?? false}
        disabled={busy || row?.writable !== true}
        onChange={enabled => {
          setBusy(true)
          setError(undefined)
          setNotice(undefined)
          void form.setEnabled(enabled)
            .then(result => {
              if (!mounted.current) return
              if (result === 'restart-required') setNotice(t('autoReview.restartRequired'))
              else if (result === 'failed') setError(t('autoReview.settingsFailed'))
            })
            .catch(() => {
              if (mounted.current) setError(t('autoReview.settingsFailed'))
            })
            .finally(() => {
              if (mounted.current) setBusy(false)
            })
        }}
      />
    </div>
  )
}
