/**
 * Host handlers for the personal-mode SSH endpoints (ADR-0041 §2/§6). Every
 * handler refuses `remote-personal-unavailable` unless the live switch is on
 * AND the custody mode is `personal`; every mutation answers the refreshed
 * `sshState` and no answer ever carries key or password bytes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MultiRootRegistry } from '../registry.ts'
import { RemoteAdmissionError } from './contract.ts'
import type { SshCall, SshStateView } from './personal-contract.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from './personal/config.ts'
import { CredentialStore, defaultExec, type ExecFile } from './personal/credentials.ts'
import { helperProtocol, HostKeyScans, installAccessKey, installHelper, testConnection } from './personal/operations.ts'
import { link, linkStatus, recordKnownHost, renderSshConfig } from './personal/ssh-files.ts'
import { primaryKey } from '../roots.ts'

const scans = new HostKeyScans(defaultExec)

interface PersonalPaths {
  readonly personalPath: string
  readonly credentialRoot: string
}

function requirePersonal(registry: MultiRootRegistry): PersonalPaths {
  if (!registry.remoteEnabled || registry.remoteMode !== 'personal') {
    throw new RemoteAdmissionError('remote-personal-unavailable', 'personal SSH management requires the switch on in personal custody mode')
  }
  const personalPath = registry.remotePersonalPath
  const credentialRoot = registry.remoteCredentialRoot
  if (personalPath === undefined || credentialRoot === undefined) {
    throw new RemoteAdmissionError('remote-personal-unavailable', 'remoteEnvironments.personalPath / credentialRoot are not configured')
  }
  return { personalPath, credentialRoot }
}

async function sshState(registry: MultiRootRegistry, paths: PersonalPaths, primary: string): Promise<SshStateView> {
  const config = loadPersonalConfig(paths.personalPath)
  const store = new CredentialStore(paths.credentialRoot)
  const key = primaryKey(primary)
  return {
    mode: 'personal',
    enabled: registry.remoteEnabled,
    linked: linkStatus(paths.credentialRoot).linked,
    revision: config.revision,
    environments: config.environments,
    credentials: store.list(),
    bindings: config.bindings.filter(binding => primaryKey(binding.primary) === key),
  }
}

async function mutate(
  registry: MultiRootRegistry, primary: string, paths: PersonalPaths,
  expectedRevision: number, edit: (config: PersonalConfig) => PersonalConfig | Promise<PersonalConfig>,
): Promise<SshStateView> {
  const config = loadPersonalConfig(paths.personalPath)
  const next = await edit(config)
  savePersonalConfig(paths.personalPath, { ...next, revision: next.revision + 1 }, expectedRevision)
  renderSshConfig(loadPersonalConfig(paths.personalPath), paths.credentialRoot)
  await registry.refreshRemotePersonal().catch(() => {})
  return await sshState(registry, paths, primary)
}

function findEnvironment(config: PersonalConfig, environmentId: string): PersonalEnvironment {
  const environment = config.environments.find(entry => entry.environmentId === environmentId)
  if (environment === undefined) throw new RemoteAdmissionError('environment-not-found', `unknown environment "${environmentId}"`)
  return environment
}

/**
 * Serve one personal endpoint. Callers have already validated the payload.
 * @returns the answer value (`sshState`, scan keys, or a connection test).
 */
export async function handlePersonalEndpoint(
  ctx: Context, registry: MultiRootRegistry, primary: string, call: SshCall,
): Promise<unknown> {
  const paths = requirePersonal(registry)
  const store = new CredentialStore(paths.credentialRoot)
  const after = async () => await sshState(registry, paths, primary)
  switch (call.endpoint) {
    case 'sshState':
      return await after()
    case 'sshCredentialGenerate':
      await store.generate(call.label)
      return await after()
    case 'sshCredentialImport':
      await store.importKey(call.label, call.privateKey, call.passphrase)
      return await after()
    case 'sshCredentialPassword':
      store.savePassword(call.label, call.password)
      return await after()
    case 'sshCredentialRemove': {
      const config = loadPersonalConfig(paths.personalPath)
      store.remove(call.id, id => config.environments.some(environment =>
        environment.credential.kind === 'managed'
        && (environment.credential.credentialId === id || environment.credential.accessKeyId === id)))
      return await after()
    }
    case 'sshHostKeyScan': {
      const { token, keys } = await scans.scan(call.hostname, call.port)
      return { token, keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
    }
    case 'sshEnvironmentSave': {
      const draft = call.environment
      let hostKey: string
      if (draft.credential.kind === 'ssh-config') {
        // The user's own alias: the fingerprint must match THEIR known_hosts.
        const { hostKeyFingerprint } = await import('./ssh-environment.ts')
        const { homedir } = await import('node:os')
        const { join } = await import('node:path')
        const exec: ExecFile = defaultExec
        const files = [join(homedir(), '.ssh', 'known_hosts')]
        const lookup = draft.endpoint.port === 22 ? draft.endpoint.hostname : `[${draft.endpoint.hostname}]:${draft.endpoint.port}`
        const { fingerprint } = await hostKeyFingerprint(lookup, files,
          async (file, args, input) => await exec(file, args, { ...(input === undefined ? {} : { input }) }))
        if (fingerprint !== call.fingerprint) {
          throw new RemoteAdmissionError('host-key-mismatch', 'the confirmed fingerprint does not match the user known_hosts')
        }
        hostKey = call.fingerprint
      } else {
        if (call.hostKeyToken === undefined) {
          throw new RemoteAdmissionError('host-key-token-required', 'a managed environment requires a host key scan token')
        }
        const lines = scans.resolve(call.hostKeyToken, call.fingerprint)
        recordKnownHost(paths.credentialRoot, draft.endpoint.hostname, draft.endpoint.port, lines)
        hostKey = call.fingerprint
      }
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        environments: [
          ...config.environments.filter(environment => environment.environmentId !== draft.environmentId),
          { ...draft, environmentId: draft.environmentId, hostKey, helper: config.environments.find(environment => environment.environmentId === draft.environmentId)?.helper ?? null } as PersonalEnvironment,
        ],
      }))
    }
    case 'sshEnvironmentRemove':
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        environments: config.environments.filter(environment => environment.environmentId !== call.environmentId),
        bindings: config.bindings.filter(binding => binding.environmentId !== call.environmentId),
      }))
    case 'sshEnvironmentTest': {
      const config = loadPersonalConfig(paths.personalPath)
      return await testConnection(defaultExec, findEnvironment(config, call.environmentId), paths.credentialRoot)
    }
    case 'sshHelperInstall': {
      const config = loadPersonalConfig(paths.personalPath)
      const environment = findEnvironment(config, call.environmentId)
      const { sshPackageVersion } = await import('../compat/dsh-version.ts')
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const hostHelperPath = require.resolve('@deepseek-ai/dsh-ssh/lib/helper.js')
      const version = sshPackageVersion('@deepseek-ai/dsh-ssh')
      if (version === undefined) throw new RemoteAdmissionError('helper-install-failed', 'the host dsh-ssh version is unknown')
      const helper = await installHelper(defaultExec, environment, paths.credentialRoot, { sshVersion: version, hostHelperPath, nodePath: call.nodePath })
      return await mutate(registry, primary, paths, call.revision, current => ({
        ...current,
        environments: current.environments.map(entry => entry.environmentId === call.environmentId
          ? { ...entry, helper: { ...helper, protocol: helperProtocol() } }
          : entry),
      }))
    }
    case 'sshAccessKeyInstall': {
      const config = loadPersonalConfig(paths.personalPath)
      const environment = findEnvironment(config, call.environmentId)
      if (environment.credential.kind !== 'managed') {
        throw new RemoteAdmissionError('credential-kind-mismatch', 'access-key bootstrap applies to managed credentials only')
      }
      const secretFile = store.secretFileOf(environment.credential.credentialId)
      if (secretFile === undefined) throw new RemoteAdmissionError('credential-not-found', 'the credential secret is missing')
      const accessKey = await store.generate(`env-${environment.environmentId}`)
      await installAccessKey(defaultExec, environment, paths.credentialRoot, { publicKey: accessKey.publicKey ?? '' }, secretFile)
      return await mutate(registry, primary, paths, call.revision, current => ({
        ...current,
        environments: current.environments.map(entry => entry.environmentId === call.environmentId
          ? { ...entry, credential: { kind: 'managed' as const, credentialId: entry.credential.kind === 'managed' ? entry.credential.credentialId : '', accessKeyId: accessKey.id } }
          : entry),
      }))
    }
    case 'sshBindingSave':
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        bindings: [
          ...config.bindings.filter(binding => !(binding.environmentId === call.binding.environmentId && binding.rootId === call.binding.rootId && primaryKey(binding.primary) === primaryKey(primary))),
          { ...call.binding, primary },
        ],
      }))
    case 'sshBindingRemove':
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        bindings: config.bindings.filter(binding => !(binding.environmentId === call.environmentId && binding.rootId === call.rootId && primaryKey(binding.primary) === primaryKey(primary))),
      }))
    case 'sshConfigLink':
      link(paths.credentialRoot)
      return await after()
  }
}
