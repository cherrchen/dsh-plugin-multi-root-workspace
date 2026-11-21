/**
 * The "add remote workspace" guided flow: pick or create a personal SSH
 * environment, bind a remote directory to this workspace's primary root, and
 * register the endpoint into the live session. Three steps on
 * {@link WizardShell}; every field validates against the shared
 * `ssh-draft.ts` wire rules before a request leaves, and every mutation goes
 * through the personal contract's CAS revision exactly like the legacy
 * management dialogs.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/wizard/add-remote
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootsView } from '../../contract.ts'
import { sshLocation, sshTarget } from '../../remote/ssh-location.ts'
import { IconCheck, IconFolderOpen, IconLink, IconPlus } from '../../compat/client-icons.ts'
import { SshButton as Button } from '../panel-buttons.tsx'
import { localBindingPeers } from '../remote-root-menu.tsx'
import { CredentialsPanel, platformLabel, type CredentialCreateKind } from '../ssh-panel.tsx'
import { PanelError } from '../panel-client.ts'
import { ErrorToast, PanelErrorToast } from '../error-toast.tsx'
import { PendingBar, StatusLine } from '../pending.tsx'
import { ChecklistRow, ChoiceCard, WizardActions, WizardCheckbox, WizardField, WizardPicker, WizardShell } from './kit.tsx'
import {
  blankEditor, connectionReady, draftFieldError, editorOf, environmentDraftOf,
  newEnvironmentId, remotePath, togglePeer,
  CONNECT_FIELDS, type ConnectField, type EditorDraft,
} from '../ssh-draft.ts'
import type { RemotesClient } from '../remotes-client.ts'
import type { CredentialPublicView, RemoteDirectoryListing, SshBindingDraft, SshClient, SshScanResult, SshStateView } from '../ssh-client.ts'
import type { Translate } from '../WorkspaceFoldersAction.tsx'

type WizardStage = 'environment' | 'binding' | 'confirm'
const STAGES: readonly WizardStage[] = ['environment', 'binding', 'confirm']

type Pending =
  | 'load' | 'scan' | 'save' | 'helper' | 'accessKey' | 'link' | 'test' | 'credential'
  | 'binding' | 'register' | undefined

interface BindingForm {
  path: string
  read: boolean
  write: boolean
  exec: boolean
  imports: ReadonlySet<string>
  exports: ReadonlySet<string>
}

const blankBinding = (): BindingForm => ({
  path: '', read: true, write: false, exec: false, imports: new Set(), exports: new Set(),
})

/** The selected-marker glyph: the host check icon where it exists. */
function CheckMark(props: { readonly size?: number }): ReactNode {
  const size = props.size ?? 14
  return IconCheck === undefined ? <span aria-hidden="true">✓</span> : <IconCheck size={size} aria-hidden="true" />
}

/** The SFTP directory picker, restyled on the wizard kit. */
function WizardPathBrowser(props: {
  readonly open: boolean
  readonly initialPath: string
  readonly environmentId: string
  readonly ssh: SshClient | undefined
  readonly sessionId: string | undefined
  readonly t: Translate
  readonly onClose: () => void
  readonly onPick: (path: string) => void
}): ReactNode {
  const { t } = props
  const [path, setPath] = useState(props.initialPath)
  const [listing, setListing] = useState<RemoteDirectoryListing | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const request = useRef(0)
  const load = useCallback(async (target: string | undefined): Promise<void> => {
    if (props.ssh === undefined || props.sessionId === undefined) {
      setError('remote-personal-unavailable')
      return
    }
    const id = ++request.current
    setLoading(true)
    setError(undefined)
    try {
      const answer = await props.ssh.listDirectories(props.sessionId, props.environmentId, target)
      if (id !== request.current) return
      setListing(answer)
      setPath(answer.path)
    } catch (cause: unknown) {
      if (id !== request.current) return
      setError(cause instanceof PanelError ? cause.message : cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [props.ssh, props.sessionId, props.environmentId])
  useEffect(() => {
    if (!props.open) return
    request.current += 1
    setListing(undefined)
    setError(undefined)
    setPath(props.initialPath)
    void load(props.initialPath.trim() === '' ? undefined : props.initialPath.trim())
    return () => { request.current += 1 }
  }, [props.open, props.initialPath, load])
  if (!props.open) return null
  const pick = (): void => {
    const chosen = path.trim() === '' ? listing?.path : path.trim()
    if (chosen === undefined || chosen === '') return
    props.onPick(chosen)
    props.onClose()
  }
  return (
    <Modal open onClose={props.onClose} title={t('ssh.pathPickerTitle')} description={t('ssh.pathPickerHint')}
      closeLabel={t('panel.close')} className="mrfw-wizBrowser"
      footer={<WizardActions>
        <Button variant="ghost" onClick={props.onClose}>{t('ssh.cancel')}</Button>
        <Button variant="primary" disabled={path.trim() === '' && listing === undefined} onClick={pick}>{t('ssh.pathPickerUse')}</Button>
      </WizardActions>}>
      <PendingBar active={loading} />
      <div className="mrfw-sshPathBar">
        <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} placeholder="/" value={path}
          onChange={event => setPath(event.currentTarget.value)} />
        <div className="mrfw-sshRowActions">
          <Button variant="outline" size="sm" disabled={loading}
            onClick={() => { void load(path.trim() === '' ? undefined : path.trim()) }}>{t('ssh.pathPickerGo')}</Button>
          <Button variant="outline" size="sm" disabled={loading || listing === undefined}
            onClick={() => { void load(listing?.parent) }}>{t('ssh.pathPickerParent')}</Button>
        </div>
      </div>
      <ErrorToast error={error} format={message => t('ssh.pathPickerFailed', { message })} />
      {loading ? <StatusLine state="ongoing">{t('ssh.pending.list')}</StatusLine> : null}
      {listing === undefined ? null : listing.entries.length === 0 ? (
        loading ? null : <p className="mrfw-note">{t('ssh.pathPickerEmpty')}</p>
      ) : (
        <div className="mrfw-wizDirList" aria-busy={loading ? 'true' : undefined}>
          {listing.entries.map(entry => (
            <button key={entry.path} type="button" className="mrfw-wizDirRow" onClick={() => { void load(entry.path) }}>
              <IconFolderOpen size={14} />
              <span className="mrfw-sshDirName">{entry.name}</span>
              <span className="mrfw-sshDirArrow" aria-hidden>›</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

export interface RemoteWizardProps {
  readonly ssh: SshClient | undefined
  readonly remotes: RemotesClient | undefined
  readonly sessionId: string | undefined
  readonly roots: RootsView | undefined
  readonly onClose: () => void
  /** Fires after a binding or registration changed server state the caller mirrors. */
  readonly onChanged: () => void
  readonly t: Translate
}

/** The three-step add-remote flow. */
export function RemoteWizard(props: RemoteWizardProps): ReactNode {
  const { ssh, remotes, sessionId, t } = props
  const [stage, setStage] = useState<WizardStage>('environment')
  const [done, setDone] = useState(false)
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [aliases, setAliases] = useState<readonly string[]>([])
  const [loadError, setLoadError] = useState<PanelError | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [pending, setPending] = useState<Pending>(undefined)
  const [envPane, setEnvPane] = useState<'choose' | 'create' | 'keys'>('choose')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<EditorDraft>(() => blankEditor())
  const [attempted, setAttempted] = useState<ReadonlySet<ConnectField>>(new Set())
  const [scan, setScan] = useState<SshScanResult | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [nodePath, setNodePath] = useState('')
  const [capExec, setCapExec] = useState(false)
  const [capTransfer, setCapTransfer] = useState(false)
  const [testResult, setTestResult] = useState<string | undefined>(undefined)
  const [credsOpen, setCredsOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [binding, setBinding] = useState<BindingForm>(() => blankBinding())
  const [bindingAttempted, setBindingAttempted] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [boundRootId, setBoundRootId] = useState<string | undefined>(undefined)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const busy = pending !== undefined

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
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
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal)
    if (ssh !== undefined && sessionId !== undefined) {
      ssh.aliases(sessionId, controller.signal)
        .then(answer => { if (!controller.signal.aborted) setAliases(answer.aliases) })
        .catch(() => { /* suggestions only; the field still accepts free text */ })
    }
    return () => { controller.abort() }
  }, [load, ssh, sessionId])

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

  const selected = view?.environments.find(entry => entry.environmentId === selectedId)
  const linked = view?.linked === true
  const needsAccessKey = selected?.credential.kind === 'managed'
    && view?.credentials.find(credential => credential.id === (selected.credential as { credentialId: string }).credentialId)?.kind === 'password'
    && (selected.credential as { accessKeyId?: string }).accessKeyId === undefined
  const needsLink = selected?.credential.kind === 'managed' && !linked
  const environmentReady = selected !== undefined && selected.helper !== null && !needsLink
  const select = (id: string): void => {
    setSelectedId(id)
    setTestResult(undefined)
    setNodePath('')
    const environment = view?.environments.find(entry => entry.environmentId === id)
    setCapExec(environment?.exec !== undefined)
    setCapTransfer(environment?.transfer !== undefined)
  }

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
      setEnvPane('keys')
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
    select(environmentId)
    setDraft(blankEditor())
    setAttempted(new Set())
    setScan(undefined)
    setFingerprint(undefined)
    setEnvPane('choose')
  }

  const saveCapabilities = async (): Promise<boolean> => {
    if (selected === undefined || view === undefined) return false
    const patch: EditorDraft = {
      ...editorOf(selected),
      allowExec: capExec && selected.helper !== null,
      allowTransfer: capTransfer,
    }
    if (patch.allowExec === (selected.exec !== undefined) && patch.allowTransfer === (selected.transfer !== undefined)) return true
    const state = await submitState('save',
      signal => ssh!.environmentSave(sessionId, view.revision, environmentDraftOf(patch, selected.environmentId), selected.hostKey, undefined, 'update', signal))
    return state !== undefined
  }

  const installHelper = async (): Promise<void> => {
    if (selected === undefined || view === undefined) return
    await submitState('helper', signal => ssh!.helperInstall(sessionId, view.revision, selected.environmentId, nodePath.trim() === '' ? undefined : nodePath.trim(), signal))
  }

  const installAccessKey = async (): Promise<void> => {
    if (selected === undefined || view === undefined) return
    await submitState('accessKey', signal => ssh!.accessKeyInstall(sessionId, view.revision, selected.environmentId, signal))
  }

  const linkConfig = async (): Promise<void> => {
    await submitState('link', signal => ssh!.configLink(sessionId, signal))
  }

  const testConnection = async (): Promise<void> => {
    const signal = lifetime.current?.signal
    if (ssh === undefined || selected === undefined || pending !== undefined || signal === undefined || signal.aborted) return
    setPending('test')
    setError(undefined)
    try {
      const result = await ssh.environmentTest(sessionId, selected.environmentId, signal)
      if (signal.aborted) return
      setTestResult(result.nodePath ?? 'ok')
      if (result.nodePath !== undefined) setNodePath(result.nodePath)
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
    const run = kind === 'generate' ? (signal: AbortSignal) => ssh!.credentialGenerate(sessionId, label, signal)
      : kind === 'import' ? (signal: AbortSignal) => ssh!.credentialImport(sessionId, label, secret, passphrase, signal)
        : (signal: AbortSignal) => ssh!.credentialPassword(sessionId, label, secret, signal)
    return await submitState('credential', run) !== undefined
  }

  const removeCredential = async (id: string): Promise<boolean> => {
    if (view === undefined) return false
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

  const saveBinding = async (): Promise<void> => {
    if (selected === undefined || view === undefined || sessionId === undefined || !remotePath(binding.path.trim())) return
    const actions = (['read', 'write', 'exec'] as const).filter(action => binding[action])
    const transfers = [
      ...[...binding.imports].map(rootId => ({ direction: 'import' as const, peer: { environmentId: 'local', rootId } })),
      ...[...binding.exports].map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local', rootId } })),
    ]
    const draftBinding: SshBindingDraft = {
      environmentId: selected.environmentId, path: binding.path.trim(), actions,
      ...(transfers.length === 0 ? {} : { transfers }),
    }
    const state = await submitState('binding', signal => ssh!.bindingSave(sessionId, view.revision, draftBinding, signal))
    if (state === undefined) return
    const created = state.bindings.find(entry => entry.environmentId === selected.environmentId && entry.path === draftBinding.path)
    if (created === undefined) {
      setError(new PanelError('panel/bad-response', 'the binding answer did not contain the saved root'))
      return
    }
    setBoundRootId(created.rootId)
    props.onChanged()
    setStage('confirm')
  }

  const register = async (): Promise<void> => {
    const signal = lifetime.current?.signal
    if (remotes === undefined || sessionId === undefined || selected === undefined || boundRootId === undefined
      || pending !== undefined || signal === undefined || signal.aborted) return
    setPending('register')
    setError(undefined)
    try {
      await remotes.add(sessionId, selected.environmentId, boundRootId, signal)
      if (signal.aborted) return
      setDone(true)
      props.onChanged()
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (!signal.aborted) setPending(undefined)
    }
  }

  const environmentNext = async (): Promise<void> => {
    if (!environmentReady) return
    if (await saveCapabilities()) setStage('binding')
  }

  const fieldError = (field: ConnectField): string | undefined => {
    if (!attempted.has(field)) return undefined
    const key = draftFieldError(draft, field)
    return key === undefined ? undefined : t(key)
  }

  const localPeers = localBindingPeers(props.roots, t)
  const stageIndex = STAGES.indexOf(stage)

  const footer = ((): ReactNode => {
    if (done) {
      return <WizardActions><Button variant="primary" onClick={props.onClose}>{t('panel.close')}</Button></WizardActions>
    }
    if (stage === 'environment') {
      if (envPane === 'create') {
        return <WizardActions>
          <Button variant="ghost" disabled={busy} onClick={() => { setEnvPane('choose'); setAttempted(new Set()) }}>{t('ssh.cancel')}</Button>
          <Button variant="primary" disabled={busy || !connectionReady(draft)} loading={pending === 'scan'}
            onClick={() => {
              setAttempted(new Set(CONNECT_FIELDS))
              if (connectionReady(draft)) void scanHost()
            }}>{t('ssh.scan')}</Button>
        </WizardActions>
      }
      if (envPane === 'keys') {
        return <WizardActions>
          <Button variant="ghost" disabled={busy} onClick={() => { setEnvPane('create'); setScan(undefined); setFingerprint(undefined) }}>{t('ssh.step.back')}</Button>
          <Button variant="primary" disabled={busy || fingerprint === undefined} loading={pending === 'save'}
            onClick={() => { void saveConnection() }}>{t('ssh.scanConfirm')}</Button>
        </WizardActions>
      }
      return <WizardActions>
        <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t('ssh.cancel')}</Button>
        <Button variant="primary" disabled={busy || !environmentReady} onClick={() => { void environmentNext() }}>{t('ssh.step.next')}</Button>
      </WizardActions>
    }
    if (stage === 'binding') {
      return <WizardActions>
        <Button variant="ghost" disabled={busy} onClick={() => setStage('environment')}>{t('ssh.step.back')}</Button>
        <Button variant="primary" disabled={busy || !(binding.read || binding.write || binding.exec)} loading={pending === 'binding'}
          onClick={() => {
            setBindingAttempted(true)
            if (remotePath(binding.path.trim()) && (binding.read || binding.write || binding.exec)) void saveBinding()
          }}>{t('ssh.step.next')}</Button>
      </WizardActions>
    }
    return <WizardActions>
      <Button variant="ghost" disabled={busy} onClick={() => setStage('binding')}>{t('ssh.step.back')}</Button>
      <Button variant="primary" disabled={busy || boundRootId === undefined} loading={pending === 'register'}
        onClick={() => { void register() }}>{t('wizard.register')}</Button>
    </WizardActions>
  })()

  const unavailable = ssh === undefined || sessionId === undefined || remotes === undefined

  const environmentBody = (): ReactNode => {
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
    if (envPane === 'create' || envPane === 'keys') {
      return (
        <div className="mrfw-wizStack" role="radiogroup" aria-label={t('wizard.chooseEnvironment')}>
          <ConnectForm draft={draft} credentials={view.credentials} aliases={aliases} busy={busy} t={t}
            errorFor={fieldError}
            onChange={next => setDraft(next)}
            onManageCredentials={() => setCredsOpen(true)} />
          {envPane === 'keys' && scan !== undefined ? (
            <div className="mrfw-wizKeys" role="radiogroup" aria-label={t('ssh.scanConfirmTitle')}>
              <span className="mrfw-wizFieldLabel">{t('ssh.scanPick')}</span>
              {scan.keys.length === 0 ? <p className="mrfw-note">{t('ssh.scanNoKeys')}</p> : scan.keys.map(key => (
                <ChoiceCard key={key.fingerprint}
                  title={key.type}
                  subtitle={<span className="mrfw-wizFingerprint">{key.fingerprint}</span>}
                  trailing={fingerprint === key.fingerprint ? <CheckMark /> : null}
                  selected={fingerprint === key.fingerprint}
                  disabled={busy}
                  onSelect={() => setFingerprint(key.fingerprint)} />
              ))}
            </div>
          ) : null}
        </div>
      )
    }
    return (
      <div className="mrfw-wizStack" role="radiogroup" aria-label={t('wizard.chooseEnvironment')}>
        {view.environments.map(environment => {
          const helperDone = environment.helper !== null
          const managedUnlinked = environment.credential.kind === 'managed' && !linked
          const ready = helperDone && !managedUnlinked
          return (
            <ChoiceCard key={environment.environmentId}
              title={environment.displayName ?? environment.environmentId}
              subtitle={sshTarget(environment.endpoint.user, environment.endpoint.hostname, environment.endpoint.port)}
              icon={<IconLink size={16} />}
              trailing={<>
                <Tag tone={ready ? 'success' : 'warning'} className="mrfw-sshTag">
                  {helperDone ? t('ssh.helperInstalled') : t('ssh.helperMissing')}
                </Tag>
                {selectedId === environment.environmentId ? <CheckMark /> : null}
              </>}
              selected={selectedId === environment.environmentId}
              disabled={busy}
              onSelect={() => select(environment.environmentId)} />
          )
        })}
        {view.environments.length === 0 ? <p className="mrfw-note">{t('wizard.envEmpty')}</p> : null}
        <ChoiceCard
          title={t('wizard.newEnvironment')}
          subtitle={t('ssh.add.personalGuide')}
          icon={<IconPlus size={16} />}
          disabled={busy}
          onSelect={() => { setEnvPane('create'); setAttempted(new Set()) }} />
        {selected !== undefined ? (
          <section className="mrfw-wizSection" aria-label={t('wizard.readiness')}>
            <span className="mrfw-wizFieldLabel">{t('wizard.readiness')}</span>
            <ChecklistRow
              state={pending === 'helper' ? 'ongoing' : selected.helper !== null ? 'done' : 'warning'}
              label={selected.helper !== null ? t('ssh.helperInstalled') : t('ssh.helperMissing')}
              detail={selected.helper === null ? (
                <span className="mrfw-wizNodeBar">
                  <Input className="mrfw-sshInput" aria-label={t('ssh.nodePath')} placeholder={t('ssh.nodePath')}
                    value={nodePath} disabled={busy} onChange={event => setNodePath(event.currentTarget.value)} />
                </span>
              ) : undefined}
              action={selected.helper === null ? (
                <span className="mrfw-sshRowActions">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void testConnection() }}>{t('ssh.add.detectNode')}</Button>
                  <Button variant="primary" size="sm" disabled={busy} loading={pending === 'helper'}
                    onClick={() => { void installHelper() }}>{t('ssh.helperInstall')}</Button>
                </span>
              ) : undefined} />
            {needsAccessKey === true ? (
              <ChecklistRow
                state={pending === 'accessKey' ? 'ongoing' : 'warning'}
                label={t('ssh.accessKey')}
                action={<Button variant="outline" size="sm" disabled={busy} loading={pending === 'accessKey'}
                  onClick={() => { void installAccessKey() }}>{t('ssh.accessKeyInstall')}</Button>} />
            ) : null}
            {needsLink === true ? (
              <ChecklistRow
                state={pending === 'link' ? 'ongoing' : 'warning'}
                label={t('ssh.linkNow')}
                detail={t('ssh.linkBanner')}
                action={<Button variant="outline" size="sm" disabled={busy} loading={pending === 'link'}
                  onClick={() => { void linkConfig() }}>{t('ssh.linkNow')}</Button>} />
            ) : null}
            <ChecklistRow
              state={pending === 'test' ? 'ongoing' : testResult === undefined ? 'idle' : 'done'}
              label={t('ssh.envTest')}
              detail={testResult === undefined ? undefined : testResult}
              action={<Button variant="outline" size="sm" disabled={busy} loading={pending === 'test'}
                onClick={() => { void testConnection() }}>{t('ssh.envTest')}</Button>} />
            <span className="mrfw-wizFieldLabel">{t('wizard.capabilities')}</span>
            <WizardCheckbox checked={capExec}
              disabled={busy || (selected.helper === null && !capExec)}
              hint={selected.helper === null && !capExec ? t('ssh.field.allowExecHelper') : undefined}
              label={t('ssh.field.allowExec')}
              onChange={setCapExec} />
            <WizardCheckbox checked={capTransfer} disabled={busy} label={t('ssh.field.allowTransfer')}
              onChange={setCapTransfer} />
          </section>
        ) : null}
      </div>
    )
  }

  const bindingBody = (): ReactNode => {
    if (selected === undefined) return null
    const pathInvalid = bindingAttempted && !remotePath(binding.path.trim())
    return (
      <div className="mrfw-wizStack">
        <ChoiceCard
          title={selected.displayName ?? selected.environmentId}
          subtitle={sshTarget(selected.endpoint.user, selected.endpoint.hostname, selected.endpoint.port)}
          icon={<IconLink size={16} />}
          trailing={<Tag tone="info" className="mrfw-sshTag">{platformLabel(selected.platform, t)}</Tag>} />
        <WizardField label={t('ssh.binding.path')} invalid={pathInvalid}
          hint={pathInvalid ? t('error.workspace-invalid') : t('ssh.field.workspaceHint')}>
          <div className="mrfw-sshPathBar">
            <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} value={binding.path} disabled={busy}
              onChange={event => setBinding({ ...binding, path: event.currentTarget.value })} />
            <Button variant="outline" size="sm" disabled={busy}
              onClick={() => setPathOpen(true)}>{t('wizard.browse')}</Button>
          </div>
        </WizardField>
        <section className="mrfw-wizSection" aria-label={t('ssh.binding.actions')}>
          <span className="mrfw-wizFieldLabel">{t('ssh.binding.actions')}</span>
          <div className="mrfw-wizCheckRow">
            {(['read', 'write', 'exec'] as const).map(action => (
              <WizardCheckbox key={action} checked={binding[action]}
                disabled={busy || (action === 'exec' && !binding.exec && selected.exec === undefined)}
                label={t(`remote.capability.${action}`)}
                onChange={next => setBinding({ ...binding, [action]: next })} />
            ))}
          </div>
        </section>
        {localPeers.length === 0 ? null : (
          <section className="mrfw-wizSection" aria-label={t('ssh.binding.transfers')}>
            <span className="mrfw-wizFieldLabel">{t('ssh.binding.transfers')}</span>
            {localPeers.map(peer => (
              <div key={peer.id} className="mrfw-wizCheckRow">
                <WizardCheckbox checked={binding.imports.has(peer.id)} label={`${t('ssh.binding.import')} (${peer.label})`}
                  disabled={busy || (selected.transfer === undefined && !binding.imports.has(peer.id))}
                  onChange={() => setBinding({ ...binding, imports: togglePeer(binding.imports, peer.id) })} />
                <WizardCheckbox checked={binding.exports.has(peer.id)} label={`${t('ssh.binding.export')} (${peer.label})`}
                  disabled={busy || (selected.transfer === undefined && !binding.exports.has(peer.id))}
                  onChange={() => setBinding({ ...binding, exports: togglePeer(binding.exports, peer.id) })} />
              </div>
            ))}
          </section>
        )}
        <WizardPathBrowser open={pathOpen} initialPath={binding.path} environmentId={selected.environmentId}
          ssh={ssh} sessionId={sessionId} t={t}
          onClose={() => setPathOpen(false)} onPick={path => setBinding({ ...binding, path })} />
      </div>
    )
  }

  const confirmBody = (): ReactNode => {
    if (selected === undefined) return null
    const actions = (['read', 'write', 'exec'] as const).filter(action => binding[action])
    const transferLines = localPeers.flatMap(peer => {
      const lines: string[] = []
      if (binding.imports.has(peer.id)) lines.push(`${t('ssh.binding.import')} (${peer.label})`)
      if (binding.exports.has(peer.id)) lines.push(`${t('ssh.binding.export')} (${peer.label})`)
      return lines
    })
    return (
      <dl className="mrfw-wizSummary">
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryEnvironment')}</dt>
          <dd>{selected.displayName ?? selected.environmentId} · {sshTarget(selected.endpoint.user, selected.endpoint.hostname, selected.endpoint.port)}</dd>
        </div>
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryPath')}</dt>
          <dd>{sshLocation(sshTarget(selected.endpoint.user, selected.endpoint.hostname, selected.endpoint.port), binding.path.trim())}</dd>
        </div>
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryActions')}</dt>
          <dd>{actions.map(action => t(`remote.capability.${action}`)).join(', ') || t('wizard.summaryNone')}</dd>
        </div>
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryTransfers')}</dt>
          <dd>{transferLines.length === 0 ? t('wizard.summaryNone') : transferLines.join(' · ')}</dd>
        </div>
      </dl>
    )
  }

  const body = ((): ReactNode => {
    if (unavailable) return <p className="mrfw-note">{t('panel.remoteUnavailable', { reason: t('error.remote-personal-unavailable') })}</p>
    if (done) {
      return (
        <div className="mrfw-wizDone">
          <span className="mrfw-wizDoneMark" aria-hidden><CheckMark size={20} /></span>
          <p className="mrfw-wizDoneTitle">{t('wizard.done')}</p>
          <p className="mrfw-note">{t('wizard.doneHint')}</p>
        </div>
      )
    }
    if (stage === 'environment') return environmentBody()
    if (stage === 'binding') return bindingBody()
    return confirmBody()
  })()

  const steps = STAGES.map(id => ({ id, title: t(`wizard.step.${id}` as const) }))

  return <>
    <WizardShell
      title={t('wizard.title')}
      railLabel={t('wizard.railLabel')}
      closeLabel={t('panel.close')}
      onClose={props.onClose}
      busy={busy}
      steps={steps}
      current={stageIndex}
      complete={done}
      footer={footer}
    >
      <PanelErrorToast error={error} t={t} />
      {body}
    </WizardShell>
    {credsOpen && view !== undefined ? (
      <Modal open onClose={() => setCredsOpen(false)} title={t('ssh.credentials')} closeLabel={t('panel.close')}
        className="mrfw-sshDialog" contentClassName="mrfw-sshDialogContent">
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

/** The create-connection form rendered inside the environment step. */
function ConnectForm(props: {
  readonly draft: EditorDraft
  readonly credentials: readonly CredentialPublicView[]
  readonly aliases: readonly string[]
  readonly busy: boolean
  readonly t: Translate
  readonly errorFor: (field: ConnectField) => string | undefined
  readonly onChange: (draft: EditorDraft) => void
  readonly onManageCredentials: () => void
}): ReactNode {
  const { draft, t, busy } = props
  const update = (partial: Partial<EditorDraft>): void => { props.onChange({ ...draft, ...partial }) }
  const invalid = (field: ConnectField): boolean => props.errorFor(field) !== undefined
  const credentials = props.credentials.filter(credential => credential.purpose !== 'access-key')
  return (
    <div className="mrfw-wizStack">
      <WizardField label={t('ssh.field.displayName')}>
        <Input className="mrfw-sshInput" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')}
          value={draft.displayName} disabled={busy}
          onChange={event => update({ displayName: event.currentTarget.value })} />
      </WizardField>
      <WizardField label={t('ssh.field.credentialSource')} hint={t('ssh.field.credentialHint')}>
        <WizardPicker label={t('ssh.field.credentialSource')} value={draft.credentialSource} disabled={busy}
          items={[
            { id: 'managed', label: t('ssh.field.managed') },
            { id: 'alias', label: t('ssh.field.alias') },
          ]}
          onChange={credentialSource => update({ credentialSource })} />
      </WizardField>
      {draft.credentialSource === 'alias' ? (
        <WizardField label={t('ssh.field.alias')} invalid={invalid('alias')}
          hint={invalid('alias') ? props.errorFor('alias') : t('ssh.field.aliasHint')}>
          <AliasInput value={draft.alias} aliases={props.aliases} busy={busy} t={t}
            onChange={alias => update({ alias })} />
        </WizardField>
      ) : (
        <WizardField label={t('ssh.field.managed')} invalid={invalid('credentialId')}
          hint={invalid('credentialId') ? props.errorFor('credentialId')
            : credentials.length === 0 ? t('ssh.add.noCredentials') : t('ssh.field.credentialIdHint')}>
          <div className="mrfw-sshPathBar">
            <WizardPicker label={t('ssh.field.managed')} value={draft.credentialId} disabled={busy}
              invalid={invalid('credentialId')}
              items={credentials.map(credential => ({ id: credential.id, label: credential.label }))}
              onChange={credentialId => update({ credentialId })} />
            <Button variant="outline" size="sm" disabled={busy} onClick={props.onManageCredentials}>{t('ssh.credentialManage')}</Button>
          </div>
        </WizardField>
      )}
      {/* The endpoint in its own ssh-target shape: user @ host : port on one
          line, each input keeping its own label and validation. */}
      <div className="mrfw-wizTargetRow">
        <WizardField label={t('ssh.field.user')} className="mrfw-wizTargetUser"
          invalid={invalid('user')} hint={invalid('user') ? props.errorFor('user') : undefined}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.user')} placeholder="deploy"
            value={draft.user} disabled={busy || draft.credentialSource === 'alias'}
            onChange={event => update({ user: event.currentTarget.value })} />
        </WizardField>
        <span className="mrfw-wizTargetSep" aria-hidden>@</span>
        <WizardField label={t('ssh.field.hostname')} className="mrfw-wizTargetHost"
          invalid={invalid('hostname')} hint={invalid('hostname') ? props.errorFor('hostname') : t('ssh.field.hostnameHint')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.hostname')} placeholder="host.example.com"
            value={draft.hostname} disabled={busy || draft.credentialSource === 'alias'}
            onChange={event => update({ hostname: event.currentTarget.value })} />
        </WizardField>
        <span className="mrfw-wizTargetSep" aria-hidden>:</span>
        <WizardField label={t('ssh.field.port')} className="mrfw-wizTargetPort"
          invalid={invalid('port')} hint={invalid('port') ? props.errorFor('port') : undefined}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.port')} placeholder="22"
            value={draft.port} disabled={busy || draft.credentialSource === 'alias'}
            onChange={event => update({ port: event.currentTarget.value })} />
        </WizardField>
      </div>
      <WizardField label={t('ssh.field.platform')} hint={t('ssh.field.platformHint')}>
        <WizardPicker label={t('ssh.field.platform')} value={draft.platform} disabled={busy}
          items={[
            { id: 'linux', label: t('ssh.platform.linux') },
            { id: 'darwin', label: t('ssh.platform.darwin') },
          ]}
          onChange={platform => update({ platform })} />
      </WizardField>
      {draft.credentialSource === 'alias' ? (
        <p className="mrfw-note">{t('ssh.add.aliasResolvedNote', { alias: draft.alias.trim() || '…' })}</p>
      ) : null}
    </div>
  )
}

/** The alias field with a suggestion menu of local Host entries. */
function AliasInput(props: {
  readonly value: string
  readonly aliases: readonly string[]
  readonly busy: boolean
  readonly t: Translate
  readonly onChange: (alias: string) => void
}): ReactNode {
  const { t } = props
  return (
    <div className="mrfw-sshPathBar">
      <Input className="mrfw-sshInput" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')}
        value={props.value} disabled={props.busy}
        onChange={event => props.onChange(event.currentTarget.value)} />
      {props.aliases.length === 0 ? null : (
        <WizardPicker iconOnly label={t('ssh.field.pickAlias')} value={props.value} disabled={props.busy}
          items={props.aliases.map(alias => ({ id: alias, label: alias }))}
          onChange={props.onChange} />
      )}
    </div>
  )
}
