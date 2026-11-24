/**
 * The SSH environment draft and its validation rules, shared by the legacy
 * management dialog (`ssh-panel.tsx`) and the new add-remote wizard
 * (`wizard/add-remote.tsx`): both drive the same personal contract and must
 * never drift on what the wire accepts. Visual components stay in their own
 * files — this module is logic only.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-draft
 */
import type { SshBindingDraft, SshEnvironmentView } from './ssh-client.ts'
import type { Key } from './locales.ts'

/**
 * The exec stanza the "allow command execution" toggle materializes (ADR-0049).
 * The deployment limits leave room for an explicit larger tool preview.
 */
export const EXEC_DEFAULTS = {
  shell: ['/bin/sh', '-c'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  maxTimeoutMs: 600_000,
  stdoutLimit: 1_048_576,
  stderrLimit: 262_144,
  terminateGraceMs: 2_000,
} as const

/** The transfer stanza the "allow file transfer" toggle materializes. */
export const TRANSFER_DEFAULTS = { maxBytes: 268_435_456, timeoutMs: 600_000 } as const

export interface EditorDraft {
  readonly existing?: SshEnvironmentView | undefined
  displayName: string
  hostname: string
  port: string
  user: string
  platform: 'linux' | 'darwin'
  credentialSource: 'alias' | 'managed'
  alias: string
  credentialId: string
  allowExec: boolean
  allowTransfer: boolean
}

export const blankEditor = (): EditorDraft => ({
  displayName: '', hostname: '', port: '22', user: '', platform: 'linux',
  credentialSource: 'managed', alias: '', credentialId: '', allowExec: false, allowTransfer: false,
})

/** The persisted environmentId rule — checked here so save never reaches the wire with an id the store would refuse. */
export const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9-]{2,62}$/

/** The wire alias rule (`sshHostKeyScan` / `credentialDraft`). */
export const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** The wire hostname/user rule: non-empty, bounded, no whitespace, no leading dash. */
export const sshToken = (value: string, max: number): boolean => {
  const text = value.trim()
  return text.length >= 1 && text.length <= max && !/\s/.test(text) && !text.startsWith('-')
}

/** The wire port rule: an integer from 1 to 65535 — no silent default-22. */
export const sshPort = (value: string): boolean => {
  if (!/^\d{1,5}$/.test(value.trim())) return false
  const port = Number.parseInt(value.trim(), 10)
  return port >= 1 && port <= 65535
}

/** `checkRemotePath` mirrored: a normalized absolute POSIX path. */
export const remotePath = (path: string): boolean =>
  path.startsWith('/') && !path.includes('\0')
  && !path.split('/').slice(1).some(segment => segment === '' || segment === '.' || segment === '..')

/** Fields validated when adding a connection. */
export type ConnectField = 'hostname' | 'port' | 'user' | 'alias' | 'credentialId'

/** The localized hint key for one invalid field, or undefined when it passes. */
export function draftFieldError(draft: EditorDraft, field: ConnectField): Key | undefined {
  switch (field) {
    case 'hostname': return draft.credentialSource === 'managed' && !sshToken(draft.hostname, 253) ? 'ssh.field.hostnameHint' : undefined
    case 'port': return draft.credentialSource === 'managed' && !sshPort(draft.port) ? 'ssh.field.portHint' : undefined
    case 'user': return draft.credentialSource === 'managed' && !sshToken(draft.user, 64) ? 'ssh.field.userHint' : undefined
    case 'alias': return draft.credentialSource === 'alias' && !SSH_ALIAS.test(draft.alias.trim()) ? 'ssh.field.aliasHint' : undefined
    case 'credentialId': return draft.credentialSource === 'managed' && draft.credentialId === '' ? 'ssh.field.credentialIdHint' : undefined
  }
}

export const CONNECT_FIELDS: readonly ConnectField[] = ['user', 'hostname', 'port', 'alias', 'credentialId']

/** The label locale key for one wizard field, used by the summary strip. */
export const FIELD_LABELS: Record<ConnectField, Key> = {
  user: 'ssh.field.user',
  hostname: 'ssh.field.hostname',
  port: 'ssh.field.port',
  alias: 'ssh.field.alias',
  credentialId: 'ssh.field.managed',
}

/** The fields a host-key scan consumes: an alias, or a valid hostname+port. */
export function scanReady(draft: EditorDraft): boolean {
  return draft.credentialSource === 'alias'
    ? draftFieldError(draft, 'alias') === undefined
    : draftFieldError(draft, 'hostname') === undefined && draftFieldError(draft, 'port') === undefined
}

/** Whether the connection form is ready to scan. */
export function connectionReady(draft: EditorDraft): boolean {
  return CONNECT_FIELDS.every(field => draftFieldError(draft, field) === undefined)
}

export const editorOf = (environment: SshEnvironmentView): EditorDraft => ({
  existing: environment,
  displayName: environment.displayName ?? '',
  hostname: environment.endpoint.hostname,
  port: String(environment.endpoint.port),
  user: environment.endpoint.user,
  platform: environment.platform,
  credentialSource: environment.credential.kind === 'ssh-config' ? 'alias' : 'managed',
  alias: environment.credential.kind === 'ssh-config' ? environment.credential.alias : '',
  credentialId: environment.credential.kind === 'managed' ? environment.credential.credentialId : '',
  allowExec: environment.exec !== undefined,
  allowTransfer: environment.transfer !== undefined,
})

export const editorIdentity = (draft: EditorDraft): string => JSON.stringify([
  draft.hostname.trim(), Number(draft.port), draft.user.trim(), draft.platform, draft.credentialSource,
  draft.credentialSource === 'alias' ? draft.alias.trim() : draft.credentialId,
])

export function recordedFingerprint(draft: EditorDraft): string | undefined {
  const existing = draft.existing
  return existing !== undefined && editorIdentity(draft) === editorIdentity(editorOf(existing)) ? existing.hostKey : undefined
}

export const execHelperReady = (draft: EditorDraft): boolean => {
  const existing = draft.existing
  if (existing === undefined || existing.helper === null) return false
  const port = Number.parseInt(draft.port, 10)
  const credentialKind = draft.credentialSource === 'alias' ? 'ssh-config' : 'managed'
  return existing.endpoint.hostname === draft.hostname.trim()
    && existing.endpoint.port === (Number.isInteger(port) ? port : 22)
    && existing.endpoint.user === draft.user.trim()
    && existing.credential.kind === credentialKind
}

/** The scan target label: the alias for ssh-config sources, host:port otherwise. */
export function scanTargetOf(draft: EditorDraft): string {
  return draft.credentialSource === 'alias'
    ? draft.alias.trim()
    : `${draft.hostname.trim()}:${draft.port.trim()}`
}

/** Allocate a new ID against the current connection inventory. */
export function newEnvironmentId(displayName: string, environments: readonly SshEnvironmentView[]): string {
  const used = new Set(environments.map(environment => environment.environmentId))
  const slug = displayName.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  if (ENVIRONMENT_ID.test(slug) && !used.has(slug)) return slug
  // The first group of a v4 UUID is four random bytes. getRandomValues also works on HTTP.
  let id: string
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(4))
    id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  } while (used.has(id))
  return id
}

/**
 * The environment object `sshEnvironmentSave` persists for one draft — the
 * same builder both add flows use, so capability toggles materialize the
 * documented exec/transfer stanzas identically.
 */
export function environmentDraftOf(draft: EditorDraft, environmentId: string): Record<string, unknown> {
  return {
    environmentId,
    ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    platform: draft.platform,
    endpoint: { hostname: draft.hostname.trim(), port: Number.parseInt(draft.port, 10), user: draft.user.trim() },
    credential: draft.credentialSource === 'alias'
      ? { kind: 'ssh-config' as const, alias: draft.alias.trim() }
      : { kind: 'managed' as const, credentialId: draft.credentialId },
    ...(draft.allowExec ? { exec: draft.existing?.exec ?? { ...EXEC_DEFAULTS, env: { ...EXEC_DEFAULTS.env }, shell: [...EXEC_DEFAULTS.shell] } } : {}),
    ...(draft.allowTransfer ? { transfer: draft.existing?.transfer ?? { ...TRANSFER_DEFAULTS } } : {}),
  }
}

export const togglePeer = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The workspace-binding draft, shared by the flat editor and the add wizard. */
export interface BindingDraft {
  environmentId: string
  /** Present only while editing an existing binding; adds never carry one. */
  readonly rootId?: string
  path: string
  read: boolean
  write: boolean
  exec: boolean
  imports: ReadonlySet<string>
  exports: ReadonlySet<string>
  /** The stable-SFTP-path Files browsing opt-in (ADR-0052); off by default. */
  directoryListing: boolean
}

export const blankBinding = (environmentId: string | undefined): BindingDraft => ({
  environmentId: environmentId ?? '', path: '', read: true, write: false, exec: false,
  imports: new Set(), exports: new Set(), directoryListing: false,
})

/** The `sshBindingSave` wire object for one draft. */
export function bindingDraftOf(value: BindingDraft): SshBindingDraft {
  const actions = (['read', 'write', 'exec'] as const).filter(action => value[action])
  const transfers = [
    ...[...value.imports].map(rootId => ({ direction: 'import' as const, peer: { environmentId: 'local', rootId } })),
    ...[...value.exports].map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local', rootId } })),
  ]
  return {
    environmentId: value.environmentId, path: value.path.trim(), actions,
    ...(value.directoryListing ? { directoryListing: 'stable-path' as const } : {}),
    ...(value.rootId === undefined ? {} : { rootId: value.rootId }),
    ...(transfers.length === 0 ? {} : { transfers }),
  }
}
