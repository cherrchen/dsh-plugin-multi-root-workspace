import { RemoteRootConfirm } from './remote-root-confirm.tsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconEdit, IconTrash } from '../compat/client-icons.ts'
import type { RootsView } from '../contract.ts'
import type { RemoteAction, RemoteEndpointView } from '../remote/panel-contract.ts'
import { errorHasDetail, errorKeyOf, PanelError } from './panel-client.ts'
import { PendingSpinner } from './pending.tsx'
import type { SshBindingView, SshClient } from './ssh-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

export function localBindingPeers(roots: RootsView | undefined, t: Translate): readonly { id: string; label: string }[] {
  return [
    { id: 'primary', label: t('panel.primary') },
    ...(roots?.roots ?? [])
      .filter(root => root.state === 'available' && root.aliasId !== undefined)
      .map(root => ({ id: root.aliasId!, label: root.alias ?? root.aliasId! })),
  ]
}

const ACTIONS = ['read', 'write', 'exec'] as const
type Transfer = NonNullable<SshBindingView['transfers']>[number]
type Direction = Transfer['direction']

interface CapabilityDraft {
  readonly revision: number
  readonly binding: SshBindingView
  readonly canExec: boolean
  readonly canTransfer: boolean
  readonly actions: ReadonlySet<RemoteAction>
  readonly transfers: readonly Transfer[]
}

interface RemoteRootMenuProps {
  readonly endpoint: RemoteEndpointView
  readonly ssh: SshClient | undefined
  readonly sessionId: string | undefined
  readonly roots: RootsView | undefined
  readonly open: boolean
  readonly pending: boolean
  readonly anchor: ReactNode
  readonly t: Translate
  readonly onClose: () => void
  readonly onRegistration: (action: 'register' | 'remove' | 'unbind') => void
  readonly onChanged: () => void
  /** Opens the workspace bindings dialog straight into this row's edit form. */
  readonly onEditBinding?: (() => void) | undefined
}

export function RemoteRootMenu(props: RemoteRootMenuProps): ReactNode {
  const { endpoint, ssh, sessionId, roots, open, pending, t } = props
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<CapabilityDraft>()
  const [error, setError] = useState<PanelError>()
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const { environmentId, rootId, path } = endpoint
  const canEdit = ssh !== undefined && sessionId !== undefined
  const controlsPending = pending || saving

  useEffect(() => {
    if (!open) {
      setEditing(false)
      setDraft(undefined)
      setError(undefined)
      return
    }
    if (!editing || ssh === undefined || sessionId === undefined) return

    const controller = new AbortController()
    void ssh.state(sessionId, controller.signal).then(view => {
      if (controller.signal.aborted) return
      const binding = view.bindings.find(entry => entry.environmentId === environmentId && entry.rootId === rootId)
      const environment = view.environments.find(entry => entry.environmentId === environmentId)
      if (binding?.path !== path || environment === undefined) {
        throw new PanelError('binding-changed', 'The binding changed before the menu opened.')
      }
      setError(undefined)
      setDraft({
        revision: view.revision, binding,
        canExec: environment.exec !== undefined,
        canTransfer: environment.transfer !== undefined,
        actions: new Set(binding.actions),
        transfers: binding.transfers ?? [],
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    })
    return () => controller.abort()
  }, [open, editing, ssh, sessionId, environmentId, rootId, path, attempt])

  const save = async (): Promise<void> => {
    if (ssh === undefined || sessionId === undefined || draft === undefined || saving) return
    setSaving(true)
    setError(undefined)
    try {
      await ssh.bindingSave(sessionId, draft.revision, {
        environmentId, rootId, path,
        actions: ACTIONS.filter(action => draft.actions.has(action)),
        ...(draft.transfers.length === 0 ? {} : { transfers: draft.transfers }),
      })
      props.onClose()
      props.onChanged()
    } catch (cause: unknown) {
      setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      setSaving(false)
    }
  }

  const checked = new Set<string>(draft?.actions)
  const update = new Map<string, () => void>()
  const items: MenuEntry[] = []
  const registering = endpoint.state !== 'registered'
  if (!editing || !canEdit) {
    if (canEdit && props.onEditBinding !== undefined) {
      items.push({ id: 'edit-binding', label: t('panel.remoteEdit'), icon: <IconEdit />, disabled: controlsPending })
    }
    if (canEdit) items.push({ id: 'edit', label: t('ssh.binding.editCapabilities'), icon: <IconEdit />, disabled: controlsPending })
    if (registering) {
      items.push({
        id: 'register', label: t(endpoint.state === 'withheld' ? 'panel.reRegister' : 'panel.remoteRegister'), disabled: controlsPending,
      })
    }
    // Personal custody owns the binding, so removal is offered in every state
    // — it is the only way to drop an unregistered row. Without it the menu
    // keeps the registration-only remove on registered rows alone.
    if (canEdit || !registering) {
      items.push({ id: 'remove', label: t('panel.remoteRemove'), icon: <IconTrash />, danger: true, disabled: controlsPending })
    }
  } else {
    if (error !== undefined) {
      const label = t(errorKeyOf(error.code)) + (errorHasDetail(error.code) ? ` (${error.message})` : '')
      items.push({ id: 'error', type: 'label', text: label }, { id: 'retry', label: t('panel.retry') })
    } else if (draft === undefined) {
      items.push({ id: 'loading', type: 'label', text: t('panel.loading') })
    } else {
      for (const action of ACTIONS) {
        const selected = draft.actions.has(action)
        items.push({ id: action, label: t(`remote.capability.${action}`),
          disabled: saving || (selected ? draft.actions.size === 1 : action === 'exec' && !draft.canExec) })
        update.set(action, () => {
          const actions = new Set(draft.actions)
          if (selected) actions.delete(action)
          else actions.add(action)
          setDraft({ ...draft, actions })
        })
      }

      const peers = localBindingPeers(roots, t)
      for (const direction of ['import', 'export'] satisfies Direction[]) {
        const label = t(direction === 'import' ? 'ssh.binding.import' : 'ssh.binding.export')
        items.push({ id: direction, type: 'label', text: label })
        for (const peer of peers) {
          const id = `${direction}:${peer.id}`
          const matches = (transfer: Transfer) => transfer.direction === direction
            && transfer.peer.environmentId === 'local' && transfer.peer.rootId === peer.id
          const selected = draft.transfers.some(matches)
          if (selected) checked.add(id)
          items.push({ id, label: peer.label, disabled: saving || (!draft.canTransfer && !selected) })
          update.set(id, () => setDraft({
            ...draft,
            transfers: selected ? draft.transfers.filter(transfer => !matches(transfer))
              : [...draft.transfers, { direction, peer: { environmentId: 'local', rootId: peer.id } }],
          }))
        }
      }
      const changed = draft.actions.size !== draft.binding.actions.length || draft.binding.actions.some(action => !draft.actions.has(action))
        || draft.transfers.length !== (draft.binding.transfers?.length ?? 0)
        || draft.transfers.some(transfer => !draft.binding.transfers?.some(entry => entry.direction === transfer.direction
          && entry.peer.environmentId === transfer.peer.environmentId && entry.peer.rootId === transfer.peer.rootId))
      if (endpoint.state === 'registered' && changed) {
        items.push({ id: 're-register', type: 'label', text: t('ssh.binding.editCapabilitiesReregister') })
      }
      items.push({
        id: 'save',
        label: t('ssh.binding.save'),
        icon: saving ? <PendingSpinner size={14} /> : undefined,
        disabled: !changed,
      })
    }
    items.push({ id: 'cancel', label: t('ssh.cancel'), disabled: saving })
  }

  return <><Menu open={open} anchor={props.anchor} items={items} selectedIds={editing ? [...checked] : []}
    portal align="end" closeOnPointerLeave={!editing} autoFocus onClose={props.onClose} onSelect={id => {
      if (id === 'register') props.onRegistration(id)
      else if (id === 'edit-binding') { props.onClose(); props.onEditBinding?.() }
      else if (id === 'remove') { props.onClose(); setConfirmRemove(true) }
      else if (id === 'edit') { setError(undefined); setEditing(true) }
      else if (id === 'cancel') {
        setEditing(false)
        setDraft(undefined)
        setError(undefined)
      } else if (id === 'retry') {
        setDraft(undefined)
        setError(undefined)
        setAttempt(current => current + 1)
        props.onChanged()
      } else if (id === 'save') void save()
      else update.get(id)?.()
    }} />
    {confirmRemove && (canEdit || endpoint.state === 'registered') ? (
      <RemoteRootConfirm kind={canEdit ? 'root' : 'registration'} path={path} t={t} onClose={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); props.onRegistration(canEdit ? 'unbind' : 'remove') }} />
    ) : null}
  </>
}
