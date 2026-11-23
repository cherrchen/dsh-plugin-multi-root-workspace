import { useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshDependencyView } from '../remote/ssh-diagnostics.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import { errorKeyOf, type PanelError } from './panel-client.ts'
import { PanelErrorToast } from './error-toast.tsx'
import { SshButton as Button } from './panel-buttons.tsx'

interface DependencyNoticeProps {
  readonly view: SshDependencyView
  readonly onCheck: () => void
  readonly checking?: boolean
  readonly t: Translate
}

export function SshDependencyNotice({ view, onCheck, checking = false, t }: DependencyNoticeProps): ReactNode {
  const [copy, setCopy] = useState<{ command: string; ok: boolean }>()
  const command = view.command
  return <div className="mrfw-wizStack">
    <p className="mrfw-sshDependencySummary" role="status">{t(errorKeyOf(view.code))}</p>
    {view.profile === undefined || view.release === undefined ? null
      : <p className="mrfw-note">{t('ssh.dependenciesProfile', { profile: view.profile, version: view.release })}</p>}
    {view.code.startsWith('ssh-host-') ? null : <ul className="mrfw-sshDependencyPackages">
      {view.packages.map(pkg => <li key={pkg.name}>
        <code>{pkg.name}</code> · {t(`ssh.dependency.${pkg.state}`)}{pkg.version === undefined ? '' : ` (${pkg.version})`}
      </li>)}
    </ul>}
    {command === undefined ? null : <>
      <p className="mrfw-note">{t('ssh.dependenciesInstall')}</p>
      <code className="mrfw-sshDependencyCommand">{command}</code>
    </>}
    {command === undefined && view.code !== 'ssh-deps-restart'
      ? <p className="mrfw-note">{t(view.code.startsWith('ssh-host-') ? 'ssh.remedy.host' : 'ssh.dependenciesNoCommand')}</p> : null}
    <div className="mrfw-sshDependencyActions">
      {command === undefined ? null : <Button variant="primary" size="sm" onClick={async () => {
        try {
          await navigator.clipboard.writeText(command)
          setCopy({ command, ok: true })
        } catch {
          setCopy({ command, ok: false })
        }
      }}>{t('ssh.copyInstallCommand')}</Button>}
      <Button variant="outline" size="sm" disabled={checking} loading={checking} onClick={onCheck}>{t('ssh.recheckDependencies')}</Button>
    </div>
    {copy !== undefined && copy.command === command
      ? <p className="mrfw-note" role="status">{t(copy.ok ? 'ssh.commandCopied' : 'error.copy-failed')}</p> : null}
  </div>
}

export function SshDependencyDialog({ onClose, error, ...notice }: DependencyNoticeProps & {
  readonly onClose: () => void
  readonly error: PanelError | undefined
}): ReactNode {
  return <Modal open title={notice.t('ssh.dependenciesTitle')} closeLabel={notice.t('panel.close')}
    className="mrfw-sshDependencyDialog" onClose={onClose}>
    <SshDependencyNotice {...notice} />
    <PanelErrorToast error={error} t={notice.t} />
  </Modal>
}
