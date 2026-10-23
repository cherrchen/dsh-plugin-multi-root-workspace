import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSkillsForm, clientInject, type SkillsForm } from '../compat/skills-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
const BUNDLE_KEY = '@dsh-electron/dsh-plugin-multi-root-workspace'
interface CardProps { form: SkillsForm; t: Translate }
export function SkillsSettingsCard({ form, t }: CardProps) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return <div className="mrfw-skillsSettings">
    <label className="mrfw-skillsToggle">
      <input type="checkbox" checked={snapshot.value?.enabled ?? true} disabled={busy || snapshot.status !== 'ready' || !snapshot.writable}
        onChange={event => {
          const enabled = event.target.checked; setBusy(true); setError(undefined)
          void form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], snapshot.revision).then(ok => { if (mounted.current && !ok) setError(t('skills.settingsFailed')) }).catch(() => { if (mounted.current) setError(t('skills.settingsFailed')) }).finally(() => { if (mounted.current) setBusy(false) })
        }} />
      {t('skills.globalEnable')}
    </label>
    <p>{t('skills.globalHint')}</p>
    {error ? <p role="alert">{error}</p> : null}
  </div>
}
export function installSkillsSettingsCard(ctx: Context, t: Translate): void {
  // One coordinator prevents duplicate cards if a host temporarily exposes both shapes.
  let current: object | undefined
  let stop: (() => void) | undefined
  const candidates = new Map<Context, SkillsForm>()
  const update = () => {
    const chosen = [...candidates.entries()].sort(([a], [b]) => Number(b.get('configForms' as never) !== undefined) - Number(a.get('configForms' as never) !== undefined))[0]
    if (chosen?.[1] === current) return
    stop?.(); stop = undefined; current = chosen?.[1]
    if (!chosen) return
    const [scope, form] = chosen
    const slots = scope.slots as unknown as { inject(name: string, callback: () => unknown): () => void; register(options: object, component: unknown): () => void }
    const disposers = [
      slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item', key: 'multi-root-skills', inject: () => ({ form, t }) }, SkillsSettingsCard)),
      slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY, inject: () => ({ form, t }) }, SkillsSettingsCard)),
    ]
    stop = () => { for (const dispose of disposers) dispose() }
  }
  for (const service of ['settingsScope', 'configForms']) clientInject(ctx, [service], scope => {
    const form = bindSkillsForm(scope)
    if (form === undefined) return
    candidates.set(scope, form); update()
    return () => { candidates.delete(scope); update() }
  })
  ctx.effect(() => () => { stop?.(); candidates.clear() })
}
