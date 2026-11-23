import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshDependencyView } from '../remote/ssh-diagnostics.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import { errorKeyOf, type PanelError } from './panel-client.ts'
import { PanelErrorToast } from './error-toast.tsx'
import { SshButton as Button } from './panel-buttons.tsx'
import { sshInstallLauncher, type SshInstallPhase } from './ssh-install-launcher.ts'

interface DependencyNoticeProps {
  readonly view: SshDependencyView
  readonly onCheck: () => void
  readonly checking?: boolean
  readonly t: Translate
}

export function SshDependencyNotice({ view, onCheck, checking = false, t }: DependencyNoticeProps): ReactNode {
  const [copy, setCopy] = useState<{ command: string; ok: boolean }>()
  const [install, setInstall] = useState<{ phase: SshInstallPhase | 'failed'; message?: string }>()
  const launcher = useMemo(() => sshInstallLauncher(), [])
  const installable = launcher !== undefined && view.profile !== undefined && view.release !== undefined
    && (view.code === 'ssh-deps-missing' || view.code === 'ssh-deps-partial')
  const installing = install !== undefined && install.phase !== 'done' && install.phase !== 'failed'
  useEffect(() => {
    if (!installable) return undefined
    return launcher!.subscribe(phase => { setInstall({ phase }) })
  }, [installable, launcher])
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
      {installable ? <Button variant="primary" size="sm" disabled={installing} loading={installing}
        onClick={async () => {
          setInstall({ phase: 'stopping' })
          try {
            const result = await launcher!.install({ profile: view.profile!, release: view.release! })
            setInstall({ phase: result.status === 'ready' ? 'checking' : 'done' })
            onCheck()
          } catch (cause: unknown) {
            setInstall({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
          }
        }}>{t('ssh.installAndRestart')}</Button> : null}
      {command === undefined ? null : <Button variant={installable ? 'outline' : 'primary'} size="sm" onClick={async () => {
        try {
          await navigator.clipboard.writeText(command)
          setCopy({ command, ok: true })
        } catch {
          setCopy({ command, ok: false })
        }
      }}>{t('ssh.copyInstallCommand')}</Button>}
      <Button variant="outline" size="sm" disabled={checking} loading={checking} onClick={onCheck}>{t('ssh.recheckDependencies')}</Button>
    </div>
    {install !== undefined ? <p className="mrfw-note" role="status">
      {install.phase === 'failed' ? t('ssh.installPhase.failed', { message: install.message ?? '' }) : t(`ssh.installPhase.${install.phase}`)}
    </p> : null}
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
