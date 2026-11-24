/**
 * The panel's personal-mode SSH client (ADR-0049 §6). It speaks the same
 * Connection RPC channel as the remotes client but over the personal contract
 * (`remote/personal-contract.ts`): a host in another custody mode answers
 * `remote-personal-unavailable`. Plugin settings use their own channel without
 * a session. Neither client receives private-key or password material in a view.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-client
 */
import { PANEL_CHANNEL, parseErrorView } from '../contract.ts'
import { SSH_SETTINGS_CHANNEL, sshSettingsViewSchema, parseSshAnswer, type SshSettingsView, type SshEndpoint, type SshStateView, type CredentialPublicView, type SshEnvironmentView, type SshBindingDraft, type SshBindingView, type SshAliasesView, type RemoteDirectoryListing } from '../remote/personal-contract.ts'
import { PanelError } from './panel-client.ts'

interface Channel {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}

export interface SshHostKey {
  readonly type: string
  readonly fingerprint: string
}

export interface SshScanResult {
  readonly token: string
  readonly keys: readonly SshHostKey[]
  /** Present on alias scans: the `ssh -G` resolved target the key was proven against. */
  readonly endpoint?: { readonly hostname: string; readonly port: number; readonly user: string }
}

export interface SshClient {
  state(sessionId: string | undefined, signal?: AbortSignal): Promise<SshStateView>
  aliases(sessionId: string | undefined, signal?: AbortSignal): Promise<SshAliasesView>
  listDirectories(sessionId: string, environmentId: string, path?: string, signal?: AbortSignal): Promise<RemoteDirectoryListing>
  credentialGenerate(sessionId: string | undefined, label: string, signal?: AbortSignal): Promise<SshStateView>
  credentialImport(sessionId: string | undefined, label: string, privateKey: string, passphrase?: string, signal?: AbortSignal): Promise<SshStateView>
  credentialPassword(sessionId: string | undefined, label: string, password: string, signal?: AbortSignal): Promise<SshStateView>
  credentialRemove(sessionId: string | undefined, id: string, signal?: AbortSignal): Promise<SshStateView>
  hostKeyScan(sessionId: string | undefined, target: { hostname?: string; port?: number; alias?: string }, signal?: AbortSignal): Promise<SshScanResult>
  environmentSave(sessionId: string | undefined, revision: number, environment: unknown, fingerprint: string, hostKeyToken: string | undefined, intent: 'create' | 'update', signal?: AbortSignal): Promise<SshStateView>
  environmentRemove(sessionId: string | undefined, revision: number, environmentId: string, signal?: AbortSignal): Promise<SshStateView>
  environmentTest(sessionId: string | undefined, environmentId: string, signal?: AbortSignal): Promise<{ platform: string; nodePath?: string; nodeVersion?: string }>
  helperInstall(sessionId: string | undefined, revision: number, environmentId: string, nodePath?: string, signal?: AbortSignal): Promise<SshStateView>
  accessKeyInstall(sessionId: string | undefined, revision: number, environmentId: string, signal?: AbortSignal): Promise<SshStateView>
  bindingSave(sessionId: string, revision: number, binding: SshBindingDraft, signal?: AbortSignal): Promise<SshStateView>
  bindingRemove(sessionId: string, revision: number, environmentId: string, rootId: string, signal?: AbortSignal): Promise<SshStateView>
  configLink(sessionId: string | undefined, signal?: AbortSignal): Promise<SshStateView>
}

export type SshManagementClient = Omit<SshClient, 'listDirectories' | 'bindingSave' | 'bindingRemove'>
export type { SshSettingsView }

export interface SshSettingsClient {
  readonly management: SshManagementClient
  status(signal?: AbortSignal): Promise<SshSettingsView>
}

export type { CredentialPublicView, SshStateView, SshEnvironmentView, SshBindingDraft, SshBindingView, SshAliasesView, RemoteDirectoryListing }

/**
 * Build the personal-mode client; every wire failure is a `PanelError`.
 * @param connection - the client Connection service.
 */
async function request(connection: Channel, channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  let result: { ok: boolean; value?: unknown; error?: unknown }
  try {
    result = await connection.rpc.call(channel, endpoint, payload, signal) as typeof result
  } catch (error: unknown) {
    throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) {
    const failure = parseErrorView(result.error)
    throw failure === undefined
      ? new PanelError('unavailable', 'the host answered with an unreadable failure')
      : new PanelError(failure.code, failure.message, failure.ssh)
  }
  return result.value
}

export function createSshSettingsClient(connection: Channel): SshSettingsClient {
  return {
    management: createSshClient(connection, SSH_SETTINGS_CHANNEL),
    async status(signal) {
      const parsed = sshSettingsViewSchema.safeParse(await request(connection, SSH_SETTINGS_CHANNEL, 'status', {}, signal))
      if (!parsed.success) throw new PanelError('panel/bad-response', parsed.error.message)
      return parsed.data
    },
  }
}

export function createSshClient(connection: Channel, channel: typeof PANEL_CHANNEL | typeof SSH_SETTINGS_CHANNEL = PANEL_CHANNEL): SshClient {
  const call = async <T>(endpoint: SshEndpoint, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const { sessionId, ...fields } = payload
    const response = await request(connection, channel, endpoint, channel === PANEL_CHANNEL ? { sessionId, ...fields } : fields, signal)
    const parsed = parseSshAnswer(endpoint, response)
    if (!parsed.ok) throw new PanelError('panel/bad-response', parsed.message)
    return parsed.value as T
  }
  return {
    state: async (sessionId, signal) => await call('sshState', { sessionId }, signal),
    aliases: async (sessionId, signal) => await call('sshConfigAliases', { sessionId }, signal),
    listDirectories: async (sessionId, environmentId, path, signal) => await call('sshListDirectories', {
      sessionId, environmentId, ...(path === undefined || path === '' ? {} : { path }),
    }, signal),
    credentialGenerate: async (sessionId, label, signal) => await call('sshCredentialGenerate', { sessionId, label }, signal),
    credentialImport: async (sessionId, label, privateKey, passphrase, signal) => await call('sshCredentialImport', { sessionId, label, privateKey, ...(passphrase === undefined ? {} : { passphrase }) }, signal),
    credentialPassword: async (sessionId, label, password, signal) => await call('sshCredentialPassword', { sessionId, label, password }, signal),
    credentialRemove: async (sessionId, id, signal) => await call('sshCredentialRemove', { sessionId, id }, signal),
    hostKeyScan: async (sessionId, target, signal) => await call('sshHostKeyScan', {
      sessionId,
      port: target.port ?? 22,
      ...(target.hostname === undefined ? {} : { hostname: target.hostname }),
      ...(target.alias === undefined ? {} : { alias: target.alias }),
    }, signal),
    environmentSave: async (sessionId, revision, environment, fingerprint, hostKeyToken, intent, signal) => await call('sshEnvironmentSave', { sessionId, revision, intent, environment, fingerprint, ...(hostKeyToken === undefined ? {} : { hostKeyToken }) }, signal),
    environmentRemove: async (sessionId, revision, environmentId, signal) => await call('sshEnvironmentRemove', { sessionId, revision, environmentId }, signal),
    environmentTest: async (sessionId, environmentId, signal) => await call('sshEnvironmentTest', { sessionId, environmentId }, signal),
    helperInstall: async (sessionId, revision, environmentId, nodePath, signal) => await call('sshHelperInstall', { sessionId, revision, environmentId, ...(nodePath === undefined ? {} : { nodePath }) }, signal),
    accessKeyInstall: async (sessionId, revision, environmentId, signal) => await call('sshAccessKeyInstall', { sessionId, revision, environmentId }, signal),
    bindingSave: async (sessionId, revision, binding, signal) => await call('sshBindingSave', { sessionId, revision, binding }, signal),
    bindingRemove: async (sessionId, revision, environmentId, rootId, signal) => await call('sshBindingRemove', { sessionId, revision, environmentId, rootId }, signal),
    configLink: async (sessionId, signal) => await call('sshConfigLink', { sessionId }, signal),
  }
}
