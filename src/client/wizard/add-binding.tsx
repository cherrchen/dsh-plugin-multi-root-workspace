/**
 * The add-binding wizard: the Workspace Folders bindings dialog's "添加绑定"
 * flow on `WizardShell` — one binding step (connection, path, capabilities,
 * local transfers) and one registration step that mirrors `RemoteWizard`'s
 * summary + `remotes.add` confirm pane, then the same done pane. The save
 * goes through the dialog's mutation path (revision CAS, conflict reload);
 * registration calls `remotes.add` like the row menu does.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/wizard/add-binding
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootsView } from '../../contract.ts'
import { sshLocation, sshTarget } from '../../remote/ssh-location.ts'
import { SshButton as Button } from '../panel-buttons.tsx'
import { localBindingPeers } from '../remote-root-menu.tsx'
import { PanelError } from '../panel-client.ts'
import { PanelErrorToast } from '../error-toast.tsx'
import type { RemotesClient } from '../remotes-client.ts'
import type { SshClient, SshEnvironmentView, SshStateView } from '../ssh-client.ts'
import { blankBinding, remotePath, togglePeer, type BindingDraft } from '../ssh-draft.ts'
import type { Translate } from '../WorkspaceFoldersAction.tsx'
import { WizardPathBrowser } from './add-remote.tsx'
import { CheckMark, WizardActions, WizardCheckbox, WizardField, WizardPicker, WizardShell } from './kit.tsx'

type BindingStage = 'binding' | 'register'

/** The dialog's save result: the new state on success, the failure otherwise. */
export interface BindingSaveResult {
  readonly state?: SshStateView | undefined
  readonly error?: PanelError | undefined
}

export function AddBindingWizard(props: {
  readonly ssh: SshClient
  readonly sessionId: string
  readonly remotes: RemotesClient | undefined
  readonly roots: RootsView | undefined
  readonly environments: readonly SshEnvironmentView[]
  /** A dialog-level mutation is in flight. */
  readonly busy: boolean
  readonly t: Translate
  readonly onClose: () => void
  readonly onChanged: () => void
  /** Saves the draft through the dialog's mutation path. */
  readonly onSave: (draft: BindingDraft) => Promise<BindingSaveResult>
}): ReactNode {
  const { t } = props
  const [stage, setStage] = useState<BindingStage>('binding')
  const [done, setDone] = useState(false)
  const [draft, setDraft] = useState<BindingDraft>(() => blankBinding(props.environments[0]?.environmentId))
  const [attempted, setAttempted] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [boundRootId, setBoundRootId] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const lifetime = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort() }
  }, [])
  const busy = props.busy || saving || registering
  const environment = props.environments.find(entry => entry.environmentId === draft.environmentId)
  const localPeers = localBindingPeers(props.roots, t)
  const pathInvalid = attempted && !remotePath(draft.path.trim())
  const capable = draft.read || draft.write || draft.exec

  const save = (): void => {
    setAttempted(true)
    if (!remotePath(draft.path.trim()) || !capable || busy) return
    setSaving(true)
    setError(undefined)
    void props.onSave(draft).then(result => {
      if (lifetime.current?.signal.aborted !== false) return
      setSaving(false)
      if (result.error !== undefined) {
        setError(result.error)
        return
      }
      const created = result.state?.bindings.find(entry => entry.environmentId === draft.environmentId && entry.path === draft.path.trim())
      if (created === undefined) {
        setError(new PanelError('panel/bad-response', 'the binding answer did not contain the saved root'))
        return
      }
      setBoundRootId(created.rootId)
      setStage('register')
    })
  }

  const register = (): void => {
    const signal = lifetime.current?.signal
    if (props.remotes === undefined || environment === undefined || boundRootId === undefined || registering
      || signal === undefined || signal.aborted) return
    setRegistering(true)
    setError(undefined)
    void props.remotes.add(props.sessionId, environment.environmentId, boundRootId, signal).then(() => {
      if (signal.aborted) return
      setDone(true)
      props.onChanged()
    }).catch((cause: unknown) => {
      if (!signal.aborted) {
        setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
      }
    }).finally(() => {
      if (!signal.aborted) setRegistering(false)
    })
  }

  const footer = done ? (
    <WizardActions>
      <Button variant="primary" onClick={props.onClose}>{t('panel.close')}</Button>
    </WizardActions>
  ) : stage === 'binding' ? (
    <WizardActions>
      <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t('ssh.cancel')}</Button>
      <Button variant="primary" disabled={busy || !capable} loading={saving}
        onClick={save}>{t('ssh.step.next')}</Button>
    </WizardActions>
  ) : (
    <WizardActions>
      <Button variant="ghost" disabled={busy} onClick={() => setStage('binding')}>{t('ssh.step.back')}</Button>
      <Button variant="primary" disabled={busy || props.remotes === undefined} loading={registering}
        onClick={register}>{t('wizard.register')}</Button>
    </WizardActions>
  )

  const bindingBody = (): ReactNode => (
    <div className="mrfw-wizStack">
      <WizardField label={t('ssh.binding.environment')}>
        <WizardPicker label={t('ssh.binding.environment')} value={draft.environmentId} disabled={busy}
          items={props.environments.map(entry => ({ id: entry.environmentId, label: entry.displayName ?? entry.environmentId }))}
          onChange={environmentId => setDraft(blankBinding(environmentId))} />
      </WizardField>
      <WizardField label={t('ssh.binding.path')} invalid={pathInvalid}
        hint={pathInvalid ? t('error.workspace-invalid') : t('ssh.field.workspaceHint')}>
        <div className="mrfw-sshPathBar">
          <Input className="mrfw-sshInput" aria-label={t('ssh.binding.path')} value={draft.path} disabled={busy}
            onChange={event => setDraft({ ...draft, path: event.currentTarget.value })} />
          <Button variant="outline" size="sm" disabled={busy || environment === undefined}
            onClick={() => setPathOpen(true)}>{t('wizard.browse')}</Button>
        </div>
      </WizardField>
      <section className="mrfw-wizSection" aria-label={t('ssh.binding.actions')}>
        <span className="mrfw-wizFieldLabel">{t('ssh.binding.actions')}</span>
        <div className="mrfw-wizCheckRow">
          {(['read', 'write', 'exec'] as const).map(action => (
            <WizardCheckbox key={action} checked={draft[action]}
              disabled={busy || (action === 'exec' && !draft.exec && environment?.exec === undefined)}
              label={t(`remote.capability.${action}`)}
              onChange={next => setDraft({ ...draft, [action]: next })} />
          ))}
        </div>
      </section>
      {localPeers.length === 0 ? null : (
        <section className="mrfw-wizSection" aria-label={t('ssh.binding.transfers')}>
          <span className="mrfw-wizFieldLabel">{t('ssh.binding.transfers')}</span>
          {localPeers.map(peer => (
            <div key={peer.id} className="mrfw-wizCheckRow">
              <WizardCheckbox checked={draft.imports.has(peer.id)}
                label={`${t('ssh.binding.import')} (${peer.label})`}
                disabled={busy || (environment?.transfer === undefined && !draft.imports.has(peer.id))}
                onChange={() => setDraft({ ...draft, imports: togglePeer(draft.imports, peer.id) })} />
              <WizardCheckbox checked={draft.exports.has(peer.id)}
                label={`${t('ssh.binding.export')} (${peer.label})`}
                disabled={busy || (environment?.transfer === undefined && !draft.exports.has(peer.id))}
                onChange={() => setDraft({ ...draft, exports: togglePeer(draft.exports, peer.id) })} />
            </div>
          ))}
        </section>
      )}
      {environment === undefined ? null : (
        <WizardPathBrowser open={pathOpen} initialPath={draft.path} environmentId={draft.environmentId}
          ssh={props.ssh} sessionId={props.sessionId} t={t}
          onClose={() => setPathOpen(false)} onPick={path => setDraft({ ...draft, path })} />
      )}
    </div>
  )

  const registerBody = (): ReactNode => {
    if (environment === undefined) return null
    const actions = (['read', 'write', 'exec'] as const).filter(action => draft[action])
    const transferLines = localPeers.flatMap(peer => {
      const lines: string[] = []
      if (draft.imports.has(peer.id)) lines.push(`${t('ssh.binding.import')} (${peer.label})`)
      if (draft.exports.has(peer.id)) lines.push(`${t('ssh.binding.export')} (${peer.label})`)
      return lines
    })
    const target = sshTarget(environment.endpoint.user, environment.endpoint.hostname, environment.endpoint.port)
    return (
      <dl className="mrfw-wizSummary">
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryEnvironment')}</dt>
          <dd>{environment.displayName ?? environment.environmentId} · {target}</dd>
        </div>
        <div className="mrfw-wizSummaryRow">
          <dt>{t('wizard.summaryPath')}</dt>
          <dd>{sshLocation(target, draft.path.trim())}</dd>
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

  const body = done ? (
    <div className="mrfw-wizDone">
      <span className="mrfw-wizDoneMark" aria-hidden><CheckMark size={20} /></span>
      <p className="mrfw-wizDoneTitle">{t('wizard.done')}</p>
      <p className="mrfw-note">{t('wizard.doneHint')}</p>
    </div>
  ) : stage === 'binding' ? bindingBody() : registerBody()

  return (
    <WizardShell title={t('ssh.bindingAdd')} railLabel={t('ssh.binding.steps')} closeLabel={t('panel.close')}
      busy={busy} onClose={props.onClose} footer={footer} complete={done}
      steps={[{ id: 'binding', title: t('wizard.step.binding') }, { id: 'register', title: t('wizard.step.confirm') }]}
      current={stage === 'binding' ? 0 : 1}>
      <PanelErrorToast error={error} t={t} />
      {body}
    </WizardShell>
  )
}
