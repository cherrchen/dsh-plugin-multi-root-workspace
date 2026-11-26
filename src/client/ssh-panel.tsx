/** SSH connection management and the Workspace's separate Root binding dialog. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button as PrimitiveButton, Input, Menu, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootsView } from '../contract.ts'
import { IconAccessReadOnly, IconAccessReadWrite, IconCheck, IconChevronDown, IconClose, IconCopy, IconDownload, IconEdit, IconLink, IconPlay, IconPlus, IconShield, IconTrash, maybeComponent } from '../compat/client-icons.ts'
import { IconButton, SshButton as Button } from './panel-buttons.tsx'
import { PendingBar, StatusLine } from './pending.tsx'
import { sshLocation, sshTarget } from '../remote/ssh-location.ts'
import { RemoteRootConfirm } from './remote-root-confirm.tsx'
import { PanelError } from './panel-client.ts'
import { PanelErrorToast, SshErrorDetail } from './error-toast.tsx'
import { SshDependencyNotice } from './ssh-dependencies.tsx'
import type { CredentialPublicView, SshBindingView, SshClient, SshManagementClient, SshEnvironmentView, SshScanResult, SshStateView } from './ssh-client.ts'
import {
  bindingDraftOf, blankBinding, editorIdentity, editorOf, environmentDraftOf, execHelperReady,
  newEnvironmentId, recordedFingerprint, remotePath, scanReady, scanTargetOf, sshPort, sshToken, togglePeer,
  SSH_ALIAS,
  type BindingDraft,
  type EditorDraft,
} from './ssh-draft.ts'
import { AddBindingWizard, type BindingSaveResult } from './wizard/add-binding.tsx'
import type { RemotesClient } from './remotes-client.ts'
import { AddConnectionWizard } from './wizard/add-connection.tsx'
import { WizardPathBrowser } from './wizard/add-remote.tsx'
import { ChoiceCard, WizardActions, WizardCheckbox, WizardField, WizardPicker } from './wizard/kit.tsx'
import type { Key } from './locales.ts'
import { localBindingPeers } from './remote-root-menu.tsx'
import { WorkspaceRow } from './workspace-row.tsx'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import type { RemotesView } from '../remote/panel-contract.ts'

/** The two management sections. Adding a connection is a separate dialog. */
export type SshDialogTab = 'connections' | 'keys'

const SSH_TABS: readonly SshDialogTab[] = ['connections', 'keys']

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

/**
 * The network-bound operation currently in flight. Row-scoped kinds carry the
 * environment id so exactly one control reports progress; the global kinds
 * cover the dialogs' own scan/save/credential flows.
 */
type ManageOp =
  | { readonly kind: 'scan' | 'save' | 'credential' }
  | { readonly kind: 'remove' | 'helper' | 'accessKey' | 'link'; readonly id?: string }

/** Whether the pending op is the row-scoped kind targeting this environment. */
function pendingRowKind(op: ManageOp | undefined, id: string): 'remove' | 'helper' | 'accessKey' | 'link' | undefined {
  if (op === undefined) return undefined
  switch (op.kind) {
    case 'remove':
    case 'helper':
    case 'accessKey':
    case 'link':
      return op.id === id ? op.kind : undefined
    default:
      return undefined
  }
}

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

/** Single-choice fields use the same anchored menu as the host's settings. */
function SshPicker<Value extends string>(props: {
  readonly label: string
  readonly value: Value
  readonly items: readonly { id: Value; label: string }[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean
  readonly invalid?: boolean
  readonly iconOnly?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const disabled = props.disabled === true || props.items.length === 0
  const expanded = open && !disabled
  const selectedLabel = props.items.find(item => item.id === props.value)?.label ?? props.label
  return <Menu open={expanded} items={props.items} selectedId={props.value} portal autoFocus
    align={props.iconOnly ? 'end' : 'start'}
    className={props.iconOnly ? 'mrfw-sshPickerCompact' : 'mrfw-sshPicker'}
    onClose={() => setOpen(false)}
    onSelect={id => {
      setOpen(false)
      const choice = props.items.find(item => item.id === id)
      if (choice !== undefined && choice.id !== props.value) props.onChange(choice.id)
    }}
    anchor={<PrimitiveButton type="button" size="sm" variant="outline"
      className={props.iconOnly ? 'mrfw-sshButton' : 'mrfw-sshButton mrfw-sshPickerTrigger'}
      disabled={disabled} aria-label={props.label}
      aria-description={props.iconOnly || selectedLabel === props.label ? undefined : selectedLabel}
      aria-invalid={props.invalid || undefined}
      aria-haspopup="menu" aria-expanded={expanded}
      title={props.iconOnly ? props.label : selectedLabel}
      onClick={() => setOpen(!expanded)}
      onKeyDown={event => {
        if (expanded || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
        event.preventDefault()
        setOpen(true)
      }}>
      {props.iconOnly ? null : <span className="mrfw-sshPickerLabel">{selectedLabel}</span>}
      <IconChevronDown size={14} aria-hidden="true" />
    </PrimitiveButton>}
  />
}

function SshAliasInput(props: {
  readonly value: string
  readonly aliases: readonly string[]
  readonly busy: boolean
  readonly invalid?: boolean
  readonly onChange: (value: string) => void
  readonly t: Translate
}): ReactNode {
  const { t } = props
  return <div className="mrfw-sshAliasInput">
    <Input className="mrfw-sshInput" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')}
      value={props.value} disabled={props.busy} aria-invalid={props.invalid || undefined}
      onChange={event => props.onChange(event.currentTarget.value)} />
    {props.aliases.length === 0 ? null : (
      <SshPicker iconOnly label={t('ssh.field.pickAlias')} value={props.value} disabled={props.busy}
        items={props.aliases.map(alias => ({ id: alias, label: alias }))} onChange={props.onChange} />
    )}
  </div>
}

const credentialSources = (t: Translate): readonly { id: CredentialMode; label: string }[] => [
  { id: 'alias', label: t('ssh.field.alias') },
  { id: 'managed', label: t('ssh.field.managed') },
]

const platforms = (t: Translate): readonly { id: EditorDraft['platform']; label: string }[] => [
  { id: 'linux', label: t('ssh.platform.linux') },
  { id: 'darwin', label: t('ssh.platform.darwin') },
]

const managedCredentials = (credentials: readonly CredentialPublicView[], t: Translate): readonly { id: string; label: string }[] =>
  credentials.length === 0 ? [] : [
    { id: '', label: t('ssh.field.managed') },
    ...credentials.map(credential => ({ id: credential.id, label: credential.label })),
  ]

/** The operator-facing reason for one remote control-plane state. */
function statusText(status: RemotesView['status'], t: Translate): string {
  if (status.code === 'owner-without-remote-plane') return t('remote.status.ownerWithoutRemotePlane')
  return status.reason ?? status.state
}

function SshSettingsNavigation({ value, onChange, t }: {
  readonly value: SshDialogTab
  readonly onChange: (value: SshDialogTab) => void
  readonly t: Translate
}): ReactNode {
  return <nav aria-label={t('ssh.tab.listLabel')} className="mrfw-sshSettingsNav">
    {SSH_TABS.map(tab => (
      <button key={tab} type="button" aria-current={value === tab || undefined}
        data-modal-autofocus={value === tab || undefined}
        className="mrfw-sshSettingsNavItem"
        onFocus={event => event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}
        onClick={() => { if (value !== tab) onChange(tab) }}>
        {tab === 'connections' ? <IconLink size={16} aria-hidden="true" /> : <IconShield size={16} aria-hidden="true" />}
        <span>{t(tabKey(tab))}</span>
      </button>
    ))}
  </nav>
}

interface SshSettingsShellProps {
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
  readonly busy: boolean
  readonly navigation: ReactNode
  readonly children: ReactNode
}

type SettingsModalLayer = (dialog: RefObject<HTMLDivElement>, open: boolean, onClose: () => void) => void
const hostSettingsModalLayer = maybeComponent<SettingsModalLayer>(['useModalLayer'])
const useSettingsModalLayer = hostSettingsModalLayer ?? (() => {})

/** Match SettingsRoot's title, close, navigation, and content grid. */
function SshSettingsShell({ title, closeLabel, onClose, busy, navigation, children }: SshSettingsShellProps): ReactNode {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useSettingsModalLayer(dialog, true, onClose)
  if (hostSettingsModalLayer === undefined) {
    return <Modal open title={title} closeLabel={closeLabel} onClose={onClose}
      className="mrfw-sshSettingsDialog" contentClassName="mrfw-sshSettingsFallback">
      <PendingBar active={busy} />
      <div className="mrfw-sshSettingsGrid">{navigation}{children}</div>
    </Modal>
  }
  return createPortal(
    <div className="mrfw-sshSettingsOverlay" role="presentation">
      <div className="mrfw-sshSettingsMask" aria-hidden="true" onClick={onClose} />
      <div ref={dialog} tabIndex={-1} className="mrfw-sshSettingsDialog mrfw-sshSettingsGrid"
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="mrfw-sshSettingsTitle">{title}</h2>
        <div className="mrfw-sshSettingsHeader">
          <button type="button" aria-label={closeLabel} className="mrfw-sshSettingsClose" onClick={onClose}>
            <CloseGlyph size={14} />
          </button>
        </div>
        {navigation}
        {children}
        <PendingBar active={busy} />
      </div>
    </div>,
    document.body,
  )
}

interface SshSettingsCardProps {
  readonly name: ReactNode
  readonly metadata?: ReactNode
  readonly actions: ReactNode
  readonly children?: ReactNode
}

function SshSettingsCard({ name, metadata, actions, children }: SshSettingsCardProps): ReactNode {
  return <li className="mrfw-sshSettingsCard">
    <div className="mrfw-sshSettingsCardMain">
      <div className="mrfw-sshSettingsCardText">
        <div className="mrfw-sshSettingsCardTitle">{name}</div>
        {metadata}
      </div>
      {actions}
    </div>
    {children}
  </li>
}

function SshSettingsAdd({ disabled, label, expanded, onClick }: {
  readonly disabled: boolean
  readonly label: string
  readonly expanded?: boolean
  readonly onClick: () => void
}): ReactNode {
  return <Button variant="outline" className="mrfw-sshSettingsAdd" disabled={disabled} aria-expanded={expanded} onClick={onClick}>
    <IconPlus size={16} aria-hidden="true" />{label}
  </Button>
}

function CheckGlyph(): ReactNode {
  return IconCheck === undefined ? <span aria-hidden="true">✓</span> : <IconCheck size={16} aria-hidden="true" />
}

function CloseGlyph({ size = 16 }: { readonly size?: number }): ReactNode {
  return IconClose === undefined ? <span aria-hidden="true">×</span> : <IconClose size={size} aria-hidden="true" />
}

function SshDeleteConfirmation({ busy, t, onConfirm, onCancel }: {
  readonly busy: boolean
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  return <>
    <Button variant="ghost" size="sm" className="mrfw-sshDanger" disabled={busy} onClick={onConfirm}>{t('ssh.confirmDelete')}</Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('ssh.cancel')}</Button>
  </>
}

interface EnvironmentFormProps {
  readonly draft: EditorDraft
  readonly onChange: (draft: EditorDraft) => void
  readonly credentials: readonly CredentialPublicView[]
  readonly aliases: readonly string[]
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
  /** Which of this form's own requests is in flight, for the spinner and status line. */
  readonly pending: 'scan' | 'save' | undefined
  readonly t: Translate
}

/** Edit one saved SSH connection. */
function EnvironmentForm(props: EnvironmentFormProps): ReactNode {
  const { draft, t, busy, pending } = props
  const update = (partial: Partial<EditorDraft>): void => {
    const next = { ...draft, ...partial }
    if (next.allowExec && !execHelperReady(next)) next.allowExec = false
    props.onChange(next)
  }
  // Flat mode (the Connections-tab editor) shows every field, so it applies
  // the strict token/port checks even for an alias-sourced endpoint.
  const canSave = !busy
    && props.fingerprint !== undefined
    && sshToken(draft.hostname, 253)
    && sshPort(draft.port)
    && sshToken(draft.user, 64)
    && (draft.credentialSource === 'alias' ? SSH_ALIAS.test(draft.alias.trim()) : draft.credentialId !== '')
  return <div className="mrfw-sshForm">
    <section className="mrfw-sshStep">
      <span className="mrfw-sshStepTitle">{t('ssh.add.stepInfo')}</span>
      <Field label={t('ssh.field.credentialSource')} hint={t('ssh.field.credentialHint')}>
        <SshPicker label={t('ssh.field.credentialSource')} value={draft.credentialSource} disabled={busy}
          items={credentialSources(t)} onChange={credentialSource => update({ credentialSource })} />
      </Field>
      <div className="mrfw-sshGrid">
        <Field label={t('ssh.field.displayName')}>
          <Input className="mrfw-sshInput" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')}
            value={draft.displayName} onChange={event => update({ displayName: event.currentTarget.value })} />
        </Field>
        <Field label={t('ssh.field.platform')} hint={t('ssh.field.platformHint')}>
          <SshPicker label={t('ssh.field.platform')} value={draft.platform} disabled={busy}
            items={platforms(t)} onChange={platform => update({ platform })} />
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
          <SshAliasInput value={draft.alias} aliases={props.aliases} busy={busy} t={t}
            onChange={alias => update({ alias })} />
        </Field>
        <p className="mrfw-note">{t('ssh.add.aliasResolvedNote', { alias: draft.alias.trim() })}</p>
      </div>
      <div hidden={draft.credentialSource !== 'managed'}>
        <Field label={t('ssh.field.managed')}>
          <SshPicker label={t('ssh.field.managed')} value={draft.credentialId} disabled={busy}
            items={managedCredentials(props.credentials, t)}
            onChange={credentialId => update({ credentialId })} />
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
        <Button variant="outline" size="sm" disabled={busy || !scanReady(draft)} loading={pending === 'scan'} onClick={props.onScan}>
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
    {pending === undefined ? null : (
      <StatusLine state="ongoing">
        {pending === 'scan' ? t('ssh.pending.scan', { target: scanTargetOf(draft) }) : t('ssh.pending.save')}
      </StatusLine>
    )}
    <div className="mrfw-sshRowActions">
      <Button variant="primary" disabled={!canSave} loading={pending === 'save'} onClick={() => { void props.onSave() }}>{props.saveLabel}</Button>
      <Button variant="ghost" disabled={busy} onClick={props.onCancel}>{props.cancelLabel}</Button>
    </div>
  </div>
}

export type CredentialCreateKind = 'generate' | 'import' | 'password'

/** The three credential kinds as selectable cards with a one-line hint each. */
const CREDENTIAL_KINDS: readonly { kind: CredentialCreateKind; title: Key; hint: Key; icon: ReactNode }[] = [
  { kind: 'generate', title: 'ssh.credentialGenerate', hint: 'ssh.credentialGenerateHint', icon: <IconPlus aria-hidden="true" /> },
  { kind: 'import', title: 'ssh.credentialImport', hint: 'ssh.credentialImportHint', icon: <IconDownload aria-hidden="true" /> },
  { kind: 'password', title: 'ssh.credentialPassword', hint: 'ssh.credentialPasswordHint', icon: <IconShield aria-hidden="true" /> },
]

/**
 * The add-credential mini-flow in a nested modal: pick a kind on the choice
 * cards, then fill its secret fields. Secrets are cleared before the request
 * leaves; the dialog closes on either outcome so the parent's error toast
 * stays visible.
 */
function AddCredentialDialog(props: {
  readonly busy: boolean
  readonly pending: boolean
  readonly t: Translate
  readonly onClose: () => void
  readonly onCreate: (kind: CredentialCreateKind, label: string, secret: string, passphrase?: string) => Promise<boolean>
}): ReactNode {
  const { t, busy } = props
  const [kind, setKind] = useState<CredentialCreateKind | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const disabled = busy || props.pending
  const valid = label.trim() !== ''
    && (kind === 'generate' || (kind === 'import' ? privateKey !== '' : password !== ''))
  const submit = (): void => {
    if (kind === undefined || !valid) return
    const name = label.trim()
    const secret = kind === 'password' ? password : privateKey
    const phrase = passphrase === '' ? undefined : passphrase
    setPrivateKey('')
    setPassphrase('')
    setPassword('')
    void props.onCreate(kind, name, secret, phrase).then(() => props.onClose())
  }
  const footer = kind === undefined ? (
    <WizardActions>
      <Button variant="ghost" disabled={disabled} onClick={props.onClose}>{t('ssh.cancel')}</Button>
    </WizardActions>
  ) : (
    <WizardActions>
      <Button variant="ghost" disabled={disabled} onClick={() => setKind(undefined)}>{t('ssh.step.back')}</Button>
      <Button variant="primary" disabled={disabled || !valid} loading={props.pending}
        onClick={submit}>{t('panel.addConfirm')}</Button>
    </WizardActions>
  )
  return (
    <Modal open onClose={props.onClose} title={t('ssh.credentialAdd')}
      description={t('ssh.keys.personalGuide')} closeLabel={t('panel.close')}
      className="mrfw-sshCredentialDialog" contentClassName="mrfw-sshDialogContent" footer={footer}>
      {kind === undefined ? (
        <div className="mrfw-wizStack" role="radiogroup" aria-label={t('ssh.credentialAdd')}>
          {CREDENTIAL_KINDS.map(entry => (
            <ChoiceCard key={entry.kind}
              title={t(entry.title)}
              subtitle={t(entry.hint)}
              icon={entry.icon}
              disabled={disabled}
              onSelect={() => setKind(entry.kind)} />
          ))}
        </div>
      ) : (
        <div className="mrfw-wizStack">
          <WizardField label={t('ssh.label')} hint={t(`ssh.credential${kind === 'generate' ? 'Generate' : kind === 'import' ? 'Import' : 'Password'}Hint` as Key)}>
            <Input className="mrfw-sshInput" aria-label={t('ssh.label')} placeholder={t('ssh.label')}
              value={label} disabled={disabled} autoFocus
              onChange={event => setLabel(event.currentTarget.value)} />
          </WizardField>
          {kind === 'import' ? (
            <>
              <WizardField label={t('ssh.privateKey')}>
                <textarea className="mrfw-sshTextarea" aria-label={t('ssh.privateKey')} placeholder={t('ssh.privateKey')}
                  value={privateKey} disabled={disabled} onChange={event => setPrivateKey(event.currentTarget.value)} />
              </WizardField>
              <WizardField label={t('ssh.passphrase')}>
                <Input className="mrfw-sshInput" type="password" aria-label={t('ssh.passphrase')}
                  placeholder={t('ssh.passphrase')} value={passphrase} disabled={disabled}
                  onChange={event => setPassphrase(event.currentTarget.value)} />
              </WizardField>
            </>
          ) : null}
          {kind === 'password' ? (
            <WizardField label={t('ssh.password')}>
              <Input className="mrfw-sshInput" type="password" aria-label={t('ssh.password')}
                placeholder={t('ssh.password')} value={password} disabled={disabled}
                onChange={event => setPassword(event.currentTarget.value)} />
            </WizardField>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

export interface CredentialsPanelProps {
  readonly credentials: readonly CredentialPublicView[]
  readonly busy: boolean
  /** A credential request (generate/import/password/remove) is in flight. */
  readonly pending: boolean
  readonly t: Translate
  readonly copiedId: string | undefined
  readonly onCopy: (credential: CredentialPublicView) => Promise<void>
  readonly onDelete: (id: string) => Promise<boolean>
  readonly onCreate: (kind: CredentialCreateKind, label: string, secret: string, passphrase?: string) => Promise<boolean>
}

/** Credential cards and their add form, shared with the connection wizard. */
export function CredentialsPanel(props: CredentialsPanelProps): ReactNode {
  const { t, busy } = props
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)
  const confirmDelete = (id: string): void => {
    setConfirmId(undefined)
    void props.onDelete(id)
  }
  return <section className="mrfw-sshSettingsInventory">
    {props.credentials.length === 0 ? <p className="mrfw-note">{t('ssh.empty.credentials')}</p> : (
      <ul className="mrfw-sshSettingsList">
        {props.credentials.map(credential => (
          <SshSettingsCard key={credential.id}
            name={<>
              <span>{credential.label}</span>
              <Tag tone="info" className="mrfw-sshTag">{t(credential.kind === 'key' ? 'ssh.kind.key' : 'ssh.kind.password')}</Tag>
            </>}
            metadata={credential.fingerprint === undefined ? null : <span className="mrfw-sshSettingsIdentifier">{credential.fingerprint}</span>}
            actions={<div className="mrfw-sshSettingsCardActions" role="group" aria-label={credential.label}>
              {credential.kind === 'key' && credential.publicKey !== undefined ? (
                <IconButton disabled={busy}
                  icon={props.copiedId === credential.id ? <CheckGlyph /> : <IconCopy aria-hidden="true" />}
                  label={props.copiedId === credential.id ? t('ssh.copied') : t('ssh.copyPublicKey')}
                  onClick={() => { void props.onCopy(credential) }} />
              ) : null}
              {confirmId === credential.id ? (
                <SshDeleteConfirmation busy={busy} t={t}
                  onConfirm={() => confirmDelete(credential.id)} onCancel={() => setConfirmId(undefined)} />
              ) : (
                <IconButton className="mrfw-sshDanger" disabled={busy} icon={<IconTrash aria-hidden="true" />}
                  label={t('ssh.delete')} onClick={() => setConfirmId(credential.id)} />
              )}
            </div>} />
        ))}
      </ul>
    )}
    <SshSettingsAdd label={t('ssh.credentialAdd')} disabled={busy} expanded={addOpen}
      onClick={() => setAddOpen(open => !open)} />
    {props.pending ? <StatusLine state="ongoing">{t('ssh.pending.credential')}</StatusLine> : null}
    {addOpen ? (
      <AddCredentialDialog busy={busy} pending={props.pending} t={t}
        onClose={() => setAddOpen(false)} onCreate={props.onCreate} />
    ) : null}
  </section>
}

/** What the dialog needs from the Workspace Folders panel. */
export interface SshManagementDialogProps {
  /** Which tab the entry point asked for. */
  readonly initialTab: SshDialogTab
  /** Personal-mode client; absent when the host exposes no personal contract. */
  readonly ssh: SshManagementClient | undefined
  /** Plugin settings owns the global connection inventory and requires no session. */
  readonly fromSettings?: boolean
  readonly overviewError?: PanelError | undefined
  readonly dependencies?: RemotesView['dependencies']
  /** The live session; the host derives the primary root from it. */
  readonly sessionId: string | undefined
  /** The control plane's live custody mode. */
  readonly custodyMode: RemotesView['custodyMode']
  /** The control plane's live state. */
  readonly status: RemotesView['status'] | undefined
  readonly onClose: () => void
  /** Ask the Workspace Folders panel to re-read its remote section. */
  readonly onChanged: () => void
  readonly t: Translate
}

/**
 * The SSH connection and credential dialog.
 * @param props - the dialog inputs.
 * @returns the modal, portaled by the shared primitive.
 */
export function SshManagementDialog(props: SshManagementDialogProps): ReactNode {
  const { t, ssh, sessionId, custodyMode, status } = props
  const headingId = useId()
  const [tab, setTab] = useState<SshDialogTab>(props.initialTab)
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [pending, setPending] = useState<ManageOp | undefined>(undefined)
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set())
  const busy = pending !== undefined
  const formPending = pending !== undefined && (pending.kind === 'scan' || pending.kind === 'save') ? pending.kind : undefined
  const [saved, setSaved] = useState(false)
  const mounted = useRef(true)

  const [confirm, setConfirm] = useState<{ kind: 'credential' | 'environment'; id: string } | undefined>(undefined)
  const [editDraft, setEditDraft] = useState<EditorDraft | undefined>(undefined)
  const [scan, setScan] = useState<ScanState | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [helperFor, setHelperFor] = useState<string | undefined>(undefined)
  const [helperNodePath, setHelperNodePath] = useState('')
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)
  const [aliases, setAliases] = useState<readonly string[]>([])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setTab(props.initialTab) }, [props.initialTab])

  const canRequest = sessionId !== undefined || props.fromSettings === true
  const blocked = props.dependencies !== undefined && props.dependencies.code !== 'ready'
  const canManage = !blocked && custodyMode === 'personal' && status?.state === 'ready' && ssh !== undefined && canRequest
  // Change identity during render: an old promise must not win the gap before
  // the reset effect runs, including when SSH becomes unavailable.
  const scope = useMemo(() => ({}), [sessionId, custodyMode, canManage, ssh])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const current = useCallback(() => mounted.current && currentScope.current === scope, [scope])
  const stateRequest = useRef(0)
  useEffect(() => { setPending(undefined); setTesting(new Set()) }, [scope])

  // A session or custody change is a different management scope: drop drafts,
  // secret inputs, and per-connection results instead of carrying them across.
  useEffect(() => {
    setAddOpen(false)
    setEditDraft(undefined)
    setScan(undefined)
    setFingerprint(undefined)
    setConfirm(undefined)
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
    setAddOpen(false)
  }

  /** The Add connection wizard always starts from a blank draft. */
  const openAdd = (): void => {
    setSaved(false)
    setError(undefined)
    setAddOpen(true)
  }

  /** Closing the wizard discards the draft; a saved connection remains available. */
  const closeAdd = (): void => setAddOpen(false)


  /** Every mutation answers the refreshed state; a CAS conflict reloads first. */
  const submitState = useCallback(async (op: ManageOp, call: () => Promise<SshStateView>): Promise<SshStateView | undefined> => {
    if (!current()) return undefined
    const requestId = ++stateRequest.current
    setPending(op)
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
        if (failure.code === 'personal-config-conflict' || failure.code === 'environment-id-conflict') await load()
      }
      return undefined
    } finally {
      if (current()) setPending(undefined)
    }
  }, [load, props.onChanged, current])

  const submit = useCallback(async (op: ManageOp, call: () => Promise<SshStateView>): Promise<boolean> => {
    return (await submitState(op, call)) !== undefined
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

  const deleteCredential = async (id: string): Promise<boolean> => {
    if (ssh === undefined || !canRequest) return false
    return await submit({ kind: 'credential' }, async () => await ssh.credentialRemove(sessionId, id))
  }

  const createCredential = async (
    kind: 'generate' | 'import' | 'password', label: string, secret: string, passphrase?: string,
  ): Promise<boolean> => {
    if (ssh === undefined || !canRequest) return false
    return await submit({ kind: 'credential' }, async () => kind === 'generate'
      ? await ssh.credentialGenerate(sessionId, label)
      : kind === 'import'
        ? await ssh.credentialImport(sessionId, label, secret, passphrase)
        : await ssh.credentialPassword(sessionId, label, secret))
  }
  const deleteEnvironment = async (id: string): Promise<void> => {
    if (ssh === undefined || !canRequest) return
    setConfirm(undefined)
    if (await submit({ kind: 'remove', id }, async () => await ssh.environmentRemove(sessionId, revision(), id))) {
      setEditDraft(draft => draft?.existing?.environmentId === id ? undefined : draft)
    }
  }
  const testEnvironment = async (id: string): Promise<string | undefined> => {
    if (ssh === undefined || !canRequest) return undefined
    setTesting(current => new Set(current).add(id))
    try {
      const result = await ssh.environmentTest(sessionId, id)
      if (current()) {
        setTestResults(previous => ({
          ...previous,
          [id]: `${platformLabel(result.platform, t)}${result.nodeVersion === undefined ? '' : ` · node ${result.nodeVersion}`}`,
        }))
        return result.nodePath
      }
    } catch (cause: unknown) {
      if (current()) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (current()) setTesting(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
    return undefined
  }

  const scanHost = async (draft: EditorDraft, applyPatch: (patch: Partial<EditorDraft>) => void): Promise<void> => {
    if (ssh === undefined || !canRequest || !scanReady(draft)) return
    const alias = draft.credentialSource === 'alias' ? draft.alias.trim() : undefined
    setPending({ kind: 'scan' })
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
      if (current()) setPending(undefined)
    }
  }

  const saveEnvironment = async (draft: EditorDraft, hostKey: string | undefined, scanToken?: string): Promise<SshEnvironmentView | undefined> => {
    if (ssh === undefined || !canRequest || view === undefined || hostKey === undefined || !sshPort(draft.port)) return undefined
    const environmentId = draft.existing?.environmentId ?? newEnvironmentId(draft.displayName, view.environments)
    const environment = environmentDraftOf(draft, environmentId)
    const intent = draft.existing === undefined ? 'create' : 'update'
    const state = await submitState({ kind: 'save' }, async () => await ssh.environmentSave(sessionId, view.revision, environment, hostKey, scanToken, intent))
    return state?.environments.find(entry => entry.environmentId === environmentId)
  }

  const installEnvironmentHelper = async (id: string, nodePath: string | undefined): Promise<void> => {
    if (ssh === undefined || !canRequest) return
    const state = await submitState({ kind: 'helper', id }, async () => await ssh.helperInstall(sessionId, revision(), id, nodePath))
    const environment = state?.environments.find(entry => entry.environmentId === id)
    if (environment === undefined) return
    setEditDraft(draft => {
      if (draft?.existing?.environmentId !== id || environment.hostKey !== draft.existing.hostKey
        || editorIdentity(editorOf(environment)) !== editorIdentity(editorOf(draft.existing))) return draft
      return { ...draft, existing: environment }
    })
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

  const renderUnavailable = (): ReactNode =>
    status === undefined
      ? <p className="mrfw-note">{t('panel.loading')}</p>
      : <p className="mrfw-note">{t('panel.remoteUnavailable', { reason: statusText(status, t) })}</p>

  /**
   * The first `sshState` read failed: the toast names the failure, the
   * tab says so and offers a retry — without it the effect would not re-fire
   * and the tab would keep showing "loading" until the dialog reopened.
   */
  const renderLoadState = (): ReactNode =>
    error === undefined
      ? <StatusLine state="ongoing">{t('ssh.add.loading')}</StatusLine>
      : <div className="mrfw-sshArea">
          <p className="mrfw-note">{t('ssh.loadFailed')}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void load() }}>{t('panel.retry')}</Button>
        </div>

  const renderCredentials = (): ReactNode => <CredentialsPanel
    credentials={userCredentials}
    busy={busy}
    pending={pending?.kind === 'credential'}
    t={t}
    copiedId={copiedId}
    onCopy={copyPublicKey}
    onDelete={deleteCredential}
    onCreate={createCredential}
  />

  const renderConnections = (state: SshStateView): ReactNode => <section className="mrfw-sshSettingsInventory">
    {!state.linked && state.environments.some(environment => environment.credential.kind === 'managed') ? (
      <div className="mrfw-alert" role="note">
        <p className="mrfw-note">{t('ssh.linkBanner')}</p>
        {pending !== undefined && pending.kind === 'link' && pending.id === undefined
          ? <StatusLine state="ongoing">{t('ssh.pending.link')}</StatusLine> : null}
        <Button variant="outline" size="sm" disabled={busy}
          loading={pending !== undefined && pending.kind === 'link' && pending.id === undefined}
          onClick={() => { if (ssh !== undefined && canRequest) void submit({ kind: 'link' }, async () => await ssh.configLink(sessionId)) }}>
          {t('ssh.linkNow')}
        </Button>
      </div>
    ) : null}
    {state.environments.length === 0 ? <p className="mrfw-note">{t('ssh.empty.environments')}</p> : (
      <ul className="mrfw-sshSettingsList">
        {state.environments.map(environment => {
          const id = environment.environmentId
          const name = environment.displayName ?? id
          const envAccessKeys = accessKeys.filter(credential => credential.environmentId === id)
          const next = envNextStep(environment)
          const installingHelper = next === 'helper' && helperFor === id
          const confirmingDelete = confirm?.kind === 'environment' && confirm.id === id
          const rowOp = pendingRowKind(pending, id)
          const edit = editDraft?.existing?.environmentId === id ? editDraft : undefined
          const readiness = t(next === 'ready' ? 'ssh.ready.done' : next === 'helper' ? 'ssh.helperMissing' : 'ssh.step.link')
          return (
            <SshSettingsCard
              key={id}
              name={<>
                <span>{name}</span>
                <span className="mrfw-sshConnectionStatus" data-ready={next === 'ready'} role="img" aria-label={readiness} title={readiness} />
                <Tag tone="neutral" className="mrfw-sshTag">{platformLabel(environment.platform, t)}</Tag>
              </>}
              metadata={<>
                <span className="mrfw-sshSettingsIdentifier">{sshTarget(environment.endpoint.user, environment.endpoint.hostname, environment.endpoint.port)}</span>
                <div className="mrfw-sshSettingsFacts">
                  <span>{credentialLabel(environment.credential)}</span>
                  <Tag tone={environment.helper === null ? 'warning' : 'neutral'} className="mrfw-sshTag">
                    {t(environment.helper === null ? 'ssh.helperMissing' : 'ssh.helperInstalled')}
                  </Tag>
                  {next === 'link' ? <Tag tone="warning" className="mrfw-sshTag">{t('ssh.step.link')}</Tag> : null}
                </div>
                {envAccessKeys.map(credential => (
                  <span key={credential.id} className="mrfw-note">{t('ssh.accessKey')} · {credential.label}{credential.fingerprint === undefined ? '' : ` · ${credential.fingerprint}`}</span>
                ))}
                {testing.has(id) ? (
                  <StatusLine state="ongoing">{t('ssh.pending.test')}</StatusLine>
                ) : testResults[id] === undefined ? null : (
                  <StatusLine state="done">{testResults[id]}</StatusLine>
                )}
                {rowOp === undefined ? null : (
                  <StatusLine state="ongoing">{t(`ssh.pending.${rowOp}` as Key)}</StatusLine>
                )}
              </>}
              actions={<div className="mrfw-sshSettingsCardActions" role="group" aria-label={name}>
                <IconButton disabled={rowOp !== undefined} loading={testing.has(id)}
                  icon={<IconPlay aria-hidden="true" />} label={t('ssh.envTest')}
                  onClick={() => { void testEnvironment(id) }} />
                {next === 'helper' && !installingHelper ? (
                  <IconButton disabled={busy} loading={rowOp === 'helper'} icon={<IconDownload />} label={t('ssh.helperInstall')}
                    onClick={() => { setHelperNodePath(''); setHelperFor(id) }} />
                ) : null}
                {next === 'link' ? (
                  <IconButton disabled={busy} loading={rowOp === 'link'} icon={<IconLink />} label={t('ssh.linkNow')}
                    onClick={() => { if (ssh !== undefined && canRequest) void submit({ kind: 'link', id }, async () => await ssh.configLink(sessionId)) }} />
                ) : null}
                {environment.credential.kind === 'managed' && credentialOf(environment.credential.credentialId)?.kind === 'password' ? (
                  <IconButton disabled={busy} loading={rowOp === 'accessKey'} icon={<IconShield />} label={t('ssh.accessKeyInstall')}
                    onClick={() => { if (ssh !== undefined && canRequest) void submit({ kind: 'accessKey', id }, async () => await ssh.accessKeyInstall(sessionId, revision(), id)) }} />
                ) : null}
                <IconButton disabled={busy} expanded={edit !== undefined}
                  icon={<IconEdit aria-hidden="true" />} label={t('ssh.envEdit')}
                  onClick={() => { setEditDraft(edit === undefined ? editorOf(environment) : undefined); setScan(undefined); setFingerprint(undefined) }} />
                <IconButton className="mrfw-sshDanger" disabled={busy || confirmingDelete} loading={rowOp === 'remove'}
                  icon={<IconTrash aria-hidden="true" />} label={t('ssh.envDelete')}
                  onClick={() => setConfirm({ kind: 'environment', id })} />
              </div>}
            >
              {installingHelper ? (
                <div className="mrfw-sshEnvExtra mrfw-sshHelperRow">
                  <Input className="mrfw-sshHelperInput" aria-label={t('ssh.nodePath')} placeholder={t('ssh.nodePath')}
                    value={helperNodePath} onChange={event => setHelperNodePath(event.currentTarget.value)} />
                  <div className="mrfw-sshRowActions">
                    <Button variant="primary" size="sm" disabled={busy} loading={rowOp === 'helper'}
                      onClick={() => {
                        const nodePath = helperNodePath.trim()
                        setHelperFor(undefined)
                        setHelperNodePath('')
                        void installEnvironmentHelper(id, nodePath || undefined)
                      }}>{t('ssh.helperInstall')}</Button>
                    <Button variant="ghost" size="sm" disabled={busy}
                      onClick={() => { setHelperFor(undefined); setHelperNodePath('') }}>{t('ssh.cancel')}</Button>
                  </div>
                </div>
              ) : null}
              {confirmingDelete ? (
                <div className="mrfw-sshEnvExtra mrfw-sshRowActions">
                  <span className="mrfw-note">{t('ssh.envDeleteHint')}</span>
                  <SshDeleteConfirmation busy={busy} t={t}
                    onConfirm={() => { void deleteEnvironment(id) }} onCancel={() => setConfirm(undefined)} />
                </div>
              ) : null}
              {edit === undefined ? null : (
                <div className="mrfw-sshEdit">
                  <span className="mrfw-sshStepTitle">{t('ssh.envEdit')}</span>
                  <EnvironmentForm
                    draft={edit}
                    onChange={next => {
                      if (editorIdentity(next) !== editorIdentity(edit)) {
                        setScan(undefined)
                        setFingerprint(undefined)
                      }
                      setEditDraft(next)
                    }}
                    credentials={userCredentials}
                    aliases={aliases}
                    scan={scan}
                    fingerprint={fingerprint ?? recordedFingerprint(edit)}
                    onScan={() => { void scanHost(edit, patch => { setEditDraft(current => current === undefined ? current : { ...current, ...patch }) }) }}
                    onFingerprint={setFingerprint}
                    onSave={async () => {
                      if (await saveEnvironment(edit, fingerprint ?? recordedFingerprint(edit), scan?.token) === undefined) return false
                      setScan(undefined)
                      setFingerprint(undefined)
                      setEditDraft(undefined)
                      return true
                    }}
                    onCancel={() => { setEditDraft(undefined); setScan(undefined); setFingerprint(undefined) }}
                    onOpenKeys={() => changeTab('keys')}
                    saveLabel={t('ssh.envSave')}
                    cancelLabel={t('ssh.cancel')}
                    busy={busy}
                    pending={formPending}
                    t={t}
                  />
                </div>
              )}
            </SshSettingsCard>
          )
        })}
      </ul>
    )}
    <SshSettingsAdd disabled={busy || editDraft !== undefined} onClick={openAdd} label={t('ssh.tab.add')} />
    {saved ? <p className="mrfw-note" role="status">{t('ssh.add.saved')}</p> : null}
  </section>

  const renderManagement = (): ReactNode => {
    if (props.overviewError !== undefined) return <><PanelErrorToast error={props.overviewError} t={t} />
      <p className="mrfw-note">{t('ssh.loadFailed')}</p><Button onClick={props.onChanged}>{t('ssh.recheckDependencies')}</Button></>
    if (blocked) return <SshDependencyNotice view={props.dependencies!} onCheck={props.onChanged} t={t} />
    if (status === undefined) return <p className="mrfw-note">{t('ssh.add.loading')}</p>
    if (status.state !== 'ready') return renderUnavailable()
    if (custodyMode !== 'personal' || ssh === undefined) return <p className="mrfw-note">{t('ssh.add.noClient')}</p>
    if (!canRequest) return <p className="mrfw-note">{t('ssh.dialog.noSession')}</p>
    if (view === undefined) return renderLoadState()
    return tab === 'connections' ? renderConnections(view) : renderCredentials()
  }

  return <>
    <PanelErrorToast error={error?.ssh === undefined ? error : undefined} t={t} />
    <SshSettingsShell
      title={t('ssh.dialog.title')}
      closeLabel={t('panel.close')}
      onClose={props.onClose}
      busy={busy || testing.size > 0}
      navigation={<SshSettingsNavigation value={tab} onChange={changeTab} t={t} />}
    >
      <section aria-labelledby={headingId} className="mrfw-sshSettingsPane" key={tab}>
        <div className="mrfw-sshSettingsHeading">
          <h3 id={headingId}>{t(tab === 'connections' ? 'ssh.environments' : 'ssh.credentials')}</h3>
          <p>{t(tab === 'connections' ? 'ssh.connections.personalGuide' : 'ssh.keys.personalGuide')}</p>
        </div>
        <SshErrorDetail error={error} t={t} />
        {renderManagement()}
      </section>
    </SshSettingsShell>
    {addOpen ? (
      <AddConnectionWizard
        ssh={ssh}
        sessionId={sessionId}
        fromSettings={props.fromSettings}
        onClose={closeAdd}
        onChanged={() => { setSaved(true); void load(); props.onChanged() }}
        t={t}
      />
    ) : null}
  </>
}

export interface SshWorkspaceBindingsDialogProps {
  readonly ssh: SshClient
  readonly sessionId: string
  readonly remotes: RemotesClient | undefined
  readonly roots: RootsView | undefined
  /** A row-menu Edit entry pre-selects this binding's inline form once the state loads. */
  readonly initialEdit?: { readonly environmentId: string; readonly rootId: string } | undefined
  readonly onClose: () => void
  readonly onChanged: () => void
  readonly t: Translate
}

/** Manage only the remote Roots bound to the Workspace of the live session. */
export function SshWorkspaceBindingsDialog(props: SshWorkspaceBindingsDialogProps): ReactNode {
  const { ssh, sessionId, roots, t } = props
  const [view, setView] = useState<SshStateView | undefined>()
  const [draft, setDraft] = useState<BindingDraft>()
  const [addOpen, setAddOpen] = useState(false)
  const [confirmUnbind, setConfirmUnbind] = useState<SshBindingView>()
  const [pathOpen, setPathOpen] = useState(false)
  const [pending, setPending] = useState<{ kind: 'save' } | { kind: 'remove'; key: string } | undefined>(undefined)
  const busy = pending !== undefined
  const [error, setError] = useState<PanelError>()
  const [copiedId, setCopiedId] = useState<string>()
  const lifetime = useRef<AbortController | undefined>(undefined)
  const copyTimer = useRef<number>(undefined)
  const formRef = useRef<HTMLDivElement | null>(null)
  const initialEditApplied = useRef(false)
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
    return () => {
      controller.abort()
      window.clearTimeout(copyTimer.current)
    }
  }, [load])

  const copyLocation = async (key: string, location: string): Promise<void> => {
    const signal = lifetime.current?.signal
    try {
      await navigator.clipboard.writeText(location)
      if (signal?.aborted) return
      window.clearTimeout(copyTimer.current)
      setCopiedId(key)
      setError(previous => previous?.code === 'copy-failed' ? undefined : previous)
      copyTimer.current = window.setTimeout(() => setCopiedId(undefined), 1500)
    } catch (cause) {
      if (signal?.aborted) return
      window.clearTimeout(copyTimer.current)
      setCopiedId(undefined)
      setError(new PanelError('copy-failed', cause instanceof Error ? cause.message : String(cause)))
    }
  }

  const mutate = async (op: { kind: 'save' } | { kind: 'remove'; key: string }, call: (revision: number, signal: AbortSignal) => Promise<SshStateView>): Promise<BindingSaveResult> => {
    const signal = lifetime.current?.signal
    if (view === undefined || signal === undefined || signal.aborted) return {}
    setPending(op)
    setError(undefined)
    try {
      const next = await call(view.revision, signal)
      if (signal.aborted) return {}
      setView(next)
      props.onChanged()
      return { state: next }
    } catch (cause) {
      if (signal.aborted) return {}
      const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
      setError(failure)
      if (failure.code === 'personal-config-conflict') await load(signal)
      return { error: failure }
    } finally {
      if (!signal.aborted) setPending(undefined)
    }
  }

  const localPeers = localBindingPeers(roots, t)
  const environment = view?.environments.find(entry => entry.environmentId === draft?.environmentId)
  const editing = draft?.rootId !== undefined
  const edit = (binding: SshBindingView): void => {
    setDraft({
      environmentId: binding.environmentId, rootId: binding.rootId, path: binding.path,
      read: binding.actions.includes('read'), write: binding.actions.includes('write'), exec: binding.actions.includes('exec'),
      imports: new Set(binding.transfers?.filter(transfer => transfer.direction === 'import').map(transfer => transfer.peer.rootId)),
      exports: new Set(binding.transfers?.filter(transfer => transfer.direction === 'export').map(transfer => transfer.peer.rootId)),
      directoryListing: binding.directoryListing === 'stable-path',
    })
  }
  const save = async (value: BindingDraft): Promise<BindingSaveResult> =>
    await mutate({ kind: 'save' }, async (revision, signal) => await ssh.bindingSave(sessionId, revision, bindingDraftOf(value), signal))
  const validPath = draft !== undefined && remotePath(draft.path.trim())
  const formOpen = draft !== undefined
  // A row-menu Edit entry lands on one binding's form exactly once; a binding
  // that no longer matches falls back to the plain list.
  useEffect(() => {
    if (initialEditApplied.current || view === undefined) return
    initialEditApplied.current = true
    const wanted = props.initialEdit
    if (wanted === undefined) return
    const binding = view.bindings.find(entry => entry.environmentId === wanted.environmentId && entry.rootId === wanted.rootId)
    if (binding !== undefined) edit(binding)
  }, [view, props.initialEdit])
  useEffect(() => {
    if (formOpen) formRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [formOpen])
  return <><Modal open title={t('ssh.bindings')} closeLabel={t('panel.close')} onClose={props.onClose}
    className="mrfw-sshDialog" contentClassName="mrfw-sshDialogContent">
    <PendingBar active={busy} />
    <div className="mrfw-sshArea">
      <PanelErrorToast error={error} t={t} />
      {view === undefined ? error === undefined ? <StatusLine state="ongoing">{t('panel.loading')}</StatusLine> : (
        <Button variant="outline" size="sm" onClick={() => {
          const signal = lifetime.current?.signal
          if (signal !== undefined) { setError(undefined); void load(signal) }
        }}>{t('panel.retry')}</Button>
      ) : <>
        {view.bindings.length === 0 ? <p className="mrfw-note">{t('ssh.empty.bindings')}</p> : null}
        {view.bindings.length > 0 ? (
          <div className="mrfw-sshBindingList">
            {view.bindings.map(binding => {
              const { environmentId, rootId, path, actions, transfers } = binding
              const key = `${environmentId}/${rootId}`
              const connection = view.environments.find(entry => entry.environmentId === environmentId)
              const environmentName = connection?.displayName ?? environmentId
              const endpoint = connection?.endpoint
              const target = endpoint === undefined ? undefined : sshTarget(endpoint.user, endpoint.hostname, endpoint.port)
              const location = sshLocation(target, path)
              const name = path.slice(path.lastIndexOf('/') + 1) || path
              const IconAccess = actions.includes('write') || actions.includes('exec')
                ? IconAccessReadWrite : actions.includes('read') ? IconAccessReadOnly : undefined
              const capabilities = actions.length === 0
                ? t('panel.remoteNoCapabilities')
                : actions.map(action => t(`remote.capability.${action}`)).join(', ')
              return <WorkspaceRow
                key={key}
                t={t}
                name={<span className="mrfw-rootNameText" title={name}>{name}</span>}
                badges={<>
                  <span className="mrfw-cwdTag" title={environmentName}>{environmentName}</span>
                  <span className="mrfw-accessBadge">
                    {IconAccess === undefined ? null : <IconAccess size={14} />}
                    <span>{capabilities}</span>
                  </span>
                </>}
                path={location}
                copied={copiedId === key}
                onCopy={() => { void copyLocation(key, location) }}
                details={<>
                  {(['import', 'export'] as const).map(direction => {
                    const peers = transfers?.filter(transfer => transfer.direction === direction).map(({ peer }) =>
                      localPeers.find(entry => entry.id === peer.rootId)?.label ?? peer.rootId)
                    if (peers === undefined || peers.length === 0) return null
                    return <span key={direction} className="mrfw-note">{t(`ssh.binding.${direction}`)} ({peers.join(', ')})</span>
                  })}
                  {pending?.kind === 'remove' && pending.key === key
                    ? <StatusLine state="ongoing">{t('ssh.pending.bindingRemove')}</StatusLine> : null}
                </>}
                trailing={<div className="mrfw-sshRowActions">
                  <IconButton disabled={busy || draft !== undefined} onClick={() => edit(binding)}
                    icon={<IconEdit />} label={t('ssh.binding.edit')} />
                  <IconButton disabled={busy || draft !== undefined}
                    loading={pending?.kind === 'remove' && pending.key === key}
                    onClick={() => setConfirmUnbind(binding)} icon={<IconTrash />} label={t('ssh.binding.remove')} />
                </div>}
              />
            })}
          </div>
        ) : null}
        {view.environments.length === 0 ? <p className="mrfw-note">{t('ssh.binding.noEnvironments')}</p> : null}
        <SshSettingsAdd label={t('ssh.bindingAdd')} disabled={busy || draft !== undefined || view.environments.length === 0}
          expanded={addOpen} onClick={() => setAddOpen(true)} />
        {draft === undefined ? null : (
          <div className="mrfw-sshForm" ref={formRef}>
            <WizardField label={t('ssh.binding.environment')}>
              <WizardPicker label={t('ssh.binding.environment')} value={draft.environmentId} disabled={busy || editing}
                items={view.environments.map(entry => ({ id: entry.environmentId, label: entry.displayName ?? entry.environmentId }))}
                onChange={environmentId => setDraft(blankBinding(environmentId))} />
            </WizardField>
            <WizardField label={t('ssh.binding.path')} invalid={draft.path !== '' && !validPath}
              hint={draft.path !== '' && !validPath ? t('error.workspace-invalid') : t('ssh.field.workspaceHint')}>
              <div className="mrfw-sshPathBar">
                <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} value={draft.path} disabled={busy}
                  onChange={event => setDraft({ ...draft, path: event.currentTarget.value })} />
                <Button variant="outline" size="sm" disabled={busy || environment === undefined} onClick={() => setPathOpen(true)}>{t('wizard.browse')}</Button>
              </div>
            </WizardField>
            <section className="mrfw-wizSection" aria-label={t('ssh.binding.actions')}>
              <span className="mrfw-wizFieldLabel">{t('ssh.binding.actions')}</span>
              <div className="mrfw-wizCheckRow">
                {(['read', 'write', 'exec'] as const).map(action => (
                  <WizardCheckbox key={action} checked={draft[action]}
                    disabled={busy || (action === 'exec' && !draft.exec && environment?.exec === undefined)}
                    label={t(`remote.capability.${action}`)}
                    onChange={next => setDraft({ ...draft, [action]: next, ...(action === 'read' && !next ? { directoryListing: false } : {}) })} />
                ))}
              </div>
            </section>
            {localPeers.length === 0 ? null : (
              <section className="mrfw-wizSection" aria-label={t('ssh.binding.transfers')}>
                <span className="mrfw-wizFieldLabel">{t('ssh.binding.transfers')}</span>
                {localPeers.map(peer => (
                  <div key={peer.id} className="mrfw-wizCheckRow">
                    <WizardCheckbox checked={draft.imports.has(peer.id)} label={`${t('ssh.binding.import')} (${peer.label})`}
                      disabled={busy || (environment?.transfer === undefined && !draft.imports.has(peer.id))}
                      onChange={() => setDraft({ ...draft, imports: togglePeer(draft.imports, peer.id) })} />
                    <WizardCheckbox checked={draft.exports.has(peer.id)} label={`${t('ssh.binding.export')} (${peer.label})`}
                      disabled={busy || (environment?.transfer === undefined && !draft.exports.has(peer.id))}
                      onChange={() => setDraft({ ...draft, exports: togglePeer(draft.exports, peer.id) })} />
                  </div>
                ))}
              </section>
            )}
            {/* The stable-SFTP-path Files browsing opt-in (ADR-0052): a
                binding-level read-only permission independent of the exec
                transport. It requires read, stays off by default, and changing
                it changes binding identity, so the existing re-registration
                flow applies after saving. */}
            {environment === undefined ? null : (
              <section className="mrfw-wizSection" aria-label={t('ssh.binding.directoryListing')}>
                <div className="mrfw-wizCheckRow">
                  <WizardCheckbox checked={draft.directoryListing} disabled={busy || !draft.read}
                    label={t('ssh.binding.directoryListing')}
                    onChange={next => setDraft({ ...draft, directoryListing: next })} />
                </div>
                <p className="mrfw-note">{t('ssh.binding.directoryListingHint')}</p>
              </section>
            )}
            {pending?.kind === 'save' ? <StatusLine state="ongoing">{t('ssh.pending.bindingSave')}</StatusLine> : null}
            <div className="mrfw-sshRowActions">
              <Button variant="primary" disabled={busy || environment === undefined || !validPath || !(draft.read || draft.write || draft.exec)}
                loading={pending?.kind === 'save'}
                onClick={() => { void save(draft).then(result => { if (result.state !== undefined) setDraft(undefined) }) }}>{t('ssh.binding.save')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>{t('ssh.cancel')}</Button>
            </div>
            {environment === undefined ? null : (
              <WizardPathBrowser open={pathOpen} initialPath={draft.path} environmentId={draft.environmentId} ssh={ssh} sessionId={sessionId}
                t={t} onClose={() => setPathOpen(false)} onPick={path => setDraft({ ...draft, path })} />
            )}
          </div>
        )}
      </>}
    </div>
  </Modal>
    {addOpen && view !== undefined ? (
      <AddBindingWizard ssh={ssh} sessionId={sessionId} remotes={props.remotes} roots={roots}
        environments={view.environments} busy={busy} t={t}
        onClose={() => setAddOpen(false)} onChanged={props.onChanged} onSave={save} />
    ) : null}
    {confirmUnbind === undefined ? null : (
      <RemoteRootConfirm kind="binding" path={confirmUnbind.path} t={t}
        onClose={() => setConfirmUnbind(undefined)}
        onConfirm={() => {
          const { environmentId, rootId } = confirmUnbind
          setConfirmUnbind(undefined)
          void mutate({ kind: 'remove', key: `${environmentId}/${rootId}` },
            async (revision, signal) => await ssh.bindingRemove(sessionId, revision, environmentId, rootId, signal))
        }} />
    )}
  </>
}
