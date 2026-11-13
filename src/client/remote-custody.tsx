/**
 * The SSH custody-mode control that lives in the Workspace Folders panel
 * (ADR-0041). It writes the SAME `multi-root-remote-tools` settings form the
 * plugin card uses, so the mode, team block, and CAS revision have one owner.
 * The enable switch stays on the plugin card; this control owns the mode and
 * its mode-specific configuration.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/remote-custody
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { remoteRiskConfirmation } from '../compat/ops-confirmation.ts'
import type { RemoteModeControl, SkillsForm } from '../compat/skills-client.ts'
import type { Key } from './locales.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/** The three SSH custody modes (ADR-0041), ordered by isolation strength. */
export type RemoteCustodyMode = 'personal' | 'team' | 'hardened'

const REMOTE_ISOLATION: Record<RemoteCustodyMode, number> = { personal: 0, team: 1, hardened: 2 }
const REMOTE_MODES: readonly RemoteCustodyMode[] = ['personal', 'team', 'hardened']
const REMOTE_TEAM_FIELDS = ['manifestPath', 'socketPath', 'brokerUid', 'credentialRoot'] as const

interface RemoteTeamDraft { manifestPath: string; socketPath: string; brokerUid: string; credentialRoot: string }

interface RemoteSettingsValue {
  readonly enabled?: unknown
  readonly mode?: unknown
  readonly team?: unknown
}

interface RemoteSettingsSnapshot {
  readonly value?: RemoteSettingsValue | undefined
  readonly status: string
  readonly writable: boolean
  readonly revision?: number | undefined
}

const snapshotOf = (form: SkillsForm): RemoteSettingsSnapshot => form.getSnapshot() as unknown as RemoteSettingsSnapshot

const normalizeMode = (value: unknown): RemoteCustodyMode | undefined =>
  value === 'personal' || value === 'team' || value === 'hardened' ? value : undefined

const teamDraftOf = (team: unknown): RemoteTeamDraft => {
  const record = typeof team === 'object' && team !== null ? team as Record<string, unknown> : {}
  return {
    manifestPath: typeof record.manifestPath === 'string' ? record.manifestPath : '',
    socketPath: typeof record.socketPath === 'string' ? record.socketPath : '',
    brokerUid: typeof record.brokerUid === 'number' ? String(record.brokerUid) : '',
    credentialRoot: typeof record.credentialRoot === 'string' ? record.credentialRoot : '',
  }
}

type RemoteMutate = (ops: readonly { op: 'set'; path: string[]; value: unknown }[], revision?: number) => Promise<boolean>
const mutateOf = (form: SkillsForm): RemoteMutate => form.mutate as unknown as RemoteMutate

/**
 * Render the custody-mode radios, the team block, and the downgrade
 * confirmation. The form is the same one the plugin card's enable switch uses.
 */
export function RemoteCustodyModeControl(props: {
  readonly form: SkillsForm
  readonly currentMode?: RemoteCustodyMode | undefined
  readonly onChanged?: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  const { form, currentMode, onChanged, t } = props
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => snapshotOf(form))
  const value = snapshot.value
  const enabled = value?.enabled === true
  const mode = normalizeMode(value?.mode) ?? currentMode ?? 'personal'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const saving = useRef(false)
  const [confirmation, setConfirmation] = useState<{ revision: number | undefined; downgradeTo: RemoteCustodyMode }>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [teamDraft, setTeamDraft] = useState<RemoteTeamDraft>()
  const mounted = useRef(true)
  const RiskConfirmation = remoteRiskConfirmation()
  const canConfirm = confirmation !== undefined
    && confirmation.revision === snapshot.revision
    && snapshot.status === 'ready'
    && snapshot.writable
    && RiskConfirmation !== undefined
    && enabled
    && mode !== confirmation.downgradeTo
  const dismiss = () => { setConfirmation(undefined); setAcknowledged(false) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (confirmation !== undefined && !canConfirm) dismiss()
  }, [confirmation, canConfirm])
  useEffect(() => {
    if (mode === 'team') setTeamDraft(teamDraftOf(value?.team))
  }, [mode, snapshot.revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const write = async (ops: readonly { op: 'set'; path: string[]; value: unknown }[], revision: number | undefined): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setBusy(true); setError(undefined)
    try {
      const ok = await mutateOf(form)(ops, revision)
      if (mounted.current && !ok) setError(t('remote.settingsFailed'))
      if (mounted.current && ok) onChanged?.()
    } catch {
      if (mounted.current) setError(t('remote.settingsFailed'))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const chooseMode = (next: RemoteCustodyMode): void => {
    if (next === mode || busy) return
    setError(undefined)
    // A less isolated mode while the service is enabled keeps the same risk
    // confirmation the plugin card used, with mode-specific copy.
    if (enabled && REMOTE_ISOLATION[next] < REMOTE_ISOLATION[mode]) {
      setAcknowledged(false)
      setConfirmation({ revision: snapshot.revision, downgradeTo: next })
      return
    }
    void write([{ op: 'set', path: ['mode'], value: next }], snapshot.revision)
  }
  const saveTeam = (): void => {
    if (teamDraft === undefined) return
    const uid = Number(teamDraft.brokerUid)
    if (!Number.isInteger(uid) || uid < 0) return
    void write([
      { op: 'set', path: ['team', 'manifestPath'], value: teamDraft.manifestPath },
      { op: 'set', path: ['team', 'socketPath'], value: teamDraft.socketPath },
      { op: 'set', path: ['team', 'brokerUid'], value: uid },
      { op: 'set', path: ['team', 'credentialRoot'], value: teamDraft.credentialRoot },
    ], snapshot.revision)
  }
  if (snapshot.status === 'unavailable') return null
  const teamUid = teamDraft === undefined ? NaN : Number(teamDraft.brokerUid)
  const modeKey = (value: RemoteCustodyMode): Key => `remote.mode.${value}` as Key
  const disabled = busy || snapshot.status !== 'ready' || !snapshot.writable || confirmation !== undefined
  return <section className="mrfw-subsection">
    <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.custodyMode')}</span></div>
    <p className="mrfw-note">{t('ssh.custodyHint')}</p>
    <div role="radiogroup" aria-label={t('remote.modeLabel')} className="mrfw-modeGroup">
      {REMOTE_MODES.map(option => (
        <label key={option} className="mrfw-modeOption">
          <input
            type="radio"
            name="mrfw-ssh-custody-mode"
            checked={mode === option}
            disabled={disabled}
            onChange={() => chooseMode(option)}
          />
          <span className="mrfw-modeOptionText">
            <span className="mrfw-modeOptionTitle">{t(modeKey(option))}</span>
            <span className="mrfw-skillsSettingsDescription">{t(`${modeKey(option)}Hint` as Key)}</span>
          </span>
        </label>
      ))}
    </div>
    {mode === 'team' && teamDraft !== undefined ? (
      <div className="mrfw-teamFields">
        {REMOTE_TEAM_FIELDS.map(field => (
          <label key={field} className="mrfw-teamField">
            <span className="mrfw-modeOptionTitle">{t(`remote.team.${field}` as Key)}</span>
            <input
              className="mrfw-input"
              type={field === 'brokerUid' ? 'number' : 'text'}
              value={teamDraft[field]}
              disabled={busy || !snapshot.writable}
              onChange={event => setTeamDraft({ ...teamDraft, [field]: event.currentTarget.value })}
            />
          </label>
        ))}
        <button type="button" className="mrfw-btn mrfw-btnOutline"
          disabled={busy || !snapshot.writable || !Number.isInteger(teamUid) || teamUid < 0}
          onClick={saveTeam}>
          {t('remote.team.save')}
        </button>
      </div>
    ) : null}
    {mode === 'hardened' ? <div className="mrfw-skillsSettingsDescription">{t('remote.mode.hardenedNote')}</div> : null}
    {error ? <div role="alert">{error}</div> : null}
    {RiskConfirmation === undefined ? null : <RiskConfirmation
      open={canConfirm}
      title={t('remote.downgradeTitle')}
      description={t('remote.downgradeDescription', {
        from: t(modeKey(mode)),
        to: t(modeKey(confirmation?.downgradeTo ?? mode)),
        why: t(`remote.downgrade.${confirmation?.downgradeTo ?? mode}` as Key),
      })}
      acknowledgeLabel={t('remote.downgradeAcknowledge')}
      cancelLabel={t('remote.confirmCancel')}
      closeLabel={t('remote.confirmClose')}
      confirmLabel={t('remote.downgradeConfirm')}
      acknowledged={acknowledged}
      disabled={busy || !canConfirm}
      onAcknowledgedChange={setAcknowledged}
      onCancel={dismiss}
      onConfirm={() => {
        if (!canConfirm || !acknowledged || confirmation === undefined || saving.current) return
        const revision = confirmation.revision
        const downgradeTo = confirmation.downgradeTo
        dismiss()
        void write([{ op: 'set', path: ['mode'], value: downgradeTo }], revision)
      }}
    />}
  </section>
}

/**
 * The panel's wrapper: follow the shared form across settings-service attach
 * and detach. Renders nothing until the host exposes the form, so a host
 * without config forms never shows a control that cannot write.
 */
export function SshCustodySection(props: {
  readonly control?: RemoteModeControl | undefined
  readonly currentMode?: RemoteCustodyMode | undefined
  readonly onChanged: () => void
  readonly t: Translate
}): ReactNode {
  const subscribe = useCallback((listener: () => void) => props.control?.subscribe(listener) ?? (() => {}), [props.control])
  const form = useSyncExternalStore(subscribe, () => props.control?.form())
  if (form === undefined) return null
  return <RemoteCustodyModeControl form={form} currentMode={props.currentMode} onChanged={props.onChanged} t={props.t} />
}
