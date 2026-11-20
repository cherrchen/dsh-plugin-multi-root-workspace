/** SSH connection management and the Workspace's separate Root binding dialog. */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootsView } from '../contract.ts'
import type { RemoteModeControl } from '../compat/skills-client.ts'
import { maybeComponent } from '../compat/client-icons.ts'
import { errorHasDetail, errorKeyOf, PanelError } from './panel-client.ts'
import type { CredentialPublicView, RemoteDirectoryListing, SshBindingView, SshClient, SshManagementClient, SshSettingsView, SshEnvironmentView, SshScanResult, SshStateView } from './ssh-client.ts'
import { SshCustodySection, type RemoteCustodyMode } from './remote-custody.tsx'
import type { Key } from './locales.ts'
import { localBindingPeers } from './remote-root-menu.tsx'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import type { RemoteEndpointView, RemotesView } from '../remote/panel-contract.ts'

/** The three management sections. Adding a connection is a separate dialog. */
export type SshDialogTab = 'connections' | 'keys' | 'mode'

/** The exec stanza the "allow command execution" toggle materializes (ADR-0049). */
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

const SSH_TABS: readonly SshDialogTab[] = ['connections', 'keys', 'mode']

const tabKey = (tab: SshDialogTab): Key => `ssh.tab.${tab}` as Key

/** Render a remote platform with its actual system name. */
export function platformLabel(platform: string, t: Translate): string {
  if (platform === 'linux') return t('ssh.platform.linux')
  if (platform === 'darwin') return t('ssh.platform.darwin')
  if (platform === 'unsupported') return t('ssh.platform.unsupported')
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

// `Checkbox` arrived with the 0.1.7-alpha.1 primitives line. Older supported
// runtimes keep the same semantics through the local, explicitly styled
// fallback below; `Input`, `Button`, and `Tag` exist on every supported
// release and are imported statically.
const CheckboxControl = maybeComponent<(props: CheckboxControlProps) => ReactNode>(['Checkbox'])

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
function Field(props: { readonly label: string; readonly wide?: boolean; readonly className?: string | undefined; readonly children: ReactNode; readonly hint?: string | undefined; readonly invalid?: boolean | undefined }): ReactNode {
  return <div className={'mrfw-sshField' + (props.wide === true ? ' mrfw-sshFieldWide' : '') + (props.invalid === true ? ' mrfw-sshFieldInvalid' : '') + (props.className === undefined ? '' : ' ' + props.className)}>
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
  credentialSource: 'managed', alias: '', credentialId: '', allowExec: false, allowTransfer: false,
})

/** The persisted environmentId rule — checked here so save never reaches the wire with an id the store would refuse. */
const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9-]{2,62}$/

/** The wire alias rule (`sshHostKeyScan` / `credentialDraft`). */
const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** The wire hostname/user rule: non-empty, bounded, no whitespace, no leading dash. */
const sshToken = (value: string, max: number): boolean => {
  const text = value.trim()
  return text.length >= 1 && text.length <= max && !/\s/.test(text) && !text.startsWith('-')
}

/** The wire port rule: an integer from 1 to 65535 — no silent default-22. */
const sshPort = (value: string): boolean => {
  if (!/^\d{1,5}$/.test(value.trim())) return false
  const port = Number.parseInt(value.trim(), 10)
  return port >= 1 && port <= 65535
}

/** `checkRemotePath` mirrored: a normalized absolute POSIX path. */
const remotePath = (path: string): boolean =>
  path.startsWith('/') && !path.includes('\0')
  && !path.split('/').slice(1).some(segment => segment === '' || segment === '.' || segment === '..')

/** Fields validated when adding a connection. */
type WizardField = 'environmentId' | 'hostname' | 'port' | 'user' | 'alias' | 'credentialId'

/** The localized hint key for one invalid field, or undefined when it passes. */
function draftFieldError(draft: EditorDraft, field: WizardField): Key | undefined {
  switch (field) {
    case 'environmentId': return draft.existing !== undefined || ENVIRONMENT_ID.test(draft.environmentId.trim()) ? undefined : 'ssh.field.environmentIdHint'
    case 'hostname': return draft.credentialSource === 'managed' && !sshToken(draft.hostname, 253) ? 'ssh.field.hostnameHint' : undefined
    case 'port': return draft.credentialSource === 'managed' && !sshPort(draft.port) ? 'ssh.field.portHint' : undefined
    case 'user': return draft.credentialSource === 'managed' && !sshToken(draft.user, 64) ? 'ssh.field.userHint' : undefined
    case 'alias': return draft.credentialSource === 'alias' && !SSH_ALIAS.test(draft.alias.trim()) ? 'ssh.field.aliasHint' : undefined
    case 'credentialId': return draft.credentialSource === 'managed' && draft.credentialId === '' ? 'ssh.field.credentialIdHint' : undefined
  }
}

const CONNECT_FIELDS: readonly WizardField[] = ['environmentId', 'user', 'hostname', 'port', 'alias', 'credentialId']

/** The label locale key for one wizard field, used by the summary strip. */
const FIELD_LABELS: Record<WizardField, Key> = {
  environmentId: 'ssh.field.environmentId',
  user: 'ssh.field.user',
  hostname: 'ssh.field.hostname',
  port: 'ssh.field.port',
  alias: 'ssh.field.alias',
  credentialId: 'ssh.field.managed',
}

/** The fields a host-key scan consumes: an alias, or a valid hostname+port. */
function scanReady(draft: EditorDraft): boolean {
  return draft.credentialSource === 'alias'
    ? draftFieldError(draft, 'alias') === undefined
    : draftFieldError(draft, 'hostname') === undefined && draftFieldError(draft, 'port') === undefined
}

/** Whether the connection form is ready to scan. */
function connectionReady(draft: EditorDraft): boolean {
  return CONNECT_FIELDS.every(field => draftFieldError(draft, field) === undefined)
}

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
  allowExec: environment.exec !== undefined,
  allowTransfer: environment.transfer !== undefined,
})

const execHelperReady = (draft: EditorDraft): boolean => {
  const existing = draft.existing
  if (existing === undefined || existing.helper === null) return false
  const port = Number.parseInt(draft.port, 10)
  const credentialKind = draft.credentialSource === 'alias' ? 'ssh-config' : 'managed'
  return existing.endpoint.hostname === draft.hostname.trim()
    && existing.endpoint.port === (Number.isInteger(port) ? port : 22)
    && existing.endpoint.user === draft.user.trim()
    && existing.credential.kind === credentialKind
}

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
  readonly onSave: () => Promise<boolean>
  readonly onCancel: () => void
  readonly onOpenKeys: () => void
  readonly saveLabel: string
  readonly cancelLabel: string
  readonly busy: boolean
  readonly t: Translate
}

/** Edit one saved SSH connection. */
function EnvironmentForm(props: EnvironmentFormProps): ReactNode {
  const { draft, t, busy } = props
  const update = (partial: Partial<EditorDraft>): void => {
    const next = { ...draft, ...partial }
    if (next.allowExec && !execHelperReady(next)) next.allowExec = false
    props.onChange(next)
  }
  // Flat mode (the Connections-tab editor) shows every field, so it applies
  // the strict token/port checks even for an alias-sourced endpoint.
  const canSave = !busy
    && props.fingerprint !== undefined
    && (draft.existing !== undefined || ENVIRONMENT_ID.test(draft.environmentId.trim()))
    && sshToken(draft.hostname, 253)
    && sshPort(draft.port)
    && sshToken(draft.user, 64)
    && (draft.credentialSource === 'alias' ? SSH_ALIAS.test(draft.alias.trim()) : draft.credentialId !== '')
  return <div className="mrfw-sshForm">
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepInfo')}</span>
      <Field label={t('ssh.field.credentialSource')} hint={t('ssh.field.credentialHint')}>
        <span className="mrfw-sshSelect">
          <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.credentialSource')} value={draft.credentialSource}
            onChange={event => update({ credentialSource: event.currentTarget.value as CredentialMode })}>
            <option value="alias">{t('ssh.field.alias')}</option>
            <option value="managed">{t('ssh.field.managed')}</option>
          </select>
        </span>
      </Field>
      <div className="mrfw-sshGrid">
        <Field label={t('ssh.field.environmentId')}
          hint={draft.existing !== undefined || draft.environmentId.trim() === '' || ENVIRONMENT_ID.test(draft.environmentId.trim()) ? undefined : t('ssh.field.environmentIdHint')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.environmentId')} placeholder={t('ssh.field.environmentId')}
            value={draft.environmentId} disabled={draft.existing !== undefined}
            onChange={event => update({ environmentId: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.displayName')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')}
            value={draft.displayName} onChange={event => update({ displayName: event.currentTarget.value })} />
        </Field>
        <div className="mrfw-sshTargetRow">
          <Field label={t('ssh.field.user')} className="mrfw-sshTargetUser">
            <Input className="mrfw-sshInput" aria-label={t('ssh.field.user')} placeholder={t('ssh.field.user')}
              value={draft.user} onChange={event => update({ user: event.currentTarget.value })} />
          </Field>
          <span className="mrfw-sshTargetSep" aria-hidden>@</span>
          <Field label={t('ssh.field.hostname')} className="mrfw-sshTargetHost">
            <Input className="mrfw-sshInput" aria-label={t('ssh.field.hostname')} placeholder={t('ssh.field.hostname')}
              value={draft.hostname} onChange={event => update({ hostname: event.currentTarget.value })} />
          </Field>
          <span className="mrfw-sshTargetSep" aria-hidden>:</span>
          <Field label={t('ssh.field.port')} className="mrfw-sshTargetPort">
            <Input className="mrfw-sshInput" aria-label={t('ssh.field.port')} placeholder={t('ssh.field.port')} type="number"
              value={draft.port} onChange={event => update({ port: event.currentTarget.value })} />
          </Field>
        </div>
        <Field label={t('ssh.field.platform')} hint={t('ssh.field.platformHint')}>
          <span className="mrfw-sshSelect">
            <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.platform')} value={draft.platform}
              onChange={event => update({ platform: event.currentTarget.value as 'linux' | 'darwin' })}>
              <option value="linux">{t('ssh.platform.linux')}</option>
              <option value="darwin">{t('ssh.platform.darwin')}</option>
            </select>
          </span>
        </Field>
      </div>
      <div className="mrfw-sshCheckRow">
        <SshCheckbox checked={draft.allowExec} disabled={busy || !execHelperReady(draft)}
          onChange={next => update({ allowExec: next })} label={t('ssh.field.allowExec')} />
        {execHelperReady(draft) ? null : <span className="mrfw-sshFieldHint">{t('ssh.field.allowExecHelper')}</span>}
        <SshCheckbox checked={draft.allowTransfer} onChange={next => update({ allowTransfer: next })}
          label={t('ssh.field.allowTransfer')} />
      </div>
    </section>
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepKey')}</span>
      <div hidden={draft.credentialSource !== 'alias'}>
        <Field label={t('ssh.field.alias')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')}
            value={draft.alias} onChange={event => update({ alias: event.currentTarget.value })} />
        </Field>
        <p className="mrfw-note">{t('ssh.add.aliasResolvedNote', { alias: draft.alias.trim() })}</p>
      </div>
      <div hidden={draft.credentialSource !== 'managed'}>
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
      {draft.credentialSource === 'managed' ? (
        <span className="mrfw-note">{draft.user.trim()}@{draft.hostname.trim()}:{draft.port.trim()}</span>
      ) : null}
      <div className="mrfw-sshScanRow">
        <Button variant="outline" size="sm" disabled={busy || !scanReady(draft)} onClick={props.onScan}>
          {t('ssh.scan')}
        </Button>
        {draft.credentialSource === 'alias' && draft.hostname.trim() === '' && props.scan !== undefined ? (
          <span className="mrfw-sshFieldHint">{t('ssh.add.aliasUnresolved')}</span>
        ) : null}
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
      <Button variant="primary" disabled={!canSave} onClick={() => { void props.onSave() }}>{props.saveLabel}</Button>
      <Button variant="ghost" disabled={busy} onClick={props.onCancel}>{props.cancelLabel}</Button>
    </div>
  </div>
}

const CONNECT_FORM_FIELDS: readonly WizardField[] = ['environmentId', 'hostname', 'port', 'user', 'alias', 'credentialId']

const togglePeer = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

interface ConnectStepFormProps {
  readonly draft: EditorDraft
  readonly credentials: readonly CredentialPublicView[]
  readonly aliases: readonly string[]
  readonly busy: boolean
  readonly t: Translate
  readonly errorFor: (field: WizardField) => string | undefined
  readonly onChange: (draft: EditorDraft) => void
  readonly onManageCredentials: () => void
}

/** Turn a display name into the persisted environmentId shape. */
const environmentIdFrom = (value: string): string => {
  const slug = value.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return /^[a-z0-9]/.test(slug) ? slug : ''
}

/** Credential source, connection name, and remote target. */
function ConnectStepForm(props: ConnectStepFormProps): ReactNode {
  const { draft, t, busy } = props
  const update = (partial: Partial<EditorDraft>): void => { props.onChange({ ...draft, ...partial }) }
  const invalid = (field: WizardField): boolean => props.errorFor(field) !== undefined
  const fieldErrors = CONNECT_FIELDS
    .map(field => ({ field, message: props.errorFor(field) }))
    .filter((entry): entry is { readonly field: WizardField; readonly message: string } => entry.message !== undefined)
  const aliasListId = 'mrfw-ssh-alias-options'
  return <>
    {fieldErrors.length === 0 ? null : (
      <div className="mrfw-sshErrors" role="alert">
        {fieldErrors.map(entry => (
          <span key={entry.field} className="mrfw-sshErrorItem">
            <span className="mrfw-sshErrorField">{t('ssh.errorField', { field: t(FIELD_LABELS[entry.field]) })}</span>
            <span>{entry.message}</span>
          </span>
        ))}
      </div>
    )}
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.field.credential')}</span>
      <div className="mrfw-sshCredentialRow">
        <Field label={t('ssh.field.credentialSource')} className="mrfw-sshCredentialSource">
          <span className="mrfw-sshSelect">
            <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.credentialSource')} value={draft.credentialSource}
              onChange={event => update({ credentialSource: event.currentTarget.value as CredentialMode })}>
              <option value="alias">{t('ssh.field.alias')}</option>
              <option value="managed">{t('ssh.field.managed')}</option>
            </select>
          </span>
        </Field>
        {draft.credentialSource === 'alias' ? (
          <Field label={t('ssh.field.alias')} invalid={invalid('alias')} className="mrfw-sshCredentialPicker">
            <Input className="mrfw-sshInput" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')}
              list={aliasListId} value={draft.alias}
              onChange={event => update({ alias: event.currentTarget.value })} />
            <datalist id={aliasListId}>
              {props.aliases.map(alias => <option key={alias} value={alias} />)}
            </datalist>
          </Field>
        ) : (
          <>
            <Field label={t('ssh.field.managed')} invalid={invalid('credentialId')} className="mrfw-sshCredentialPicker">
              <span className="mrfw-sshSelect">
                <select className="mrfw-sshSelectControl" aria-label={t('ssh.field.managed')} value={draft.credentialId}
                  onChange={event => update({ credentialId: event.currentTarget.value })}>
                  <option value="">{t('ssh.field.managed')}</option>
                  {props.credentials.map(credential => <option key={credential.id} value={credential.id}>{credential.label}</option>)}
                </select>
              </span>
            </Field>
            <Button className="mrfw-sshCredentialManage" variant="outline" size="sm" disabled={busy} onClick={props.onManageCredentials}>
              {t('ssh.credentialManage')}
            </Button>
          </>
        )}
      </div>
    </section>
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.hostInfo')}</span>
      <div className="mrfw-sshGrid mrfw-sshGridThree">
        <Field label={t('ssh.field.displayName')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')}
            value={draft.displayName} onChange={event => update({ displayName: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.environmentId')} invalid={invalid('environmentId')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.environmentId')} placeholder={t('ssh.field.environmentId')}
            value={draft.environmentId} disabled={draft.existing !== undefined}
            onChange={event => update({ environmentId: event.currentTarget.value })} />
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
        {draft.credentialSource === 'managed' ? (
          <div className="mrfw-sshTargetRow">
            <Field label={t('ssh.field.user')} invalid={invalid('user')} className="mrfw-sshTargetUser">
              <Input className="mrfw-sshInput" aria-label={t('ssh.field.user')} placeholder={t('ssh.field.user')}
                value={draft.user} onChange={event => update({ user: event.currentTarget.value })} />
            </Field>
            <span className="mrfw-sshTargetSep" aria-hidden>@</span>
            <Field label={t('ssh.field.hostname')} invalid={invalid('hostname')} className="mrfw-sshTargetHost">
              <Input className="mrfw-sshInput" aria-label={t('ssh.field.hostname')} placeholder={t('ssh.field.hostname')}
                value={draft.hostname} onChange={event => update({ hostname: event.currentTarget.value })} />
            </Field>
            <span className="mrfw-sshTargetSep" aria-hidden>:</span>
            <Field label={t('ssh.field.port')} invalid={invalid('port')} className="mrfw-sshTargetPort">
              <Input className="mrfw-sshInput" aria-label={t('ssh.field.port')} placeholder={t('ssh.field.port')} type="number"
                value={draft.port} onChange={event => update({ port: event.currentTarget.value })} />
            </Field>
          </div>
        ) : null}
      </div>
    </section>
  </>
}

interface HostKeyConfirmDialogProps {
  readonly open: boolean
  readonly target: string
  readonly keys: SshScanResult['keys']
  readonly fingerprint: string | undefined
  readonly busy: boolean
  readonly t: Translate
  readonly onFingerprint: (fingerprint: string) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** The scan result is a modal decision: confirm one fingerprint before saving. */
function HostKeyConfirmDialog(props: HostKeyConfirmDialogProps): ReactNode {
  const { t } = props
  const footer = <div className="mrfw-sshRowActions mrfw-sshDialogFooterActions">
    <Button variant="ghost" disabled={props.busy} onClick={props.onCancel}>{t('ssh.cancel')}</Button>
    <Button variant="primary" disabled={props.busy || props.fingerprint === undefined} data-modal-autofocus
      onClick={props.onConfirm}>{t('ssh.scanConfirm')}</Button>
  </div>
  return <Modal open={props.open} onClose={props.onCancel} title={t('ssh.scanConfirmTitle')}
    description={t('ssh.scanPick')} closeLabel={t('panel.close')} className="mrfw-sshConfirmDialog" footer={footer}>
    <div className="mrfw-sshArea">
      <span className="mrfw-sshFieldHint">{props.target}</span>
      {props.keys.length === 0 ? <p className="mrfw-note">{t('ssh.scanNoKeys')}</p> : (
        <div className="mrfw-sshRadioGroup" role="radiogroup" aria-label={t('ssh.scanPick')}>
          {props.keys.map(key => (
            <label key={key.fingerprint} className="mrfw-sshRadioOption">
              <input type="radio" name="mrfw-ssh-fp-confirm" checked={props.fingerprint === key.fingerprint}
                onChange={() => props.onFingerprint(key.fingerprint)} />
              <span>{key.type} {key.fingerprint}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  </Modal>
}

type CredentialCreateKind = 'generate' | 'import' | 'password'

interface CredentialsPanelProps {
  readonly credentials: readonly CredentialPublicView[]
  readonly busy: boolean
  readonly t: Translate
  readonly copiedId: string | undefined
  readonly showTitle?: boolean | undefined
  readonly onCopy: (credential: CredentialPublicView) => Promise<void>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onCreate: (kind: CredentialCreateKind, label: string, secret: string, passphrase?: string) => Promise<boolean>
}

/** The credential list plus its three add forms, shared by the Keys tab and the add dialog. */
function CredentialsPanel(props: CredentialsPanelProps): ReactNode {
  const { t, busy } = props
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const [addKind, setAddKind] = useState<CredentialCreateKind | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const clearSecrets = (): void => { setPrivateKey(''); setPassphrase(''); setPassword('') }
  const submit = (kind: CredentialCreateKind): void => {
    const name = label.trim()
    const key = privateKey
    const phrase = passphrase === '' ? undefined : passphrase
    const secret = password
    clearSecrets()
    setLabel('')
    setAddKind(undefined)
    void props.onCreate(kind, name, kind === 'password' ? secret : key, phrase)
  }
  const confirmDelete = (id: string): void => {
    setConfirmId(undefined)
    void props.onDelete(id)
  }
  return <section className="mrfw-subsection">
    {props.showTitle === false ? null : (
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.credentials')}</span></div>
    )}
    <p className="mrfw-note">{t('ssh.keys.personalGuide')}</p>
    {props.credentials.length === 0 ? <p className="mrfw-note">{t('ssh.empty.credentials')}</p> : null}
    {props.credentials.map(credential => (
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
            onClick={() => { void props.onCopy(credential) }}>
            {props.copiedId === credential.id ? t('ssh.copied') : t('ssh.copyPublicKey')}
          </Button>
        ) : null}
        {confirmId === credential.id ? (
          <>
            <Button variant="ghost" size="sm" className="mrfw-sshDanger" disabled={busy}
              onClick={() => { confirmDelete(credential.id) }}>{t('ssh.confirmDelete')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmId(undefined)}>{t('ssh.cancel')}</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => setConfirmId(credential.id)}>{t('ssh.delete')}</Button>
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
          onClick={() => submit(addKind)}>
          {t('panel.addConfirm')}
        </Button>
      </div>
    )}
    <p className="mrfw-note">{t('ssh.keys.accessKeyNote')}</p>
  </section>
}

interface RemotePathDialogProps {
  readonly open: boolean
  readonly initialPath: string
  readonly environmentId: string
  readonly ssh: SshClient | undefined
  readonly sessionId: string | undefined
  readonly t: Translate
  readonly onClose: () => void
  readonly onPick: (path: string) => void
}

/** Read-only SFTP directory picker; a failed listing never blocks a manual path. */
function RemotePathDialog(props: RemotePathDialogProps): ReactNode {
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
  const pick = (): void => {
    const chosen = path.trim() === '' ? listing?.path : path.trim()
    if (chosen === undefined || chosen === '') return
    props.onPick(chosen)
    props.onClose()
  }
  const footer = <div className="mrfw-sshRowActions mrfw-sshDialogFooterActions">
    <Button variant="ghost" onClick={props.onClose}>{t('ssh.cancel')}</Button>
    <Button variant="primary" disabled={path.trim() === '' && listing === undefined} onClick={pick}>{t('ssh.pathPickerUse')}</Button>
  </div>
  return <Modal open={props.open} onClose={props.onClose} title={t('ssh.pathPickerTitle')}
    description={t('ssh.pathPickerHint')} closeLabel={t('panel.close')} className="mrfw-sshPathDialog" footer={footer}>
    <div className="mrfw-sshArea">
      <div className="mrfw-sshPathBar">
        <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} placeholder="/" value={path}
          onChange={event => setPath(event.currentTarget.value)} />
        <Button variant="outline" size="sm" disabled={loading}
          onClick={() => { void load(path.trim() === '' ? undefined : path.trim()) }}>{t('ssh.pathPickerGo')}</Button>
        <Button variant="outline" size="sm" disabled={loading || listing === undefined}
          onClick={() => { void load(listing?.parent) }}>{t('ssh.pathPickerParent')}</Button>
      </div>
      {error === undefined ? null : <p className="mrfw-note" role="alert">{t('ssh.pathPickerFailed', { message: error })}</p>}
      {loading ? <p className="mrfw-note">{t('panel.loading')}</p> : listing === undefined ? null : listing.entries.length === 0 ? (
        <p className="mrfw-note">{t('ssh.pathPickerEmpty')}</p>
      ) : (
        <div className="mrfw-sshDirList">
          {listing.entries.map(entry => (
            <button key={entry.path} type="button" className="mrfw-sshDirRow" onClick={() => { void load(entry.path) }}>
              <span className="mrfw-sshDirName">{entry.name}</span>
              <span className="mrfw-sshDirArrow" aria-hidden>›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  </Modal>
}

interface AddConnectionFormProps {
  readonly draft: EditorDraft
  readonly onChange: (draft: EditorDraft) => void
  readonly credentials: readonly CredentialPublicView[]
  readonly aliases: readonly string[]
  readonly busy: boolean
  readonly t: Translate
  readonly onManageCredentials: () => void
  readonly onScanHost: (draft: EditorDraft) => Promise<SshScanResult | undefined>
  readonly onSave: (draft: EditorDraft, scan: SshScanResult, fingerprint: string) => Promise<void>
  readonly onCancel: () => void
}

function AddConnectionForm(props: AddConnectionFormProps): ReactNode {
  const { draft, t, busy } = props
  const [attempted, setAttempted] = useState<ReadonlySet<WizardField>>(new Set())
  const [idTouched, setIdTouched] = useState(false)
  const [scanDialog, setScanDialog] = useState<{ result: SshScanResult; draft: EditorDraft; fingerprint: string | undefined } | undefined>(undefined)

  const errorFor = (field: WizardField): string | undefined => {
    if (!attempted.has(field)) return undefined
    const key = draftFieldError(draft, field)
    return key === undefined ? undefined : t(key)
  }
  const reveal = (fields: readonly WizardField[]): void => {
    setAttempted(current => {
      const touched = new Set(current)
      for (const field of fields) touched.add(field)
      return touched
    })
  }
  const change = (next: EditorDraft): void => {
    let updated = next
    const manualId = next.environmentId !== draft.environmentId
      && next.displayName === draft.displayName
      && next.alias === draft.alias
    if (manualId) setIdTouched(true)
    if (!idTouched && !manualId && draft.existing === undefined) {
      const source = updated.displayName.trim() !== '' ? updated.displayName : updated.alias
      const generated = environmentIdFrom(source)
      if (generated !== '') updated = { ...updated, environmentId: generated }
      else if (updated.displayName !== draft.displayName || updated.alias !== draft.alias) updated = { ...updated, environmentId: '' }
    }
    setAttempted(current => {
      const touched = new Set(current)
      for (const field of CONNECT_FORM_FIELDS) if (updated[field] !== draft[field]) touched.add(field)
      if (updated.credentialSource !== draft.credentialSource) { touched.add('alias'); touched.add('credentialId') }
      return touched
    })
    props.onChange(updated)
  }

  const scan = async (): Promise<void> => {
    if (!connectionReady(draft)) { reveal(CONNECT_FIELDS); return }
    const result = await props.onScanHost(draft)
    if (result === undefined) return
    const resolved = result.endpoint === undefined ? draft : {
      ...draft,
      hostname: result.endpoint.hostname,
      port: String(result.endpoint.port),
      user: result.endpoint.user,
    }
    if (resolved !== draft) props.onChange(resolved)
    setScanDialog({ result, draft: resolved, fingerprint: result.keys[0]?.fingerprint })
  }

  const confirmScan = async (): Promise<void> => {
    const dialog = scanDialog
    if (dialog === undefined || dialog.fingerprint === undefined) return
    setScanDialog(undefined)
    await props.onSave(dialog.draft, dialog.result, dialog.fingerprint)
  }

  const target = scanDialog === undefined ? '' :
    scanDialog.draft.user.trim() + '@' + scanDialog.draft.hostname.trim() + ':' + scanDialog.draft.port.trim()
  return <div className="mrfw-sshForm">
    <ConnectStepForm draft={draft} credentials={props.credentials} aliases={props.aliases} busy={busy} t={t}
      errorFor={errorFor} onChange={change} onManageCredentials={props.onManageCredentials} />
    <div className="mrfw-sshRowActions">
      <Button variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>{t('ssh.cancel')}</Button>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => { void scan() }}>{t('ssh.scan')}</Button>
    </div>
    <HostKeyConfirmDialog open={scanDialog !== undefined} target={target} keys={scanDialog?.result.keys ?? []}
      fingerprint={scanDialog?.fingerprint} busy={busy} t={t}
      onFingerprint={fingerprint => setScanDialog(current => current === undefined ? current : { ...current, fingerprint })}
      onConfirm={() => { void confirmScan() }} onCancel={() => setScanDialog(undefined)} />
  </div>
}

/** What the dialog needs from the Workspace Folders panel. */
export interface SshManagementDialogProps {
  /** Which tab the entry point asked for. */
  readonly initialTab: SshDialogTab
  /** Personal-mode client; absent when the host exposes no personal contract. */
  readonly ssh: SshManagementClient | undefined
  /** Plugin settings owns the global connection inventory and requires no session. */
  readonly fromSettings?: boolean
  readonly deploymentConnections?: SshSettingsView['connections']
  readonly overviewError?: PanelError | undefined
  /** The live session; the host derives the primary root from it. */
  readonly sessionId: string | undefined
  /** The control plane's live custody mode. */
  readonly custodyMode: RemoteCustodyMode | undefined
  /** The control plane's live state. */
  readonly status: RemotesView['status'] | undefined
  /** The deployment endpoints, used as the read-only team/hardened list. */
  readonly endpoints: readonly RemoteEndpointView[]
  /** The shared remote-tools settings form (same owner as the plugin card). */
  readonly remoteMode: RemoteModeControl | undefined
  readonly onClose: () => void
  /** Ask the Workspace Folders panel to re-read its remote section. */
  readonly onChanged: () => void
  readonly t: Translate
}

/**
 * The SSH connection, credential and mode dialog.
 * @param props - the dialog inputs.
 * @returns the modal, portaled by the shared primitive.
 */
export function SshManagementDialog(props: SshManagementDialogProps): ReactNode {
  const { t, ssh, sessionId, custodyMode, status, endpoints, remoteMode } = props
  const [tab, setTab] = useState<SshDialogTab>(props.initialTab)
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const mounted = useRef(true)

  const [confirm, setConfirm] = useState<{ kind: 'credential' | 'environment'; id: string } | undefined>(undefined)
  const [addDraft, setAddDraft] = useState<EditorDraft>(() => blankEditor())
  const [editDraft, setEditDraft] = useState<EditorDraft | undefined>(undefined)
  const [scan, setScan] = useState<ScanState | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [helperFor, setHelperFor] = useState<string | undefined>(undefined)
  const [helperNodePath, setHelperNodePath] = useState('')
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [credentialManagerOpen, setCredentialManagerOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [aliases, setAliases] = useState<readonly string[]>([])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setTab(props.initialTab) }, [props.initialTab])

  const canRequest = sessionId !== undefined || props.fromSettings === true
  const canManage = custodyMode === 'personal' && status?.state === 'ready' && ssh !== undefined && canRequest
  // Change identity during render: an old promise must not win the gap before
  // the reset effect runs, including personal -> team -> personal transitions.
  const scope = useMemo(() => ({}), [sessionId, custodyMode, canManage, ssh])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const current = useCallback(() => mounted.current && currentScope.current === scope, [scope])
  const stateRequest = useRef(0)
  useEffect(() => { setBusy(false) }, [scope])

  // A session or custody change is a different management scope: drop drafts,
  // secret inputs, and per-connection results instead of carrying them across.
  useEffect(() => {
    setAddDraft(blankEditor())
    setEditDraft(undefined)
    setScan(undefined)
    setFingerprint(undefined)
    setConfirm(undefined)
    setCredentialManagerOpen(false)
    setAddOpen(false)
    setAliases([])
    setSaved(false)
    setError(undefined)
    setTestResults({})
    setHelperFor(undefined)
    setHelperNodePath('')
  }, [sessionId, custodyMode])

  const load = useCallback(async (): Promise<void> => {
    if (ssh === undefined || !canRequest || !current()) return
    const requestId = ++stateRequest.current
    try {
      const state = await ssh.state(sessionId)
      if (current() && requestId === stateRequest.current) setView(state)
    } catch (cause: unknown) {
      if (current() && requestId === stateRequest.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    }
  }, [ssh, sessionId, canRequest, current])

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

  // The alias picker is a convenience only: a failed read leaves the free-text
  // field usable, so the add flow never depends on this answer.
  useEffect(() => {
    if (!canManage || ssh === undefined || !canRequest) {
      setAliases([])
      return
    }
    let active = true
    ssh.aliases(sessionId)
      .then(answer => { if (active && current()) setAliases(answer.aliases) })
      .catch(() => { if (active && current()) setAliases([]) })
    return () => { active = false }
  }, [canManage, ssh, sessionId, canRequest, current])

  /** Clear the form-owned transient state when the operator switches tabs. */
  const changeTab = (next: SshDialogTab): void => {
    setTab(next)
    setError(undefined)
    setSaved(false)
    setConfirm(undefined)
    setScan(undefined)
    setFingerprint(undefined)
    setCredentialManagerOpen(false)
    setAddOpen(false)
  }

  /** The Add connection dialog always starts from a blank draft. */
  const openAdd = (): void => {
    setAddDraft(blankEditor())
    setScan(undefined)
    setFingerprint(undefined)
    setSaved(false)
    setError(undefined)
    setAddOpen(true)
  }

  /** Closing the dialog discards the draft; a saved connection remains available. */
  const closeAdd = (): void => {
    setAddOpen(false)
    setAddDraft(blankEditor())
    setScan(undefined)
    setFingerprint(undefined)
    setSaved(false)
    setCredentialManagerOpen(false)
  }


  /** Every mutation answers the refreshed state; a CAS conflict reloads first. */
  const submitState = useCallback(async (call: () => Promise<SshStateView>): Promise<SshStateView | undefined> => {
    if (!current()) return undefined
    const requestId = ++stateRequest.current
    setBusy(true)
    try {
      const state = await call()
      if (!current() || requestId !== stateRequest.current) return undefined
      if (current()) {
        setView(state)
        setError(undefined)
        setSaved(true)
        props.onChanged()
      }
      return state
    } catch (cause: unknown) {
      const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
      if (current() && requestId === stateRequest.current) {
        setError(failure)
        if (failure.code === 'personal-config-conflict') await load()
      }
      return undefined
    } finally {
      if (current()) setBusy(false)
    }
  }, [load, props.onChanged, current])

  const submit = useCallback(async (call: () => Promise<SshStateView>): Promise<boolean> => {
    return (await submitState(call)) !== undefined
  }, [submitState])

  const revision = (): number => view?.revision ?? 0
  const userCredentials = (view?.credentials ?? []).filter(credential => credential.purpose !== 'access-key')
  const accessKeys = (view?.credentials ?? []).filter(credential => credential.purpose === 'access-key')
  const credentialOf = (id: string | undefined): CredentialPublicView | undefined => view?.credentials.find(credential => credential.id === id)
  const envNextStep = (environment: SshEnvironmentView): 'helper' | 'link' | 'ready' => {
    if (environment.helper === null) return 'helper'
    if (environment.credential.kind === 'managed' && view?.linked !== true) return 'link'
    return 'ready'
  }

  const envSteps = (environment: SshEnvironmentView): { key: 'helper' | 'link'; done: boolean }[] => [
    { key: 'helper', done: environment.helper !== null },
    ...(environment.credential.kind === 'managed' ? [{ key: 'link' as const, done: view?.linked === true }] : []),
  ]

  const deleteCredential = async (id: string): Promise<boolean> => {
    if (ssh === undefined || !canRequest) return false
    return await submit(async () => await ssh.credentialRemove(sessionId, id))
  }

  const createCredential = async (
    kind: 'generate' | 'import' | 'password', label: string, secret: string, passphrase?: string,
  ): Promise<boolean> => {
    if (ssh === undefined || !canRequest) return false
    const known = new Set((view?.credentials ?? []).map(credential => credential.id))
    const state = await submitState(async () => kind === 'generate'
      ? await ssh.credentialGenerate(sessionId, label)
      : kind === 'import'
        ? await ssh.credentialImport(sessionId, label, secret, passphrase)
        : await ssh.credentialPassword(sessionId, label, secret))
    if (state === undefined) return false
    const fresh = state.credentials.find(credential => !known.has(credential.id) && credential.purpose !== 'access-key')
    if (fresh !== undefined) {
      setAddDraft(current => current.credentialSource === 'managed' && current.credentialId === ''
        ? { ...current, credentialId: fresh.id }
        : current)
    }
    return true
  }
  const deleteEnvironment = async (id: string): Promise<void> => {
    if (ssh === undefined || !canRequest) return
    setConfirm(undefined)
    await submit(async () => await ssh.environmentRemove(sessionId, revision(), id))
  }
  const testEnvironment = async (id: string): Promise<void> => {
    if (ssh === undefined || !canRequest) return
    setBusy(true)
    try {
      const result = await ssh.environmentTest(sessionId, id)
      if (current()) {
        setTestResults(previous => ({
          ...previous,
          [id]: `${platformLabel(result.platform, t)}${result.nodeVersion === undefined ? '' : ` · node ${result.nodeVersion}`}`,
        }))
      }
    } catch (cause: unknown) {
      if (current()) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const scanHost = async (draft: EditorDraft, applyPatch: (patch: Partial<EditorDraft>) => void): Promise<void> => {
    if (ssh === undefined || !canRequest || !scanReady(draft)) return
    const alias = draft.credentialSource === 'alias' ? draft.alias.trim() : undefined
    setBusy(true)
    try {
      const result = await ssh.hostKeyScan(sessionId, {
        port: Number.parseInt(draft.port, 10),
        ...(alias === undefined ? { hostname: draft.hostname.trim() } : { alias }),
      })
      if (current()) {
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
      if (current()) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (current()) setBusy(false)
    }
  }

  const scanAddHost = async (draft: EditorDraft): Promise<SshScanResult | undefined> => {
    if (ssh === undefined || !canRequest || !scanReady(draft)) return undefined
    const alias = draft.credentialSource === 'alias' ? draft.alias.trim() : undefined
    setBusy(true)
    try {
      const result = await ssh.hostKeyScan(sessionId, {
        port: Number.parseInt(draft.port, 10),
        ...(alias === undefined ? { hostname: draft.hostname.trim() } : { alias }),
      })
      return current() ? result : undefined
    } catch (cause: unknown) {
      if (current()) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
      return undefined
    } finally {
      if (current()) setBusy(false)
    }
  }

  const saveEnvironment = async (draft: EditorDraft, hostKey: string | undefined, scanToken?: string): Promise<boolean> => {
    if (ssh === undefined || !canRequest || hostKey === undefined || !sshPort(draft.port)) return false
    const environment = {
      environmentId: draft.environmentId.trim(),
      ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
      platform: draft.platform,
      endpoint: { hostname: draft.hostname.trim(), port: Number.parseInt(draft.port, 10), user: draft.user.trim() },
      credential: draft.credentialSource === 'alias'
        ? { kind: 'ssh-config' as const, alias: draft.alias.trim() }
        : { kind: 'managed' as const, credentialId: draft.credentialId },
      ...(draft.allowExec ? { exec: draft.existing?.exec ?? { ...EXEC_DEFAULTS, env: { ...EXEC_DEFAULTS.env }, shell: [...EXEC_DEFAULTS.shell] } } : {}),
      ...(draft.allowTransfer ? { transfer: draft.existing?.transfer ?? { ...TRANSFER_DEFAULTS } } : {}),
    }
    const token = draft.credentialSource === 'managed' ? scanToken : undefined
    const ok = await submit(async () => await ssh.environmentSave(sessionId, revision(), environment, hostKey, token))
    if (!ok) return false
    if (draft.existing === undefined) {
      closeAdd()
      setSaved(true)
    } else {
      setScan(undefined)
      setFingerprint(undefined)
      setEditDraft(undefined)
    }
    return true
  }

  const copyPublicKey = async (credential: CredentialPublicView): Promise<void> => {
    try {
      await navigator.clipboard.writeText(credential.publicKey ?? '')
      if (current()) setCopiedId(credential.id)
    } catch {
      if (current()) setError(new PanelError('copy-failed', 'clipboard write failed'))
    }
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

  /** The current failure; the Add dialog renders its own copy while it is open. */
  const renderError = (): ReactNode => error === undefined ? null : (
    <p role="alert" className="mrfw-alert">
      {t(errorKeyOf(error.code))}
      {errorHasDetail(error.code) ? ` (${error.message})` : ''}
    </p>
  )

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

  const renderCredentials = (): ReactNode => <CredentialsPanel
    credentials={userCredentials}
    busy={busy}
    t={t}
    copiedId={copiedId}
    onCopy={copyPublicKey}
    onDelete={deleteCredential}
    onCreate={createCredential}
  />

  const renderConnections = (): ReactNode => <div className="mrfw-sshArea">
    <p className="mrfw-note">{t('ssh.connections.personalGuide')}</p>
    {view !== undefined && !view.linked && view.environments.some(environment => environment.credential.kind === 'managed') ? (
      <div className="mrfw-alert" role="note">
        <p className="mrfw-note">{t('ssh.linkBanner')}</p>
        <Button variant="outline" size="sm" disabled={busy}
          onClick={() => { if (ssh !== undefined && canRequest) void submit(async () => await ssh.configLink(sessionId)) }}>
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
        const next = envNextStep(environment)
        return (
          <div key={id} className="mrfw-row mrfw-sshEnvRow">
            <div className="mrfw-rootText">
              <span className="mrfw-rootName">
                <span className="mrfw-rootNameText">{environment.displayName ?? id}</span>
                <Tag tone="neutral" className="mrfw-sshTag">{platformLabel(environment.platform, t)}</Tag>
                <Tag tone={environment.helper === null ? 'warning' : 'success'} className="mrfw-sshTag">{environment.helper === null ? t('ssh.helperMissing') : t('ssh.helperInstalled')}</Tag>
              </span>
              <span className="mrfw-rootPath">{environment.endpoint.user}@{environment.endpoint.hostname}:{environment.endpoint.port}</span>
              <span className="mrfw-note">{credentialLabel(environment.credential)}</span>
              <span className="mrfw-sshCheckRow">
                <span className="mrfw-sshFieldHint">{t('ssh.ready.label')}</span>
                {envSteps(environment).map((step, index) => (
                  <Fragment key={step.key}>
                    {index === 0 ? null : <span className="mrfw-sshFieldHint">→</span>}
                    <Tag tone={step.done ? 'success' : step.key === next ? 'warning' : 'outline'} className="mrfw-sshTag">
                      {t(`ssh.step.${step.key}` as Key)}
                    </Tag>
                  </Fragment>
                ))}
                {next === 'ready' ? <Tag tone="success" className="mrfw-sshTag">{t('ssh.ready.done')}</Tag> : null}
              </span>
              {envAccessKeys.map(credential => (
                <span key={credential.id} className="mrfw-note">{t('ssh.accessKey')} · {credential.label}{credential.fingerprint === undefined ? '' : ` · ${credential.fingerprint}`}</span>
              ))}
              {testResults[id] === undefined ? null : <span className="mrfw-note">{testResults[id]}</span>}
              {helperFor === id ? (
                <div className="mrfw-sshHelperRow">
                  <Input className="mrfw-sshHelperInput" aria-label={t('ssh.nodePath')} placeholder={t('ssh.nodePath')}
                    value={helperNodePath} onChange={event => setHelperNodePath(event.currentTarget.value)} />
                  <Button variant="primary" size="sm" disabled={busy}
                    onClick={() => {
                      if (ssh === undefined || !canRequest) return
                      const nodePath = helperNodePath.trim()
                      setHelperFor(undefined)
                      setHelperNodePath('')
                      void submit(async () => await ssh.helperInstall(sessionId, revision(), id, nodePath === '' ? undefined : nodePath))
                    }}>
                    {t('ssh.helperInstall')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => { setHelperFor(undefined); setHelperNodePath('') }}>
                    {t('ssh.cancel')}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="mrfw-sshRowActions">
              {next === 'helper' && helperFor !== id ? (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => setHelperFor(id)}>{t('ssh.helperInstall')}</Button>
              ) : null}
              {next === 'link' ? (
                <Button variant="primary" size="sm" disabled={busy}
                  onClick={() => { if (ssh !== undefined && canRequest) void submit(async () => await ssh.configLink(sessionId)) }}>
                  {t('ssh.linkNow')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void testEnvironment(id) }}>{t('ssh.envTest')}</Button>
              {helperFor !== id && environment.helper !== null ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHelperFor(id)}>{t('ssh.helperInstall')}</Button>
              ) : null}
              {environment.credential.kind === 'managed' && credentialOf(environment.credential.credentialId)?.kind === 'password' ? (
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => { if (ssh !== undefined && canRequest) void submit(async () => await ssh.accessKeyInstall(sessionId, revision(), id)) }}>
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
      <Button variant="primary" size="sm" disabled={busy || editDraft !== undefined} onClick={openAdd}>{t('ssh.tab.add')}</Button>
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
            onSave={async () => await saveEnvironment(editDraft, fingerprint, scan?.token)}
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
    {saved ? <p className="mrfw-note" role="status">{t('ssh.add.saved')}</p> : null}
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
      {endpoints.length === 0 && (props.deploymentConnections?.length ?? 0) === 0 ? <p className="mrfw-note">{t('ssh.connections.emptyDeployment')}</p> : null}
      {props.deploymentConnections?.map(connection => (
        <div key={connection.environmentId} className="mrfw-row">
          <div className="mrfw-rootText">
            <span className="mrfw-rootName">
              <span className="mrfw-rootNameText">{connection.displayName ?? connection.environmentId}</span>
              <Tag tone="neutral" className="mrfw-sshTag">{platformLabel(connection.platform, t)}</Tag>
            </span>
            <span className="mrfw-rootPath">{connection.target}</span>
          </div>
        </div>
      ))}
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
    if (props.overviewError !== undefined) return <p role="alert" className="mrfw-alert">{t(errorKeyOf(props.overviewError.code))}</p>
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal') {
      return <div className="mrfw-sshArea">
        <div className="mrfw-sshGuide">
          <span className="mrfw-sshStepTitle">{t('ssh.tab.add')}</span>
          <p className="mrfw-note">{t(addGuideKey(custodyMode))}</p>
          <Button variant="outline" size="sm" onClick={() => { closeAdd(); changeTab('mode') }}>{t('ssh.add.openMode')}</Button>
        </div>
      </div>
    }
    if (ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (!canRequest) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return <div className="mrfw-sshArea">
      <p className="mrfw-note">{t('ssh.add.personalGuide')}</p>
      {renderError()}
      <AddConnectionForm
        draft={addDraft}
        onChange={setAddDraft}
        credentials={userCredentials}
        aliases={aliases}
        busy={busy}
        t={t}
        onManageCredentials={() => setCredentialManagerOpen(true)}
        onScanHost={scanAddHost}
        onSave={async (draft, result, hostKey) => { await saveEnvironment(draft, hostKey, result.token) }}
        onCancel={closeAdd}
      />
    </div>
  }

  const renderKeys = (): ReactNode => {
    if (props.overviewError !== undefined) return <p role="alert" className="mrfw-alert">{t(errorKeyOf(props.overviewError.code))}</p>
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
    if (!canRequest) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return <div className="mrfw-sshArea">{renderCredentials()}</div>
  }

  const renderConnectionsTab = (): ReactNode => {
    if (props.overviewError !== undefined) return <p role="alert" className="mrfw-alert">{t(errorKeyOf(props.overviewError.code))}</p>
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal') return renderDeploymentConnections()
    if (ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (!canRequest) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
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
      <Button variant="outline" size="sm" onClick={() => changeTab('connections')}>{t('ssh.tab.connections')}</Button>
    </div>
  </div>

  const panel = (): ReactNode => tab === 'connections' ? renderConnectionsTab()
    : tab === 'keys' ? renderKeys()
      : renderMode()

  const panelId = 'mrfw-ssh-panel-' + tab
  const tabId = 'mrfw-ssh-tab-' + tab
  return <>
    <Modal
      open
      onClose={props.onClose}
      title={t('ssh.dialog.title')}
      description={t('ssh.dialog.description')}
      closeLabel={t('panel.close')}
      className="mrfw-sshDialog"
      contentClassName="mrfw-sshDialogContent"
    >
      <SshTabStrip value={tab} onChange={changeTab} t={t} />
      {addOpen ? null : renderError()}
      <div id={panelId} role="tabpanel" aria-labelledby={tabId} className="mrfw-sshDialogPanel">
        {panel()}
      </div>
    </Modal>
    {addOpen ? (
      <Modal
        open
        onClose={closeAdd}
        title={t('ssh.tab.add')}
        closeLabel={t('panel.close')}
        className="mrfw-sshAddDialog"
        contentClassName="mrfw-sshDialogContent"
      >
        {renderAdd()}
      </Modal>
    ) : null}
    {credentialManagerOpen ? (
      <Modal
        open
        onClose={() => setCredentialManagerOpen(false)}
        title={t('ssh.credentials')}
        description={t('ssh.keys.personalGuide')}
        closeLabel={t('panel.close')}
        className="mrfw-sshCredentialDialog"
        contentClassName="mrfw-sshDialogContent"
      >
        <CredentialsPanel
          credentials={userCredentials}
          busy={busy}
          t={t}
          copiedId={copiedId}
          showTitle={false}
          onCopy={copyPublicKey}
          onDelete={deleteCredential}
          onCreate={createCredential}
        />
      </Modal>
    ) : null}
  </>
}

export interface SshWorkspaceBindingsDialogProps {
  readonly ssh: SshClient
  readonly sessionId: string
  readonly roots: RootsView | undefined
  readonly onClose: () => void
  readonly onChanged: () => void
  readonly t: Translate
}

/** Manage only the remote Roots bound to the Workspace of the live session. */
export function SshWorkspaceBindingsDialog(props: SshWorkspaceBindingsDialogProps): ReactNode {
  const { ssh, sessionId, roots, t } = props
  const [view, setView] = useState<SshStateView | undefined>()
  const [draft, setDraft] = useState<BindingDraft>()
  const [editing, setEditing] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PanelError>()
  const lifetime = useRef<AbortController | undefined>(undefined)
  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const next = await ssh.state(sessionId, signal)
      if (!signal.aborted) setView(next)
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    }
  }, [ssh, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const mutate = async (call: (revision: number, signal: AbortSignal) => Promise<SshStateView>): Promise<boolean> => {
    const signal = lifetime.current?.signal
    if (view === undefined || signal === undefined || signal.aborted) return false
    setBusy(true)
    setError(undefined)
    try {
      const next = await call(view.revision, signal)
      if (signal.aborted) return false
      setView(next)
      props.onChanged()
      return true
    } catch (cause) {
      if (!signal.aborted) {
        const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
        setError(failure)
        if (failure.code === 'personal-config-conflict') await load(signal)
      }
      return false
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }

  const localPeers = localBindingPeers(roots, t)
  const environment = view?.environments.find(entry => entry.environmentId === draft?.environmentId)
  const edit = (binding: SshBindingView): void => {
    setEditing(true)
    setDraft({
      environmentId: binding.environmentId, rootId: binding.rootId, path: binding.path,
      read: binding.actions.includes('read'), write: binding.actions.includes('write'), exec: binding.actions.includes('exec'),
      imports: new Set(binding.transfers?.filter(transfer => transfer.direction === 'import').map(transfer => transfer.peer.rootId)),
      exports: new Set(binding.transfers?.filter(transfer => transfer.direction === 'export').map(transfer => transfer.peer.rootId)),
    })
  }
  const save = async (value: BindingDraft): Promise<void> => {
    const actions = (['read', 'write', 'exec'] as const).filter(action => value[action])
    const transfers = [
      ...[...value.imports].map(rootId => ({ direction: 'import', peer: { environmentId: 'local', rootId } })),
      ...[...value.exports].map(rootId => ({ direction: 'export', peer: { environmentId: 'local', rootId } })),
    ]
    const binding = {
      environmentId: value.environmentId, rootId: value.rootId.trim(), path: value.path.trim(), actions,
      ...(transfers.length === 0 ? {} : { transfers }),
    }
    if (await mutate(async (revision, signal) => await ssh.bindingSave(sessionId, revision, binding, signal))) setDraft(undefined)
  }
  const validRootId = draft !== undefined && /^[a-z0-9][a-z0-9-]{0,62}$/.test(draft.rootId.trim())
  const duplicate = !editing && view?.bindings.some(binding => binding.environmentId === draft?.environmentId && binding.rootId === draft?.rootId.trim())
  const validPath = draft !== undefined && remotePath(draft.path.trim())
  return <Modal open title={t('ssh.bindings')} closeLabel={t('panel.close')} onClose={props.onClose}
    className="mrfw-sshDialog" contentClassName="mrfw-sshDialogContent">
    <div className="mrfw-sshArea">
      {error === undefined ? null : <p role="alert" className="mrfw-alert">
        {t(errorKeyOf(error.code))}{errorHasDetail(error.code) ? ` (${error.message})` : ''}
      </p>}
      {view === undefined ? error === undefined ? <p className="mrfw-note">{t('panel.loading')}</p> : (
        <Button variant="outline" size="sm" onClick={() => {
          const signal = lifetime.current?.signal
          if (signal !== undefined) { setError(undefined); void load(signal) }
        }}>{t('panel.retry')}</Button>
      ) : <>
        {view.bindings.length === 0 ? <p className="mrfw-note">{t('ssh.empty.bindings')}</p> : null}
        {view.bindings.map(binding => (
          <div key={`${binding.environmentId}/${binding.rootId}`} className="mrfw-row">
            <div className="mrfw-rootText">
              <span className="mrfw-rootName">
                <span className="mrfw-rootNameText">{view.environments.find(entry => entry.environmentId === binding.environmentId)?.displayName ?? binding.environmentId}</span>
                <Tag tone="outline" className="mrfw-sshTag">{binding.rootId}</Tag>
              </span>
              <span className="mrfw-rootPath">{binding.path}</span>
              <span className="mrfw-note">{binding.actions.map(action => t(`remote.capability.${action}`)).join(', ')}</span>
            </div>
            <div className="mrfw-sshRowActions">
              <Button variant="ghost" size="sm" disabled={busy || draft !== undefined} onClick={() => edit(binding)}>{t('ssh.binding.edit')}</Button>
              <Button variant="ghost" size="sm" disabled={busy || draft !== undefined} onClick={() => {
                void mutate(async (revision, signal) => await ssh.bindingRemove(sessionId, revision, binding.environmentId, binding.rootId, signal))
              }}>{t('ssh.binding.remove')}</Button>
            </div>
          </div>
        ))}
        {view.environments.length === 0 ? <p className="mrfw-note">{t('ssh.binding.noEnvironments')}</p> : null}
        {draft === undefined ? (
          <Button variant="primary" size="sm" disabled={busy || view.environments.length === 0}
            onClick={() => { setEditing(false); setDraft(blankBinding(view.environments[0]?.environmentId)) }}>{t('ssh.bindingAdd')}</Button>
        ) : (
          <div className="mrfw-sshForm">
            <Field label={t('ssh.binding.environment')}>
              <span className="mrfw-sshSelect">
                <select className="mrfw-sshSelectControl" aria-label={t('ssh.binding.environment')} value={draft.environmentId} disabled={busy || editing}
                  onChange={event => setDraft(blankBinding(event.currentTarget.value))}>
                  {view.environments.map(entry => <option key={entry.environmentId} value={entry.environmentId}>{entry.displayName ?? entry.environmentId}</option>)}
                </select>
              </span>
            </Field>
            <Field label={t('ssh.binding.rootId')} invalid={duplicate || (draft.rootId !== '' && !validRootId)}
              hint={duplicate ? t('ssh.binding.duplicate') : undefined}>
              <Input aria-label={t('ssh.binding.rootId')} disabled={busy || editing} value={draft.rootId}
                onChange={event => setDraft({ ...draft, rootId: event.currentTarget.value })} />
            </Field>
            <Field label={t('ssh.binding.path')} invalid={draft.path !== '' && !validPath}
              hint={draft.path !== '' && !validPath ? t('error.workspace-invalid') : undefined}>
              <div className="mrfw-sshPathBar">
                <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} value={draft.path} disabled={busy}
                  onChange={event => setDraft({ ...draft, path: event.currentTarget.value })} />
                <Button variant="outline" size="sm" disabled={busy || environment === undefined} onClick={() => setPathOpen(true)}>{t('ssh.add.pickPath')}</Button>
              </div>
            </Field>
            <div className="mrfw-sshCheckRow" role="group" aria-label={t('ssh.binding.actions')}>
              {(['read', 'write', 'exec'] as const).map(action => (
                <SshCheckbox key={action} checked={draft[action]} disabled={busy || (action === 'exec' && !draft.exec && environment?.exec === undefined)}
                  label={t(`remote.capability.${action}`)} onChange={next => setDraft({ ...draft, [action]: next })} />
              ))}
            </div>
            <div className="mrfw-sshTransferRow" role="group" aria-label={t('ssh.binding.transfers')}>
              {localPeers.map(peer => (
                <div key={peer.id} className="mrfw-sshTransferPeer">
                  <SshCheckbox checked={draft.imports.has(peer.id)} label={`${t('ssh.binding.import')} ${peer.label}`}
                    disabled={busy || (environment?.transfer === undefined && !draft.imports.has(peer.id))}
                    onChange={() => setDraft({ ...draft, imports: togglePeer(draft.imports, peer.id) })} />
                  <SshCheckbox checked={draft.exports.has(peer.id)} label={`${t('ssh.binding.export')} ${peer.label}`}
                    disabled={busy || (environment?.transfer === undefined && !draft.exports.has(peer.id))}
                    onChange={() => setDraft({ ...draft, exports: togglePeer(draft.exports, peer.id) })} />
                </div>
              ))}
            </div>
            <div className="mrfw-sshRowActions">
              <Button variant="primary" disabled={busy || environment === undefined || !validRootId || duplicate || !validPath || !(draft.read || draft.write || draft.exec)}
                onClick={() => { void save(draft) }}>{t('ssh.binding.save')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>{t('ssh.cancel')}</Button>
            </div>
            <RemotePathDialog open={pathOpen} initialPath={draft.path} environmentId={draft.environmentId} ssh={ssh} sessionId={sessionId}
              t={t} onClose={() => setPathOpen(false)} onPick={path => setDraft({ ...draft, path })} />
          </div>
        )}
      </>}
    </div>
  </Modal>
}
