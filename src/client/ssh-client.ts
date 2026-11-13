/**
 * The panel's personal-mode SSH client (ADR-0041 §6). It speaks the same
 * Connection RPC channel as the remotes client but over the personal contract
 * (`remote/personal-contract.ts`): a host in another custody mode answers
 * `remote-personal-unavailable`. Every call is session-addressed; no method
 * ever sends or receives private-key or password material in a view.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-client
 */
import { PANEL_CHANNEL } from '../contract.ts'
import { parseSshAnswer, type SshEndpoint, type SshStateView, type CredentialPublicView, type SshEnvironmentView, type SshBindingView } from '../remote/personal-contract.ts'
import { PanelError } from './panel-client.ts'

interface Channel {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}

export interface SshHostKey {
  readonly type: string
  readonly fingerprint: string
}

export interface SshClient {
  state(sessionId: string, signal?: AbortSignal): Promise<SshStateView>
  credentialGenerate(sessionId: string, label: string, signal?: AbortSignal): Promise<SshStateView>
  credentialImport(sessionId: string, label: string, privateKey: string, passphrase?: string, signal?: AbortSignal): Promise<SshStateView>
  credentialPassword(sessionId: string, label: string, password: string, signal?: AbortSignal): Promise<SshStateView>
  credentialRemove(sessionId: string, id: string, signal?: AbortSignal): Promise<SshStateView>
  hostKeyScan(sessionId: string, hostname: string, port: number, signal?: AbortSignal): Promise<{ token: string; keys: readonly SshHostKey[] }>
  environmentSave(sessionId: string, revision: number, environment: unknown, fingerprint: string, hostKeyToken?: string, signal?: AbortSignal): Promise<SshStateView>
  environmentRemove(sessionId: string, revision: number, environmentId: string, signal?: AbortSignal): Promise<SshStateView>
  environmentTest(sessionId: string, environmentId: string, signal?: AbortSignal): Promise<{ platform: string; nodePath?: string; nodeVersion?: string }>
  helperInstall(sessionId: string, revision: number, environmentId: string, nodePath?: string, signal?: AbortSignal): Promise<SshStateView>
  accessKeyInstall(sessionId: string, revision: number, environmentId: string, signal?: AbortSignal): Promise<SshStateView>
  bindingSave(sessionId: string, revision: number, binding: unknown, signal?: AbortSignal): Promise<SshStateView>
  bindingRemove(sessionId: string, revision: number, environmentId: string, rootId: string, signal?: AbortSignal): Promise<SshStateView>
  configLink(sessionId: string, signal?: AbortSignal): Promise<SshStateView>
}

export type { CredentialPublicView, SshStateView, SshEnvironmentView, SshBindingView }

/**
 * Build the personal-mode client; every wire failure is a `PanelError`.
 * @param connection - the client Connection service.
 */
export function createSshClient(connection: Channel): SshClient {
  const call = async <T>(endpoint: SshEndpoint, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    let result: { ok: boolean; value?: unknown; error?: unknown }
    try {
      result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as typeof result
    } catch (error: unknown) {
      throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
    }
    if (!result.ok) {
      const failure = result.error as { code?: unknown; message?: unknown } | undefined
      throw new PanelError(
        typeof failure?.code === 'string' ? failure.code : 'unavailable',
        typeof failure?.message === 'string' ? failure.message : 'the host answered with an unreadable failure',
      )
    }
    const parsed = parseSshAnswer(endpoint, result.value)
    if (!parsed.ok) throw new PanelError('panel/bad-response', parsed.message)
    return parsed.value as T
  }
  return {
    state: async (sessionId, signal) => await call('sshState', { sessionId }, signal),
    credentialGenerate: async (sessionId, label, signal) => await call('sshCredentialGenerate', { sessionId, label }, signal),
    credentialImport: async (sessionId, label, privateKey, passphrase, signal) => await call('sshCredentialImport', { sessionId, label, privateKey, ...(passphrase === undefined ? {} : { passphrase }) }, signal),
    credentialPassword: async (sessionId, label, password, signal) => await call('sshCredentialPassword', { sessionId, label, password }, signal),
    credentialRemove: async (sessionId, id, signal) => await call('sshCredentialRemove', { sessionId, id }, signal),
    hostKeyScan: async (sessionId, hostname, port, signal) => await call('sshHostKeyScan', { sessionId, hostname, port }, signal),
    environmentSave: async (sessionId, revision, environment, fingerprint, hostKeyToken, signal) => await call('sshEnvironmentSave', { sessionId, revision, environment, fingerprint, ...(hostKeyToken === undefined ? {} : { hostKeyToken }) }, signal),
    environmentRemove: async (sessionId, revision, environmentId, signal) => await call('sshEnvironmentRemove', { sessionId, revision, environmentId }, signal),
    environmentTest: async (sessionId, environmentId, signal) => await call('sshEnvironmentTest', { sessionId, environmentId }, signal),
    helperInstall: async (sessionId, revision, environmentId, nodePath, signal) => await call('sshHelperInstall', { sessionId, revision, environmentId, ...(nodePath === undefined ? {} : { nodePath }) }, signal),
    accessKeyInstall: async (sessionId, revision, environmentId, signal) => await call('sshAccessKeyInstall', { sessionId, revision, environmentId }, signal),
    bindingSave: async (sessionId, revision, binding, signal) => await call('sshBindingSave', { sessionId, revision, binding }, signal),
    bindingRemove: async (sessionId, revision, environmentId, rootId, signal) => await call('sshBindingRemove', { sessionId, revision, environmentId, rootId }, signal),
    configLink: async (sessionId, signal) => await call('sshConfigLink', { sessionId }, signal),
  }
}
