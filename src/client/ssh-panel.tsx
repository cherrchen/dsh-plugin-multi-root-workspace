/**
 * The personal-mode management area inside the Workspace Folders remote
 * section (ADR-0041 §6). Renders only while the plane is `ready` in personal
 * custody; team/hardened keep the read-only endpoint list. Every mutation
 * answers the refreshed `SshStateView`, so the area keeps one `view` and one
 * `revision` for all CAS writes. Secret material is input-only: credential
 * textareas are cleared immediately after submit — success or failure — and
 * are never prefilled from state.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-panel
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RootsView } from '../contract.ts'
import { errorKeyOf, PanelError } from './panel-client.ts'
import type { CredentialPublicView, SshBindingView, SshClient, SshEnvironmentView, SshStateView } from './ssh-client.ts'
import type { Key } from './locales.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/** The exec stanza the "allow command execution" toggle materializes (ADR-0041). */
const EXEC_DEFAULTS = {
  shell: ['/bin/sh', '-c'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  maxTimeoutMs: 600_000,
  stdoutLimit: 1_048_576,
  stderrLimit: 262_144,
  terminateGraceMs: 2_000,
} as const

/** The transfer stanza the "allow file transfer" toggle materializes. */
const TRANSFER_DEFAULTS = { maxBytes: 268_435_456, timeoutMs: 600_000 } as const

interface EditorDraft {
  readonly existing?: SshEnvironmentView | undefined
  environmentId: string
  displayName: string
  hostname: string
  port: string
  user: string
  platform: 'linux' | 'darwin'
  credentialSource: 'alias' | 'managed'
  alias: string
  credentialId: string
  workspace: string
  allowExec: boolean
  allowTransfer: boolean
}

interface BindingDraft {
  environmentId: string
  rootId: string
  path: string
  read: boolean
  write: boolean
  exec: boolean
  imports: ReadonlySet<string>
  exports: ReadonlySet<string>
}

const blankEditor = (): EditorDraft => ({
  environmentId: '', displayName: '', hostname: '', port: '22', user: '', platform: 'linux',
  credentialSource: 'managed', alias: '', credentialId: '', workspace: '', allowExec: false, allowTransfer: true,
})

const editorOf = (environment: SshEnvironmentView): EditorDraft => ({
  existing: environment,
  environmentId: environment.environmentId,
  displayName: environment.displayName ?? '',
  hostname: environment.endpoint.hostname,
  port: String(environment.endpoint.port),
  user: environment.endpoint.user,
  platform: environment.platform,
  credentialSource: environment.credential.kind === 'ssh-config' ? 'alias' : 'managed',
  alias: environment.credential.kind === 'ssh-config' ? environment.credential.alias : '',
  credentialId: environment.credential.kind === 'managed' ? environment.credential.credentialId : '',
  workspace: environment.workspace,
  allowExec: environment.exec !== undefined,
  allowTransfer: environment.transfer !== undefined,
})

const blankBinding = (environmentId: string | undefined): BindingDraft => ({
  environmentId: environmentId ?? '', rootId: '', path: '', read: true, write: false, exec: false,
  imports: new Set(), exports: new Set(),
})

/**
 * The personal-custody management area: link banner, credentials, environments,
 * and this project's bindings.
 */
export function SshPersonalArea(props: { ssh: SshClient; sessionId: string | undefined; roots: RootsView | undefined; t: Translate }): ReactNode {
  const { ssh, t } = props
  const [view, setView] = useState<SshStateView | undefined>(undefined)
  const [error, setError] = useState<PanelError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const [confirm, setConfirm] = useState<{ kind: 'credential' | 'environment'; id: string } | undefined>(undefined)
  const [addKind, setAddKind] = useState<'generate' | 'import' | 'password' | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [editor, setEditor] = useState<EditorDraft | undefined>(undefined)
  const [scan, setScan] = useState<{ token: string; keys: readonly { type: string; fingerprint: string }[] } | undefined>(undefined)
  const [fingerprint, setFingerprint] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [helperFor, setHelperFor] = useState<string | undefined>(undefined)
  const [helperNodePath, setHelperNodePath] = useState('')
  const [bindingDraft, setBindingDraft] = useState<BindingDraft | undefined>(undefined)
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    if (props.sessionId === undefined) return
    try {
      const state = await ssh.state(props.sessionId)
      if (mounted.current) setView(state)
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    }
  }, [ssh, props.sessionId])
  useEffect(() => { void load() }, [load])

  /** Every mutation answers the refreshed state; a CAS conflict reloads first. */
  const submit = useCallback(async (call: () => Promise<SshStateView>): Promise<void> => {
    setBusy(true)
    try {
      const state = await call()
      if (mounted.current) { setView(state); setError(undefined) }
    } catch (cause: unknown) {
      const failure = cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause))
      if (mounted.current) setError(failure)
      if (failure.code === 'personal-config-conflict') await load()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [load])

  const sessionId = props.sessionId
  if (sessionId === undefined) return null

  const clearSecretInputs = () => { setPrivateKey(''); setPassphrase(''); setPassword('') }
  const userCredentials = (view?.credentials ?? []).filter(credential => credential.purpose !== 'access-key')
  const accessKeys = (view?.credentials ?? []).filter(credential => credential.purpose === 'access-key')
  const credentialOf = (id: string | undefined): CredentialPublicView | undefined => view?.credentials.find(credential => credential.id === id)
  const environmentOf = (id: string): SshEnvironmentView | undefined => view?.environments.find(environment => environment.environmentId === id)

  const revision = (): number => view?.revision ?? 0

  const deleteCredential = async (id: string): Promise<void> => {
    setConfirm(undefined)
    await submit(async () => await ssh.credentialRemove(sessionId, id))
  }
  const deleteEnvironment = async (id: string): Promise<void> => {
    setConfirm(undefined)
    await submit(async () => await ssh.environmentRemove(sessionId, revision(), id))
  }
  const testEnvironment = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await ssh.environmentTest(sessionId, id)
      if (mounted.current) {
        setTestResults(previous => ({ ...previous, [id]: `${result.platform}${result.nodeVersion === undefined ? '' : ` · node ${result.nodeVersion}`}` }))
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const saveEnvironment = async (): Promise<void> => {
    if (editor === undefined || fingerprint === undefined) return
    const port = Number.parseInt(editor.port, 10)
    const draft = {
      environmentId: editor.environmentId,
      ...(editor.displayName.trim() === '' ? {} : { displayName: editor.displayName.trim() }),
      platform: editor.platform,
      endpoint: { hostname: editor.hostname.trim(), port: Number.isInteger(port) ? port : 22, user: editor.user.trim() },
      credential: editor.credentialSource === 'alias'
        ? { kind: 'ssh-config' as const, alias: editor.alias.trim() }
        : { kind: 'managed' as const, credentialId: editor.credentialId },
      workspace: editor.workspace.trim(),
      ...(editor.allowExec ? { exec: { ...EXEC_DEFAULTS, env: { ...EXEC_DEFAULTS.env }, shell: [...EXEC_DEFAULTS.shell] } } : {}),
      ...(editor.allowTransfer ? { transfer: { ...TRANSFER_DEFAULTS } } : {}),
    }
    const token = scan?.token
    setEditor(undefined); setScan(undefined); setFingerprint(undefined)
    await submit(async () => await ssh.environmentSave(sessionId, revision(), draft, fingerprint, editor.credentialSource === 'managed' ? token : undefined))
  }

  const saveBinding = async (): Promise<void> => {
    if (bindingDraft === undefined) return
    const actions = ([bindingDraft.read ? 'read' : undefined, bindingDraft.write ? 'write' : undefined, bindingDraft.exec ? 'exec' : undefined]
      .filter(action => action !== undefined))
    if (actions.length === 0) return
    const transfers = [
      ...[...bindingDraft.imports].map(rootId => ({ direction: 'import' as const, peer: { environmentId: 'local' as const, rootId } })),
      ...[...bindingDraft.exports].map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local' as const, rootId } })),
    ]
    const binding = { environmentId: bindingDraft.environmentId, rootId: bindingDraft.rootId.trim(), path: bindingDraft.path.trim(), actions, ...(transfers.length === 0 ? {} : { transfers }) }
    setBindingDraft(undefined)
    await submit(async () => await ssh.bindingSave(sessionId, revision(), binding))
  }

  const copyPublicKey = async (credential: CredentialPublicView): Promise<void> => {
    try {
      await navigator.clipboard.writeText(credential.publicKey ?? '')
      if (mounted.current) setCopiedId(credential.id)
    } catch {
      if (mounted.current) setError(new PanelError('copy-failed', 'clipboard write failed'))
    }
  }

  /** Local transfer peers: 'primary' plus every available root's stable alias id — the exact ids `localTransferDestination` accepts. */
  const localPeers: readonly { id: string; label: string }[] = [
    { id: 'primary', label: t('panel.primary') },
    ...(props.roots?.roots ?? [])
      .filter(root => root.state === 'available' && root.aliasId !== undefined)
      .map(root => ({ id: root.aliasId!, label: root.alias ?? root.aliasId! })),
  ]

  const togglePeer = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const credentialLabel = (credential: SshEnvironmentView['credential']): string =>
    credential.kind === 'ssh-config'
      ? t('ssh.credential.sshConfig', { alias: credential.alias })
      : t(credentialOf(credential.credentialId)?.kind === 'password' ? 'ssh.credential.managedPassword' : 'ssh.credential.managedKey')

  return <div className="mrfw-sshArea">
    {error === undefined ? null : <p role="alert" className="mrfw-alert">{t(errorKeyOf(error.code))}</p>}

    {view !== undefined && !view.linked && view.environments.some(environment => environment.credential.kind === 'managed') ? (
      <div className="mrfw-alert" role="note">
        <p className="mrfw-note">{t('ssh.linkBanner')}</p>
        <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy}
          onClick={() => { void submit(async () => await ssh.configLink(sessionId)) }}>
          {t('ssh.linkNow')}
        </button>
      </div>
    ) : null}

    <section className="mrfw-subsection">
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.credentials')}</span></div>
      {userCredentials.length === 0 ? <p className="mrfw-note">{t('ssh.empty.credentials')}</p> : null}
      {userCredentials.map(credential => (
        <div key={credential.id} className="mrfw-row">
          <div className="mrfw-rootText">
            <span className="mrfw-rootName">
              <span className="mrfw-rootNameText">{credential.label}</span>
              <span className="mrfw-accessBadge">{t(credential.kind === 'key' ? 'ssh.kind.key' : 'ssh.kind.password')}</span>
            </span>
            {credential.fingerprint === undefined ? null : <span className="mrfw-rootPath">{credential.fingerprint}</span>}
          </div>
          {credential.kind === 'key' && credential.publicKey !== undefined ? (
            <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy}
              onClick={() => { void copyPublicKey(credential) }}>
              {copiedId === credential.id ? t('ssh.copied') : t('ssh.copyPublicKey')}
            </button>
          ) : null}
          {confirm?.kind === 'credential' && confirm.id === credential.id ? (
            <>
              <button type="button" className="mrfw-btn mrfw-btnDanger" disabled={busy} onClick={() => { void deleteCredential(credential.id) }}>{t('ssh.confirmDelete')}</button>
              <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => setConfirm(undefined)}>{t('ssh.cancel')}</button>
            </>
          ) : (
            <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => setConfirm({ kind: 'credential', id: credential.id })}>{t('ssh.delete')}</button>
          )}
        </div>
      ))}
      <div className="mrfw-row mrfw-sshAddRow">
        <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => setAddKind(addKind === 'generate' ? undefined : 'generate')}>{t('ssh.credentialGenerate')}</button>
        <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => setAddKind(addKind === 'import' ? undefined : 'import')}>{t('ssh.credentialImport')}</button>
        <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy} onClick={() => setAddKind(addKind === 'password' ? undefined : 'password')}>{t('ssh.credentialPassword')}</button>
      </div>
      {addKind === undefined ? null : (
        <div className="mrfw-sshForm">
          <input className="mrfw-input" aria-label={t('ssh.label')} placeholder={t('ssh.label')} value={label} onChange={event => setLabel(event.currentTarget.value)} />
          {addKind === 'import' ? (
            <>
              <textarea className="mrfw-input" aria-label={t('ssh.privateKey')} placeholder={t('ssh.privateKey')} value={privateKey} onChange={event => setPrivateKey(event.currentTarget.value)} />
              <input className="mrfw-input" type="password" aria-label={t('ssh.passphrase')} placeholder={t('ssh.passphrase')} value={passphrase} onChange={event => setPassphrase(event.currentTarget.value)} />
            </>
          ) : null}
          {addKind === 'password' ? (
            <input className="mrfw-input" type="password" aria-label={t('ssh.password')} placeholder={t('ssh.password')} value={password} onChange={event => setPassword(event.currentTarget.value)} />
          ) : null}
          <button type="button" className="mrfw-btn mrfw-btnPrimary" disabled={busy || label.trim() === '' || (addKind === 'import' && privateKey === '') || (addKind === 'password' && password === '')}
            onClick={() => {
              const kind = addKind, name = label.trim(), key = privateKey, phrase = passphrase === '' ? undefined : passphrase, secret = password
              clearSecretInputs(); setLabel(''); setAddKind(undefined)
              void submit(async () => kind === 'generate'
                ? await ssh.credentialGenerate(sessionId, name)
                : kind === 'import'
                  ? await ssh.credentialImport(sessionId, name, key, phrase)
                  : await ssh.credentialPassword(sessionId, name, secret))
            }}>
            {t('panel.addConfirm')}
          </button>
        </div>
      )}
    </section>

    <section className="mrfw-subsection">
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.environments')}</span></div>
      {(view?.environments.length ?? 0) === 0 ? <p className="mrfw-note">{t('ssh.empty.environments')}</p> : null}
      {view?.environments.map(environment => {
        const id = environment.environmentId
        const envAccessKeys = accessKeys.filter(credential => credential.environmentId === id)
        return (
          <div key={id} className="mrfw-row mrfw-sshEnvRow">
            <div className="mrfw-rootText">
              <span className="mrfw-rootName">
                <span className="mrfw-rootNameText">{environment.displayName ?? id}</span>
                <span className="mrfw-accessBadge">{environment.platform}</span>
                <span className="mrfw-accessBadge">{environment.helper === null ? t('ssh.helperMissing') : t('ssh.helperInstalled')}</span>
              </span>
              <span className="mrfw-rootPath">{environment.endpoint.user}@{environment.endpoint.hostname}:{environment.endpoint.port} · {environment.workspace}</span>
              <span className="mrfw-note">{credentialLabel(environment.credential)}</span>
              {envAccessKeys.map(credential => (
                <span key={credential.id} className="mrfw-note">{t('ssh.accessKey')} · {credential.label}{credential.fingerprint === undefined ? '' : ` · ${credential.fingerprint}`}</span>
              ))}
              {testResults[id] === undefined ? null : <span className="mrfw-note">{testResults[id]}</span>}
            </div>
            <div className="mrfw-sshRowActions">
              <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => { void testEnvironment(id) }}>{t('ssh.envTest')}</button>
              {helperFor === id ? (
                <>
                  <input className="mrfw-input" aria-label={t('ssh.nodePath')} placeholder={t('ssh.nodePath')} value={helperNodePath}
                    onChange={event => setHelperNodePath(event.currentTarget.value)} />
                  <button type="button" className="mrfw-btn mrfw-btnPrimary" disabled={busy}
                    onClick={() => {
                      const nodePath = helperNodePath.trim()
                      setHelperFor(undefined); setHelperNodePath('')
                      void submit(async () => await ssh.helperInstall(sessionId, revision(), id, nodePath === '' ? undefined : nodePath))
                    }}>
                    {t('ssh.helperInstall')}
                  </button>
                </>
              ) : (
                <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => setHelperFor(id)}>{t('ssh.helperInstall')}</button>
              )}
              {environment.credential.kind === 'managed' && credentialOf(environment.credential.credentialId)?.kind === 'password' ? (
                <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy}
                  onClick={() => { void submit(async () => await ssh.accessKeyInstall(sessionId, revision(), id)) }}>
                  {t('ssh.accessKeyInstall')}
                </button>
              ) : null}
              <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => { setEditor(editorOf(environment)); setScan(undefined); setFingerprint(undefined) }}>{t('ssh.envEdit')}</button>
              {confirm?.kind === 'environment' && confirm.id === id ? (
                <>
                  <button type="button" className="mrfw-btn mrfw-btnDanger" disabled={busy} title={t('ssh.envDeleteHint')} onClick={() => { void deleteEnvironment(id) }}>{t('ssh.confirmDelete')}</button>
                  <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => setConfirm(undefined)}>{t('ssh.cancel')}</button>
                </>
              ) : (
                <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} title={t('ssh.envDeleteHint')} onClick={() => setConfirm({ kind: 'environment', id })}>{t('ssh.envDelete')}</button>
              )}
            </div>
          </div>
        )
      })}
      <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy || editor !== undefined} onClick={() => { setEditor(blankEditor()); setScan(undefined); setFingerprint(undefined) }}>{t('ssh.envAdd')}</button>
      {editor === undefined ? null : (
        <div className="mrfw-sshForm">
          <input className="mrfw-input" aria-label={t('ssh.field.environmentId')} placeholder={t('ssh.field.environmentId')} value={editor.environmentId} disabled={editor.existing !== undefined}
            onChange={event => setEditor({ ...editor, environmentId: event.currentTarget.value })} />
          <input className="mrfw-input" aria-label={t('ssh.field.displayName')} placeholder={t('ssh.field.displayName')} value={editor.displayName}
            onChange={event => setEditor({ ...editor, displayName: event.currentTarget.value })} />
          <input className="mrfw-input" aria-label={t('ssh.field.hostname')} placeholder={t('ssh.field.hostname')} value={editor.hostname}
            onChange={event => setEditor({ ...editor, hostname: event.currentTarget.value })} />
          <input className="mrfw-input" aria-label={t('ssh.field.port')} placeholder={t('ssh.field.port')} type="number" value={editor.port}
            onChange={event => setEditor({ ...editor, port: event.currentTarget.value })} />
          <input className="mrfw-input" aria-label={t('ssh.field.user')} placeholder={t('ssh.field.user')} value={editor.user}
            onChange={event => setEditor({ ...editor, user: event.currentTarget.value })} />
          <label className="mrfw-field">
            <span className="mrfw-note">{t('ssh.field.platform')}</span>
            <select className="mrfw-input" value={editor.platform} onChange={event => setEditor({ ...editor, platform: event.currentTarget.value as 'linux' | 'darwin' })}>
              <option value="linux">linux</option>
              <option value="darwin">darwin</option>
            </select>
          </label>
          <div role="radiogroup" aria-label={t('ssh.field.credential')} className="mrfw-modeGroup">
            <label className="mrfw-modeOption">
              <input type="radio" name="mrfw-ssh-cred" checked={editor.credentialSource === 'alias'} onChange={() => setEditor({ ...editor, credentialSource: 'alias' })} />
              <span className="mrfw-modeOptionTitle">{t('ssh.field.alias')}</span>
            </label>
            <label className="mrfw-modeOption">
              <input type="radio" name="mrfw-ssh-cred" checked={editor.credentialSource === 'managed'} onChange={() => setEditor({ ...editor, credentialSource: 'managed' })} />
              <span className="mrfw-modeOptionTitle">{t('ssh.field.managed')}</span>
            </label>
          </div>
          {editor.credentialSource === 'alias' ? (
            <input className="mrfw-input" aria-label={t('ssh.field.alias')} placeholder={t('ssh.field.alias')} value={editor.alias}
              onChange={event => setEditor({ ...editor, alias: event.currentTarget.value })} />
          ) : (
            <select className="mrfw-input" aria-label={t('ssh.field.managed')} value={editor.credentialId}
              onChange={event => setEditor({ ...editor, credentialId: event.currentTarget.value })}>
              <option value="">{t('ssh.field.managed')}</option>
              {userCredentials.map(credential => <option key={credential.id} value={credential.id}>{credential.label}</option>)}
            </select>
          )}
          <input className="mrfw-input" aria-label={t('ssh.field.workspace')} placeholder={t('ssh.field.workspace')} value={editor.workspace}
            onChange={event => setEditor({ ...editor, workspace: event.currentTarget.value })} />
          <label className="mrfw-field">
            <input type="checkbox" checked={editor.allowExec} onChange={event => setEditor({ ...editor, allowExec: event.currentTarget.checked })} />
            <span className="mrfw-modeOptionTitle">{t('ssh.field.allowExec')}</span>
          </label>
          <label className="mrfw-field">
            <input type="checkbox" checked={editor.allowTransfer} onChange={event => setEditor({ ...editor, allowTransfer: event.currentTarget.checked })} />
            <span className="mrfw-modeOptionTitle">{t('ssh.field.allowTransfer')}</span>
          </label>
          <div className="mrfw-sshScanRow">
            <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy || editor.hostname.trim() === ''}
              onClick={() => {
                const port = Number.parseInt(editor.port, 10)
                void (async () => {
                  setBusy(true)
                  try {
                    const result = await ssh.hostKeyScan(sessionId, editor.hostname.trim(), Number.isInteger(port) ? port : 22)
                    if (mounted.current) { setScan(result); setFingerprint(result.keys[0]?.fingerprint) }
                  } catch (cause: unknown) {
                    if (mounted.current) setError(cause instanceof PanelError ? cause : new PanelError('unavailable', String(cause)))
                  } finally {
                    if (mounted.current) setBusy(false)
                  }
                })()
              }}>
              {t('ssh.scan')}
            </button>
            {scan === undefined ? null : (
              <div className="mrfw-modeGroup" role="radiogroup" aria-label={t('ssh.scanPick')}>
                {scan.keys.map(key => (
                  <label key={key.fingerprint} className="mrfw-modeOption">
                    <input type="radio" name="mrfw-ssh-fp" checked={fingerprint === key.fingerprint} onChange={() => setFingerprint(key.fingerprint)} />
                    <span className="mrfw-modeOptionTitle">{key.type} {key.fingerprint}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="mrfw-sshRowActions">
            <button type="button" className="mrfw-btn mrfw-btnPrimary"
              disabled={busy || fingerprint === undefined || editor.environmentId.trim() === '' || editor.hostname.trim() === '' || editor.user.trim() === '' || editor.workspace.trim() === ''
                || (editor.credentialSource === 'alias' ? editor.alias.trim() === '' : editor.credentialId === '')}
              onClick={() => { void saveEnvironment() }}>
              {t('ssh.envSave')}
            </button>
            <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => { setEditor(undefined); setScan(undefined); setFingerprint(undefined) }}>{t('ssh.cancel')}</button>
          </div>
        </div>
      )}
    </section>

    <section className="mrfw-subsection">
      <div className="mrfw-sectionTitleRow"><span className="mrfw-sectionTitle">{t('ssh.bindings')}</span></div>
      {(view?.bindings.length ?? 0) === 0 ? <p className="mrfw-note">{t('ssh.empty.bindings')}</p> : null}
      {view?.bindings.map((binding: SshBindingView) => (
        <div key={`${binding.environmentId}/${binding.rootId}`} className="mrfw-row">
          <div className="mrfw-rootText">
            <span className="mrfw-rootName">
              <span className="mrfw-rootNameText">{environmentOf(binding.environmentId)?.displayName ?? binding.environmentId}</span>
              <span className="mrfw-accessBadge">{binding.rootId}</span>
            </span>
            <span className="mrfw-rootPath">{binding.path}</span>
            <span className="mrfw-note">
              {binding.actions.join(', ')}
              {(binding.transfers ?? []).map(transfer => ` · ${transfer.direction === 'import' ? '⇐' : '⇒'} ${transfer.peer.rootId}`).join('')}
            </span>
          </div>
          <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy}
            onClick={() => { void submit(async () => await ssh.bindingRemove(sessionId, revision(), binding.environmentId, binding.rootId)) }}>
            {t('ssh.delete')}
          </button>
        </div>
      ))}
      <button type="button" className="mrfw-btn mrfw-btnOutline" disabled={busy || bindingDraft !== undefined || (view?.environments.length ?? 0) === 0}
        onClick={() => setBindingDraft(blankBinding(view?.environments[0]?.environmentId))}>
        {t('ssh.bindingAdd')}
      </button>
      {bindingDraft === undefined ? null : (
        <div className="mrfw-sshForm">
          <select className="mrfw-input" aria-label={t('ssh.binding.environment')} value={bindingDraft.environmentId}
            onChange={event => setBindingDraft({ ...bindingDraft, environmentId: event.currentTarget.value })}>
            {(view?.environments ?? []).map(environment => <option key={environment.environmentId} value={environment.environmentId}>{environment.displayName ?? environment.environmentId}</option>)}
          </select>
          <input className="mrfw-input" aria-label={t('ssh.binding.rootId')} placeholder={t('ssh.binding.rootId')} value={bindingDraft.rootId}
            onChange={event => setBindingDraft({ ...bindingDraft, rootId: event.currentTarget.value })} />
          <input className="mrfw-input" aria-label={t('ssh.binding.path')} placeholder={t('ssh.binding.path')} value={bindingDraft.path}
            onChange={event => setBindingDraft({ ...bindingDraft, path: event.currentTarget.value })} />
          <div className="mrfw-modeGroup" role="group" aria-label={t('ssh.binding.actions')}>
            {(['read', 'write', 'exec'] as const).map(action => {
              const allowed = action !== 'exec' || environmentOf(bindingDraft.environmentId)?.exec !== undefined
              return (
                <label key={action} className="mrfw-modeOption">
                  <input type="checkbox" checked={bindingDraft[action]} disabled={!allowed}
                    onChange={event => setBindingDraft({ ...bindingDraft, [action]: event.currentTarget.checked })} />
                  <span className="mrfw-modeOptionTitle">{t(`remote.capability.${action}` as Key)}</span>
                </label>
              )
            })}
          </div>
          <div className="mrfw-modeGroup" role="group" aria-label={t('ssh.binding.transfers')}>
            {localPeers.map(peer => (
              <span key={peer.id} className="mrfw-modeOption">
                <label>
                  <input type="checkbox" checked={bindingDraft.imports.has(peer.id)}
                    onChange={() => setBindingDraft({ ...bindingDraft, imports: togglePeer(bindingDraft.imports, peer.id) })} />
                  <span className="mrfw-modeOptionTitle">{t('ssh.binding.import')} {peer.label}</span>
                </label>
                <label>
                  <input type="checkbox" checked={bindingDraft.exports.has(peer.id)}
                    onChange={() => setBindingDraft({ ...bindingDraft, exports: togglePeer(bindingDraft.exports, peer.id) })} />
                  <span className="mrfw-modeOptionTitle">{t('ssh.binding.export')} {peer.label}</span>
                </label>
              </span>
            ))}
          </div>
          <div className="mrfw-sshRowActions">
            <button type="button" className="mrfw-btn mrfw-btnPrimary"
              disabled={busy || bindingDraft.environmentId === '' || bindingDraft.rootId.trim() === '' || bindingDraft.path.trim() === ''
                || !(bindingDraft.read || bindingDraft.write || bindingDraft.exec)}
              onClick={() => { void saveBinding() }}>
              {t('ssh.binding.save')}
            </button>
            <button type="button" className="mrfw-btn mrfw-btnGhost" disabled={busy} onClick={() => setBindingDraft(undefined)}>{t('ssh.cancel')}</button>
          </div>
        </div>
      )}
    </section>
  </div>
}
