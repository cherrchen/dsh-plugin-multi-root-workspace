/**
 * The SSH environment manager: turns a verified manifest environment into a
 * live `SshEnvironment` — host identity checked BEFORE any official class is
 * constructed, the official stack mounted inside an isolated Context, and one
 * connection per environment. A disposed or lost environment never blocks the
 * others; reopening produces a new generation rather than a reconnect.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { classifyInstallation, classifySshCapability, sshPackageVersion, sshPrivateCopy, type SshCapability } from '../compat/dsh-version.ts'
import { loadHostSshPackages } from '../compat/ssh-packages.ts'
import { SftpClient, type SftpVersion } from './sftp.ts'
import { environmentDigest, type DeploymentManifest, type RemoteEnvironment } from './manifest.ts'

export class SshEnvironmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SshEnvironmentError'
  }
}

/** What `ssh -G <alias>` resolves this host to — the deployer's identity story. */
export interface SshHostIdentity {
  readonly user: string
  readonly hostname: string
  readonly knownHostsFiles: readonly string[]
  readonly globalKnownHostsFiles: readonly string[]
  readonly strictHostKeyChecking: string
  readonly forwardAgent: string
  readonly batchMode: string
  readonly updateHostKeys: string
  readonly port: string
  readonly hostKeyAlias: string | undefined
  readonly lookupHost: string
}

export interface SshEnvironment {
  readonly environmentId: string
  readonly generation: string
  readonly hello: Readonly<Record<string, unknown>>
  readonly fs: unknown
  readonly sandbox: { confine(argv: readonly string[], policy: unknown, signal?: AbortSignal): Promise<{ argv: readonly string[]; enforcement: string }> }
  readonly subprocess: { spawn(spec: unknown): { done: Promise<unknown>; waitForExit(signal?: AbortSignal): Promise<boolean>; terminate(): void; collected: unknown } }
  /**
   * Cheap local liveness check — throws when the underlying connection is
   * already closed or failed. A cached environment that throws here is a
   * corpse: it must never be handed out again.
   */
  assertAlive(): void
  dispose(): Promise<void>
}

/** One managed SFTP session — the G2 transfer endpoint's lifetime handle. */
export interface SftpEnvironment {
  readonly environmentId: string
  readonly generation: string
  readonly client: SftpClient
  readonly version: SftpVersion
  dispose(): Promise<void>
}

export interface SshEnvironmentManagerOptions {
  readonly manifest: DeploymentManifest | undefined
  readonly logger: { debug(message: string): void; warn(message: string): void }
  readonly gate?: SshCapability
  readonly allowUnattestedForTesting?: boolean
  /**
   * This process is the credential broker, running under the dedicated
   * account and owning the keys (ADR-0048). Custody is then the deployment's
   * attestation, not this process's manifest flag — the Host's
   * `attestBroker()` decides whether any model-facing tool may use it.
   */
  readonly custody?: 'broker' | 'personal'
  readonly exec?: (file: string, args: readonly string[], input?: string) => Promise<{ stdout: string; stderr: string }>
  readonly managedKnownHostsFile?: string | undefined
  readonly readFile?: (path: string) => string
}

const defaultExec = (file: string, args: readonly string[], input?: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = execFile(file, [...args], { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
    if (error !== null && stdout === '') reject(error)
    else resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
  if (input !== undefined) child.stdin?.end(input)
})

/**
 * Parse `ssh -G` output into the fields the deployer must prove: the login,
 * the resolved hostname, every user known_hosts file, and the safety flags.
 */
export function parseSshConfig(stdout: string, options: { relaxed?: boolean; managedKnownHostsFile?: string | undefined } = {}): SshHostIdentity {
  const fields: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim())
    if (match !== null) fields[match[1]!.toLowerCase()] = match[2]!.trim()
  }
  if (fields.user === undefined || fields.hostname === undefined) {
    throw new SshEnvironmentError('host-identity-unverifiable', `ssh -G resolved no user/hostname: ${JSON.stringify(stdout.slice(0, 200))}`)
  }
  // ssh -G removes filename quotes. The generated managed directive names
  // exactly one known path; preserve it only on a complete field match.
  const userFiles = fields.userknownhostsfile === options.managedKnownHostsFile && options.managedKnownHostsFile !== undefined
    ? [options.managedKnownHostsFile] : (fields.userknownhostsfile ?? '').split(/\s+/)
  const files = userFiles.filter(file => file !== '' && file !== '/dev/null' && file.toLowerCase() !== 'none')
  const globalFiles = (fields.globalknownhostsfile ?? '').split(/\s+/).filter(file => file !== '' && file !== '/dev/null' && file.toLowerCase() !== 'none')
  const strict = (fields.stricthostkeychecking ?? '').toLowerCase()
  const batchMode = (fields.batchmode ?? '').toLowerCase()
  const forwardAgent = (fields.forwardagent ?? '').toLowerCase()
  // OpenSSH -G normalizes `UpdateHostKeys no` to `false` (and `yes` to
  // `true`, `ask` stays `ask`); accept both spellings of "never rewrite".
  const updateHostKeys = (fields.updatehostkeys ?? 'no').toLowerCase()
  // Personal custody (ADR-0049 §2): upstream already forces BatchMode /
  // StrictHostKeyChecking / ForwardAgent on its own command line, so the
  // user's config need not prove them. Account and host-key checks stay.
  if (options.relaxed !== true) {
    if (strict !== 'true' && strict !== 'yes') {
      throw new SshEnvironmentError('host-identity-unverifiable', `strictHostKeyChecking is "${fields.stricthostkeychecking ?? ''}", must be yes`)
    }
    if (batchMode !== 'yes') {
      throw new SshEnvironmentError('host-identity-unverifiable', `batchMode is "${fields.batchmode ?? ''}", must be yes`)
    }
    if (forwardAgent !== 'no') {
      throw new SshEnvironmentError('host-identity-unverifiable', `forwardAgent is "${fields.forwardagent ?? ''}", must be no`)
    }
    if (updateHostKeys !== 'no' && updateHostKeys !== 'false') {
      throw new SshEnvironmentError('host-identity-unverifiable', `updateHostKeys resolves "${fields.updatehostkeys ?? ''}", must be no`)
    }
  }
  const port = fields.port ?? '22'
  const hostKeyAlias = fields.hostkeyalias
  const lookupHost = hostKeyAlias ?? (port === '22' ? fields.hostname : `[${fields.hostname}]:${port}`)
  return {
    user: fields.user, hostname: fields.hostname, knownHostsFiles: files, globalKnownHostsFiles: globalFiles,
    strictHostKeyChecking: strict, forwardAgent, batchMode, updateHostKeys, port, hostKeyAlias, lookupHost,
  }
}

/** The ssh-keygen -F + -lf pipeline, broken out so tests feed fixture text. */
export async function hostKeyFingerprint(
  hostname: string, files: readonly string[],
  exec: NonNullable<SshEnvironmentManagerOptions['exec']>,
): Promise<{ keys: number; fingerprint: string | undefined }> {
  const keyLines: string[] = []
  for (const file of files) {
    const { stdout } = await exec('ssh-keygen', ['-F', hostname, '-f', file]).catch(() => ({ stdout: '', stderr: '' }))
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '' && !trimmed.startsWith('#') && /\s(?:ssh-|sk-|ecdsa|rsa)/u.test(trimmed)) keyLines.push(trimmed)
    }
  }
  if (keyLines.length !== 1) return { keys: keyLines.length, fingerprint: undefined }
  const { stdout } = await exec('ssh-keygen', ['-lf', '-'], keyLines[0])
  const match = /SHA256:[A-Za-z0-9+/]{43}/u.exec(stdout)
  return { keys: 1, fingerprint: match?.[0] }
}

const UNAVAILABLE_MANIFEST: DeploymentManifest = { schemaVersion: 1, configVersion: 'unavailable', environments: [], bindings: [] }

export class SshEnvironmentManager {
  private manifest: DeploymentManifest
  private readonly logger: SshEnvironmentManagerOptions['logger']
  private readonly gate: SshCapability
  private readonly allowUnattested: boolean
  private readonly brokerCustody: boolean
  private readonly managedKnownHostsFile: string | undefined
  private readonly personalCustody: boolean
  private readonly exec: NonNullable<SshEnvironmentManagerOptions['exec']>
  private readonly readFile: (path: string) => string
  private readonly openings = new Map<string, Promise<SshEnvironment>>()
  private readonly resolved = new Map<string, SshEnvironment>()
  private readonly sftpOpenings = new Map<string, Promise<SftpEnvironment>>()
  private readonly sftpResolved = new Map<string, SftpEnvironment>()

  constructor(options: SshEnvironmentManagerOptions) {
    this.manifest = options.manifest ?? UNAVAILABLE_MANIFEST
    this.logger = options.logger
    this.gate = options.gate ?? classifySshCapability({
      platform: process.platform, local: classifyInstallation(),
      readVersion: sshPackageVersion, privateCopy: sshPrivateCopy,
    })
    this.allowUnattested = options.allowUnattestedForTesting === true || options.custody === 'personal'
    this.brokerCustody = options.custody === 'broker'
    this.managedKnownHostsFile = options.managedKnownHostsFile
    this.personalCustody = options.custody === 'personal'
    this.exec = options.exec ?? defaultExec
    this.readFile = options.readFile ?? (path => readFileSync(path, 'utf8'))
  }

  /** Rebind personal facts while retaining unchanged connections and Root helpers. */
  rebind(manifest: DeploymentManifest | undefined): void {
    const previous = this.manifest
    const next = manifest ?? UNAVAILABLE_MANIFEST
    if (previous === next) return
    this.manifest = next
    const identities = new Map(next.environments.map(environment => [environment.environmentId, environmentDigest(environment)]))
    const changed = new Set(previous.environments
      .filter(environment => identities.get(environment.environmentId) !== environmentDigest(environment))
      .map(environment => environment.environmentId))
    const scopes = new Set(next.bindings.map(binding => this.helperKey(binding.environmentId, binding.path)))
    for (const key of this.openings.keys()) {
      const [id] = JSON.parse(key) as [string, string]
      if (changed.has(id) || !scopes.has(key)) void this.disposeHelper(key, true).catch(() => {})
    }
    for (const id of changed) this.markSftpStale(id)
  }

  /** The current verified deployment manifest. */
  get deployment(): DeploymentManifest { return this.manifest }

  get capability(): { readonly eligible: boolean; readonly reason?: string } {
    return this.gate.status === 'eligible'
      ? { eligible: true }
      : { eligible: false, reason: this.gate.status === 'absent' ? this.gate.reason : 'unknown' }
  }

  private helperKey(environmentId: string, workspace?: string): string {
    return this.personalCustody ? JSON.stringify([environmentId, workspace]) : environmentId
  }

  /** The live generation of a deployment connection or personal Root helper. */
  generationOf(environmentId: string, workspace?: string): string {
    return this.resolved.get(this.helperKey(environmentId, workspace))?.generation ?? 'stale'
  }

  private requireEnvironmentDigest(environmentId: string, expected: string | undefined): void {
    if (expected === undefined) return
    const environment = this.manifest.environments.find(entry => entry.environmentId === environmentId)
    if (environment === undefined || environmentDigest(environment) !== expected) {
      throw new SshEnvironmentError('binding-changed', 'the connection changed after admission')
    }
  }

  /** Open or reuse the Helper under its deployment or personal Root scope. */
  async open(environmentId: string, workspace?: string, expectedDigest?: string): Promise<SshEnvironment> {
    this.requireEnvironmentDigest(environmentId, expectedDigest)
    const key = this.helperKey(environmentId, workspace)
    const existing = this.openings.get(key)
    if (existing !== undefined) {
      const env = await existing
      if (this.openings.get(key) !== existing) throw new SshEnvironmentError('remote-unavailable', 'the Helper generation was superseded')
      try {
        env.assertAlive()
        return env
      } catch {
        if (this.openings.get(key) !== existing) return await this.open(environmentId, workspace, expectedDigest)
        this.markStale(environmentId, workspace, env.generation)
      }
    }
    const promise = this.openFresh(environmentId, workspace)
    this.openings.set(key, promise)
    try {
      const env = await promise
      if (this.openings.get(key) !== promise) throw new SshEnvironmentError('remote-unavailable', 'the Helper opening was superseded')
      this.resolved.set(key, env)
      return env
    } catch (error) {
      if (this.openings.get(key) === promise) this.openings.delete(key)
      throw error
    }
  }

  /** Mark only the affected Helper as lost. */
  markStale(environmentId: string, workspace?: string, generation?: string): void {
    if (generation !== undefined && this.generationOf(environmentId, workspace) !== generation) return
    void this.disposeHelper(this.helperKey(environmentId, workspace)).catch(() => {})
  }

  private async disposeHelper(key: string, allowRevocation = false): Promise<void> {
    const opening = this.openings.get(key)
    this.openings.delete(key)
    this.resolved.delete(key)
    if (opening !== undefined) await opening.then(async env => {
      // The admission monitor can terminate work using the old handle before
      // the transport closes. A new call cannot obtain this generation.
      if (allowRevocation) await new Promise<void>(resolve => setTimeout(resolve, 1_000).unref())
      await env.dispose()
    }, () => {})
  }

  async dispose(environmentId: string, workspace?: string): Promise<void> {
    await this.disposeHelper(this.helperKey(environmentId, workspace))
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.openings.keys()].map(key => this.disposeHelper(key)))
    for (const id of [...this.sftpOpenings.keys()]) await this.disposeSftp(id)
  }

  /** The live SFTP generation — a sentinel when none is open. */
  sftpGenerationOf(environmentId: string): string {
    return this.sftpResolved.get(environmentId)?.generation ?? 'stale'
  }

  /** Open (or join the in-flight open of) one environment's SFTP session. */
  async openSftp(environmentId: string, signal?: AbortSignal, expectedDigest?: string): Promise<SftpEnvironment> {
    signal?.throwIfAborted()
    this.requireEnvironmentDigest(environmentId, expectedDigest)
    let opening = this.sftpOpenings.get(environmentId)
    if (opening === undefined) {
      const ownsSlot = () => this.sftpOpenings.get(environmentId) === pending
      const pending: Promise<SftpEnvironment> = this.openSftpFresh(environmentId, () => {
        if (ownsSlot()) this.markSftpStale(environmentId)
      }).then(async env => {
        if (!ownsSlot()) {
          await env.dispose()
          throw new SshEnvironmentError('remote-unavailable', 'the SFTP opening was superseded')
        }
        this.sftpResolved.set(environmentId, env)
        return env
      }).catch(error => {
        if (ownsSlot()) this.sftpOpenings.delete(environmentId)
        throw error
      })
      opening = pending
      this.sftpOpenings.set(environmentId, opening)
    }
    if (signal === undefined) return await opening
    const aborted = Promise.withResolvers<never>()
    const abort = () => aborted.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([opening, aborted.promise]) }
    finally { signal.removeEventListener('abort', abort) }
  }

  markSftpStale(environmentId: string): void {
    const opening = this.sftpOpenings.get(environmentId)
    this.sftpOpenings.delete(environmentId)
    this.sftpResolved.delete(environmentId)
    void opening?.then(env => env.dispose()).catch(() => {})
  }

  async disposeSftp(environmentId: string): Promise<void> {
    const opening = this.sftpOpenings.get(environmentId)
    this.sftpOpenings.delete(environmentId)
    this.sftpResolved.delete(environmentId)
    if (opening !== undefined) await (await opening.catch(() => undefined))?.dispose()
  }

  /** Same ordered refusals as open(), then the SFTP handshake + publish extensions. */
  private async openSftpFresh(environmentId: string, onLoss: () => void): Promise<SftpEnvironment> {
    const environment = this.manifest.environments.find(entry => entry.environmentId === environmentId)
    if (environment === undefined) throw new SshEnvironmentError('unknown-environment', `no manifest environment "${environmentId}"`)
    if (this.gate.status !== 'eligible') {
      throw new SshEnvironmentError(`ssh-capability-absent:${this.gate.status === 'absent' ? this.gate.reason : 'unknown'}`, 'SSH capability is not eligible on this host')
    }
    // The SFTP session is the transfer adapter, not the environment's exec
    // transport: a helper environment that declares `transfer` uses the same
    // alias's SFTP subsystem, and a device may be SFTP-only.
    if (environment.credentialIsolation !== 'attested' && !this.allowUnattested && !this.brokerCustody) {
      throw new SshEnvironmentError('credential-isolation-unattested', `environment "${environmentId}" is declared unattested; connections require an attested deployment`)
    }
    if (environment.transfer === undefined) throw new SshEnvironmentError('transfer-unavailable', `environment "${environmentId}" declares no transfer block`)
    await this.verifyHostIdentity(environment)
    const client = SftpClient.connect(environment.connection.host, { onLoss })
    const timeout = setTimeout(() => client.dispose(), 15_000)
    timeout.unref()
    try {
      const version = await client.init()
      if (version.extensions['hardlink@openssh.com'] === undefined || version.extensions['fsync@openssh.com'] === undefined) {
        client.dispose()
        throw new SshEnvironmentError('publish-unsupported', `environment "${environmentId}" lacks hardlink/fsync extensions`)
      }
      this.logger.debug(`[sftp-env] ${environmentId} ready extensions ${Object.keys(version.extensions).join(',')}`)
      return { environmentId, generation: randomUUID(), client, version, dispose: async () => client.dispose() }
    } catch (error) {
      client.dispose()
      throw error
    } finally { clearTimeout(timeout) }
  }

  /** The full ordered admission: gate → transport → isolation → identity → load → mount. */
  private async openFresh(environmentId: string, bindingPath?: string): Promise<SshEnvironment> {
    const environment = this.manifest.environments.find(entry => entry.environmentId === environmentId)
    if (environment === undefined) throw new SshEnvironmentError('unknown-environment', `no manifest environment "${environmentId}"`)
    if (this.gate.status !== 'eligible') {
      throw new SshEnvironmentError(`ssh-capability-absent:${this.gate.status === 'absent' ? this.gate.reason : 'unknown'}`, `SSH capability is not eligible on this host`)
    }
    if (environment.transport !== 'helper') throw new SshEnvironmentError('transport-not-helper', `environment "${environmentId}" uses transport "${environment.transport}"`)
    // A helper installed before full-artifact integrity has no entry point to
    // verify its file set: refuse rather than trust the single-file digest.
    if (this.personalCustody && environment.helper!.integrity === undefined) {
      throw new SshEnvironmentError('helper-outdated', 'the recorded helper predates full-artifact integrity; reinstall the helper')
    }
    if (environment.credentialIsolation !== 'attested' && !this.allowUnattested && !this.brokerCustody) {
      throw new SshEnvironmentError('credential-isolation-unattested', `environment "${environmentId}" is declared unattested; connections require an attested deployment`)
    }
    const workspace = this.personalCustody ? bindingPath : environment.connection.workspace
    if (workspace === undefined || (this.personalCustody
      && !this.manifest.bindings.some(binding => binding.environmentId === environmentId && binding.path === workspace))) {
      throw new SshEnvironmentError('workspace-invalid', 'the Helper requires a declared remote Root')
    }
    const identity = await this.verifyHostIdentity(environment)
    const connection = environment.connection
    const modules = await loadHostSshPackages(this.gate) as Record<string, Record<string, unknown> & { default?: Record<string, unknown> }>
    const exported = (pkg: string, name: string) => modules[pkg]![name] ?? modules[pkg]!.default?.[name]
    const ctx = new Context()
    const mount = ctx.plugin.bind(ctx) as (plugin: unknown, config?: unknown) => { dispose(): Promise<void> }
    const fibers = [
      mount(SessionProjectionRegistry),
      mount(SandboxPolicyService, { mode: 'read-only', workspaceRoot: workspace }),
      mount(exported('@deepseek-ai/dsh-ssh', 'SshConnection'), {
        host: connection.host,
        launch: { kind: 'node-script', node: connection.nodePath! },
        helper: connection.helperPath!, helperHash: environment.helper!.sha256,
        workspace,
      }),
      mount(exported('@deepseek-ai/dsh-fs-ssh', 'SshFileSystem')),
      mount(exported('@deepseek-ai/dsh-subprocess-ssh', 'SshSubprocessRuntime')),
      mount(exported('@deepseek-ai/dsh-sandbox-ssh', 'SshSandboxProvider')),
    ]
    try {
      await Promise.all(fibers)
      const services = ctx as unknown as {
        ssh: { ready: Promise<Record<string, unknown>>; assertOpen(): void }
        fs: unknown
        sandbox: unknown
        subprocess: unknown
      }
      const hello = await services.ssh.ready
      if (hello.platform !== environment.platform) {
        throw new SshEnvironmentError('platform-mismatch', `environment "${environmentId}" declares "${environment.platform}" but reports "${String(hello.platform)}"`)
      }
      this.logger.debug(`[ssh-env] ${environmentId} ready as ${identity.user}@${identity.hostname} protocol ${String(hello.protocol)}`)
      const env: SshEnvironment = {
        environmentId, generation: randomUUID(),
        hello: { platform: hello.platform, workspace: hello.workspace, executable: hello.executable, protocol: hello.protocol },
        fs: services.fs, sandbox: services.sandbox as SshEnvironment['sandbox'], subprocess: services.subprocess as SshEnvironment['subprocess'],
        assertAlive: () => services.ssh.assertOpen(),
        dispose: async () => { for (const fiber of [...fibers].reverse()) await fiber.dispose() },
      }
      return env
    } catch (error) {
      for (const fiber of [...fibers].reverse()) await fiber.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Host identity binding: `ssh -G` resolves the alias the deployer named; the
   * account and host key must be the ones the manifest declares — a resolved
   * identity that drifts from the manifest is a refusal, never a hint.
   */
  private async verifyHostIdentity(environment: RemoteEnvironment): Promise<SshHostIdentity> {
    const { host } = environment.connection
    let stdout: string
    try {
      stdout = (await this.exec('ssh', ['-G', host])).stdout
    } catch (error) {
      throw new SshEnvironmentError('host-identity-unverifiable', `ssh -G ${host} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const identity = parseSshConfig(stdout, { relaxed: this.personalCustody, managedKnownHostsFile: this.managedKnownHostsFile })
    // A managed `dsh-*` alias that resolves to itself means the Include link
    // is absent (ADR-0049 §2): refuse with the actionable code.
    if (this.personalCustody && host.startsWith('dsh-') && identity.hostname === host) {
      throw new SshEnvironmentError('ssh-config-not-linked', `managed alias "${host}" is not linked into ~/.ssh/config`)
    }
    if (environment.personalIdentity !== undefined && (identity.hostname !== environment.personalIdentity.hostname
      || Number(identity.port) !== environment.personalIdentity.port)) {
      throw new SshEnvironmentError('host-identity-unverifiable', 'the resolved SSH hostname or port differs from the saved target')
    }
    if (identity.user !== environment.account) {
      throw new SshEnvironmentError('account-mismatch', `manifest account "${environment.account}" but ssh resolves user "${identity.user}"`)
    }
    const files = [...identity.knownHostsFiles, ...identity.globalKnownHostsFiles]
      .filter(file => { try { this.readFile(file); return true } catch { return false } })
    const { keys, fingerprint } = await hostKeyFingerprint(identity.lookupHost, files, this.exec)
    if (keys !== 1) throw new SshEnvironmentError('host-identity-unverifiable', `host "${host}" resolves ${keys} known_hosts keys, exactly one required`)
    if (fingerprint !== environment.hostKey) {
      throw new SshEnvironmentError('host-key-mismatch', `manifest hostKey "${environment.hostKey}" but known_hosts verifies "${fingerprint ?? 'none'}"`)
    }
    return identity
  }
}
