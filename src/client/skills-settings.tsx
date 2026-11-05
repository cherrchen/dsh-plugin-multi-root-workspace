import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconWarningOutlineRegular, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { bindSkillsForm, clientInject, type SkillsForm } from '../compat/skills-client.ts'
import { installAutoReviewSettings, type AutoReviewForm } from '../compat/auto-review-client.ts'
import { AutoReviewSettingsCard } from './auto-review-settings.tsx'
import type { Translate } from './WorkspaceFoldersAction.tsx'
const BUNDLE_KEY = '@dsh-electron/dsh-plugin-multi-root-workspace'
interface CardProps { form: SkillsForm; t: Translate }
export function SkillsSettingsCard({ form, t }: CardProps) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const toastSeq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])
  return <div className="mrfw-skillsSettings">
    <div className="mrfw-skillsSettingsText">
      <div className="mrfw-skillsSettingsTitle">{t('skills.globalEnable')}</div>
      <div className="mrfw-skillsSettingsDescription">{t('skills.globalHint')}</div>
    </div>
    <Switch label={t('skills.globalEnable')} checked={snapshot.value?.enabled ?? true} disabled={busy || snapshot.status !== 'ready' || !snapshot.writable}
        onChange={enabled => {
          setBusy(true)
          void form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], snapshot.revision)
            .then(ok => { if (mounted.current && !ok) showToast(t('skills.settingsFailed')) })
            .catch(() => { if (mounted.current) showToast(t('skills.settingsFailed')) })
            .finally(() => { if (mounted.current) setBusy(false) })
        }} />
    {toast === null ? null : (
      <Toast
        key={toast.seq}
        text={toast.text}
        icon={<IconWarningOutlineRegular />}
        holdMs={8000}
        onDone={() => { setToast(null) }}
      />
    )}
  </div>
}
/**
 * The bundle's one `plugins.bundle.config` cell: every plugin-level switch the
 * package offers, in display order. Each row owns its own form and write path —
 * Skills through its settings namespace, Auto Review through the Plugin
 * Manager's Loader-row enablement — so one cell never serializes their state.
 */
export function BundleSettingsCard({ form, autoReviewForm, t }: { form?: SkillsForm | undefined; autoReviewForm?: AutoReviewForm | undefined; t: Translate }) {
  return <>
    {form !== undefined ? <SkillsSettingsCard form={form} t={t} /> : null}
    {autoReviewForm !== undefined ? <AutoReviewSettingsCard form={autoReviewForm} t={t} /> : null}
  </>
}
export function installSkillsSettingsCard(ctx: Context, t: Translate): void {
  // One coordinator prevents duplicate cards if a host temporarily exposes both shapes.
  let currentSkills: SkillsForm | undefined
  let currentAutoReview = false
  let stop: (() => void) | undefined
  const candidates = new Map<Context, SkillsForm>()
  const update = () => {
    const chosen = [...candidates.entries()].sort(([a], [b]) => Number(b.get('configForms' as never) !== undefined) - Number(a.get('configForms' as never) !== undefined))[0]
    const skillsForm = chosen?.[1]
    // Mirror the row's own render rule: hidden while unavailable or once the
    // composition answers without the optional entry, so the cell never
    // registers an empty card.
    const autoSnapshot = autoForm.getSnapshot()
    const autoAvailable = autoSnapshot.status === 'loading' || autoSnapshot.status === 'error'
      || (autoSnapshot.status === 'ready' && autoSnapshot.row !== undefined)
    if (skillsForm === undefined && !autoAvailable) {
      if (currentSkills !== undefined || currentAutoReview) { stop?.(); stop = undefined; currentSkills = undefined; currentAutoReview = false }
      return
    }
    if (currentSkills === skillsForm && currentAutoReview === autoAvailable) return
    const slots = (ctx as unknown as { slots?: { inject(name: string, callback: () => unknown): () => void; register(options: object, component: unknown): () => void } }).slots
    // Leave `current*` untouched so a later publish retries once slots exists.
    if (slots === undefined) return
    stop?.(); stop = undefined
    currentSkills = skillsForm; currentAutoReview = autoAvailable
    const disposers = [slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY, inject: () => ({ form: skillsForm, autoReviewForm: autoForm, t }) }, BundleSettingsCard))]
    if (skillsForm !== undefined) disposers.push(slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item', key: 'multi-root-skills', inject: () => ({ form: skillsForm, t }) }, SkillsSettingsCard)))
    stop = () => { for (const dispose of disposers) dispose() }
  }
  // `autoForm` is created up front and publishes on every attach/detach/read,
  // so one subscription keeps `autoAvailable` — and therefore the cell's
  // registration — in step with the live snapshot.
  const autoForm = installAutoReviewSettings(ctx)
  const stopAutoWatch = autoForm.subscribe(update)
  // A synchronous attach inside install publishes before the subscription
  // exists; one explicit pass picks up whatever state it left behind.
  update()
  for (const service of ['settingsScope', 'configForms']) clientInject(ctx, [service], scope => {
    const form = bindSkillsForm(scope)
    if (form === undefined) return
    candidates.set(scope, form); update()
    return () => { candidates.delete(scope); update() }
  })
  ctx.effect(() => () => { stop?.(); stopAutoWatch(); candidates.clear() })
}
