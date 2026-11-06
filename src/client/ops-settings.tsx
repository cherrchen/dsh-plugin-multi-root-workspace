import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillsForm } from '../compat/skills-client.ts'
import { opsRiskConfirmation } from '../compat/ops-confirmation.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
export function OpsCompatibilitySettingsCard({ form, t }: { form: SkillsForm; t: Translate }) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [confirmation, setConfirmation] = useState<{ form: SkillsForm; revision: number | undefined }>()
  const [acknowledged, setAcknowledged] = useState(false)
  const saving = useRef(false)
  const mounted = useRef(true)
  const RiskConfirmation = opsRiskConfirmation()
  const canConfirm = confirmation !== undefined && confirmation.form === form
    && confirmation.revision === snapshot.revision && snapshot.status === 'ready'
    && snapshot.writable && snapshot.value?.enabled !== true && RiskConfirmation !== undefined
  const dismiss = () => { setConfirmation(undefined); setAcknowledged(false) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (confirmation !== undefined && !canConfirm) {
      setConfirmation(undefined); setAcknowledged(false)
    }
  }, [confirmation, canConfirm])
  const save = async (enabled: boolean, revision: number | undefined) => {
    if (saving.current) return
    saving.current = true
    setBusy(true); setError(undefined)
    try {
      const ok = await form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], revision)
      if (mounted.current && !ok) setError(t('ops.settingsFailed'))
    } catch {
      if (mounted.current) setError(t('ops.settingsFailed'))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }
  if (snapshot.status === 'unavailable') return null
  return <div className="mrfw-skillsSettings">
    <div className="mrfw-skillsSettingsText">
      <div className="mrfw-settingsTitleRow">
        <span className="mrfw-skillsSettingsTitle">{t('ops.compatibilityEnable')}</span>
        <Tag tone="info">{t('ops.experimental')}</Tag>
      </div>
      <div className="mrfw-skillsSettingsDescription">{t('ops.compatibilityHint')}</div>
      {error ? <div role="alert">{error}</div> : null}
    </div>
    <Switch label={t('ops.compatibilityEnable')} checked={snapshot.value?.enabled === true} disabled={busy || confirmation !== undefined || snapshot.status !== 'ready' || !snapshot.writable || (snapshot.value?.enabled !== true && RiskConfirmation === undefined)}
        onChange={enabled => {
          if (!enabled) { void save(false, snapshot.revision); return }
          setError(undefined); setAcknowledged(false)
          setConfirmation({ form, revision: snapshot.revision })
        }} />
    {RiskConfirmation === undefined ? null : <RiskConfirmation
      open={canConfirm}
      title={t('ops.confirmTitle')}
      description={t('ops.confirmDescription')}
      acknowledgeLabel={t('ops.confirmAcknowledge')}
      cancelLabel={t('ops.confirmCancel')}
      closeLabel={t('ops.confirmClose')}
      confirmLabel={t('ops.confirmEnable')}
      acknowledged={acknowledged}
      disabled={busy || !canConfirm}
      onAcknowledgedChange={setAcknowledged}
      onCancel={dismiss}
      onConfirm={() => {
        if (!canConfirm || !acknowledged || saving.current) return
        const revision = confirmation.revision
        dismiss()
        void save(true, revision)
      }}
    />}
  </div>
}
