/**
 * The credential broker daemon (ADR-0040): it runs under the dedicated OS
 * account, owns the SSH keys/config/ControlMasters, and exposes ONLY the
 * semantic operations the Host needs — SFTP primitives, `confine`, `spawn`,
 * wait/terminate and dispose. There is no key, config, host or shell-selection
 * method; every environment id is resolved against the protected deployment
 * manifest the deployer installed.
 *
 * The listener authenticates each peer by kernel credentials: the configured
 * Host uid, not a sandboxed / `NoNewPrivs` process (the Agent's commands are
 * exactly such peers). Starting under the Host uid is refused because it would
 * make the custody claim false.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-broker/server
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, chownSync, lstatSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { listenNative, type Channel, type Listener } from '../../authority/native.ts'
import { loadDeploymentManifest, manifestDigest, type DeploymentManifest, type RemoteQuota } from '../manifest.ts'
import { SshEnvironmentManager, type SftpEnvironment, type SshEnvironment } from '../ssh-environment.ts'
import { SftpConnectionLost, SftpStatusError } from '../sftp.ts'
import {
  BROKER_PROTOCOL,
  MAX_DATA,
  MAX_IN_FLIGHT,
  MAX_PROCESSES,
  parseBrokerRequest,
  readBrokerLines,
  writeBrokerLine,
  type BrokerHello,
  type BrokerMethod,
} from './protocol.ts'

/** Stable broker refusals the Host maps onto its own result codes. */
class BrokerRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BrokerRefusal'
  }
}

/** Options the deployer's unit file supplies; nothing here is client-controlled. */
export interface BrokerServerOptions {
  /** The protected deployment manifest (owned by the broker account or root). */
  readonly manifestPath: string
  /** The listening socket; its directory must already be 0750 broker-owned. */
  readonly socketPath: string
  /** The trusted Host's uid; every peer must report exactly this. */
  readonly clientUid: number
  /** The broker account; defaults to this process's uid and must equal it. */
  readonly brokerUid?: number
  /** Optional append-only audit file (0600, broker-owned). Rotated at `auditMaxBytes`, keeping `auditKeep` rotated files. */
  readonly auditPath?: string
  /** Audit rotation size budget; defaults to 8 MiB. */
  readonly auditMaxBytes?: number
  /** How many rotated audit files to keep; defaults to 4. */
  readonly auditKeep?: number
  readonly logger?: { debug(message: string): void; warn(message: string): void }
  /** TEST-ONLY: allow starting as the client uid (protocol tests only). */
  readonly allowSameUidForTesting?: boolean
  /** TEST-ONLY: allow a sandboxed / NoNewPrivs peer (this suite runs inside DSH). */
  readonly allowRestrictedForTesting?: boolean
  /** TEST-ONLY: inject a manager with in-memory endpoints. */
  readonly manager?: SshEnvironmentManager
}

interface ProcessRecord {
  readonly environmentId: string
  readonly handle: {
    done: Promise<Record<string, unknown>>
    waitForExit(signal?: AbortSignal): Promise<boolean>
    terminate(): void
    collected?: { stdout?: Collected; stderr?: Collected }
  }
  stdout: string
  stderr: string
  done: boolean
  graceMs: number
  /** Recorded when the broker observed the exit; `wait` reports it after. */
  scope?: boolean
}

interface Collected { readFrom(offset: number): { text: string } | undefined }

interface ConnectionState {
  readonly id: number
  readonly channel: Channel
  readonly sftp: Map<string, SftpEnvironment>
  readonly environments: Map<string, SshEnvironment>
  readonly processes: Map<number, ProcessRecord>
  readonly tickets: Map<string, ConfinementTicket>
  inFlight: number
  closed: boolean
  nextProcess: number
}

interface ConfinementTicket {
  readonly argv: readonly string[]
  readonly environmentId: string
  readonly generation: string
  readonly workspaceRoot: string
  readonly expiresAt: number
}

const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 256
const DEFAULT_AUDIT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_AUDIT_KEEP = 4

/**
 * One rolling time-window budget. Events are a chronological queue of
 * `{time, bytes}` records; anything older than `windowMs` is pruned before
 * admission, so a client can never hold the window open by timing its
 * requests. Bounds come from the manifest — never from client input.
 */
class RollingQuota {
  private readonly events: { time: number; bytes: number }[] = []
  private bytes = 0
  constructor(private readonly limit: RemoteQuota, private readonly scope: string) {}

  /**
   * Whether one operation carrying `bytes` would exhaust this window.
   * Pruning happens here so the check and {@link record} see the same set.
   */
  exceeds(bytes: number, now = Date.now()): boolean {
    const cutoff = now - this.limit.windowMs
    while (this.events.length > 0 && this.events[0]!.time <= cutoff) {
      this.bytes -= this.events.shift()!.bytes
    }
    return this.events.length >= this.limit.maxOperations || this.bytes + bytes > this.limit.maxBytes
  }

  /** Charge one operation carrying `bytes`; callers must {@link exceeds}-check first. */
  record(bytes: number, now = Date.now()): void {
    this.events.push({ time: now, bytes })
    this.bytes += bytes
  }

  describe(): string { return `the ${this.scope} budget is exhausted for the current ${Math.round(this.limit.windowMs / 1000)}s window` }
}

/** One broker daemon instance. */
export class BrokerServer {
  private listener: Listener | undefined
  /** The socket directory's group; the socket is handed to it after bind. */
  private socketGroup: number | undefined
  private manager: SshEnvironmentManager | undefined
  private manifest: DeploymentManifest | undefined
  private deploymentDigest = ''
  private readonly connections = new Set<ConnectionState>()
  private nextConnection = 1
  private stopped = false
  /** The deployer's deny list; every environment-bound request is refused. */
  private readonly revoked = new Set<string>()
  /** The manifest's broker-global window, if declared. */
  private globalQuota: RollingQuota | undefined
  /** Per-environment windows, built from the manifest at start. */
  private readonly envQuotas = new Map<string, RollingQuota>()
  private auditSize = 0

  constructor(private readonly options: BrokerServerOptions) {}

  /** Start listening. Throws on any custody, manifest or permission failure. */
  async start(): Promise<void> {
    const uid = process.getuid?.()
    if (uid === undefined) throw new BrokerRefusal('unsupported-platform', 'the credential broker is POSIX-only')
    const brokerUid = this.options.brokerUid ?? uid
    if (brokerUid !== uid) {
      throw new BrokerRefusal('broker-uid-mismatch', `the broker runs as uid ${uid}, not the configured ${brokerUid}`)
    }
    if (brokerUid === this.options.clientUid && this.options.allowSameUidForTesting !== true) {
      throw new BrokerRefusal('broker-same-uid', 'the broker must run under an account other than the trusted Host user (ADR-0040)')
    }
    if (this.options.manager !== undefined) {
      this.manager = this.options.manager
      this.manifest = this.manager.deployment
    } else {
      const loaded = loadDeploymentManifest(this.options.manifestPath)
      this.manifest = loaded.manifest
      const unattested = this.manifest.environments.filter(environment => environment.credentialIsolation !== 'attested')
      if (unattested.length > 0) {
        throw new BrokerRefusal('manifest-unattested', `environments not declared attested: ${unattested.map(environment => environment.environmentId).join(', ')}`)
      }
      this.manager = new SshEnvironmentManager({
        manifest: this.manifest,
        logger: this.options.logger ?? { debug: () => {}, warn: () => {} },
        custody: 'broker',
      })
    }
    this.deploymentDigest = manifestDigest(this.manifest)
    for (const revocation of this.manifest.revocations ?? []) this.revoked.add(revocation.environmentId)
    if (this.manifest.quotas !== undefined) this.globalQuota = new RollingQuota(this.manifest.quotas, 'broker-global')
    for (const environment of this.manifest.environments) {
      if (environment.quotas !== undefined) this.envQuotas.set(environment.environmentId, new RollingQuota(environment.quotas, `environment "${environment.environmentId}"`))
    }
    this.prepareAuditFile()
    this.prepareSocketDirectory()
    this.listener = await listenNative(this.options.socketPath, channel => this.accept(channel), {
      expectedUid: this.options.clientUid,
      ...(this.options.allowRestrictedForTesting === true ? { allowRestricted: true } : {}),
    })
    // Bind creates the socket with the process's primary group, not the
    // directory's. Hand it to the directory's group (the deployer's client
    // group) and narrow it to 0660; world access never exists.
    try {
      if (this.socketGroup !== undefined) chownSync(this.options.socketPath, process.getuid!(), this.socketGroup)
      chmodSync(this.options.socketPath, 0o660)
    } catch (error) {
      this.options.logger?.warn(`dsh-ssh-broker: cannot set socket ownership/mode: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.options.logger?.debug(`dsh-ssh-broker: listening on ${this.options.socketPath} for uid ${this.options.clientUid}`)
  }

  /** Stop accepting, close every session, release the socket. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.listener?.close()
    this.listener = undefined
    for (const connection of [...this.connections]) this.closeConnection(connection)
    await this.manager?.disposeAll().catch(() => {})
    this.manager = undefined
  }

  private prepareSocketDirectory(): void {
    const directory = dirname(this.options.socketPath)
    try { mkdirSync(directory, { recursive: true, mode: 0o750 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const entry = lstatSync(directory)
    const uid = process.getuid!()
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) {
      throw new BrokerRefusal('unsafe-socket-directory', `${directory} must be a real directory owned by the broker account`)
    }
    if ((entry.mode & 0o007) !== 0) {
      throw new BrokerRefusal('unsafe-socket-directory', `${directory} is world-accessible; the broker socket must stay inside the deployer's group`)
    }
    this.socketGroup = entry.gid
  }

  private accept(channel: Channel): void {
    const state: ConnectionState = {
      id: this.nextConnection++,
      channel,
      sftp: new Map(),
      environments: new Map(),
      processes: new Map(),
      tickets: new Map(),
      inFlight: 0,
      closed: false,
      nextProcess: 1,
    }
    this.connections.add(state)
    const capability = (this.manager as { capability?: { eligible: boolean; reason?: string } } | undefined)?.capability
    const hello: BrokerHello = {
      protocol: BROKER_PROTOCOL,
      brokerUid: process.getuid!(),
      environmentIds: this.manifest?.environments.map(environment => environment.environmentId) ?? [],
      manifestDigest: this.deploymentDigest,
      sshCapability: capability?.eligible === true
        ? (capability.reason === undefined ? { eligible: true } : { eligible: true, reason: capability.reason })
        : { eligible: false, reason: capability?.reason ?? 'capability-unreported' },
    }
    if (!writeBrokerLine(channel, { event: 'hello', ...hello })) return
    channel.on('close', () => this.closeConnection(state))
    channel.on('error', () => channel.destroy())
    readBrokerLines(channel, value => this.receive(state, channel, value), error => {
      this.options.logger?.warn(`dsh-ssh-broker: dropped connection ${state.id}: ${error.message}`)
      this.audit(state, 'protocol', 'rejected')
    })
  }

  private receive(state: ConnectionState, channel: Channel, value: unknown): void {
    let request
    try { request = parseBrokerRequest(value) } catch (error) {
      // A malformed line has no trustworthy request id to answer; close the
      // connection instead of guessing one.
      this.options.logger?.warn(`dsh-ssh-broker: protocol violation on connection ${state.id}: ${error instanceof Error ? error.message : String(error)}`)
      this.audit(state, 'protocol', 'rejected')
      channel.destroy()
      return
    }
    if (state.closed) return
    if (state.inFlight >= MAX_IN_FLIGHT) {
      writeBrokerLine(channel, { id: request.id, ok: false, code: 'busy', message: 'too many in-flight broker requests' })
      return
    }
    state.inFlight++
    const environmentId = (request.params as { environmentId?: string }).environmentId
    void this.dispatch(state, request.method, request.params).then(value => {
      if (!state.closed) writeBrokerLine(channel, { id: request.id, ok: true, value })
      this.audit(state, request.method, 'ok', environmentId)
    }, error => {
      const refusal = error instanceof BrokerRefusal ? error
        : new BrokerRefusal(codeOf(error), error instanceof Error ? error.message : String(error))
      if (!state.closed) writeBrokerLine(channel, { id: request.id, ok: false, code: refusal.code, message: refusal.message })
      this.audit(state, request.method, `refused:${refusal.code}`, environmentId)
    }).finally(() => { state.inFlight-- })
  }

  private async dispatch(state: ConnectionState, method: BrokerMethod, params: unknown): Promise<unknown> {
    const p = params as Record<string, unknown>
    const environmentId = p.environmentId as string
    this.admit(method, p)
    switch (method) {
      case 'openSftp': {
        const opened = await this.openSftp(state, environmentId)
        return { environmentId, generation: opened.generation, version: opened.version }
      }
      case 'sftp':
        return await this.sftpCall(state, p)
      case 'open': {
        const environment = await this.openEnvironment(state, environmentId)
        return { environmentId, generation: environment.generation, hello: environment.hello }
      }
      case 'confine': {
        const environment = await this.openEnvironment(state, environmentId)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
          const confined = await environment.sandbox.confine(p.argv as string[], p.policy as never, controller.signal)
          const value: Record<string, unknown> = { argv: confined.argv, enforcement: confined.enforcement, generation: environment.generation }
          if (confined.enforcement === 'full') {
            value.confinementToken = this.issueTicket(state, environmentId, confined.argv, environment.generation, (p.policy as { workspaceRoot: string }).workspaceRoot)
          }
          return value
        } catch (error) {
          if (error instanceof BrokerRefusal) throw error
          throw new BrokerRefusal('confine-failed', error instanceof Error ? error.message : String(error))
        } finally { clearTimeout(timer) }
      }
      case 'spawn':
        return await this.spawn(state, environmentId, p)
      case 'wait': {
        const process = this.process(state, p.process as number)
        if (process.scope !== undefined) return { confirmed: process.scope }
        return { confirmed: await process.handle.waitForExit(AbortSignal.timeout(p.timeoutMs as number)) }
      }
      case 'terminate': {
        const process = this.process(state, p.process as number)
        process.handle.terminate()
        return {}
      }
      case 'dispose': {
        state.sftp.delete(environmentId)
        state.environments.delete(environmentId)
        for (const [token, ticket] of state.tickets) if (ticket.environmentId === environmentId) state.tickets.delete(token)
        // The manager owns the cache; disposing the env/session objects
        // directly would leave corpses its openings maps keep serving.
        const manager = await this.managerOrThrow()
        await manager.disposeSftp(environmentId).catch(() => {})
        await manager.dispose(environmentId).catch(() => {})
        return {}
      }
    }
  }

  /**
   * The deployment's admission gate: revocations deny the environment
   * outright; the manifest's rolling windows then charge every
   * environment-bound request one operation plus its SFTP payload bytes.
   * `dispose` (and the SFTP `dispose` op) stay admissible — cleanup must be
   * able to run even on a revoked environment.
   */
  private admit(method: BrokerMethod, p: Record<string, unknown>): void {
    const environmentId = p.environmentId as string | undefined
    if (environmentId === undefined) return
    if (method !== 'dispose' && !(method === 'sftp' && p.op === 'dispose') && this.revoked.has(environmentId)) {
      throw new BrokerRefusal('environment-revoked', `the deployment revokes environment "${environmentId}"`)
    }
    let bytes = 0
    if (method === 'sftp') {
      if (p.op === 'write') bytes = Buffer.from(p.data as string, 'base64').length
      else if (p.op === 'read') bytes = p.length as number
    }
    // Check every window before charging any: a refusal must not leak into
    // the other scope's budget (an env-denied op never consumed global room).
    const now = Date.now()
    const global = this.globalQuota
    const scoped = this.envQuotas.get(environmentId)
    const globalOver = global?.exceeds(bytes, now) === true
    const scopedOver = scoped?.exceeds(bytes, now) === true
    if (globalOver || scopedOver) {
      throw new BrokerRefusal('quota-exceeded', (scopedOver ? scoped! : global!).describe())
    }
    global?.record(bytes, now)
    scoped?.record(bytes, now)
  }

  private async managerOrThrow(): Promise<SshEnvironmentManager> {
    if (this.manager === undefined) throw new BrokerRefusal('broker-stopped', 'the broker is not running')
    return this.manager
  }

  private async openSftp(state: ConnectionState, environmentId: string): Promise<SftpEnvironment> {
    const manager = await this.managerOrThrow()
    // A per-connection entry whose manager cache entry is gone is a corpse:
    // another connection's dispose already reclaimed it. Drop and reopen.
    const existing = state.sftp.get(environmentId)
    if (existing !== undefined && manager.sftpGenerationOf(environmentId) === existing.generation) return existing
    state.sftp.delete(environmentId)
    const opened = await manager.openSftp(environmentId)
    state.sftp.set(environmentId, opened)
    return opened
  }

  private async openEnvironment(state: ConnectionState, environmentId: string): Promise<SshEnvironment> {
    const manager = await this.managerOrThrow()
    const existing = state.environments.get(environmentId)
    if (existing !== undefined && manager.generationOf(environmentId) === existing.generation) {
      try {
        existing.assertAlive()
        return existing
      } catch { /* a killed connection leaves a corpse; reopen below */ }
    }
    state.environments.delete(environmentId)
    const opened = await manager.open(environmentId)
    state.environments.set(environmentId, opened)
    return opened
  }

  private async sftpCall(state: ConnectionState, p: Record<string, unknown>): Promise<unknown> {
    const environmentId = p.environmentId as string
    const session = state.sftp.get(environmentId)
    if (session === undefined || session.generation !== p.generation || this.manager?.sftpGenerationOf(environmentId) !== session.generation) {
      throw new BrokerRefusal('generation-changed', 'the SFTP session is stale or was never opened on this connection')
    }
    const client = session.client
    try {
      switch (p.op) {
        case 'realpath': return { path: await client.realpath(p.path as string) }
        case 'lstat': {
          const attrs = await client.lstat(p.path as string)
          return {
            flags: attrs.flags, size: attrs.size, permissions: attrs.permissions, mtime: attrs.mtime,
            ...(attrs.uid === undefined ? {} : { uid: attrs.uid }),
            ...(attrs.gid === undefined ? {} : { gid: attrs.gid }),
          }
        }
        case 'open': return { handle: (await client.open(p.path as string, p.flags as number, p.permissions as number | undefined)).toString('base64') }
        case 'read': return { data: (await client.read(Buffer.from(p.handle as string, 'base64'), p.offset as number, p.length as number)).toString('base64') }
        case 'write': await client.write(Buffer.from(p.handle as string, 'base64'), p.offset as number, Buffer.from(p.data as string, 'base64')); return {}
        case 'close': await client.close(Buffer.from(p.handle as string, 'base64')); return {}
        case 'remove': await client.remove(p.path as string); return {}
        case 'hardlink': await client.hardlink(p.oldPath as string, p.newPath as string); return {}
        case 'fsync': await client.fsync(Buffer.from(p.handle as string, 'base64')); return {}
        case 'dispose': {
          state.sftp.delete(environmentId)
          await session.dispose().catch(() => {})
          return {}
        }
        default: throw new BrokerRefusal('unknown-method', 'unsupported SFTP operation')
      }
    } catch (error) {
      if (error instanceof SftpStatusError) throw new BrokerRefusal('sftp-status', `${error.code}:${error.message}`)
      if (error instanceof SftpConnectionLost) throw new BrokerRefusal('connection-lost', error.message)
      throw error
    }
  }

  private issueTicket(state: ConnectionState, environmentId: string, argv: readonly string[], generation: string, workspaceRoot: string): string {
    const now = Date.now()
    for (const [token, ticket] of state.tickets) if (ticket.expiresAt <= now) state.tickets.delete(token)
    if (state.tickets.size >= MAX_TICKETS) throw new BrokerRefusal('busy', 'too many live confinement tickets')
    const token = randomUUID()
    state.tickets.set(token, { argv: [...argv], environmentId, generation, workspaceRoot, expiresAt: now + TICKET_TTL_MS })
    return token
  }

  private consumeTicket(state: ConnectionState, environmentId: string, generation: string, p: Record<string, unknown>): void {
    const token = p.confinementToken as string
    const ticket = state.tickets.get(token)
    if (ticket === undefined) throw new BrokerRefusal('confinement-ticket-invalid', 'the confinement ticket is unknown or already consumed')
    const deny = (code: string, message: string): never => { state.tickets.delete(token); throw new BrokerRefusal(code, message) }
    if (ticket.expiresAt <= Date.now()) deny('confinement-ticket-expired', 'the confinement ticket expired')
    if (ticket.environmentId !== environmentId || ticket.generation !== generation) {
      deny('confinement-ticket-invalid', 'the confinement ticket does not name this environment and generation')
    }
    if (JSON.stringify(ticket.argv) !== JSON.stringify(p.argv)) {
      deny('confinement-ticket-argv', 'the spawn argv does not match the confined argv')
    }
    const cwd = (p.cwd as string).replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
    const root = ticket.workspaceRoot.replace(/\/+$/, '') || '/'
    if (!cwd.startsWith('/') || cwd.split('/').includes('..') || (root !== '/' && cwd !== root && !cwd.startsWith(`${root}/`))) {
      deny('confinement-ticket-cwd', 'the spawn cwd does not stay under the confined workspace root')
    }
    state.tickets.delete(token)
  }

  private async spawn(state: ConnectionState, environmentId: string, p: Record<string, unknown>): Promise<unknown> {
    if (state.processes.size >= MAX_PROCESSES) throw new BrokerRefusal('busy', 'too many remote processes')
    const environment = await this.openEnvironment(state, environmentId)
    if (environment.generation !== p.generation) {
      throw new BrokerRefusal('generation-changed', 'the remote connection changed since preparation')
    }
    this.consumeTicket(state, environmentId, environment.generation, p)
    for (const [key, value] of Object.entries((p.env ?? {}) as Record<string, string>)) {
      if (value !== '' && (key.startsWith('LD_') || key.startsWith('DYLD_') || key === 'NODE_OPTIONS' || key === 'NODE_PATH')) {
        throw new BrokerRefusal('confinement-ticket-env', `the remote profile refuses spawn env.${key}`)
      }
    }
    const stdoutLimit = p.stdoutLimit as number
    const stderrLimit = p.stderrLimit as number
    let handle: ProcessRecord['handle']
    try {
      handle = environment.subprocess.spawn({
        argv: p.argv as string[], cwd: p.cwd as string, env: p.env as Record<string, string>,
        // The SSH adapter already requests twice the declared result limit.
        stdio: { stdin: 'ignore', stdout: { maxBytes: stdoutLimit }, stderr: { maxBytes: stderrLimit } },
        graceMs: p.graceMs as number,
      }) as ProcessRecord['handle']
    } catch (error) {
      throw new BrokerRefusal('spawn-failed', error instanceof Error ? error.message : String(error))
    }
    const id = state.nextProcess++
    const record: ProcessRecord = { environmentId, handle, stdout: '', stderr: '', done: false, graceMs: p.graceMs as number }
    state.processes.set(id, record)
    void handle.done.then(async done => {
      record.done = true
      record.stdout = readCollected(handle.collected?.stdout)
      record.stderr = readCollected(handle.collected?.stderr)
      // The scope confirmation is observed here, while the broker still owns
      // the handle; the Host's later `wait` reads this recorded fact.
      const scope = await handle.waitForExit(AbortSignal.timeout(record.graceMs)).catch(() => false)
      record.scope = scope
      // Output is delivered on exit: the Host's contract only reads it then.
      if (state.closed) return
      if (record.stdout !== '') writeBrokerLine(state.channel, { event: 'stdout', process: id, data: Buffer.from(record.stdout).subarray(0, MAX_DATA).toString('base64') })
      if (record.stderr !== '') writeBrokerLine(state.channel, { event: 'stderr', process: id, data: Buffer.from(record.stderr).subarray(0, MAX_DATA).toString('base64') })
      writeBrokerLine(state.channel, {
        event: 'exit', process: id,
        exitCode: typeof done.exitCode === 'number' ? done.exitCode : null,
        signal: typeof done.signal === 'string' ? done.signal : null,
        scope,
      })
    }, error => {
      record.done = true
      if (!state.closed) writeBrokerLine(state.channel, { event: 'exit', process: id, exitCode: null, signal: 'BROKER-LOST', scope: false })
      this.options.logger?.warn(`dsh-ssh-broker: process ${id} lost: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { state.processes.delete(id) })
    return { process: id }
  }

  private process(state: ConnectionState, id: number): ProcessRecord {
    const process = state.processes.get(id)
    if (process === undefined) throw new BrokerRefusal('unknown-process', 'no such remote process')
    return process
  }

  private closeConnection(state: ConnectionState): void {
    if (state.closed) return
    state.closed = true
    state.channel.destroy()
    this.connections.delete(state)
    for (const [id, process] of state.processes) {
      try { process.handle.terminate() } catch { /* already gone */ }
      state.processes.delete(id)
    }
    for (const environmentId of state.sftp.keys()) void this.manager?.disposeSftp(environmentId).catch(() => {})
    state.sftp.clear()
    for (const environmentId of state.environments.keys()) void this.manager?.dispose(environmentId).catch(() => {})
    state.environments.clear()
    state.tickets.clear()
  }

  /**
   * Validate the audit sink before serving: if a file already sits at
   * `auditPath` it must be the broker's own regular file (a planted symlink
   * would point `appendFileSync` wherever the broker can write), and its
   * current size seeds the rotation budget.
   */
  private prepareAuditFile(): void {
    if (this.options.auditPath === undefined) return
    let entry
    try { entry = lstatSync(this.options.auditPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.auditSize = 0; return }
      throw new BrokerRefusal('unsafe-audit-file', `the audit file is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid!()) {
      throw new BrokerRefusal('unsafe-audit-file', `${this.options.auditPath} must be a real file owned by the broker account`)
    }
    if ((entry.mode & 0o077) !== 0) chmodSync(this.options.auditPath, 0o600)
    this.auditSize = entry.size
  }

  /** Rotate `audit` → `audit.1`, shifting `audit.N` → `audit.N+1` and dropping the oldest. */
  private rotateAudit(path: string, keep: number): void {
    for (let index = keep; index > 1; index--) {
      try { renameSync(`${path}.${index - 1}`, `${path}.${index}`) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try { renameSync(path, `${path}.1`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.auditSize = 0
  }

  private audit(state: ConnectionState, method: BrokerMethod | 'protocol', outcome: string, environmentId?: string): void {
    if (this.options.auditPath === undefined) return
    const line = JSON.stringify({
      time: new Date().toISOString(), connection: state.id, method,
      ...(environmentId === undefined ? {} : { environment: environmentId }),
      outcome,
    }) + '\n'
    const bytes = Buffer.byteLength(line)
    const max = this.options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES
    try {
      if (this.auditSize + bytes > max) this.rotateAudit(this.options.auditPath, this.options.auditKeep ?? DEFAULT_AUDIT_KEEP)
      appendFileSync(this.options.auditPath, line, { mode: 0o600 })
      this.auditSize += bytes
    } catch (error) {
      this.options.logger?.warn(`dsh-ssh-broker: audit write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function readCollected(stream: Collected | undefined): string {
  if (stream === undefined) return ''
  return stream.readFrom(0)?.text ?? ''
}

function codeOf(error: unknown): string {
  if (typeof (error as { code?: unknown })?.code === 'string') return (error as { code: string }).code
  return 'broker-failed'
}
