import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { SshButton as Button } from './panel-buttons.tsx'
import type { Translate } from './WorkspaceFoldersAction.tsx'

export function RemoteRootConfirm(props: {
  readonly kind: 'binding' | 'registration' | 'root'
  readonly path: string
  readonly t: Translate
  readonly onClose: () => void
  readonly onConfirm: () => void
}): ReactNode {
  const { kind, path, t } = props
  const binding = kind === 'binding'
  const description = binding ? 'ssh.binding.confirmRemove'
    : kind === 'root' ? 'panel.remoteConfirmRemoveBound' : 'panel.remoteConfirmRemove'
  return <Modal open title={t(binding ? 'ssh.binding.remove' : 'panel.remoteRemove')}
    description={t(description, { path })}
    closeLabel={t('panel.close')} onClose={props.onClose}
    footer={<>
      <Button variant="ghost" onClick={props.onClose}>{t('ssh.cancel')}</Button>
      <Button variant="ghost" className="mrfw-sshDanger" onClick={props.onConfirm}>{t('ssh.confirmDelete')}</Button>
    </>} />
}
