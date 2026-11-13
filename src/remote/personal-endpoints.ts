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
const injectedScans = new WeakMap<ExecFile, HostKeyScans>()
const scansFor = (exec: ExecFile): HostKeyScans => {
  if (exec === defaultExec) return scans
  let entry = injectedScans.get(exec)
  if (entry === undefined) { entry = new HostKeyScans(exec); injectedScans.set(exec, entry) }
  return entry
}

/** Test seam: inject the exec used for every external command. */
export interface PersonalDeps {
  readonly exec?: ExecFile
}

/** Serialize personal mutations per Host (R8); CAS still guards cross-Host races. */
let mutationChain: Promise<unknown> = Promise.resolve()
const enqueueMutation = <T>(job: () => Promise<T>): Promise<T> => {
  const result = mutationChain.then(job)
  mutationChain = result.then(() => undefined, () => undefined)
  return result
}

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
  ctx: Context, registry: MultiRootRegistry, primary: string, call: SshCall, deps: PersonalDeps = {},
): Promise<unknown> {
  if (call.endpoint !== 'sshState' && call.endpoint !== 'sshHostKeyScan' && call.endpoint !== 'sshEnvironmentTest') {
    return await enqueueMutation(async () => await runPersonalEndpoint(ctx, registry, primary, call, deps))
  }
  return await runPersonalEndpoint(ctx, registry, primary, call, deps)
}

async function runPersonalEndpoint(
  ctx: Context, registry: MultiRootRegistry, primary: string, call: SshCall, deps: PersonalDeps,
): Promise<unknown> {
  const paths = requirePersonal(registry)
  const exec = deps.exec ?? defaultExec
  const activeScans = scansFor(exec)
  const store = new CredentialStore(paths.credentialRoot, exec)
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
      const { token, keys } = await activeScans.scan(call.hostname, call.port)
      return { token, keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
    }
    case 'sshEnvironmentSave': {
      const draft = { ...call.environment, endpoint: { ...call.environment.endpoint } }
      let hostKey: string
      if (draft.credential.kind === 'ssh-config') {
        // R4: never trust the draft's endpoint — resolve the user's own alias
        // with ssh -G (relaxed parse) exactly as the manager does at connect
        // time, then check the fingerprint against the SAME known_hosts set.
        const { hostKeyFingerprint, parseSshConfig } = await import('./ssh-environment.ts')
        const execAdapter = async (file: string, args: readonly string[], input?: string) =>
          await exec(file, args, { ...(input === undefined ? {} : { input }) })
        let identity
        try {
          identity = parseSshConfig((await execAdapter('ssh', ['-G', draft.credential.alias])).stdout, { relaxed: true })
        } catch (error) {
          throw new RemoteAdmissionError('host-identity-unverifiable', error instanceof Error ? error.message : String(error))
        }
        draft.endpoint = { hostname: identity.hostname, port: Number.parseInt(identity.port, 10) || 22, user: identity.user }
        const files = [...identity.knownHostsFiles, ...identity.globalKnownHostsFiles]
        const { keys, fingerprint } = await hostKeyFingerprint(identity.lookupHost, files, execAdapter)
        if (keys !== 1) throw new RemoteAdmissionError('host-identity-unverifiable', `host "${identity.lookupHost}" resolves ${keys} known_hosts keys, exactly one required`)
        if (fingerprint !== call.fingerprint) {
          throw new RemoteAdmissionError('host-key-mismatch', 'the confirmed fingerprint does not match the user known_hosts')
        }
        hostKey = call.fingerprint
      } else {
        if (call.hostKeyToken === undefined) {
          throw new RemoteAdmissionError('host-key-token-required', 'a managed environment requires a host key scan token')
        }
        const lines = activeScans.resolve(call.hostKeyToken, call.fingerprint)
        recordKnownHost(paths.credentialRoot, draft.endpoint.hostname, draft.endpoint.port, lines)
        hostKey = call.fingerprint
      }
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        environments: [
          ...config.environments.filter(environment => environment.environmentId !== draft.environmentId),
          { ...draft, environmentId: draft.environmentId, hostKey, helper: (() => {
              const previous = config.environments.find(environment => environment.environmentId === draft.environmentId)
              if (previous === undefined) return null
              const sameTarget = previous.endpoint.hostname === draft.endpoint.hostname
                && previous.endpoint.port === draft.endpoint.port
                && previous.endpoint.user === draft.endpoint.user
                && previous.credential.kind === draft.credential.kind
              return sameTarget ? previous.helper : null
            })() } as PersonalEnvironment,
        ],
      }))
    }
    case 'sshEnvironmentRemove': {
      const removed = loadPersonalConfig(paths.personalPath).environments.find(environment => environment.environmentId === call.environmentId)
      const state = await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        environments: config.environments.filter(environment => environment.environmentId !== call.environmentId),
        bindings: config.bindings.filter(binding => binding.environmentId !== call.environmentId),
      }))
      // R6: the removed environment's access key is best-effort cleanup.
      const accessKeyId = removed?.credential.kind === 'managed' ? removed.credential.accessKeyId : undefined
      if (accessKeyId !== undefined) {
        try { store.remove(accessKeyId, () => false) } catch { /* already gone */ }
      }
      return state
    }
    case 'sshEnvironmentTest': {
      const config = loadPersonalConfig(paths.personalPath)
      return await testConnection(exec, findEnvironment(config, call.environmentId), paths.credentialRoot)
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
      const helper = await installHelper(exec, environment, paths.credentialRoot, { sshVersion: version, hostHelperPath, nodePath: call.nodePath })
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
      const accessKey = await store.generate(`env-${environment.environmentId}`, { purpose: 'access-key', environmentId: environment.environmentId })
      try {
        await installAccessKey(exec, environment, paths.credentialRoot, { publicKey: accessKey.publicKey ?? '' }, secretFile)
      } catch (error) {
        try { store.remove(accessKey.id, () => false) } catch { /* best effort: no orphan key */ }
        throw error
      }
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
