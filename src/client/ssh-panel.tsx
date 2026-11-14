/**
 * The standalone remote-SSH management dialog.
 *
 * The Workspace Folders panel keeps only the remote-workspace list and this
 * dialog's entry points. Everything connection-shaped — the personal add form,
 * saved connections, SSH keys, bindings, and the custody-mode control — lives
 * here, grouped into four tabs. The dialog is deliberately a client-only
 * reorganization: it speaks the same `ssh*` and remote-settings contracts as
 * the inline area it replaces, and every mutation still answers the refreshed
 * `SshStateView` or `RemotesView`.
 *
 * Secret material is input-only: credential textareas are cleared immediately
 * after submit — success or failure — and are never prefilled from state.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-panel
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootsView } from '../contract.ts'
import type { RemoteModeControl } from '../compat/skills-client.ts'
import { maybeComponent } from '../compat/client-icons.ts'
import { errorHasDetail, errorKeyOf, PanelError } from './panel-client.ts'
import type { CredentialPublicView, SshBindingView, SshClient, SshEnvironmentView, SshScanResult, SshStateView } from './ssh-client.ts'
import { SshCustodySection, type RemoteCustodyMode } from './remote-custody.tsx'
import type { Key } from './locales.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import type { RemoteEndpointView, RemotesView } from '../remote/panel-contract.ts'

/** The four management sections. */
export type SshDialogTab = 'add' | 'connections' | 'keys' | 'mode'

/** The exec stanza the "allow command execution" toggle materializes (ADR-0041). */
const EXEC_DEFAULTS = {
  shell: ['/bin/sh', '-c'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  maxTimeoutMs: 600_000,
  stdoutLimit: 1_048_576,
  stderrLimit: 262_144,
  terminateGraceMs: 2_000,
} as const

/** The transfer stanza the "allow file transfer" toggle materializes. */
const TRANSFER_DEFAULTS = { maxBytes: 268_435_456, timeoutMs: 600_000 } as const

const SSH_TABS: readonly SshDialogTab[] = ['add', 'connections', 'keys', 'mode']

const tabKey = (tab: SshDialogTab): Key => `ssh.tab.${tab}` as Key

/** Render a remote platform with its actual system name. */
export function platformLabel(platform: string, t: Translate): string {
  if (platform === 'linux') return t('ssh.platform.linux')
  if (platform === 'darwin') return t('ssh.platform.darwin')
  return platform
}

/** One parsed host-key scan answer. */
type ScanState = SshScanResult

/** The two credential sources a personal environment can use. */
type CredentialMode = 'alias' | 'managed'

interface CheckboxControlProps {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly className?: string | undefined
}

interface CredentialSegmentedProps {
  readonly id: string
  readonly value: CredentialMode
  readonly options: readonly { readonly value: CredentialMode; readonly label: string }[]
  readonly onChange: (next: CredentialMode) => void
  readonly label: string
  readonly className?: string | undefined
}

// `Checkbox` and `SegmentedControl` arrived with the 0.1.7-alpha.1
// primitives line. Older supported runtimes keep the same semantics through
// the local, explicitly styled fallbacks below; `Input`, `Button`, and
// `Tag` exist on every supported release and are imported statically.
const CheckboxControl = maybeComponent<(props: CheckboxControlProps) => ReactNode>(['Checkbox'])
const CredentialSegmented = maybeComponent<(props: CredentialSegmentedProps) => ReactNode>(['SegmentedControl'])

/** A primitive checkbox where available; a native, styled checkbox otherwise. */
function SshCheckbox(props: CheckboxControlProps): ReactNode {
  if (CheckboxControl !== undefined) return <CheckboxControl {...props} />
  return <label className={'mrfw-sshCheckbox' + (props.className === undefined ? '' : ' ' + props.className)}>
    <input type="checkbox" checked={props.checked} disabled={props.disabled === true}
      onChange={event => props.onChange(event.currentTarget.checked)} />
    <span>{props.label}</span>
  </label>
}

/** One labeled form field; the label stays visible after the value is typed. */
function Field(props: { readonly label: string; readonly wide?: boolean; readonly children: ReactNode; readonly hint?: string }): ReactNode {
  return <div className={'mrfw-sshField' + (props.wide === true ? ' mrfw-sshFieldWide' : '')}>
    <span className="mrfw-sshFieldLabel">{props.label}</span>
    {props.children}
    {props.hint === undefined ? null : <span className="mrfw-sshFieldHint">{props.hint}</span>}
  </div>
}

interface EditorDraft {
  readonly existing?: SshEnvironmentView | undefined
  environmentId: string
  displayName: string
  hostname: string
  port: string
  user: string
  platform: 'linux' | 'darwin'
  credentialSource: 'alias' | 'managed'
  alias: string
  credentialId: string
  workspace: string
  allowExec: boolean
  allowTransfer: boolean
}

interface BindingDraft {
  environmentId: string
  rootId: string
  path: string
  read: boolean
  write: boolean
  exec: boolean
  imports: ReadonlySet<string>
  exports: ReadonlySet<string>
}

const blankEditor = (): EditorDraft => ({
  environmentId: '', displayName: '', hostname: '', port: '22', user: '', platform: 'linux',
  credentialSource: 'managed', alias: '', credentialId: '', workspace: '', allowExec: false, allowTransfer: true,
})

const editorOf = (environment: SshEnvironmentView): EditorDraft => ({
  existing: environment,
  environmentId: environment.environmentId,
  displayName: environment.displayName ?? '',
  hostname: environment.endpoint.hostname,
  port: String(environment.endpoint.port),
  user: environment.endpoint.user,
  platform: environment.platform,
  credentialSource: environment.credential.kind === 'ssh-config' ? 'alias' : 'managed',
  alias: environment.credential.kind === 'ssh-config' ? environment.credential.alias : '',
  credentialId: environment.credential.kind === 'managed' ? environment.credential.credentialId : '',
  workspace: environment.workspace,
  allowExec: environment.exec !== undefined,
  allowTransfer: environment.transfer !== undefined,
})

const blankBinding = (environmentId: string | undefined): BindingDraft => ({
  environmentId: environmentId ?? '', rootId: '', path: '', read: true, write: false, exec: false,
  imports: new Set(), exports: new Set(),
})

/** The panel's localized remote-state label. */
function remoteStateKey(state: RemoteEndpointView['state']): Key {
  switch (state) {
    case 'unregistered': return 'remote.state.unregistered'
    case 'registered': return 'remote.state.registered'
    case 'withheld': return 'remote.state.withheld'
    case 'revoked': return 'remote.state.revoked'
  }
}

/** The operator-facing reason for one remote control-plane state. */
function statusText(status: RemotesView['status'], t: Translate): string {
  if (status.code === 'owner-without-remote-plane') return t('remote.status.ownerWithoutRemotePlane')
  return status.reason ?? status.state
}

/** The add-tab guidance key for a custody mode. */
function addGuideKey(mode: RemoteCustodyMode | undefined): Key {
  if (mode === 'team') return 'ssh.add.teamGuide'
  if (mode === 'hardened') return 'ssh.add.hardenedGuide'
  if (mode === 'personal') return 'ssh.add.personalGuide'
  return 'ssh.add.unknownGuide'
}

/** The mode-specific add guidance shown under Mode. */
function modeAddGuideKey(mode: RemoteCustodyMode | undefined): Key {
  if (mode === 'team') return 'ssh.mode.addGuide.team'
  if (mode === 'hardened') return 'ssh.mode.addGuide.hardened'
  return 'ssh.mode.addGuide.personal'
}

interface SegmentedTabsProps {
  readonly items: readonly [SegmentedTab, ...SegmentedTab[]]
  readonly value: SshDialogTab
  readonly onChange: (value: SshDialogTab) => void
  readonly label: string
  readonly className?: string | undefined
}

interface SegmentedTab {
  readonly value: SshDialogTab
  readonly label: ReactNode
  readonly id: string
  readonly panelId: string
}

// `SegmentedTabs` arrived with the 0.1.7-alpha.1 UI-primitives line. Older
// supported runtimes keep the same DOM contract through the local fallback,
// so the client graph never hard-imports a missing export.
const SegmentedTabs = maybeComponent<(props: SegmentedTabsProps) => ReactNode>(['SegmentedTabs'])

/** The tab strip: the shared primitive where present, a local tablist otherwise. */
function SshTabStrip(props: { readonly value: SshDialogTab; readonly onChange: (value: SshDialogTab) => void; readonly t: Translate }): ReactNode {
  const items = SSH_TABS.map(tab => ({
    value: tab,
    label: props.t(tabKey(tab)),
    id: 'mrfw-ssh-tab-' + tab,
    panelId: 'mrfw-ssh-panel-' + tab,
  })) as unknown as readonly [SegmentedTab, ...SegmentedTab[]]
  const label = props.t('ssh.tab.listLabel')
  if (SegmentedTabs !== undefined) {
    return <SegmentedTabs items={items} value={props.value} onChange={props.onChange} label={label} className="mrfw-sshTabs" />
  }
  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const offset = event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowLeft' ? -1
        : event.key === 'Home' ? -index
          : event.key === 'End' ? items.length - 1 - index
            : 0
    if (offset === 0) return
    event.preventDefault()
    event.stopPropagation()
    const next = items[(index + offset + items.length) % items.length]!
    props.onChange(next.value)
    document.getElementById(next.id)?.focus()
  }
  return <div role="tablist" aria-label={label} className="mrfw-sshTabs mrfw-sshTabsFallback">
    {items.map((item, index) => (
      <button
        key={item.value}
        type="button"
        role="tab"
        id={item.id}
        aria-selected={props.value === item.value}
        aria-controls={item.panelId}
        tabIndex={props.value === item.value ? 0 : -1}
        className={'mrfw-sshTab' + (props.value === item.value ? ' mrfw-sshTabActive' : '')}
        onClick={() => { props.onChange(item.value) }}
        onKeyDown={event => { move(event, index) }}
      >
        {item.label}
      </button>
    ))}
  </div>
}

interface EnvironmentFormProps {
  readonly draft: EditorDraft
  readonly onChange: (draft: EditorDraft) => void
  readonly credentials: readonly CredentialPublicView[]
  readonly scan: ScanState | undefined
  readonly fingerprint: string | undefined
  readonly onScan: () => void
  readonly onFingerprint: (fingerprint: string) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly onOpenKeys: () => void
  readonly saveLabel: string
  readonly cancelLabel: string
  readonly busy: boolean
  readonly t: Translate
}

/** The add/edit environment form, shared by the Add and Connections tabs. */
function EnvironmentForm(props: EnvironmentFormProps): ReactNode {
  const { draft, t, busy } = props
  const update = (partial: Partial<EditorDraft>): void => { props.onChange({ ...draft, ...partial }) }
  const canSave = !busy
    && props.fingerprint !== undefined
    && draft.environmentId.trim() !== ''
    && draft.hostname.trim() !== ''
    && draft.user.trim() !== ''
    && draft.workspace.trim() !== ''
    && (draft.credentialSource === 'alias' ? draft.alias.trim() !== '' : draft.credentialId !== '')
  const credentialId = 'mrfw-ssh-cred'
  const segmented = CredentialSegmented !== undefined
  const credentialOptions = [
    { value: 'alias' as const, label: t('ssh.field.alias') },
    { value: 'managed' as const, label: t('ssh.field.managed') },
  ]
  return <div className="mrfw-sshForm">
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepTarget')}</span>
      <div className="mrfw-sshGrid">
        <Field label={t('ssh.field.environmentId')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.environmentId')} placeholder={t('ssh.field.environmentId')}
            value={draft.environmentId} disabled={draft.existing !== undefined}
            onChange={event => update({ environmentId: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.displayName')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')}
            value={draft.displayName} onChange={event => update({ displayName: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.hostname')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.hostname')} placeholder={t('ssh.field.hostname')}
            value={draft.hostname} onChange={event => update({ hostname: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.port')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.port')} placeholder={t('ssh.field.port')} type="number"
            value={draft.port} onChange={event => update({ port: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.user')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.user')} placeholder={t('ssh.field.user')}
            value={draft.user} onChange={event => update({ user: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.platform')}>
          <span className="mrfw-sshSelect">
            <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.platform')} value={draft.platform}
              onChange={event => update({ platform: event.currentTarget.value as 'linux' | 'darwin' })}>
              <option value="linux">{t('ssh.platform.linux')}</option>
              <option value="darwin">{t('ssh.platform.darwin')}</option>
            </select>
          </span>
        </Field>
      </div>
    </section>

    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepCredential')}</span>
      <Field label={t('ssh.field.credential')}>
        {segmented ? (
          <CredentialSegmented id={credentialId} value={draft.credentialSource} options={credentialOptions}
            onChange={next => update({ credentialSource: next })} label={t('ssh.field.credential')} />
        ) : (
          <div className="mrfw-sshRadioGroup" role="radiogroup" aria-label={t('ssh.field.credential')}>
            {credentialOptions.map(option => (
              <label key={option.value} className="mrfw-sshRadioOption">
                <input type="radio" name={credentialId} checked={draft.credentialSource === option.value}
                  onChange={() => update({ credentialSource: option.value })} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
      <div id={`${credentialId}-alias-panel`} role={segmented ? 'tabpanel' : undefined}
        aria-labelledby={segmented ? `${credentialId}-alias` : undefined} hidden={draft.credentialSource !== 'alias'}>
        <Field label={t('ssh.field.alias')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')}
            value={draft.alias} onChange={event => update({ alias: event.currentTarget.value })} />
        </Field>
      </div>
      <div id={`${credentialId}-managed-panel`} role={segmented ? 'tabpanel' : undefined}
        aria-labelledby={segmented ? `${credentialId}-managed` : undefined} hidden={draft.credentialSource !== 'managed'}>
        <Field label={t('ssh.field.managed')}>
          <span className="mrfw-sshSelect">
            <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.managed')} value={draft.credentialId}
              onChange={event => update({ credentialId: event.currentTarget.value })}>
              <option value="">{t('ssh.field.managed')}</option>
              {props.credentials.map(credential => <option key={credential.id} value={credential.id}>{credential.label}</option>)}
            </select>
          </span>
        </Field>
        {props.credentials.length === 0 ? (
          <div className="mrfw-sshInlineNote">
            <span className="mrfw-sshFieldHint">{t('ssh.add.noCredentials')}</span>
            <Button variant="outline" size="sm" disabled={busy} onClick={props.onOpenKeys}>{t('ssh.add.openKeys')}</Button>
          </div>
        ) : null}
      </div>
    </section>

    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepWorkspace')}</span>
      <Field label={t('ssh.field.workspace')} wide>
        <Input className="mrfw-sshInput" aria-label={t('ssh.field.workspace')} placeholder={t('ssh.field.workspace')}
          value={draft.workspace} onChange={event => update({ workspace: event.currentTarget.value })} />
      </Field>
      <div className="mrfw-sshCheckRow">
        <SshCheckbox checked={draft.allowExec} onChange={next => update({ allowExec: next })}
          label={t('ssh.field.allowExec')} />
        <SshCheckbox checked={draft.allowTransfer} onChange={next => update({ allowTransfer: next })}
          label={t('ssh.field.allowTransfer')} />
      </div>
    </section>

    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepHostKey')}</span>
      <div className="mrfw-sshScanRow">
        <Button variant="outline" size="sm" disabled={busy || (draft.credentialSource === 'alias' ? draft.alias.trim() === '' : draft.hostname.trim() === '')} onClick={props.onScan}>
          {t('ssh.scan')}
        </Button>
        {props.scan === undefined ? null : (
          <div className="mrfw-sshRadioGroup" role="radiogroup" aria-label={t('ssh.scanPick')}>
            {props.scan.keys.map(key => (
              <label key={key.fingerprint} className="mrfw-sshRadioOption">
                <input type="radio" name="mrfw-ssh-fp" checked={props.fingerprint === key.fingerprint}
                  onChange={() => props.onFingerprint(key.fingerprint)} />
                <span>{key.type} {key.fingerprint}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </section>

    <div className="mrfw-sshRowActions">
      <Button variant="primary" disabled={!canSave} onClick={props.onSave}>{props.saveLabel}</Button>
      <Button variant="ghost" disabled={busy} onClick={props.onCancel}>{props.cancelLabel}</Button>
    </div>
  </div>
}

/** What the dialog needs from the Workspace Folders panel. */
export interface SshManagementDialogProps {
  /** Which tab the entry point asked for. */
  readonly initialTab: SshDialogTab
  /** Personal-mode client; absent when the host exposes no personal contract. */
  readonly ssh: SshClient | undefined
  /** The live session; the host derives the primary root from it. */
  readonly sessionId: string | undefined
  /** The control plane's live custody mode. */
  readonly custodyMode: RemoteCustodyMode | undefined
  /** The control plane's live state. */
  readonly status: RemotesView['status'] | undefined
  /** The deployment endpoints, used as the read-only team/hardened list. */
  readonly endpoints: readonly RemoteEndpointView[]
  /** The roots view, for the binding local-peer choices. */
  readonly roots: RootsView | undefined
  /** The shared remote-tools settings form (same owner as the plugin card). */
  readonly remoteMode: RemoteModeControl | undefined
  readonly onClose: () => void
  /** Ask the Workspace Folders panel to re-read its remote section. */
  readonly onChanged: () => void
  readonly t: Translate
}

/**
 * The four-tab remote-SSH management dialog.
 * @param props - the dialog inputs.
 * @returns the modal, portaled by the shared primitive.
 */
export function SshManagementDialog(props: SshManagementDialogProps): ReactNode {
  const { t, ssh, sessionId, custodyMode, status, endpoints, roots, remoteMode } = props
  const [tab, setTab] = useState<SshDialogTab>(props.initialTab)
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const mounted = useRef(true)

  const [confirm, setConfirm] = useState<{ kind: 'credential' | 'environment'; id: string } | undefined>(undefined)
  const [addKind, setAddKind] = useState<'generate' | 'import' | 'password' | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [addDraft, setAddDraft] = useState<EditorDraft>(() => blankEditor())
  const [editDraft, setEditDraft] = useState<EditorDraft | undefined>(undefined)
  const [scan, setScan] = useState<ScanState | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [helperFor, setHelperFor] = useState<string | undefined>(undefined)
  const [helperNodePath, setHelperNodePath] = useState('')
  const [bindingDraft, setBindingDraft] = useState<BindingDraft | undefined>(undefined)
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setTab(props.initialTab) }, [props.initialTab])

  const canManage = custodyMode === 'personal' && status?.state === 'ready' && ssh !== undefined && sessionId !== undefined

  // A session or custody change is a different management scope: drop drafts,
  // secret inputs, and per-connection results instead of carrying them across.
  useEffect(() => {
    setAddDraft(blankEditor())
    setEditDraft(undefined)
    setBindingDraft(undefined)
    setScan(undefined)
    setFingerprint(undefined)
    setConfirm(undefined)
    setAddKind(undefined)
    setLabel('')
    setPrivateKey('')
    setPassphrase('')
    setPassword('')
    setSaved(false)
    setError(undefined)
    setTestResults({})
    setHelperFor(undefined)
    setHelperNodePath('')
  }, [sessionId, custodyMode])

  const load = useCallback(async (): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
    try {
      const state = await ssh.state(sessionId)
      if (mounted.current) setView(state)
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    }
  }, [ssh, sessionId])

  useEffect(() => {
    if (!canManage) {
      setView(undefined)
      setError(undefined)
      return
    }
    setView(undefined)
    setError(undefined)
    void load()
  }, [canManage, load])

  /** Clear the form-owned transient state when the operator switches tabs. */
  const changeTab = (next: SshDialogTab): void => {
    setTab(next)
    setError(undefined)
    setSaved(false)
    setConfirm(undefined)
    setScan(undefined)
    setFingerprint(undefined)
    setPrivateKey('')
    setPassphrase('')
    setPassword('')
    setLabel('')
    setAddKind(undefined)
  }


  /** Every mutation answers the refreshed state; a CAS conflict reloads first. */
  const submit = useCallback(async (call: () => Promise<SshStateView>): Promise<boolean> => {
    setBusy(true)
    try {
      const state = await call()
      if (mounted.current) {
        setView(state)
        setError(undefined)
        setSaved(true)
        props.onChanged()
      }
      return true
    } catch (cause: unknown) {
      const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
      if (mounted.current) {
        setError(failure)
        if (failure.code === 'personal-config-conflict') await load()
      }
      return false
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [load, props.onChanged])

  const revision = (): number => view?.revision ?? 0
  const userCredentials = (view?.credentials ?? []).filter(credential => credential.purpose !== 'access-key')
  const accessKeys = (view?.credentials ?? []).filter(credential => credential.purpose === 'access-key')
  const credentialOf = (id: string | undefined): CredentialPublicView | undefined => view?.credentials.find(credential => credential.id === id)
  const environmentOf = (id: string): SshEnvironmentView | undefined => view?.environments.find(environment => environment.environmentId === id)

  const clearSecretInputs = (): void => { setPrivateKey(''); setPassphrase(''); setPassword('') }

  const deleteCredential = async (id: string): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
    setConfirm(undefined)
    await submit(async () => await ssh.credentialRemove(sessionId, id))
  }
  const deleteEnvironment = async (id: string): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
    setConfirm(undefined)
    await submit(async () => await ssh.environmentRemove(sessionId, revision(), id))
  }
  const testEnvironment = async (id: string): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
    setBusy(true)
    try {
      const result = await ssh.environmentTest(sessionId, id)
      if (mounted.current) {
        setTestResults(previous => ({
          ...previous,
          [id]: `${platformLabel(result.platform, t)}${result.nodeVersion === undefined ? '' : ` · node ${result.nodeVersion}`}`,
        }))
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const scanHost = async (draft: EditorDraft, applyPatch: (patch: Partial<EditorDraft>) => void): Promise<void> => {
    if (ssh === undefined || sessionId === undefined) return
    const port = Number.parseInt(draft.port, 10)
    const alias = draft.credentialSource === 'alias' && draft.alias.trim() !== '' ? draft.alias.trim() : undefined
    setBusy(true)
    try {
      const result = await ssh.hostKeyScan(sessionId, {
        port: Number.isInteger(port) ? port : 22,
        ...(alias === undefined ? { hostname: draft.hostname.trim() } : { alias }),
      })
      if (mounted.current) {
        setScan(result)
        setFingerprint(result.keys[0]?.fingerprint)
        // Alias scans resolve `ssh -G` on the host: copy the proven target
        // back into the form so the fingerprint the user confirms is the
        // one `sshEnvironmentSave` re-verifies.
        if (result.endpoint !== undefined) {
          applyPatch({ hostname: result.endpoint.hostname, port: String(result.endpoint.port), user: result.endpoint.user })
        }
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const saveEnvironment = async (draft: EditorDraft): Promise<void> => {
    if (ssh === undefined || sessionId === undefined || fingerprint === undefined) return
    const port = Number.parseInt(draft.port, 10)
    const environment = {
      environmentId: draft.environmentId.trim(),
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
      platform: draft.platform,
      endpoint: { hostname: draft.hostname.trim(), port: Number.isInteger(port) ? port : 22, user: draft.user.trim() },
      credential: draft.credentialSource === 'alias'
        ? { kind: 'ssh-config' as const, alias: draft.alias.trim() }
        : { kind: 'managed' as const, credentialId: draft.credentialId },
      workspace: draft.workspace.trim(),
      ...(draft.allowExec ? { exec: { ...EXEC_DEFAULTS, env: { ...EXEC_DEFAULTS.env }, shell: [...EXEC_DEFAULTS.shell] } } : {}),
      ...(draft.allowTransfer ? { transfer: { ...TRANSFER_DEFAULTS } } : {}),
    }
    const token = draft.credentialSource === 'managed' ? scan?.token : undefined
    const existing = draft.existing !== undefined
    const ok = await submit(async () => await ssh.environmentSave(sessionId, revision(), environment, fingerprint, token))
    if (!ok) return
    setScan(undefined)
    setFingerprint(undefined)
    if (existing) setEditDraft(undefined)
    else setAddDraft(blankEditor())
  }

  const saveBinding = async (): Promise<void> => {
    if (bindingDraft === undefined || ssh === undefined || sessionId === undefined) return
    const actions = ([bindingDraft.read ? 'read' : undefined, bindingDraft.write ? 'write' : undefined, bindingDraft.exec ? 'exec' : undefined]
      .filter(action => action !== undefined))
    if (actions.length === 0) return
    const transfers = [
      ...[...bindingDraft.imports].map(rootId => ({ direction: 'import' as const, peer: { environmentId: 'local' as const, rootId } })),
      ...[...bindingDraft.exports].map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local' as const, rootId } })),
    ]
    const binding = {
      environmentId: bindingDraft.environmentId,
      rootId: bindingDraft.rootId.trim(),
      path: bindingDraft.path.trim(),
      actions,
      ...(transfers.length === 0 ? {} : { transfers }),
    }
    setBindingDraft(undefined)
    await submit(async () => await ssh.bindingSave(sessionId, revision(), binding))
  }

  const copyPublicKey = async (credential: CredentialPublicView): Promise<void> => {
    try {
      await navigator.clipboard.writeText(credential.publicKey ?? '')
      if (mounted.current) setCopiedId(credential.id)
    } catch {
      if (mounted.current) setError(new PanelError('copy-failed', 'clipboard write failed'))
    }
  }

  /** Local transfer peers: 'primary' plus every available root's stable alias id. */
  const localPeers: readonly { id: string; label: string }[] = [
    { id: 'primary', label: t('panel.primary') },
    ...(roots?.roots ?? [])
      .filter(root => root.state === 'available' && root.aliasId !== undefined)
      .map(root => ({ id: root.aliasId!, label: root.alias ?? root.aliasId! })),
  ]

  const togglePeer = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const credentialLabel = (credential: SshEnvironmentView['credential']): string =>
    credential.kind === 'ssh-config'
      ? t('ssh.credential.sshConfig', { alias: credential.alias })
      : t(credentialOf(credential.credentialId)?.kind === 'password' ? 'ssh.credential.managedPassword' : 'ssh.credential.managedKey')

  const openMode = (): void => { changeTab('mode') }

  const renderUnavailable = (): ReactNode =>
    status === undefined
      ? <p className="mrfw-note">{t('panel.loading')}</p>
      : <p className="mrfw-note">{t('panel.remoteUnavailable', { reason: statusText(status, t) })}</p>

  /**
   * The first `sshState` read failed: the alert above names the failure, the
   * tab says so and offers a retry — without it the effect would not re-fire
   * and the tab would keep showing "loading" until the dialog reopened.
   */
  const renderLoadState = (): ReactNode =>
    error === undefined
      ? <p className="mrfw-note">{t('ssh.add.loading')}</p>
      : <div className="mrfw-sshArea">
          <p className="mrfw-note">{t('ssh.loadFailed')}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load() }}>{t('panel.retry')}</Button>
        </div>

  const renderCredentials = (): ReactNode => <section className="mrfw-subsection">
    <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.credentials')}</span></div>
    <p className="mrfw-note">{t('ssh.keys.personalGuide')}</p>
    {userCredentials.length === 0 ? <p className="mrfw-note">{t('ssh.empty.credentials')}</p> : null}
    {userCredentials.map(credential => (
      <div key={credential.id} className="mrfw-row">
        <div className="mrfw-rootText">
          <span className="mrfw-rootName">
            <span className="mrfw-rootNameText">{credential.label}</span>
            <Tag tone="info" className="mrfw-sshTag">{t(credential.kind === 'key' ? 'ssh.kind.key' : 'ssh.kind.password')}</Tag>
          </span>
          {credential.fingerprint === undefined ? null : <span className="mrfw-rootPath">{credential.fingerprint}</span>}
        </div>
        {credential.kind === 'key' && credential.publicKey !== undefined ? (
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => { void copyPublicKey(credential) }}>
            {copiedId === credential.id ? t('ssh.copied') : t('ssh.copyPublicKey')}
          </Button>
        ) : null}
        {confirm?.kind === 'credential' && confirm.id === credential.id ? (
          <>
            <Button variant="ghost" size="sm" className="mrfw-sshDanger" disabled={busy}
              onClick={() => { void deleteCredential(credential.id) }}>{t('ssh.confirmDelete')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(undefined)}>{t('ssh.cancel')}</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => setConfirm({ kind: 'credential', id: credential.id })}>{t('ssh.delete')}</Button>
        )}
      </div>
    ))}
    <div className="mrfw-row mrfw-sshAddRow">
      <Button variant="outline" size="sm" disabled={busy}
        onClick={() => setAddKind(addKind === 'generate' ? undefined : 'generate')}>{t('ssh.credentialGenerate')}</Button>
      <Button variant="outline" size="sm" disabled={busy}
        onClick={() => setAddKind(addKind === 'import' ? undefined : 'import')}>{t('ssh.credentialImport')}</Button>
      <Button variant="outline" size="sm" disabled={busy}
        onClick={() => setAddKind(addKind === 'password' ? undefined : 'password')}>{t('ssh.credentialPassword')}</Button>
    </div>
    {addKind === undefined ? null : (
      <div className="mrfw-sshForm">
        <Field label={t('ssh.label')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.label')} placeholder={t('ssh.label')}
            value={label} onChange={event => setLabel(event.currentTarget.value)} />
        </Field>
        {addKind === 'import' ? (
          <>
            <Field label={t('ssh.privateKey')}>
              <textarea className="mrfw-sshTextarea" aria-label={t('ssh.privateKey')} placeholder={t('ssh.privateKey')}
                value={privateKey} onChange={event => setPrivateKey(event.currentTarget.value)} />
            </Field>
            <Field label={t('ssh.passphrase')}>
              <Input className="mrfw-sshInput" type="password" aria-label={t('ssh.passphrase')}
                placeholder={t('ssh.passphrase')} value={passphrase} onChange={event => setPassphrase(event.currentTarget.value)} />
            </Field>
          </>
        ) : null}
        {addKind === 'password' ? (
          <Field label={t('ssh.password')}>
            <Input className="mrfw-sshInput" type="password" aria-label={t('ssh.password')}
              placeholder={t('ssh.password')} value={password} onChange={event => setPassword(event.currentTarget.value)} />
          </Field>
        ) : null}
        <Button variant="primary"
          disabled={busy || label.trim() === '' || (addKind === 'import' && privateKey === '') || (addKind === 'password' && password === '')}
          onClick={() => {
            if (ssh === undefined || sessionId === undefined) return
            const kind = addKind
            const name = label.trim()
            const key = privateKey
            const phrase = passphrase === '' ? undefined : passphrase
            const secret = password
            clearSecretInputs()
            setLabel('')
            setAddKind(undefined)
            void submit(async () => kind === 'generate'
              ? await ssh.credentialGenerate(sessionId, name)
              : kind === 'import'
                ? await ssh.credentialImport(sessionId, name, key, phrase)
                : await ssh.credentialPassword(sessionId, name, secret))
          }}>
          {t('panel.addConfirm')}
        </Button>
      </div>
    )}
    <p className="mrfw-note">{t('ssh.keys.accessKeyNote')}</p>
  </section>

  const renderBindings = (): ReactNode => <section className="mrfw-subsection">
    <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.bindings')}</span></div>
    <p className="mrfw-note">{t('ssh.connections.bindingsGuide')}</p>
    {(view?.bindings.length ?? 0) === 0 ? <p className="mrfw-note">{t('ssh.empty.bindings')}</p> : null}
    {view?.bindings.map((binding: SshBindingView) => (
      <div key={`${binding.environmentId}/${binding.rootId}`} className="mrfw-row">
        <div className="mrfw-rootText">
          <span className="mrfw-rootName">
            <span className="mrfw-rootNameText">{environmentOf(binding.environmentId)?.displayName ?? binding.environmentId}</span>
            <Tag tone="outline" className="mrfw-sshTag">{binding.rootId}</Tag>
          </span>
          <span className="mrfw-rootPath">{binding.path}</span>
          <span className="mrfw-note">
            {binding.actions.join(', ')}
            {(binding.transfers ?? []).map(transfer => ` · ${transfer.direction === 'import' ? '⇐' : '⇒'} ${transfer.peer.rootId}`).join('')}
          </span>
        </div>
        <Button variant="ghost" size="sm" disabled={busy}
          onClick={() => { if (ssh !== undefined && sessionId !== undefined) void submit(async () => await ssh.bindingRemove(sessionId, revision(), binding.environmentId, binding.rootId)) }}>
          {t('ssh.delete')}
        </Button>
      </div>
    ))}
    <Button variant="outline" size="sm" disabled={busy || bindingDraft !== undefined || (view?.environments.length ?? 0) === 0}
      onClick={() => setBindingDraft(blankBinding(view?.environments[0]?.environmentId))}>
      {t('ssh.bindingAdd')}
    </Button>
    {bindingDraft === undefined ? null : (
      <div className="mrfw-sshForm">
        <Field label={t('ssh.binding.environment')}>
          <span className="mrfw-sshSelect">
            <select className="mrfw-sshSelectControl" aria-label={t('ssh.binding.environment')} value={bindingDraft.environmentId}
              onChange={event => setBindingDraft({ ...bindingDraft, environmentId: event.currentTarget.value })}>
              {(view?.environments ?? []).map(environment => <option key={environment.environmentId} value={environment.environmentId}>{environment.displayName ?? environment.environmentId}</option>)}
            </select>
          </span>
        </Field>
        <div className="mrfw-sshGrid">
          <Field label={t('ssh.binding.rootId')}>
            <Input className="mrfw-sshInput" aria-label={t('ssh.binding.rootId')} placeholder={t('ssh.binding.rootId')}
              value={bindingDraft.rootId} onChange={event => setBindingDraft({ ...bindingDraft, rootId: event.currentTarget.value })} />
          </Field>
          <Field label={t('ssh.binding.path')}>
            <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} placeholder={t('ssh.binding.path')}
              value={bindingDraft.path} onChange={event => setBindingDraft({ ...bindingDraft, path: event.currentTarget.value })} />
          </Field>
        </div>
        <div className="mrfw-sshCheckRow" role="group" aria-label={t('ssh.binding.actions')}>
          {(['read', 'write', 'exec'] as const).map(action => {
            const allowed = action !== 'exec' || environmentOf(bindingDraft.environmentId)?.exec !== undefined
            return (
              <SshCheckbox key={action} checked={bindingDraft[action]} disabled={!allowed}
                label={t(`remote.capability.${action}` as Key)}
                onChange={next => setBindingDraft({ ...bindingDraft, [action]: next })} />
            )
          })}
        </div>
        <div className="mrfw-sshTransferRow" role="group" aria-label={t('ssh.binding.transfers')}>
          {localPeers.map(peer => (
            <div key={peer.id} className="mrfw-sshTransferPeer">
              <SshCheckbox checked={bindingDraft.imports.has(peer.id)}
                label={`${t('ssh.binding.import')} ${peer.label}`}
                onChange={() => setBindingDraft({ ...bindingDraft, imports: togglePeer(bindingDraft.imports, peer.id) })} />
              <SshCheckbox checked={bindingDraft.exports.has(peer.id)}
                label={`${t('ssh.binding.export')} ${peer.label}`}
                onChange={() => setBindingDraft({ ...bindingDraft, exports: togglePeer(bindingDraft.exports, peer.id) })} />
            </div>
          ))}
        </div>
        <div className="mrfw-sshRowActions">
          <Button variant="primary"
            disabled={busy || bindingDraft.environmentId === '' || bindingDraft.rootId.trim() === '' || bindingDraft.path.trim() === ''
              || !(bindingDraft.read || bindingDraft.write || bindingDraft.exec)}
            onClick={() => { void saveBinding() }}>
            {t('ssh.binding.save')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setBindingDraft(undefined)}>{t('ssh.cancel')}</Button>
        </div>
      </div>
    )}
  </section>

  const renderConnections = (): ReactNode => <div className="mrfw-sshArea">
    <p className="mrfw-note">{t('ssh.connections.personalGuide')}</p>
    {view !== undefined && !view.linked && view.environments.some(environment => environment.credential.kind === 'managed') ? (
      <div className="mrfw-alert" role="note">
        <p className="mrfw-note">{t('ssh.linkBanner')}</p>
        <Button variant="outline" size="sm" disabled={busy}
          onClick={() => { if (ssh !== undefined && sessionId !== undefined) void submit(async () => await ssh.configLink(sessionId)) }}>
          {t('ssh.linkNow')}
        </Button>
      </div>
    ) : null}
    <section className="mrfw-subsection">
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.environments')}</span></div>
      {(view?.environments.length ?? 0) === 0 ? <p className="mrfw-note">{t('ssh.empty.environments')}</p> : null}
      {view?.environments.map(environment => {
        const id = environment.environmentId
        const envAccessKeys = accessKeys.filter(credential => credential.environmentId === id)
        return (
          <div key={id} className="mrfw-row mrfw-sshEnvRow">
            <div className="mrfw-rootText">
              <span className="mrfw-rootName">
                <span className="mrfw-rootNameText">{environment.displayName ?? id}</span>
                <Tag tone="neutral" className="mrfw-sshTag">{platformLabel(environment.platform, t)}</Tag>
                <Tag tone={environment.helper === null ? 'warning' : 'success'} className="mrfw-sshTag">{environment.helper === null ? t('ssh.helperMissing') : t('ssh.helperInstalled')}</Tag>
              </span>
              <span className="mrfw-rootPath">{environment.endpoint.user}@{environment.endpoint.hostname}:{environment.endpoint.port} · {environment.workspace}</span>
              <span className="mrfw-note">{credentialLabel(environment.credential)}</span>
              {envAccessKeys.map(credential => (
                <span key={credential.id} className="mrfw-note">{t('ssh.accessKey')} · {credential.label}{credential.fingerprint === undefined ? '' : ` · ${credential.fingerprint}`}</span>
              ))}
              {testResults[id] === undefined ? null : <span className="mrfw-note">{testResults[id]}</span>}
            </div>
            <div className="mrfw-sshRowActions">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void testEnvironment(id) }}>{t('ssh.envTest')}</Button>
              {helperFor === id ? (
                <>
                  <Input className="mrfw-sshHelperInput" aria-label={t('ssh.nodePath')} placeholder={t('ssh.nodePath')}
                    value={helperNodePath} onChange={event => setHelperNodePath(event.currentTarget.value)} />
                  <Button variant="primary" size="sm" disabled={busy}
                    onClick={() => {
                      if (ssh === undefined || sessionId === undefined) return
                      const nodePath = helperNodePath.trim()
                      setHelperFor(undefined)
                      setHelperNodePath('')
                      void submit(async () => await ssh.helperInstall(sessionId, revision(), id, nodePath === '' ? undefined : nodePath))
                    }}>
                    {t('ssh.helperInstall')}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHelperFor(id)}>{t('ssh.helperInstall')}</Button>
              )}
              {environment.credential.kind === 'managed' && credentialOf(environment.credential.credentialId)?.kind === 'password' ? (
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => { if (ssh !== undefined && sessionId !== undefined) void submit(async () => await ssh.accessKeyInstall(sessionId, revision(), id)) }}>
                  {t('ssh.accessKeyInstall')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={busy}
                onClick={() => { setEditDraft(editorOf(environment)); setScan(undefined); setFingerprint(undefined) }}>
                {t('ssh.envEdit')}
              </Button>
              {confirm?.kind === 'environment' && confirm.id === id ? (
                <>
                  <Button variant="ghost" size="sm" className="mrfw-sshDanger" disabled={busy}
                    title={t('ssh.envDeleteHint')} onClick={() => { void deleteEnvironment(id) }}>{t('ssh.confirmDelete')}</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(undefined)}>{t('ssh.cancel')}</Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} title={t('ssh.envDeleteHint')}
                  onClick={() => setConfirm({ kind: 'environment', id })}>{t('ssh.envDelete')}</Button>
              )}
            </div>
          </div>
        )
      })}
      <p className="mrfw-note">{t('ssh.connections.registerHint')}</p>
      <Button variant="outline" size="sm" disabled={busy || editDraft !== undefined} onClick={() => changeTab('add')}>{t('ssh.envAdd')}</Button>
      {editDraft === undefined ? null : (
        <div className="mrfw-sshEdit">
          <span className="mrfw-sshStepTitle">{t('ssh.envEdit')}</span>
          <EnvironmentForm
            draft={editDraft}
            onChange={setEditDraft}
            credentials={userCredentials}
            scan={scan}
            fingerprint={fingerprint}
            onScan={() => { void scanHost(editDraft, patch => { setEditDraft(current => current === undefined ? current : { ...current, ...patch }) }) }}
            onFingerprint={setFingerprint}
            onSave={() => { void saveEnvironment(editDraft) }}
            onCancel={() => { setEditDraft(undefined); setScan(undefined); setFingerprint(undefined) }}
            onOpenKeys={() => changeTab('keys')}
            saveLabel={t('ssh.envSave')}
            cancelLabel={t('ssh.cancel')}
            busy={busy}
            t={t}
          />
        </div>
      )}
    </section>
    {renderBindings()}
  </div>

  const renderDeploymentConnections = (): ReactNode => <div className="mrfw-sshArea">
    <p className="mrfw-note">
      {custodyMode === undefined
        ? t('ssh.add.unknownGuide')
        : t('ssh.connections.deploymentGuide', { mode: t(`remote.mode.${custodyMode}` as Key) })}
    </p>
    <Button variant="outline" size="sm" onClick={openMode}>{t('ssh.add.openMode')}</Button>
    <section className="mrfw-subsection">
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.connections.deploymentList')}</span></div>
      {endpoints.length === 0 ? <p className="mrfw-note">{t('ssh.connections.emptyDeployment')}</p> : null}
      {endpoints.map(endpoint => (
        <div key={`${endpoint.environmentId}/${endpoint.rootId}`} className="mrfw-row">
          <div className="mrfw-rootText">
            <span className="mrfw-rootName">
              <span className="mrfw-rootNameText">{endpoint.displayName ?? endpoint.environmentId}</span>
              <Tag tone="neutral" className="mrfw-sshTag">{platformLabel(endpoint.platform, t)}</Tag>
              <Tag tone={endpoint.state === 'registered' ? 'success' : endpoint.state === 'withheld' ? 'warning' : 'outline'} className="mrfw-sshTag">{t(remoteStateKey(endpoint.state))}</Tag>
            </span>
            <span className="mrfw-rootPath" title={endpoint.path}>{endpoint.rootId} · {endpoint.path}</span>
          </div>
        </div>
      ))}
    </section>
  </div>

  const renderAdd = (): ReactNode => {
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal') {
      return <div className="mrfw-sshArea">
        <div className="mrfw-sshGuide">
          <span className="mrfw-sshStepTitle">{t('ssh.tab.add')}</span>
          <p className="mrfw-note">{t(addGuideKey(custodyMode))}</p>
          <Button variant="outline" size="sm" onClick={openMode}>{t('ssh.add.openMode')}</Button>
        </div>
      </div>
    }
    if (ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (sessionId === undefined) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return <div className="mrfw-sshArea">
      <p className="mrfw-note">{t('ssh.add.personalGuide')}</p>
      {saved ? <p className="mrfw-note" role="status">{t('ssh.add.saved')}</p> : null}
      <EnvironmentForm
        draft={addDraft}
        onChange={setAddDraft}
        credentials={userCredentials}
        scan={scan}
        fingerprint={fingerprint}
        onScan={() => { void scanHost(addDraft, patch => { setAddDraft(current => ({ ...current, ...patch })) }) }}
        onFingerprint={setFingerprint}
        onSave={() => { void saveEnvironment(addDraft) }}
        onCancel={() => { setAddDraft(blankEditor()); setScan(undefined); setFingerprint(undefined); setSaved(false) }}
        onOpenKeys={() => changeTab('keys')}
        saveLabel={t('ssh.add.save')}
        cancelLabel={t('ssh.add.reset')}
        busy={busy}
        t={t}
      />
    </div>
  }

  const renderKeys = (): ReactNode => {
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal') {
      return <div className="mrfw-sshArea">
        <p className="mrfw-note">
          {custodyMode === undefined
            ? t('ssh.add.unknownGuide')
            : t('ssh.keys.teamGuide', { mode: t(`remote.mode.${custodyMode}` as Key) })}
        </p>
        <Button variant="outline" size="sm" onClick={openMode}>{t('ssh.add.openMode')}</Button>
      </div>
    }
    if (ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (sessionId === undefined) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return <div className="mrfw-sshArea">{renderCredentials()}</div>
  }

  const renderConnectionsTab = (): ReactNode => {
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal') return renderDeploymentConnections()
    if (ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (sessionId === undefined) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return renderConnections()
  }

  const renderMode = (): ReactNode => <div className="mrfw-sshArea">
    <p className="mrfw-note">{t('ssh.mode.guide')}</p>
    {remoteMode === undefined
      ? <p className="mrfw-note">{t('ssh.mode.unavailable')}</p>
      : <SshCustodySection control={remoteMode} currentMode={custodyMode} onChanged={props.onChanged} t={t} />}
    <div className="mrfw-sshGuide">
      <span className="mrfw-sshStepTitle">{t('ssh.tab.add')}</span>
      <p className="mrfw-note">{t(modeAddGuideKey(custodyMode))}</p>
      <Button variant="outline" size="sm" onClick={() => changeTab('add')}>{t('ssh.mode.openAdd')}</Button>
    </div>
  </div>

  const panel = (): ReactNode => tab === 'add' ? renderAdd()
    : tab === 'connections' ? renderConnectionsTab()
      : tab === 'keys' ? renderKeys()
        : renderMode()

  const panelId = 'mrfw-ssh-panel-' + tab
  const tabId = 'mrfw-ssh-tab-' + tab
  return <Modal
    open
    onClose={props.onClose}
    title={t('ssh.dialog.title')}
    description={t('ssh.dialog.description')}
    closeLabel={t('panel.close')}
    className="mrfw-sshDialog"
    contentClassName="mrfw-sshDialogContent"
  >
    <SshTabStrip value={tab} onChange={changeTab} t={t} />
    {error === undefined ? null : (
      <p role="alert" className="mrfw-alert">
        {t(errorKeyOf(error.code))}
        {errorHasDetail(error.code) ? ` (${error.message})` : ''}
      </p>
    )}
    <div id={panelId} role="tabpanel" aria-labelledby={tabId} className="mrfw-sshDialogPanel">
      {panel()}
    </div>
  </Modal>
}
