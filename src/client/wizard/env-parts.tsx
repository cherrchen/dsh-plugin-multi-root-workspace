/**
 * SSH environment building blocks on the wizard kit: the connect form, the
 * host-key fingerprint pick, and the post-save readiness checklist. Shared by
 * the add-remote wizard and the management dialog's add-connection flow.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/wizard/env-parts
 */
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CredentialPublicView, SshEnvironmentView, SshScanResult } from '../ssh-client.ts'
import type { ConnectField, EditorDraft } from '../ssh-draft.ts'
import { IconCheck } from '../../compat/client-icons.ts'
import { SshButton as Button } from '../panel-buttons.tsx'
import type { Translate } from '../WorkspaceFoldersAction.tsx'
import { ChecklistRow, ChoiceCard, WizardCheckbox, WizardField, WizardPicker } from './kit.tsx'

/** The remote node major helper install needs — v20 already fails it in practice. */
export const REMOTE_NODE_MIN_MAJOR = 24

/** What a remote node probe says about helper readiness. */
export interface NodeCheck {
  readonly kind: 'ok' | 'missing' | 'old'
  readonly version: string | undefined
}

/**
 * Classify one `environmentTest` answer. An unparsable version still counts as
 * "node found": the helper's own launch is the last word, the check only
 * guards the cases detection can already rule out.
 */
export function nodeCheckOf(result: { readonly nodePath?: string | undefined; readonly nodeVersion?: string | undefined }): NodeCheck {
  if (result.nodePath === undefined) return { kind: 'missing', version: undefined }
  const major = Number.parseInt(result.nodeVersion?.replace(/^v/, '').split('.')[0] ?? '', 10)
  return !Number.isNaN(major) && major < REMOTE_NODE_MIN_MAJOR
    ? { kind: 'old', version: result.nodeVersion }
    : { kind: 'ok', version: result.nodeVersion }
}

/** The selected-marker glyph: the host check icon where it exists. */
function CheckMark(props: { readonly size?: number }): ReactNode {
  const size = props.size ?? 14
  return IconCheck === undefined ? <span aria-hidden="true">✓</span> : <IconCheck size={size} aria-hidden="true" />
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

/** The environment editor in kit form: name, credential, target, platform. */
export function ConnectForm(props: {
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
          invalid={invalid('hostname')} hint={invalid('hostname') ? props.errorFor('hostname') : undefined}>
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

/** The scanned host keys as selectable cards: pick one fingerprint to save. */
export function HostKeyPick(props: {
  readonly keys: SshScanResult['keys']
  readonly fingerprint: string | undefined
  readonly busy: boolean
  readonly t: Translate
  readonly onPick: (fingerprint: string) => void
}): ReactNode {
  const { t } = props
  return (
    <div className="mrfw-wizKeys" role="radiogroup" aria-label={t('ssh.scanConfirmTitle')}>
      <span className="mrfw-wizFieldLabel">{t('ssh.scanPick')}</span>
      {props.keys.length === 0 ? <p className="mrfw-note">{t('ssh.scanNoKeys')}</p> : props.keys.map(key => (
        <ChoiceCard key={key.fingerprint}
          title={key.type}
          subtitle={<span className="mrfw-wizFingerprint">{key.fingerprint}</span>}
          trailing={props.fingerprint === key.fingerprint ? <CheckMark /> : null}
          selected={props.fingerprint === key.fingerprint}
          disabled={props.busy}
          onSelect={() => props.onPick(key.fingerprint)} />
      ))}
    </div>
  )
}

/**
 * The post-save readiness checklist: helper install with its node probe, the
 * optional access-key and link steps, the connection test, and the two
 * capability grants. The owner wires each action and reads the states back.
 */
export function EnvironmentSetup(props: {
  readonly environment: SshEnvironmentView
  readonly needsAccessKey: boolean
  readonly needsLink: boolean
  /** Which of the checklist's own operations is in flight. */
  readonly pending: 'helper' | 'accessKey' | 'link' | undefined
  /** The connection probe is in flight (the detect and test buttons share it). */
  readonly detecting: boolean
  readonly busy: boolean
  readonly nodeCheck: NodeCheck | undefined
  readonly testResult: string | undefined
  readonly allowExec: boolean
  readonly allowTransfer: boolean
  readonly t: Translate
  readonly onDetect: () => void
  readonly onInstallHelper: () => void
  readonly onInstallAccessKey: () => void
  readonly onLink: () => void
  readonly onExec: (next: boolean) => void
  readonly onTransfer: (next: boolean) => void
}): ReactNode {
  const { environment, pending, busy, t } = props
  const helperMissing = environment.helper === null
  return (
    <section className="mrfw-wizSection" aria-label={t('wizard.readiness')}>
      <span className="mrfw-wizFieldLabel">{t('wizard.readiness')}</span>
      <ChecklistRow
        state={pending === 'helper' ? 'ongoing' : helperMissing ? 'warning' : 'done'}
        label={helperMissing ? t('ssh.helperMissing') : t('ssh.helperInstalled')}
        detail={props.nodeCheck === undefined || props.nodeCheck.kind === 'old' ? undefined
          : props.nodeCheck.kind === 'missing' ? t('ssh.node.missing')
            : t('ssh.node.ok', { version: props.nodeCheck.version ?? '?' })}
        action={helperMissing ? (
          <span className="mrfw-sshRowActions">
            <Button variant="outline" size="sm" disabled={busy} loading={props.detecting}
              onClick={props.onDetect}>{t('ssh.add.detectNode')}</Button>
            <Button variant="primary" size="sm" disabled={busy} loading={pending === 'helper'}
              onClick={props.onInstallHelper}>{t('ssh.helperInstall')}</Button>
          </span>
        ) : undefined} />
      {props.needsAccessKey ? (
        <ChecklistRow
          state={pending === 'accessKey' ? 'ongoing' : 'warning'}
          label={t('ssh.accessKey')}
          action={<Button variant="outline" size="sm" disabled={busy} loading={pending === 'accessKey'}
            onClick={props.onInstallAccessKey}>{t('ssh.accessKeyInstall')}</Button>} />
      ) : null}
      {props.needsLink ? (
        <ChecklistRow
          state={pending === 'link' ? 'ongoing' : 'warning'}
          label={t('ssh.linkNow')}
          detail={t('ssh.linkBanner')}
          action={<Button variant="outline" size="sm" disabled={busy} loading={pending === 'link'}
            onClick={props.onLink}>{t('ssh.linkNow')}</Button>} />
      ) : null}
      <ChecklistRow
        state={props.detecting ? 'ongoing' : props.testResult === undefined ? 'idle' : 'done'}
        label={t('ssh.envTest')}
        detail={props.testResult}
        action={<Button variant="outline" size="sm" disabled={busy} loading={props.detecting}
          onClick={props.onDetect}>{t('ssh.envTest')}</Button>} />
      <span className="mrfw-wizFieldLabel">{t('wizard.capabilities')}</span>
      <WizardCheckbox checked={props.allowExec}
        disabled={busy || (helperMissing && !props.allowExec)}
        hint={helperMissing && !props.allowExec ? t('ssh.field.allowExecHelper') : undefined}
        label={t('ssh.field.allowExec')}
        onChange={props.onExec} />
      <WizardCheckbox checked={props.allowTransfer} disabled={busy} label={t('ssh.field.allowTransfer')}
        onChange={props.onTransfer} />
    </section>
  )
}
