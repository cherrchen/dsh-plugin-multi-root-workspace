/**
 * The "add connection" guided flow the SSH settings dialog opens: the connect
 * form and the host-key pick on the first rail step, the post-save readiness
 * checklist (helper, access key, config link, connection test) and the
 * capability grants on the second. Staged on {@link WizardShell} with the
 * shared `env-parts.tsx` building blocks; every field validates against the
 * shared `ssh-draft.ts` wire rules before a request leaves, and every
 * mutation goes through the personal contract's CAS revision exactly like the
 * rest of the management dialog.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/wizard/add-connection
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { sshTarget } from '../../remote/ssh-location.ts'
import { IconCheck, IconLink } from '../../compat/client-icons.ts'
import { SshButton as Button } from '../panel-buttons.tsx'
import { CredentialsPanel, platformLabel, type CredentialCreateKind } from '../ssh-panel.tsx'
import { PanelError } from '../panel-client.ts'
import { PanelErrorToast, SshErrorDetail } from '../error-toast.tsx'
import { StatusLine } from '../pending.tsx'
import { ChoiceCard, WizardActions, WizardShell } from './kit.tsx'
import { ConnectForm, EnvironmentSetup, HostKeyPick, nodeCheckOf, type NodeCheck } from './env-parts.tsx'
import {
  blankEditor, connectionReady, draftFieldError, editorOf, environmentDraftOf,
  newEnvironmentId,
  CONNECT_FIELDS, type ConnectField, type EditorDraft,
} from '../ssh-draft.ts'
import type { CredentialPublicView, SshManagementClient, SshScanResult, SshStateView } from '../ssh-client.ts'
import type { Translate } from '../WorkspaceFoldersAction.tsx'

type ConnectionStage = 'connect' | 'setup'
const STAGES: readonly ConnectionStage[] = ['connect', 'setup']

type Pending =
  | 'load' | 'scan' | 'save' | 'helper' | 'accessKey' | 'link' | 'test' | 'credential'
  | undefined

/** The selected-marker glyph: the host check icon where it exists. */
function CheckMark(props: { readonly size?: number }): ReactNode {
  const size = props.size ?? 14
  return IconCheck === undefined ? <span aria-hidden="true">✓</span> : <IconCheck size={size} aria-hidden="true" />
}

export interface AddConnectionWizardProps {
  /** Personal-mode client; absent when the host exposes no personal contract. */
  readonly ssh: SshManagementClient | undefined
  /** The live session; plugin settings carry none and ride the settings channel. */
  readonly sessionId: string | undefined
  /** Opened from plugin settings: a missing session still allows requests. */
  readonly fromSettings?: boolean | undefined
  readonly onClose: () => void
  /** Fires after a mutation changed server state the caller mirrors. */
  readonly onChanged: () => void
  readonly t: Translate
}

/** The two-step add-connection flow. */
export function AddConnectionWizard(props: AddConnectionWizardProps): ReactNode {
  const { ssh, sessionId, t } = props
  const [stage, setStage] = useState<ConnectionStage>('connect')
  const [pane, setPane] = useState<'form' | 'keys'>('form')
  const [done, setDone] = useState(false)
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [aliases, setAliases] = useState<readonly string[]>([])
  const [loadError, setLoadError] = useState<PanelError | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [pending, setPending] = useState<Pending>(undefined)
  const [draft, setDraft] = useState<EditorDraft>(() => blankEditor())
  const [attempted, setAttempted] = useState<ReadonlySet<ConnectField>>(new Set())
  const [scan, setScan] = useState<SshScanResult | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [createdId, setCreatedId] = useState<string | undefined>(undefined)
  const [capExec, setCapExec] = useState(false)
  const [capTransfer, setCapTransfer] = useState(false)
  const [nodeCheck, setNodeCheck] = useState<NodeCheck | undefined>(undefined)
  const [testResult, setTestResult] = useState<string | undefined>(undefined)
  const [credsOpen, setCredsOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const busy = pending !== undefined
  const canRequest = sessionId !== undefined || props.fromSettings === true
  const unavailable = ssh === undefined || !canRequest

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (ssh === undefined) return
    setPending(previous => previous ?? 'load')
    try {
      const state = await ssh.state(sessionId, signal)
      if (signal.aborted) return
      setView(state)
      setLoadError(undefined)
    } catch (cause) {
      if (!signal.aborted) setLoadError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (!signal.aborted) setPending(previous => previous === 'load' ? undefined : previous)
    }
  }, [ssh, sessionId])

  useEffect(() => {
    if (unavailable) return
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal)
    ssh.aliases(sessionId, controller.signal)
      .then(answer => { if (!controller.signal.aborted) setAliases(answer.aliases) })
      .catch(() => { /* suggestions only; the field still accepts free text */ })
    return () => { controller.abort() }
  }, [load, ssh, sessionId, unavailable])

  const current = (): boolean => lifetime.current !== undefined && !lifetime.current.signal.aborted

  /** One personal-contract mutation: pending flag, view swap, localized failure. */
  const submitState = async (op: Exclude<Pending, 'load' | undefined>, run: (signal: AbortSignal) => Promise<SshStateView>): Promise<SshStateView | undefined> => {
    const signal = lifetime.current?.signal
    if (pending !== undefined || signal === undefined || signal.aborted) return undefined
    setPending(op)
    setError(undefined)
    try {
      const state = await run(signal)
      if (signal.aborted) return undefined
      setView(state)
      props.onChanged()
      return state
    } catch (cause) {
      if (!signal.aborted) {
        const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
        setError(failure)
        if (failure.code === 'personal-config-conflict') void load(signal)
      }
      return undefined
    } finally {
      if (!signal.aborted) setPending(undefined)
    }
  }

  const created = view?.environments.find(entry => entry.environmentId === createdId)
  const linked = view?.linked === true
  const needsAccessKey = created?.credential.kind === 'managed'
    && view?.credentials.find(credential => credential.id === (created.credential as { credentialId: string }).credentialId)?.kind === 'password'
    && (created.credential as { accessKeyId?: string }).accessKeyId === undefined
  const needsLink = created?.credential.kind === 'managed' && !linked

  const scanHost = async (): Promise<void> => {
    const signal = lifetime.current?.signal
    if (ssh === undefined || pending !== undefined || signal === undefined || signal.aborted || !connectionReady(draft)) return
    const target = draft.credentialSource === 'alias'
      ? { alias: draft.alias.trim(), port: Number.parseInt(draft.port, 10) }
      : { hostname: draft.hostname.trim(), port: Number.parseInt(draft.port, 10) }
    setPending('scan')
    setError(undefined)
    try {
      const result = await ssh.hostKeyScan(sessionId, target, signal)
      if (signal.aborted) return
      if (result.endpoint !== undefined) {
        setDraft(previous => ({
          ...previous,
          hostname: result.endpoint!.hostname,
          port: String(result.endpoint!.port),
          user: result.endpoint!.user,
        }))
      }
      setScan(result)
      setFingerprint(result.keys[0]?.fingerprint)
      setPane('keys')
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (!signal.aborted) setPending(undefined)
    }
  }

  const saveConnection = async (): Promise<void> => {
    if (view === undefined || scan === undefined || fingerprint === undefined) return
    const environmentId = newEnvironmentId(draft.displayName, view.environments)
    const state = await submitState('save',
      signal => ssh!.environmentSave(sessionId, view.revision, environmentDraftOf(draft, environmentId), fingerprint, scan.token, 'create', signal))
    if (state === undefined) return
    const createdEnvironment = state.environments.find(entry => entry.environmentId === environmentId)
    setCreatedId(environmentId)
    setCapExec(createdEnvironment?.exec !== undefined)
    setCapTransfer(createdEnvironment?.transfer !== undefined)
    setAttempted(new Set())
    setScan(undefined)
    setFingerprint(undefined)
    setPane('form')
    setStage('setup')
  }

  const finish = async (): Promise<void> => {
    if (created === undefined || view === undefined) return
    const patch: EditorDraft = {
      ...editorOf(created),
      allowExec: capExec && created.helper !== null,
      allowTransfer: capTransfer,
    }
    if (patch.allowExec !== (created.exec !== undefined) || patch.allowTransfer !== (created.transfer !== undefined)) {
      const state = await submitState('save',
        signal => ssh!.environmentSave(sessionId, view.revision, environmentDraftOf(patch, created.environmentId), created.hostKey, undefined, 'update', signal))
      if (state === undefined) return
    }
    setDone(true)
  }

  const installHelper = async (): Promise<void> => {
    if (created === undefined || view === undefined) return
    await submitState('helper', signal => ssh!.helperInstall(sessionId, view.revision, created.environmentId, undefined, signal))
  }

  const installAccessKey = async (): Promise<void> => {
    if (created === undefined || view === undefined) return
    await submitState('accessKey', signal => ssh!.accessKeyInstall(sessionId, view.revision, created.environmentId, signal))
  }

  const linkConfig = async (): Promise<void> => {
    await submitState('link', signal => ssh!.configLink(sessionId, signal))
  }

  const testConnection = async (): Promise<void> => {
    const signal = lifetime.current?.signal
    if (ssh === undefined || created === undefined || pending !== undefined || signal === undefined || signal.aborted) return
    setPending('test')
    setError(undefined)
    try {
      const result = await ssh.environmentTest(sessionId, created.environmentId, signal)
      if (signal.aborted) return
      setTestResult(result.nodePath ?? 'ok')
      const check = nodeCheckOf(result)
      setNodeCheck(check)
    } catch (cause) {
      if (!signal.aborted) {
        setTestResult(undefined)
        setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
      }
    } finally {
      if (!signal.aborted) setPending(undefined)
    }
  }

  const createCredential = async (kind: CredentialCreateKind, label: string, secret: string, passphrase?: string): Promise<boolean> => {
    const known = new Set((view?.credentials ?? []).map(credential => credential.id))
    const run = kind === 'generate' ? (signal: AbortSignal) => ssh!.credentialGenerate(sessionId, label, signal)
      : kind === 'import' ? (signal: AbortSignal) => ssh!.credentialImport(sessionId, label, secret, passphrase, signal)
        : (signal: AbortSignal) => ssh!.credentialPassword(sessionId, label, secret, signal)
    const state = await submitState('credential', run)
    if (state === undefined) return false
    const fresh = state.credentials.find(credential => !known.has(credential.id) && credential.purpose !== 'access-key')
    if (fresh !== undefined) {
      setDraft(previous => previous.credentialSource === 'managed' && previous.credentialId === ''
        ? { ...previous, credentialId: fresh.id }
        : previous)
    }
    return true
  }

  const removeCredential = async (id: string): Promise<boolean> => {
    return await submitState('credential', signal => ssh!.credentialRemove(sessionId, id, signal)) !== undefined
  }

  const copyPublicKey = async (credential: CredentialPublicView): Promise<void> => {
    try {
      await navigator.clipboard.writeText(credential.publicKey ?? '')
      if (current()) setCopiedId(credential.id)
    } catch {
      if (current()) setError(new PanelError('copy-failed', 'clipboard write failed'))
    }
  }

  const fieldError = (field: ConnectField): string | undefined => {
    if (!attempted.has(field)) return undefined
    const key = draftFieldError(draft, field)
    return key === undefined ? undefined : t(key)
  }

  const stageIndex = STAGES.indexOf(stage)

  const footer = ((): ReactNode => {
    if (unavailable || done) {
      return <WizardActions><Button variant="primary" onClick={props.onClose}>{t('panel.close')}</Button></WizardActions>
    }
    if (stage === 'connect') {
      if (pane === 'keys') {
        return <WizardActions>
          <Button variant="ghost" disabled={busy} onClick={() => { setPane('form'); setScan(undefined); setFingerprint(undefined) }}>{t('ssh.step.back')}</Button>
          <Button variant="primary" disabled={busy || fingerprint === undefined} loading={pending === 'save'}
            onClick={() => { void saveConnection() }}>{t('ssh.scanConfirm')}</Button>
        </WizardActions>
      }
      return <WizardActions>
        <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t('ssh.cancel')}</Button>
        <Button variant="primary" disabled={busy} loading={pending === 'scan'}
          onClick={() => {
            setAttempted(new Set(CONNECT_FIELDS))
            if (connectionReady(draft)) void scanHost()
          }}>{t('ssh.scan')}</Button>
      </WizardActions>
    }
    return <WizardActions>
      <Button variant="primary" disabled={busy || created === undefined} loading={pending === 'save'}
        onClick={() => { void finish() }}>{t('ssh.step.finish')}</Button>
    </WizardActions>
  })()

  const connectBody = (): ReactNode => {
    if (view === undefined) {
      if (loadError === undefined) return <StatusLine state="ongoing">{t('ssh.loading')}</StatusLine>
      return <div className="mrfw-wizEmpty">
        <p className="mrfw-note">{t('ssh.loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => {
          const signal = lifetime.current?.signal
          if (signal !== undefined) { setLoadError(undefined); void load(signal) }
        }}>{t('panel.retry')}</Button>
      </div>
    }
    return (
      <div className="mrfw-wizStack">
        <p className="mrfw-note">{t('ssh.add.personalGuide')}</p>
        <ConnectForm draft={draft} credentials={view.credentials} aliases={aliases} busy={busy} t={t}
          errorFor={fieldError}
          onChange={next => setDraft(next)}
          onManageCredentials={() => setCredsOpen(true)} />
        {pane === 'keys' && scan !== undefined ? (
          <HostKeyPick keys={scan.keys} fingerprint={fingerprint} busy={busy} t={t}
            onPick={setFingerprint} />
        ) : null}
      </div>
    )
  }

  const setupBody = (): ReactNode => {
    if (created === undefined) return <p className="mrfw-note">{t('error.environment-not-found')}</p>
    return (
      <div className="mrfw-wizStack">
        <ChoiceCard
          title={created.displayName ?? created.environmentId}
          subtitle={sshTarget(created.endpoint.user, created.endpoint.hostname, created.endpoint.port)}
          icon={<IconLink size={16} />}
          trailing={<Tag tone="info" className="mrfw-sshTag">{platformLabel(created.platform, t)}</Tag>} />
        <SshErrorDetail error={error} t={t} />
        <EnvironmentSetup
          environment={created}
          needsAccessKey={needsAccessKey === true}
          needsLink={needsLink === true}
          pending={pending === 'helper' || pending === 'accessKey' || pending === 'link' ? pending : undefined}
          detecting={pending === 'test'}
          busy={busy}
          nodeCheck={nodeCheck}
          testResult={testResult}
          allowExec={capExec}
          allowTransfer={capTransfer}
          t={t}
          onDetect={() => { void testConnection() }}
          onInstallHelper={() => { void installHelper() }}
          onInstallAccessKey={() => { void installAccessKey() }}
          onLink={() => { void linkConfig() }}
          onExec={setCapExec}
          onTransfer={setCapTransfer} />
      </div>
    )
  }

  const body = ((): ReactNode => {
    if (unavailable) {
      return <p className="mrfw-note">{canRequest ? t('ssh.add.noClient') : t('ssh.dialog.noSession')}</p>
    }
    if (done) {
      return (
        <div className="mrfw-wizDone">
          <span className="mrfw-wizDoneMark" aria-hidden><CheckMark size={20} /></span>
          <p className="mrfw-wizDoneTitle">{t('ssh.add.done')}</p>
          <p className="mrfw-note">{t('ssh.add.doneHint')}</p>
        </div>
      )
    }
    if (stage === 'connect') return connectBody()
    return setupBody()
  })()

  const steps = STAGES.map(id => ({ id, title: t(id === 'connect' ? 'ssh.add.stepInfo' : 'ssh.add.stepSetup') }))

  return <>
    <WizardShell
      title={t('ssh.tab.add')}
      railLabel={t('ssh.step.listLabel')}
      closeLabel={t('panel.close')}
      onClose={props.onClose}
      busy={busy}
      steps={steps}
      current={stageIndex}
      complete={done}
      footer={footer}
    >
      <PanelErrorToast error={error?.ssh === undefined ? error : undefined} t={t} />
      {body}
    </WizardShell>
    {credsOpen && view !== undefined ? (
      <Modal open onClose={() => setCredsOpen(false)} title={t('ssh.credentials')} description={t('ssh.keys.personalGuide')}
        closeLabel={t('panel.close')} className="mrfw-sshDialog" contentClassName="mrfw-sshDialogContent">
        <CredentialsPanel
          credentials={view.credentials.filter(credential => credential.purpose !== 'access-key')}
          busy={busy} pending={pending === 'credential'} t={t} copiedId={copiedId}
          onCopy={copyPublicKey}
          onDelete={removeCredential}
          onCreate={createCredential} />
      </Modal>
    ) : null}
  </>
}
