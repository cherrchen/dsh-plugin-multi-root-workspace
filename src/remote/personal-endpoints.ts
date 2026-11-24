/**
 * Host handlers for the personal-mode SSH endpoints (ADR-0049 §2/§6). Every
 * handler refuses `remote-personal-unavailable` unless the live switch is on
 * AND the custody mode is `personal`; every mutation answers the refreshed
 * `sshState` and no answer ever carries key or password bytes.
 */
import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MultiRootRegistry } from '../registry.ts'
import { RemoteAdmissionError } from './contract.ts'
import { checkRemotePath, ManifestError } from './manifest.ts'
import { inspectSshProfile } from '../compat/ssh-profile.ts'
import { helperCommandError, HelperInstallError } from './personal/helper-error.ts'
import type { SshCall, SshSettingsCall, SshStateView } from './personal-contract.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from './personal/config.ts'
import { CommandExecutionError, CredentialStore, defaultExec, type ExecFile } from './personal/credentials.ts'
import { helperProtocol, HostKeyScans, installAccessKey, installHelper, pinAccessKeyTarget, removeAccessKey, testConnection } from './personal/operations.ts'
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

async function sshState(registry: MultiRootRegistry, paths: PersonalPaths, primary: string | undefined): Promise<SshStateView> {
  const config = loadPersonalConfig(paths.personalPath)
  const store = new CredentialStore(paths.credentialRoot)
  const key = primary === undefined ? undefined : primaryKey(primary)
  return {
    mode: 'personal',
    enabled: registry.remoteEnabled,
    linked: linkStatus(paths.credentialRoot).linked,
    revision: config.revision,
    environments: config.environments.map(({ identityId: _identityId, ...environment }) => environment),
    credentials: store.list(),
    bindings: key === undefined ? [] : config.bindings.filter(binding => primaryKey(binding.primary) === key)
      .map(({ bindingId: _bindingId, ...binding }) => binding),
  }
}

async function mutate(
  registry: MultiRootRegistry, primary: string | undefined, paths: PersonalPaths,
  expectedRevision: number, edit: (config: PersonalConfig) => PersonalConfig | Promise<PersonalConfig>,
  beforeCommit?: () => void,
): Promise<SshStateView> {
  const config = loadPersonalConfig(paths.personalPath)
  if (config.revision !== expectedRevision) {
    throw new RemoteAdmissionError('personal-config-conflict', 'the personal config revision changed; reload and retry')
  }
  const next = await edit(config)
  if (next === config) return await sshState(registry, paths, primary)
  await savePersonalConfig(paths.personalPath, { ...next, revision: next.revision + 1 }, expectedRevision, beforeCommit)
  if (next.environments !== config.environments) renderSshConfig(loadPersonalConfig(paths.personalPath), paths.credentialRoot)
  await registry.refreshRemotePersonal().catch(() => {})
  return await sshState(registry, paths, primary)
}

function findEnvironment(config: PersonalConfig, environmentId: string): PersonalEnvironment {
  const environment = config.environments.find(entry => entry.environmentId === environmentId)
  if (environment === undefined) throw new RemoteAdmissionError('environment-not-found', `unknown environment "${environmentId}"`)
  return environment
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const entries = new Set(left)
  const other = new Set(right)
  return entries.size === other.size && [...other].every(entry => entries.has(entry))
}

function transferKeys(transfers: import('./manifest.ts').RemoteBinding['transfers']): string[] {
  return (transfers ?? []).map(({ direction, peer }) => JSON.stringify([direction, peer.environmentId, peer.rootId]))
}

/** Allocate within the same workspace and environment as the new binding. */
function newBindingRootId(path: string, used: ReadonlySet<string>): string {
  const slug = posix.basename(path).normalize('NFKD').toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, 63)
    .replace(/-$/, '')
  if (slug !== '' && !used.has(slug)) return slug

  let id: string
  do {
    id = randomUUID().slice(0, 8)
  } while (used.has(id))
  return id
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
    throw new RemoteAdmissionError('host-identity-unverifiable', error instanceof Error ? error.message : String(error), { cause: error })
  }
  const files = [...identity.knownHostsFiles, ...identity.globalKnownHostsFiles]
  const { keys, fingerprint } = await hostKeyFingerprint(identity.lookupHost, files, execAdapter)
  if (keys !== 1 || fingerprint === undefined) {
    throw new RemoteAdmissionError('host-identity-unverifiable', `host "${identity.lookupHost}" resolves ${keys} usable known_hosts keys, exactly one required`)
  }
  return { endpoint: { hostname: identity.hostname, port: Number.parseInt(identity.port, 10) || 22, user: identity.user }, fingerprint }
}

async function verifyStoredAlias(exec: ExecFile, environment: PersonalEnvironment, credentialRoot: string): Promise<void> {
  if (environment.credential.kind === 'ssh-config') {
    const { endpoint, fingerprint } = await sshConfigIdentity(exec, environment.credential.alias, join(credentialRoot, 'known_hosts'))
    if (endpoint.hostname !== environment.endpoint.hostname || endpoint.port !== environment.endpoint.port) {
      throw new RemoteAdmissionError('host-identity-unverifiable', 'the resolved SSH hostname or port differs from the saved target')
    }
    if (endpoint.user !== environment.endpoint.user) throw new RemoteAdmissionError('account-mismatch', 'the SSH alias resolves a different account')
    if (fingerprint !== environment.hostKey) throw new RemoteAdmissionError('host-key-mismatch', 'the SSH alias resolves a different host key')
  }
}

/**
 * Serve one personal endpoint. Callers have already validated the payload.
 * @returns the answer value (`sshState`, scan keys, or a connection test).
 */
export async function handlePersonalEndpoint(
  ctx: Context, registry: MultiRootRegistry, primary: string | undefined, call: SshCall | SshSettingsCall, deps: PersonalDeps = {},
): Promise<unknown> {
  if (call.endpoint !== 'sshState' && call.endpoint !== 'sshHostKeyScan' && call.endpoint !== 'sshEnvironmentTest'
    && call.endpoint !== 'sshConfigAliases' && call.endpoint !== 'sshListDirectories') {
    return await enqueueMutation(async () => await runPersonalEndpoint(ctx, registry, primary, call, deps))
  }
  return await runPersonalEndpoint(ctx, registry, primary, call, deps)
}

async function installAndRecordHelper(
  ctx: Context, registry: MultiRootRegistry, primary: string | undefined, paths: PersonalPaths,
  call: Extract<SshSettingsCall, { endpoint: 'sshHelperInstall' }>, exec: ExecFile,
): Promise<SshStateView> {
  const { view, gate } = inspectSshProfile(ctx)
  const root = gate?.status === 'eligible' ? gate.locations?.['@deepseek-ai/dsh-ssh']?.root : undefined
  if (gate?.status !== 'eligible' || root === undefined) {
    throw new HelperInstallError(view.code, 'The Host SSH dependencies are not ready.', {
      stage: 'host-preflight', retryable: false,
      remediation: view.code === 'ssh-deps-restart' ? 'restart' : view.code.startsWith('ssh-host-') ? 'host' : 'dependencies',
      ...(view.release === undefined ? {} : { expectedVersion: view.release }),
    })
  }
  try {
    new CredentialStore(paths.credentialRoot, exec)
  } catch (error) {
    throw new HelperInstallError('credential-root-unsafe', 'The Host could not open its protected SSH credential directory.', {
      stage: 'host-preflight', retryable: false, remediation: 'host',
    }, error)
  }
  let config: PersonalConfig
  try {
    config = loadPersonalConfig(paths.personalPath)
  } catch (error) {
    throw new HelperInstallError('helper-config-read', 'The Host could not load the SSH configuration.', {
      stage: 'config-commit', retryable: false, remediation: 'reload', registration: 'not-committed',
    }, error)
  }
  if (config.revision !== call.revision) {
    throw new HelperInstallError('personal-config-conflict', 'The SSH configuration revision changed before installation.', {
      stage: 'config-commit', retryable: true, remediation: 'reload', registration: 'not-committed',
    })
  }
  const environment = findEnvironment(config, call.environmentId)
  try {
    await verifyStoredAlias(exec, environment, paths.credentialRoot)
  } catch (error) {
    const cause = error instanceof RemoteAdmissionError ? error.cause : error
    if (cause instanceof CommandExecutionError) throw helperCommandError(cause, 'ssh-connect')
    throw new HelperInstallError('ssh-connect-host-key', 'The confirmed SSH alias identity could not be verified.', {
      stage: 'ssh-connect', retryable: false, remediation: 'host-key',
    }, error)
  }
  const protocol = helperProtocol(root)
  const helper = await installHelper(exec, environment, paths.credentialRoot, {
    sshVersion: gate.release, hostHelperPath: join(root, 'lib', 'helper.js'), nodePath: call.nodePath,
  })
  const next = {
    ...config,
    revision: config.revision + 1,
    environments: config.environments.map(entry => entry.environmentId === call.environmentId
      ? { ...entry, helper: { ...helper, protocol } }
      : entry),
  }
  try {
    await savePersonalConfig(paths.personalPath, next, call.revision, () => {
      requirePersonal(registry)
      if (inspectSshProfile(ctx).gate?.status !== 'eligible') throw new Error('Host SSH dependencies changed during installation')
    })
  } catch (error) {
    const conflict = error instanceof ManifestError && error.code === 'personal-config-conflict'
    throw new HelperInstallError(conflict ? 'personal-config-conflict' : 'helper-config-commit',
      'The remote Helper was deployed and verified. Host registration could not be confirmed.', {
        stage: 'config-commit', retryable: false, remediation: 'reload', remoteState: 'verified', registration: 'unconfirmed',
      }, error)
  }
  await registry.refreshRemotePersonal().catch(() => {})
  try {
    return await sshState(registry, paths, primary)
  } catch (error) {
    throw new HelperInstallError('helper-config-reload', 'The Helper was registered, but the Host could not return the updated configuration.', {
      stage: 'config-commit', retryable: false, remediation: 'reload', remoteState: 'verified',
    }, error)
  }
}

async function runPersonalEndpoint(
  ctx: Context, registry: MultiRootRegistry, primary: string | undefined, call: SshCall | SshSettingsCall, deps: PersonalDeps,
): Promise<unknown> {
  const paths = requirePersonal(registry)
  const exec = deps.exec ?? defaultExec
  if (call.endpoint === 'sshHelperInstall') return await installAndRecordHelper(ctx, registry, primary, paths, call, exec)
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
      const environment = findEnvironment(config, call.environmentId)
      await verifyStoredAlias(exec, environment, paths.credentialRoot)
      return await listRemoteDirectories(environment, paths.credentialRoot, call.path)
    }
    case 'sshCredentialGenerate':
      await store.generate(call.label)
      return await after()
    case 'sshCredentialImport':
      await store.importKey(call.label, call.privateKey, call.passphrase)
      return await after()
    case 'sshCredentialPassword':
      await store.savePassword(call.label, call.password)
      return await after()
    case 'sshCredentialRemove': {
      const config = loadPersonalConfig(paths.personalPath)
      await store.remove(call.id, id => config.environments.some(environment =>
        environment.credential.kind === 'managed'
        && (environment.credential.credentialId === id || environment.credential.accessKeyId === id)))
      return await after()
    }
    case 'sshHostKeyScan': {
      if (call.alias !== undefined) {
        // Alias scan: the fingerprint lives in the user's own known_hosts,
        // so no network probe. The token pins both the resolved target
        // and the saved known_hosts fingerprint through confirmation.
        const resolved = await sshConfigIdentity(exec, call.alias, join(paths.credentialRoot, 'known_hosts'))
        return { token: activeScans.rememberAlias(call.alias, resolved.endpoint, resolved.fingerprint),
          keys: [{ type: 'known-hosts', fingerprint: resolved.fingerprint }], endpoint: resolved.endpoint }
      }
      const { token, keys } = await activeScans.scan(call.hostname!, call.port)
      return { token, keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
    }
    case 'sshEnvironmentSave': {
      const draft = { ...call.environment, endpoint: { ...call.environment.endpoint } }
      const currentConfig = loadPersonalConfig(paths.personalPath)
      const currentEnvironments = currentConfig.environments
      const previous = currentEnvironments.find(environment => environment.environmentId === draft.environmentId)
      if (call.intent === 'create' && previous !== undefined) {
        throw new RemoteAdmissionError('environment-id-conflict', 'an SSH connection with this ID already exists')
      }
      if (call.intent === 'update' && previous === undefined) {
        throw new RemoteAdmissionError('environment-not-found', 'the SSH connection to edit no longer exists')
      }
      if (currentConfig.revision !== call.revision) {
        throw new RemoteAdmissionError('personal-config-conflict', 'the personal config revision changed; reload and retry')
      }
      // The recorded fingerprint may be reused for an update that changes only
      // connection metadata or capabilities: the target identity and the managed credential
      // must be untouched. A changed target still needs a fresh scan token.
      const sameIdentity = (): boolean => previous !== undefined
        && previous.platform === draft.platform
        && previous.endpoint.hostname === draft.endpoint.hostname
        && previous.endpoint.port === draft.endpoint.port
        && previous.endpoint.user === draft.endpoint.user
        && previous.credential.kind === draft.credential.kind
        && (draft.credential.kind === 'managed'
          ? previous.credential.kind === 'managed' && previous.credential.credentialId === draft.credential.credentialId
          : previous.credential.kind === 'ssh-config' && previous.credential.alias === draft.credential.alias)
      const preservedHelper = (environments: readonly PersonalEnvironment[]): PersonalEnvironment['helper'] => {
        const found = environments.find(environment => environment.environmentId === draft.environmentId)
        if (found === undefined) return null
        const sameTarget = found.endpoint.hostname === draft.endpoint.hostname
          && found.endpoint.port === draft.endpoint.port
          && found.endpoint.user === draft.endpoint.user
          && found.credential.kind === draft.credential.kind
        return sameTarget ? found.helper : null
      }
      const hostKey = call.fingerprint
      const mayReuse = sameIdentity() && previous?.hostKey === hostKey
      let recordKey: (() => void) | undefined
      if (draft.credential.kind === 'managed' && draft.exec !== undefined && preservedHelper(currentEnvironments) === null) {
        throw new RemoteAdmissionError('exec-requires-helper', 'exec requires an installed remote helper; save without exec, install the helper, then enable it')
      }
      if (call.hostKeyToken === undefined && !mayReuse) {
        throw new RemoteAdmissionError('host-key-token-required', 'confirm a new host key scan when the SSH identity changes')
      }
      if (draft.credential.kind === 'ssh-config') {
        const alias = draft.credential.alias
        const { endpoint, fingerprint } = await sshConfigIdentity(exec, alias, join(paths.credentialRoot, 'known_hosts'))
        if (fingerprint !== hostKey) {
          throw new RemoteAdmissionError('host-key-mismatch', 'the confirmed fingerprint does not match the SSH alias')
        }
        if (call.hostKeyToken !== undefined) {
          activeScans.resolve(call.hostKeyToken, fingerprint, endpoint.hostname, endpoint.port, alias, endpoint.user)
        } else if (endpoint.hostname !== draft.endpoint.hostname || endpoint.port !== draft.endpoint.port || endpoint.user !== draft.endpoint.user) {
          throw new RemoteAdmissionError('host-key-mismatch', 'the saved target no longer matches the SSH alias')
        }
        draft.endpoint = endpoint
      } else if (call.hostKeyToken !== undefined) {
        const lines = activeScans.resolve(call.hostKeyToken, hostKey, draft.endpoint.hostname, draft.endpoint.port)
        recordKey = () => recordKnownHost(paths.credentialRoot, draft.endpoint.hostname, draft.endpoint.port, lines)
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
            {
              ...draft, credential, hostKey, helper,
              identityId: sameIdentity() && previous?.hostKey === hostKey ? previous.identityId : randomUUID(),
            },
          ],
        }
      }, recordKey)
    }
    case 'sshEnvironmentRemove': {
      const removed = loadPersonalConfig(paths.personalPath).environments.find(environment => environment.environmentId === call.environmentId)
      const state = await mutate(registry, primary, paths, call.revision, config => {
        if (config.bindings.some(binding => binding.environmentId === call.environmentId)) {
          throw new RemoteAdmissionError('environment-in-use', 'remove the Workspace Root bindings before deleting this SSH environment')
        }
        return { ...config, environments: config.environments.filter(environment => environment.environmentId !== call.environmentId) }
      })
      // R6: the removed environment's access key is best-effort cleanup.
      const accessKeyId = removed?.credential.kind === 'managed' ? removed.credential.accessKeyId : undefined
      if (accessKeyId !== undefined) {
        try { await store.remove(accessKeyId, () => false) } catch { /* already gone */ }
      }
      return state
    }
    case 'sshEnvironmentTest': {
      const config = loadPersonalConfig(paths.personalPath)
      return await testConnection(exec, findEnvironment(config, call.environmentId), paths.credentialRoot)
    }
    case 'sshAccessKeyInstall': {
      const config = loadPersonalConfig(paths.personalPath)
      const environment = findEnvironment(config, call.environmentId)
      if (environment.credential.kind !== 'managed') {
        throw new RemoteAdmissionError('credential-kind-mismatch', 'access-key bootstrap applies to managed credentials only')
      }
      const secretFile = store.secretFileOf(environment.credential.credentialId)
      if (secretFile === undefined) throw new RemoteAdmissionError('credential-not-found', 'the credential secret is missing')
      // Fail before any key generation or remote write when the caller's
      // revision is already stale — an install that cannot be recorded would
      // leave a remote grant plus an orphan local key.
      if (config.revision !== call.revision) {
        throw new RemoteAdmissionError('personal-config-conflict', 'the SSH environment data changed; reload and retry')
      }
      if (environment.credential.accessKeyId !== undefined) return await after()
      const managed = environment.credential
      const sameTarget = (entry: PersonalEnvironment): boolean => entry.credential.kind === 'managed'
        && entry.credential.credentialId === managed.credentialId
        && entry.credential.accessKeyId === managed.accessKeyId
        && entry.identityId === environment.identityId && entry.hostKey === environment.hostKey
        && entry.endpoint.hostname === environment.endpoint.hostname && entry.endpoint.port === environment.endpoint.port
        && entry.endpoint.user === environment.endpoint.user
      const conflict = () => new RemoteAdmissionError('personal-config-conflict', 'the SSH environment changed during access-key install; reload and retry')
      const pinned = pinAccessKeyTarget(environment, paths.credentialRoot, secretFile)
      try {
        const accessKey = await store.generate(`env-${environment.environmentId}`, { purpose: 'access-key', environmentId: environment.environmentId })
        const key = { publicKey: accessKey.publicKey ?? '' }
        const attach = (revision: number) => mutate(registry, primary, paths, revision, current => {
          const entry = current.environments.find(candidate => candidate.environmentId === call.environmentId)
          if (entry === undefined || !sameTarget(entry)) throw conflict()
          return {
            ...current,
            environments: current.environments.map(candidate => candidate !== entry ? candidate : {
              ...candidate,
              credential: { ...managed, accessKeyId: accessKey.id },
            }),
          }
        })
        try {
          await installAccessKey(exec, environment, paths.credentialRoot, key, pinned.secretFile, pinned.knownHosts)
          try { return await attach(call.revision) }
          catch (error) {
            if ((error as { code?: unknown }).code !== 'personal-config-conflict') throw error
            const current = loadPersonalConfig(paths.personalPath)
            const entry = current.environments.find(candidate => candidate.environmentId === call.environmentId)
            if (entry === undefined || !sameTarget(entry)) throw error
            return await attach(current.revision)
          }
        } catch (error) {
          // Read durable state before rolling back: a write may have succeeded
          // even if refreshing the view afterward failed.
          try {
            const attached = loadPersonalConfig(paths.personalPath).environments.some(entry =>
              entry.credential.kind === 'managed' && entry.credential.accessKeyId === accessKey.id)
            if (!attached) {
              await removeAccessKey(exec, environment, paths.credentialRoot, key, pinned.secretFile, pinned.knownHosts)
              await store.remove(accessKey.id, () => false)
            }
          } catch {
            throw new RemoteAdmissionError('access-key-reconcile-required',
              `access-key install could not be reconciled; inspect the original host for key dsh-${accessKey.id}`)
          }
          throw error
        }
      } finally {
        pinned.dispose()
      }
    }
    case 'sshBindingSave':
      if (primary === undefined) throw new RemoteAdmissionError('panel/bad-request', 'a Workspace binding requires a live session')
      try {
        checkRemotePath(call.binding.path)
      } catch {
        throw new RemoteAdmissionError('workspace-invalid', 'the remote Root must be a normalized absolute POSIX path')
      }
      return await mutate(registry, primary, paths, call.revision, config => {
        const { binding } = call
        const key = primaryKey(primary)
        const siblings = config.bindings.filter(entry => entry.environmentId === binding.environmentId
          && primaryKey(entry.primary) === key)
        // A create-shaped draft (no rootId) re-save edits the binding that
        // already covers this environment+path instead of allocating a fresh id.
        const previous = binding.rootId === undefined
          ? siblings.find(entry => entry.path === binding.path)
          : siblings.find(entry => entry.rootId === binding.rootId)
        if (binding.rootId !== undefined && previous === undefined) {
          throw new RemoteAdmissionError('personal-config-conflict', 'the Workspace binding to edit no longer exists; reload and retry')
        }
        // Personal UI can keep an existing deployment-style pairing when
        // editing this directory, but it may only add local transfer peers.
        for (const transfer of binding.transfers ?? []) {
          if (transfer.peer.environmentId === 'local') continue
          if (previous?.path !== binding.path || !previous.transfers?.some(entry => entry.direction === transfer.direction
            && entry.peer.environmentId === transfer.peer.environmentId && entry.peer.rootId === transfer.peer.rootId)) {
            throw new RemoteAdmissionError('personal-config-invalid', 'a personal binding can only add local transfer peers')
          }
        }
        if (previous !== undefined && previous.path === binding.path
          && sameMembers(previous.actions, binding.actions)
          && sameMembers(transferKeys(previous.transfers), transferKeys(binding.transfers))) return config
        const rootId = binding.rootId ?? previous?.rootId ?? newBindingRootId(binding.path, new Set(siblings.map(entry => entry.rootId)))
        return {
          ...config,
          bindings: [...config.bindings.filter(entry => entry !== previous), { ...binding, rootId, primary, bindingId: randomUUID() }],
        }
      })
    case 'sshBindingRemove':
      if (primary === undefined) throw new RemoteAdmissionError('panel/bad-request', 'a Workspace binding requires a live session')
      return await mutate(registry, primary, paths, call.revision, config => ({
        ...config,
        bindings: config.bindings.filter(binding => !(binding.environmentId === call.environmentId && binding.rootId === call.rootId && primaryKey(binding.primary) === primaryKey(primary))),
      }))
    case 'sshConfigLink':
      link(paths.credentialRoot)
      return await after()
  }
}
