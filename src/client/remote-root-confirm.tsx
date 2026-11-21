import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './WorkspaceFoldersAction.tsx'

export function RemoteRootConfirm(props: {
  readonly kind: 'binding' | 'registration'
  readonly path: string
  readonly t: Translate
  readonly onClose: () => void
  readonly onConfirm: () => void
}): ReactNode {
  const { kind, path, t } = props
  const binding = kind === 'binding'
  return <Modal open title={t(binding ? 'ssh.binding.remove' : 'panel.remoteRemove')}
    description={t(binding ? 'ssh.binding.confirmRemove' : 'panel.remoteConfirmRemove', { path })}
    closeLabel={t('panel.close')} onClose={props.onClose}
    footer={<>
      <Button variant="ghost" onClick={props.onClose}>{t('ssh.cancel')}</Button>
      <Button variant="ghost" className="mrfw-sshDanger" onClick={props.onConfirm}>{t('ssh.confirmDelete')}</Button>
    </>} />
}
