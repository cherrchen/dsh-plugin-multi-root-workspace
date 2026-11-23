import { useState, type ReactNode } from 'react'
import type { SshDependencyView } from '../remote/ssh-diagnostics.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import { errorKeyOf } from './panel-client.ts'
import { SshButton as Button } from './panel-buttons.tsx'

export function SshDependencyNotice({ view, onCheck, t }: {
  readonly view: SshDependencyView
  readonly onCheck: () => void
  readonly t: Translate
}): ReactNode {
  const [copy, setCopy] = useState<{ command: string; ok: boolean }>()
  return <div className="mrfw-wizStack" role="status">
    <p className="mrfw-note">{t(errorKeyOf(view.code))}</p>
    {view.profile === undefined || view.release === undefined ? null
      : <p className="mrfw-note">{t('ssh.dependenciesProfile', { profile: view.profile, version: view.release })}</p>}
    {view.code.startsWith('ssh-host-') ? null : <ul className="mrfw-note">
      {view.packages.map(pkg => <li key={pkg.name}>
        <code>{pkg.name}</code> · {t(`ssh.dependency.${pkg.state}`)}{pkg.version === undefined ? '' : ` (${pkg.version})`}
      </li>)}
    </ul>}
    {view.command === undefined ? null : <>
      <p className="mrfw-note">{t('ssh.dependenciesInstall')}</p>
      <code className="mrfw-sshDependencyCommand">{view.command}</code>
      <div>
        <Button size="sm" onClick={async () => {
          const command = view.command!
          try {
            await navigator.clipboard.writeText(command)
            setCopy({ command, ok: true })
          } catch {
            setCopy({ command, ok: false })
          }
        }}>{t('ssh.copyInstallCommand')}</Button>
        {copy !== undefined && copy.command === view.command
          ? <p className="mrfw-note">{t(copy.ok ? 'ssh.commandCopied' : 'error.copy-failed')}</p> : null}
      </div>
    </>}
    {view.command === undefined && view.code !== 'ssh-deps-restart'
      ? <p className="mrfw-note">{t(view.code.startsWith('ssh-host-') ? 'ssh.remedy.host' : 'ssh.dependenciesNoCommand')}</p> : null}
    <div><Button size="sm" onClick={onCheck}>{t('ssh.recheckDependencies')}</Button></div>
  </div>
}
