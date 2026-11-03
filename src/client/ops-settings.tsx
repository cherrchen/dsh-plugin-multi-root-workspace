import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillsForm } from '../compat/skills-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
export function OpsCompatibilitySettingsCard({ form, t }: { form: SkillsForm; t: Translate }) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return <div className="mrfw-skillsSettings">
    <div className="mrfw-skillsSettingsText">
      <div className="mrfw-skillsSettingsTitle">{t('ops.compatibilityEnable')}</div>
      <div className="mrfw-skillsSettingsDescription">{t('ops.compatibilityHint')}</div>
      {error ? <div role="alert">{error}</div> : null}
    </div>
    <Switch label={t('ops.compatibilityEnable')} checked={snapshot.value?.enabled === true} disabled={busy || snapshot.status !== 'ready' || !snapshot.writable}
        onChange={enabled => {
          setBusy(true); setError(undefined)
          void form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], snapshot.revision).then(ok => { if (mounted.current && !ok) setError(t('ops.settingsFailed')) }).catch(() => { if (mounted.current) setError(t('ops.settingsFailed')) }).finally(() => { if (mounted.current) setBusy(false) })
        }} />
  </div>
}
