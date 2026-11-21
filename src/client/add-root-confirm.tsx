/**
 * The add-directory confirmation dialog: after the system picker returns a
 * path, the operator confirms the grant and picks the access level the
 * request carries — the same trust step the SSH enable flow performs, scoped
 * to one local directory.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/add-root-confirm
 */
import { useState, type ReactNode } from 'react'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RootAccess } from '../contract.ts'
import { IconAccessInherit, IconAccessReadOnly, IconAccessReadWrite, IconChevronDown } from '../compat/client-icons.ts'
import { SshButton as Button } from './panel-buttons.tsx'
import type { Translate } from './WorkspaceFoldersAction.tsx'

const ACCESS_ORDER: readonly RootAccess[] = ['inherit', 'read-only', 'read-write']

export function AddRootConfirm(props: {
  readonly path: string
  readonly pending: boolean
  readonly t: Translate
  readonly onCancel: () => void
  readonly onConfirm: (access: RootAccess | undefined) => void
}): ReactNode {
  const { t } = props
  const [access, setAccess] = useState<RootAccess>('inherit')
  const [chosen, setChosen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const accessLabel = (value: RootAccess): string =>
    value === 'inherit' ? t('panel.accessInherit')
      : value === 'read-only' ? t('panel.accessReadOnly')
        : t('panel.accessReadWrite')
  const accessIcon = (value: RootAccess): ReactNode => {
    const Icon = value === 'inherit' ? IconAccessInherit : value === 'read-only' ? IconAccessReadOnly : IconAccessReadWrite
    return Icon === undefined ? null : <Icon size={14} aria-hidden="true" />
  }
  return (
    <Modal
      open
      title={t('panel.addTrustTitle')}
      description={t('panel.addTrustDescription')}
      closeLabel={t('panel.close')}
      onClose={props.onCancel}
      className="mrfw-trustDialog"
      footer={<div className="mrfw-sshRowActions">
        <Button variant="ghost" disabled={props.pending} onClick={props.onCancel}>{t('panel.aliasCancel')}</Button>
        <Button variant="primary" disabled={props.pending} loading={props.pending}
          onClick={() => props.onConfirm(chosen ? access : undefined)}>{t('panel.addConfirm')}</Button>
      </div>}
    >
      <p className="mrfw-trustPath" title={props.path}>{props.path}</p>
      <div className="mrfw-trustAccess">
        <span className="mrfw-trustAccessLabel">{t('panel.accessLabel')}</span>
        <Menu
          open={menuOpen}
          portal
          autoFocus
          selectedId={access}
          items={ACCESS_ORDER.map(id => ({ id, label: accessLabel(id), icon: accessIcon(id) }))}
          onClose={() => setMenuOpen(false)}
          onSelect={id => {
            setMenuOpen(false)
            if (ACCESS_ORDER.includes(id as RootAccess)) {
              setAccess(id as RootAccess)
              setChosen(true)
            }
          }}
          anchor={
            <button
              type="button"
              className="mrfw-accessTrigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={props.pending}
              onClick={() => setMenuOpen(open => !open)}
              onKeyDown={event => {
                if (menuOpen || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
                event.preventDefault()
                setMenuOpen(true)
              }}
            >
              {accessIcon(access)}
              <span>{accessLabel(access)}</span>
              <IconChevronDown size={12} aria-hidden="true" />
            </button>
          }
        />
      </div>
    </Modal>
  )
}
