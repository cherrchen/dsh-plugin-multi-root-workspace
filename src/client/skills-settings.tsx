import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconWarningOutlineRegular, Switch, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { bindSettingsForm, bindSkillsForm, clientInject, type SkillsForm } from '../compat/skills-client.ts'
import { installAutoReviewSettings, type AutoReviewForm } from '../compat/auto-review-client.ts'
import { AutoReviewSettingsCard } from './auto-review-settings.tsx'
import { OpsCompatibilitySettingsCard } from './ops-settings.tsx'
import type { Key } from './locales.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
const BUNDLE_KEY = '@dsh-electron/dsh-plugin-multi-root-workspace'

/** One live boolean settings row; the Skills and worktree switches share it. */
function SettingSwitchRow({ form, title, hint, failureText, t, tag, defaultChecked = true }: {
  form: SkillsForm
  title: string
  hint: string
  failureText: Key
  t: Translate
  /** Optional label rendered beside the title (the experimental tag). */
  tag?: ReactNode
  /** The value shown before the form publishes one; the worktree row is off. */
  defaultChecked?: boolean
}) {
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
      {tag === undefined
        ? <div className="mrfw-skillsSettingsTitle">{title}</div>
        : (
            <div className="mrfw-settingsTitleRow">
              <span className="mrfw-skillsSettingsTitle">{title}</span>
              {tag}
            </div>
          )}
      <div className="mrfw-skillsSettingsDescription">{hint}</div>
    </div>
    <Switch label={title} checked={snapshot.value?.enabled ?? defaultChecked} disabled={busy || snapshot.status !== 'ready' || !snapshot.writable}
      onChange={enabled => {
        setBusy(true)
        void form.mutate([{ op: 'set', path: ['enabled'], value: enabled }], snapshot.revision)
          .then(ok => { if (mounted.current && !ok) showToast(t(failureText)) })
          .catch(() => { if (mounted.current) showToast(t(failureText)) })
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
 * The worktree switch: experimental, off by default, and therefore the only
 * row that carries a tag and a non-true fallback. Written once so the modern
 * bundle card and the legacy per-namespace card can never disagree.
 */
function WorktreeSwitchRow({ form, t }: { form: SkillsForm; t: Translate }) {
  return <SettingSwitchRow
    form={form}
    title={t('worktree.globalEnable')}
    hint={t('worktree.globalHint')}
    failureText="worktree.settingsFailed"
    t={t}
    defaultChecked={false}
    tag={<Tag tone="info">{t('worktree.experimental')}</Tag>} />
}

interface SkillsCardProps { form: SkillsForm; worktreeForm?: SkillsForm | undefined; t: Translate }

/** The plugin-detail card: root Skills and worktree suggestions, one cell. */
export function SkillsSettingsCard({ form, worktreeForm, t }: SkillsCardProps) {
  return <>
    <SettingSwitchRow form={form} title={t('skills.globalEnable')} hint={t('skills.globalHint')} failureText="skills.settingsFailed" t={t} />
    {worktreeForm === undefined ? null : <WorktreeSwitchRow form={worktreeForm} t={t} />}
  </>
}

/**
 * The bundle's one `plugins.bundle.config` cell: every plugin-level switch the
 * package offers, in display order. Each row owns its own form and write path —
 * Skills and worktree suggestions through their settings namespaces, OPS through
 * its namespace, Auto Review through the Plugin Manager's Loader-row enablement —
 * so one cell never serializes their state.
 */
export function BundleSettingsCard({ form, worktreeForm, autoReviewForm, opsForm, t }: {
  form?: SkillsForm | undefined
  worktreeForm?: SkillsForm | undefined
  autoReviewForm?: AutoReviewForm | undefined
  opsForm?: SkillsForm | undefined
  t: Translate
}) {
  return <>
    {form === undefined
      ? null
      : <SkillsSettingsCard form={form} worktreeForm={worktreeForm} t={t} />}
    {form === undefined && worktreeForm !== undefined ? <WorktreeSwitchRow form={worktreeForm} t={t} /> : null}
    {autoReviewForm !== undefined ? <AutoReviewSettingsCard form={autoReviewForm} t={t} /> : null}
    {opsForm !== undefined ? <OpsCompatibilitySettingsCard form={opsForm} t={t} /> : null}
  </>
}

/** The client-scoped signal that the worktree switch changed. */
export interface WorktreeSettingsSignal {
  enabled(): boolean
  /**
   * Subscribe to a change of the selected worktree form (attachment, detach,
   * or a value/revision update). The overlay uses it to remount its wait after
   * the operator turns the feature back on.
   */
  subscribe(listener: () => void): () => void
}

export function installSkillsSettingsCard(ctx: Context, t: Translate): WorktreeSettingsSignal {
  // One coordinator prevents duplicate cards if a host temporarily exposes both shapes.
  let currentSkills: SkillsForm | undefined
  let currentWorktree: SkillsForm | undefined
  let currentOps: SkillsForm | undefined
  let currentAutoReview = false
  let stop: (() => void) | undefined
  const listeners = new Set<() => void>()
  let watchedWorktree: SkillsForm | undefined
  let stopWorktreeWatch: (() => void) | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  const candidates = new Map<Context, { skills?: SkillsForm | undefined; worktree?: SkillsForm | undefined; ops?: SkillsForm | undefined }>()
  const update = () => {
    const chosen = [...candidates.entries()].sort(([a], [b]) => Number(b.get('configForms' as never) !== undefined) - Number(a.get('configForms' as never) !== undefined))[0]
    const skillsForm = chosen?.[1].skills
    const worktreeForm = chosen?.[1].worktree
    const opsCandidate = chosen?.[1].ops
    const opsForm = opsCandidate?.getSnapshot().status === 'unavailable' ? undefined : opsCandidate
    // The overlay's own view of the switch follows the SAME form the card
    // renders, including a late attach and a host that republished it.
    if (watchedWorktree !== worktreeForm) {
      stopWorktreeWatch?.()
      watchedWorktree = worktreeForm
      stopWorktreeWatch = worktreeForm?.subscribe(notify)
      notify()
    }
    // Mirror the row's own render rule: hidden while unavailable or once the
    // composition answers without the optional entry, so the cell never
    // registers an empty card.
    const autoSnapshot = autoForm.getSnapshot()
    const autoAvailable = autoSnapshot.status === 'loading' || autoSnapshot.status === 'error'
      || (autoSnapshot.status === 'ready' && autoSnapshot.row !== undefined)
    if (skillsForm === undefined && worktreeForm === undefined && opsForm === undefined && !autoAvailable) {
      if (currentSkills !== undefined || currentWorktree !== undefined || currentOps !== undefined || currentAutoReview) {
        stop?.(); stop = undefined; currentSkills = undefined; currentWorktree = undefined; currentOps = undefined; currentAutoReview = false
      }
      return
    }
    if (currentSkills === skillsForm && currentWorktree === worktreeForm && currentOps === opsForm && currentAutoReview === autoAvailable) return
    const slots = (ctx as unknown as { slots?: { inject(name: string, callback: () => unknown): () => void; register(options: object, component: unknown): () => void } }).slots
    // Leave `current*` untouched so a later publish retries once slots exists.
    if (slots === undefined) return
    stop?.(); stop = undefined
    currentSkills = skillsForm; currentWorktree = worktreeForm; currentOps = opsForm; currentAutoReview = autoAvailable
    const disposers = [slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config', key: BUNDLE_KEY,
      inject: () => ({ form: skillsForm, worktreeForm, autoReviewForm: autoForm, opsForm, t }),
    }, BundleSettingsCard))]
    // Legacy hosts render one item per namespace: the Skills card carries both
    // switches, so the worktree feature never registers a second package card.
    if (skillsForm !== undefined) {
      disposers.push(slots.inject('settings.plugin.item', () => slots.register({
        name: 'settings.plugin.item', key: 'multi-root-skills',
        inject: () => ({ form: skillsForm, worktreeForm, t }),
      }, SkillsSettingsCard)))
    }
    if (opsForm !== undefined) disposers.push(slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item', key: 'multi-root-ops-compatibility', inject: () => ({ form: opsForm, t }) }, OpsCompatibilitySettingsCard)))
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
    const skills = bindSkillsForm(scope)
    const worktree = bindSettingsForm(scope, 'multi-root-worktrees')
    const forms = scope.get('configForms' as never) as { get(id: string): SkillsForm } | undefined
    const ops = forms?.get('multi-root-ops-compatibility')
    if (skills === undefined && worktree === undefined && ops === undefined) return
    const stopOpsWatch = ops?.subscribe(update)
    candidates.set(scope, { skills, worktree, ops }); update()
    return () => { stopOpsWatch?.(); candidates.delete(scope); update() }
  })
  ctx.effect(() => () => {
    stop?.()
    stopWorktreeWatch?.()
    stopAutoWatch()
    candidates.clear()
    listeners.clear()
    watchedWorktree = undefined
  })
  return {
    // Unknown is not "off": the loader row can enable suggestions without any
    // browser settings form, and the host's own switch is the only authority.
    // Only a READY form that reports a definite value may suppress the overlay
    // here; every other state polls and lets `worktree/not-enabled` stop the
    // loop (the overlay already handles that code).
    enabled: () => {
      const snapshot = watchedWorktree?.getSnapshot()
      if (snapshot?.status !== 'ready' || snapshot.value?.enabled === undefined) return true
      return snapshot.value.enabled === true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
