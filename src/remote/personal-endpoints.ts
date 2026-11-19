/**
 * Host handlers for the personal-mode SSH endpoints (ADR-0049 §2/§6). Every
 * handler refuses `remote-personal-unavailable` unless the live switch is on
 * AND the custody mode is `personal`; every mutation answers the refreshed
 * `sshState` and no answer ever carries key or password bytes.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MultiRootRegistry } from '../registry.ts'
import { RemoteAdmissionError } from './contract.ts'
import { checkRemotePath } from './manifest.ts'
import type { SshCall, SshStateView } from './personal-contract.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from './personal/config.ts'
import { CredentialStore, defaultExec, type ExecFile } from './personal/credentials.ts'
import { helperProtocol, HostKeyScans, installAccessKey, installHelper, testConnection } from './personal/operations.ts'
import { link, linkStatus, listSshConfigAliases, recordKnownHost, renderSshConfig } from './personal/ssh-files.ts'
import { listRemoteDirectories } from './personal/remote-paths.ts'
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
  await savePersonalConfig(paths.personalPath, { ...next, revision: next.revision + 1 }, expectedRevision)
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
 * Resolve one ssh-config alias via `ssh -G` (relaxed parse, exactly as the
 * manager resolves it at connect time) and prove the host key against the
 * SAME user known_hosts files. Both the scan answer and the save-time check
 * draw on this single resolution so they can never disagree.
 */
async function sshConfigIdentity(
  exec: ExecFile, alias: string, managedKnownHostsFile: string,
): Promise<{ readonly endpoint: { readonly hostname: string; readonly port: number; readonly user: string }; readonly fingerprint: string }> {
  const { hostKeyFingerprint, parseSshConfig } = await import('./ssh-environment.ts')
  const execAdapter = async (file: string, args: readonly string[], input?: string) =>
    await exec(file, args, { ...(input === undefined ? {} : { input }) })
  let identity
  try {
    identity = parseSshConfig((await execAdapter('ssh', ['-G', alias])).stdout, { relaxed: true, managedKnownHostsFile })
  } catch (error) {
    throw new RemoteAdmissionError('host-identity-unverifiable', error instanceof Error ? error.message : String(error))
  }
  const files = [...identity.knownHostsFiles, ...identity.globalKnownHostsFiles]
  const { keys, fingerprint } = await hostKeyFingerprint(identity.lookupHost, files, execAdapter)
  if (keys !== 1 || fingerprint === undefined) {
    throw new RemoteAdmissionError('host-identity-unverifiable', `host "${identity.lookupHost}" resolves ${keys} usable known_hosts keys, exactly one required`)
  }
  return { endpoint: { hostname: identity.hostname, port: Number.parseInt(identity.port, 10) || 22, user: identity.user }, fingerprint }
}

/**
 * Serve one personal endpoint. Callers have already validated the payload.
 * @returns the answer value (`sshState`, scan keys, or a connection test).
 */
export async function handlePersonalEndpoint(
  ctx: Context, registry: MultiRootRegistry, primary: string, call: SshCall, deps: PersonalDeps = {},
): Promise<unknown> {
  if (call.endpoint !== 'sshState' && call.endpoint !== 'sshHostKeyScan' && call.endpoint !== 'sshEnvironmentTest'
    && call.endpoint !== 'sshConfigAliases' && call.endpoint !== 'sshListDirectories') {
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
    case 'sshConfigAliases':
      // Local read only; no mutation and no remote connection.
      return { aliases: listSshConfigAliases() }
    case 'sshListDirectories': {
      if (call.path !== undefined && call.path !== '' && (!call.path.startsWith('/') || call.path.includes('\0'))) {
        throw new RemoteAdmissionError('remote-path-listing-failed', 'the remote path must be an absolute POSIX path')
      }
      const config = loadPersonalConfig(paths.personalPath)
      return await listRemoteDirectories(findEnvironment(config, call.environmentId), paths.credentialRoot, call.path)
    }
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
      if (call.alias !== undefined) {
        // Alias scan: the fingerprint lives in the user's own known_hosts,
        // so no network probe and no token — save re-runs the same
        // resolution and compares the confirmed fingerprint.
        const resolved = await sshConfigIdentity(exec, call.alias, join(paths.credentialRoot, 'known_hosts'))
        return { token: '', keys: [{ type: 'known-hosts', fingerprint: resolved.fingerprint }], endpoint: resolved.endpoint }
      }
      const { token, keys } = await activeScans.scan(call.hostname!, call.port)
      return { token, keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
    }
    case 'sshEnvironmentSave': {
      const draft = { ...call.environment, endpoint: { ...call.environment.endpoint } }
      // `workspace` enters `connection` — and is therefore checked — only
      // under the helper transport; under sftp it used to persist unchecked
      // and explode inside savePersonalConfig on the NEXT helper install.
      try {
        checkRemotePath(draft.workspace)
      } catch {
        throw new RemoteAdmissionError('workspace-invalid', `the remote workspace is not a normalized absolute POSIX path: ${JSON.stringify(draft.workspace)}`)
      }
      const currentEnvironments = loadPersonalConfig(paths.personalPath).environments
      const previous = currentEnvironments.find(environment => environment.environmentId === draft.environmentId)
      // The recorded fingerprint may be reused for an update that changes only
      // workspace/capabilities: the target identity and the managed credential
      // must be untouched. A changed target still needs a fresh scan token.
      const sameIdentity = previous !== undefined
        && previous.endpoint.hostname === draft.endpoint.hostname
        && previous.endpoint.port === draft.endpoint.port
        && previous.endpoint.user === draft.endpoint.user
        && previous.credential.kind === draft.credential.kind
        && (draft.credential.kind !== 'managed'
          || (previous.credential.kind === 'managed' && previous.credential.credentialId === draft.credential.credentialId))
      const preservedHelper = (environments: readonly PersonalEnvironment[]): PersonalEnvironment['helper'] => {
        const found = environments.find(environment => environment.environmentId === draft.environmentId)
        if (found === undefined) return null
        const sameTarget = found.endpoint.hostname === draft.endpoint.hostname
          && found.endpoint.port === draft.endpoint.port
          && found.endpoint.user === draft.endpoint.user
          && found.credential.kind === draft.credential.kind
        return sameTarget ? found.helper : null
      }
      let hostKey: string
      if (draft.credential.kind === 'ssh-config') {
        // R4: never trust the draft's endpoint — resolve the user's own alias
        // exactly as the scan did, then compare the confirmed fingerprint.
        const resolved = await sshConfigIdentity(exec, draft.credential.alias, join(paths.credentialRoot, 'known_hosts'))
        draft.endpoint = resolved.endpoint
        if (resolved.fingerprint !== call.fingerprint) {
          throw new RemoteAdmissionError('host-key-mismatch', 'the confirmed fingerprint does not match the user known_hosts')
        }
        hostKey = call.fingerprint
      } else {
        if (draft.exec !== undefined && preservedHelper(currentEnvironments) === null) {
          throw new RemoteAdmissionError('exec-requires-helper', 'exec requires an installed remote helper; save without exec, install the helper, then enable it')
        }
        if (call.hostKeyToken === undefined) {
          // Workspace/capability edits reuse the already-recorded key only
          // while the identity is unchanged; anything else must rescan.
          if (!sameIdentity || previous === undefined || previous.hostKey !== call.fingerprint) {
            throw new RemoteAdmissionError('host-key-token-required', 'a managed environment requires a host key scan token')
          }
          hostKey = call.fingerprint
        } else {
          const lines = activeScans.resolve(call.hostKeyToken, call.fingerprint)
          recordKnownHost(paths.credentialRoot, draft.endpoint.hostname, draft.endpoint.port, lines)
          hostKey = call.fingerprint
        }
      }
      return await mutate(registry, primary, paths, call.revision, config => {
        const helper = preservedHelper(config.environments)
        const previous = config.environments.find(environment => environment.environmentId === draft.environmentId)
        let credential = draft.credential
        if (credential.kind === 'managed') {
          // This key was installed on one target by the Host. An edit may
          // omit it, but cannot transplant it to another identity.
          const accessKeyId = previous?.credential.kind === 'managed'
            && previous.credential.credentialId === credential.credentialId
            && previous.endpoint.hostname === draft.endpoint.hostname
            && previous.endpoint.port === draft.endpoint.port
            && previous.endpoint.user === draft.endpoint.user
            && previous.hostKey === hostKey
            ? previous.credential.accessKeyId : undefined
          credential = { kind: 'managed', credentialId: credential.credentialId,
            ...(accessKeyId === undefined ? {} : { accessKeyId }) }
        }
        if (draft.exec !== undefined && helper === null) {
          throw new RemoteAdmissionError('exec-requires-helper', 'exec requires an installed remote helper; save without exec, install the helper, then enable it')
        }
        return {
          ...config,
          environments: [
            ...config.environments.filter(environment => environment.environmentId !== draft.environmentId),
            { ...draft, credential, environmentId: draft.environmentId, hostKey, helper } as PersonalEnvironment,
          ],
        }
      })
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
      const { sshPackageRoot, sshPackageVersion } = await import('../compat/dsh-version.ts')
      const version = sshPackageVersion('@deepseek-ai/dsh-ssh')
      const packageRoot = sshPackageRoot('@deepseek-ai/dsh-ssh')
      if (version === undefined || packageRoot === undefined) throw new RemoteAdmissionError('helper-install-failed', 'the host dsh-ssh package is not resolvable')
      const hostHelperPath = join(packageRoot, 'lib', 'helper.js')
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
