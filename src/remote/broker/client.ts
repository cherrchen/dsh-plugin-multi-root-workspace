/**
 * Host-side client of the credential broker (ADR-0036).
 *
 * `BrokerConnection` speaks the bounded protocol over the kernel-attested
 * socket; `BrokerEnvironmentManager` exposes the same structural surface as
 * the in-process `SshEnvironmentManager`, so the transfer pipeline, the
 * endpoint verifier and the two-admission command contract are unchanged.
 * The credentials never enter this process: every operation is a request the
 * broker performs under its own account.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-broker/client
 */
import type { Channel } from '../../authority/native.ts'
import { connectNative } from '../../authority/native.ts'
import type { DeploymentManifest } from '../manifest.ts'
import type { SshEnvironment, SftpEnvironment } from '../ssh-environment.ts'
import type { SftpClient, SftpVersion } from '../sftp.ts'
import { SftpConnectionLost, SftpStatusError } from '../sftp.ts'
import { RemoteConnectionLost, type RemoteProcessHandle } from '../exec.ts'
import type { RemoteToolsManager } from '../tools.ts'
import {
  BrokerError,
  decodeData,
  encodeData,
  parseBrokerEvent,
  parseBrokerReply,
  readBrokerLines,
  writeBrokerLine,
  type BrokerMethod,
} from './protocol.ts'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface ProcessListeners {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly exit: (exitCode: number | null, signal: string | null, scope: boolean) => void
  readonly lost: (error: Error) => void
}

/** One event that arrived before the client registered its process listener. */
type OrphanEvent =
  | { readonly kind: 'stdout' | 'stderr'; readonly text: string }
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly signal: string | null; readonly scope: boolean }

/** One authenticated broker connection. */
export class BrokerConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly processes = new Map<number, ProcessListeners>()
  /** Events for a process id whose listener has not been registered yet. */
  private readonly orphans = new Map<number, OrphanEvent[]>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false
  hello: { readonly protocol: 1; readonly brokerUid: number; readonly environmentIds: readonly string[] } | undefined

  private constructor(
    private readonly channel: Channel,
    private readonly expectedBrokerUid: number,
  ) {}

  /**
   * Connect and read the required hello.
   * @param socketPath - the broker's Unix socket.
   * @param expectedBrokerUid - the uid the broker must report.
   * @param timeoutMs - handshake budget.
   * @returns the ready connection.
   * @throws {BrokerError} when peer authentication, the hello, or the protocol fails.
   */
  static async connect(socketPath: string, expectedBrokerUid: number, timeoutMs = 5_000): Promise<BrokerConnection> {
    // The expected uid is the dedicated broker account. Its confinement state
    // is the deployment's business (a launchd/systemd unit may set
    // NoNewPrivileges); only the uid is meaningful on this side. The BROKER's
    // own peer check is the one that must refuse restricted clients.
    const channel = await connectNative(socketPath, { expectedUid: expectedBrokerUid, allowRestricted: true })
    const connection = new BrokerConnection(channel, expectedBrokerUid)
    channel.on('close', () => connection.lose(new BrokerError('broker-disconnected', 'the broker connection closed')))
    channel.on('error', () => channel.destroy())
    const hello = Promise.withResolvers<void>()
    const timer = setTimeout(() => hello.reject(new BrokerError('broker-timeout', 'the broker did not send its hello')), timeoutMs)
    readBrokerLines(channel, value => {
      try {
        if (typeof value === 'object' && value !== null && 'event' in value) {
          const event = parseBrokerEvent(value)
          if (event.event === 'hello') {
            if (event.protocol !== 1) throw new BrokerError('protocol-mismatch', 'the broker speaks a different protocol')
            if (event.brokerUid !== expectedBrokerUid) throw new BrokerError('broker-uid-mismatch', 'the broker runs under an unexpected uid')
            connection.hello = { protocol: 1, brokerUid: event.brokerUid, environmentIds: [...event.environmentIds] }
            clearTimeout(timer)
            hello.resolve()
            return
          }
          connection.deliver(event)
          return
        }
        const reply = parseBrokerReply(value)
        const request = connection.pending.get(reply.id)
        if (request === undefined) return
        connection.pending.delete(reply.id)
        clearTimeout(request.timer)
        if (reply.ok) request.resolve(reply.value)
        else request.reject(new BrokerError(reply.code, reply.message))
      } catch (error) {
        connection.lose(error instanceof Error ? error : new Error(String(error)))
        channel.destroy()
      }
    }, error => { connection.lose(error); channel.destroy() })
    try {
      await hello.promise
    } catch (error) {
      clearTimeout(timer)
      connection.close()
      throw error
    }
    return connection
  }

  /** Throws when the connection is closed — the `assertOpen` peer of upstream. */
  assertOpen(): void {
    if (this.closed) throw new BrokerError('broker-disconnected', 'the broker connection is closed')
  }

  /** Send one request and wait for its reply. */
  request<T = unknown>(method: BrokerMethod, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new BrokerError('broker-disconnected', 'the broker connection is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrokerError('broker-timeout', `the broker did not answer ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      if (!writeBrokerLine(this.channel, { protocol: 1, id, method, params })) {
        clearTimeout(timer); this.pending.delete(id)
        reject(new BrokerError('broker-disconnected', 'the broker connection could not queue the request'))
      }
    })
  }

  /** Register process event handlers; replays events that arrived first. */
  watchProcess(id: number, listeners: ProcessListeners): () => void {
    this.processes.set(id, listeners)
    for (const event of this.orphans.get(id) ?? []) {
      if (event.kind === 'exit') listeners.exit(event.exitCode, event.signal, event.scope)
      else if (event.kind === 'stdout') listeners.stdout(event.text)
      else listeners.stderr(event.text)
    }
    this.orphans.delete(id)
    return () => { this.processes.delete(id) }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  close(): void {
    this.lose(new BrokerError('broker-disconnected', 'the broker connection was closed'))
    this.channel.destroy()
  }

  private deliver(event: ReturnType<typeof parseBrokerEvent>): void {
    if (event.event === 'hello') return
    const listeners = this.processes.get(event.process)
    const stdout = event.event === 'stdout' ? decodeData(event.data).toString('utf8')
      : event.event === 'stderr' ? decodeData(event.data).toString('utf8') : undefined
    if (listeners === undefined) {
      // A fast command can finish before the spawn reply is processed. Buffer
      // its events (bounded) and replay them when the listener registers.
      const orphans = this.orphans.get(event.process) ?? []
      if (event.event === 'exit') {
        orphans.push({ kind: 'exit', exitCode: event.exitCode, signal: event.signal === 'BROKER-LOST' ? null : event.signal, scope: event.scope })
      } else if (stdout !== undefined) {
        const bytes = Buffer.byteLength(stdout)
        if (orphans.reduce((sum, entry) => sum + ('text' in entry ? Buffer.byteLength(entry.text) : 0), 0) + bytes > 2 * 1024 * 1024) return
        orphans.push({ kind: event.event, text: stdout })
      }
      this.orphans.set(event.process, orphans)
      return
    }
    if (event.event === 'exit') {
      this.processes.delete(event.process)
      listeners.exit(event.exitCode, event.signal === 'BROKER-LOST' ? null : event.signal, event.scope)
      return
    }
    if (stdout !== undefined) listeners[event.event](stdout)
  }

  private lose(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
    for (const listeners of this.processes.values()) listeners.lost(new RemoteConnectionLost(error.message))
    this.processes.clear()
    this.orphans.clear()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear()
  }
}

/** The SFTP surface the transfer pipeline and the verifier consume. */
class BrokerSftp {
  private readonly version: SftpVersion
  constructor(
    private readonly connection: BrokerConnection,
    readonly environmentId: string,
    version: SftpVersion,
  ) { this.version = version }

  get negotiated(): SftpVersion { return this.version }
  async init(): Promise<SftpVersion> { return this.version }
  private call<T>(op: string, params: Record<string, unknown>): Promise<T> {
    return this.connection.request<T>('sftp', { environmentId: this.environmentId, op, ...params }, 60_000)
      .catch((error: unknown) => {
        // The wire flattens SFTP errors into refusal codes: `sftp-status`
        // carries `${SSH_FX_code}:${text}` and `connection-lost` the lost
        // session. Reconstruct the typed errors so the transfer layer's
        // `instanceof` branches keep their direct-path semantics.
        if (error instanceof BrokerError && error.code === 'sftp-status') {
          const match = /^(\d+):([\s\S]*)$/.exec(error.message)
          if (match !== null) throw new SftpStatusError(Number(match[1]), match[2]!)
        }
        if (error instanceof BrokerError && error.code === 'connection-lost') throw new SftpConnectionLost(error.message)
        throw error
      })
  }
  async realpath(path: string): Promise<string> { return (await this.call<{ path: string }>('realpath', { path })).path }
  async lstat(path: string) { return await this.call<{ flags: number; size?: number; permissions?: number; mtime?: number }>('lstat', { path }) }
  async open(path: string, flags: number, permissions?: number): Promise<Buffer> {
    const value = await this.call<{ handle: string }>('open', permissions === undefined ? { path, flags } : { path, flags, permissions })
    return Buffer.from(value.handle, 'base64')
  }
  async read(handle: Buffer, offset: number | bigint, length: number): Promise<Buffer> {
    const value = await this.call<{ data: string }>('read', { handle: encodeData(handle), offset: Number(offset), length })
    return Buffer.from(value.data, 'base64')
  }
  async write(handle: Buffer, offset: number | bigint, data: Buffer | Uint8Array): Promise<void> {
    await this.call('write', { handle: encodeData(handle), offset: Number(offset), data: encodeData(Buffer.from(data)) })
  }
  async close(handle: Buffer): Promise<void> { await this.call('close', { handle: encodeData(handle) }) }
  async remove(path: string): Promise<void> { await this.call('remove', { path }) }
  async hardlink(oldPath: string, newPath: string): Promise<void> { await this.call('hardlink', { oldPath, newPath }) }
  async fsync(handle: Buffer): Promise<void> { await this.call('fsync', { handle: encodeData(handle) }) }
  dispose(): void { void this.connection.request('sftp', { environmentId: this.environmentId, op: 'dispose' }).catch(() => {}) }
}

/** A broker-backed environment/connection manager with the SSH manager's surface. */
export class BrokerEnvironmentManager implements RemoteToolsManager {
  private readonly sftp = new Map<string, SftpEnvironment>()
  private readonly environments = new Map<string, SshEnvironment>()
  private readonly generations = new Map<string, string>()
  private readonly sftpGenerations = new Map<string, string>()

  constructor(
    readonly deployment: DeploymentManifest,
    private readonly connection: BrokerConnection,
  ) {
    connection.onClose(() => {
      // Every open environment is gone with the connection; the Host reports
      // unknown and reconnects only through a fresh attestation.
      this.sftp.clear()
      this.environments.clear()
      this.generations.clear()
      this.sftpGenerations.clear()
    })
  }

  async openSftp(environmentId: string): Promise<SftpEnvironment> {
    const existing = this.sftp.get(environmentId)
    if (existing !== undefined) return existing
    const opened = await this.connection.request<{ generation: string; version: SftpVersion }>('openSftp', { environmentId })
    const client = new BrokerSftp(this.connection, environmentId, opened.version) as unknown as SftpClient
    const environment: SftpEnvironment = {
      environmentId,
      generation: opened.generation,
      client,
      version: opened.version,
      dispose: async () => {
        this.sftp.delete(environmentId)
        await this.connection.request('sftp', { environmentId, op: 'dispose' }).catch(() => {})
      },
    }
    this.sftp.set(environmentId, environment)
    this.sftpGenerations.set(environmentId, opened.generation)
    return environment
  }

  sftpGenerationOf(environmentId: string): string { return this.sftpGenerations.get(environmentId) ?? 'stale' }

  async open(environmentId: string): Promise<SshEnvironment> {
    const existing = this.environments.get(environmentId)
    if (existing !== undefined) return existing
    const opened = await this.connection.request<{ generation: string; hello: Readonly<Record<string, unknown>> }>('open', { environmentId })
    const environment = {
      environmentId,
      generation: opened.generation,
      hello: opened.hello,
      fs: {},
      sandbox: {
        confine: async (argv: readonly string[], policy: unknown, signal?: AbortSignal) => {
          const confined = await this.connection.request<{ argv: readonly string[]; enforcement: string; generation: string }>(
            'confine', { environmentId, argv: [...argv], policy }, 60_000,
          )
          if (signal?.aborted) throw new Error('confine cancelled')
          return { argv: confined.argv, enforcement: confined.enforcement }
        },
      },
      subprocess: {
        spawn: (spec: unknown) => this.spawn(environmentId, spec),
      },
      assertAlive: () => this.connection.assertOpen(),
      dispose: async () => {
        this.environments.delete(environmentId)
        this.generations.delete(environmentId)
        await this.connection.request('dispose', { environmentId }).catch(() => {})
      },
    } as unknown as SshEnvironment
    this.environments.set(environmentId, environment)
    this.generations.set(environmentId, opened.generation)
    return environment
  }

  generationOf(environmentId: string): string { return this.generations.get(environmentId) ?? 'stale' }

  markStale(environmentId: string): void {
    this.environments.delete(environmentId)
    this.generations.delete(environmentId)
    this.sftp.delete(environmentId)
    this.sftpGenerations.delete(environmentId)
    void this.connection.request('dispose', { environmentId }).catch(() => {})
  }

  async disposeAll(): Promise<void> {
    for (const environmentId of [...this.environments.keys(), ...this.sftp.keys()]) {
      await this.connection.request('dispose', { environmentId }).catch(() => {})
    }
    this.environments.clear()
    this.sftp.clear()
    this.generations.clear()
    this.sftpGenerations.clear()
    this.connection.close()
  }

  /**
   * One remote process over the broker. Output is collected by the broker and
   * delivered on exit; the Host's sink decides truncation.
   */
  private spawn(environmentId: string, spec: unknown): RemoteProcessHandle & {
    /** The official handle's exit promise; the verifier awaits this name. */
    done: Promise<{ exitCode: number | null; signal: string | null }>
    collected?: { stdout?: { readFrom(offset: number): { text: string } | undefined }; stderr?: { readFrom(offset: number): { text: string } | undefined } }
  } {
    const input = spec as { argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; stdio: { stdout?: { maxBytes?: number }; stderr?: { maxBytes?: number } }; graceMs?: number }
    const generation = this.generationOf(environmentId)
    const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null; scope: boolean }>()
    let stdout = ''
    let stderr = ''
    let terminated = false
    const id = Promise.withResolvers<number>()
    void this.connection.request<{ process: number }>('spawn', {
      environmentId,
      argv: [...input.argv],
      cwd: input.cwd,
      env: { ...input.env },
      stdoutLimit: input.stdio?.stdout?.maxBytes ?? 65_536,
      stderrLimit: input.stdio?.stderr?.maxBytes ?? 65_536,
      graceMs: input.graceMs ?? 0,
      generation,
    }, 60_000).then(value => {
      id.resolve(value.process)
      this.connection.watchProcess(value.process, {
        stdout: text => { stdout += text },
        stderr: text => { stderr += text },
        exit: (exitCode, signal, scope) => exit.resolve({ exitCode, signal, scope }),
        lost: error => exit.reject(error),
      })
    }, error => {
      id.reject(error)
      exit.reject(error)
    })
    return {
      started: id.promise.then(() => undefined),
      // `done` is the official handle's name (the verifier awaits it); the
      // exec adapter uses `exited`. Both observe the same exit event.
      done: exit.promise,
      exited: exit.promise,
      terminate: () => {
        if (terminated) return
        terminated = true
        void id.promise.then(process => this.connection.request('terminate', { process }).catch(() => {}), () => {})
      },
      waitForExit: async (timeoutMs: number) => {
        // The caller asks AFTER `exited` settles; the broker recorded the
        // scope confirmation in the exit event. Fall back to a live wait only
        // if the event has not arrived yet.
        const settled = await new Promise<{ scope: boolean } | undefined>(resolve => {
          const timer = setTimeout(() => resolve(undefined), Math.max(0, Math.min(timeoutMs, 60_000)))
          void exit.promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
        })
        if (settled !== undefined) return settled.scope
        try {
          const process = await id.promise
          const value = await this.connection.request<{ confirmed: boolean }>('wait', { process, timeoutMs: Math.max(0, Math.min(timeoutMs, 60_000)) }).catch(() => ({ confirmed: false }))
          return value.confirmed
        } catch { return false }
      },
      collected: {
        stdout: { readFrom: (offset: number) => offset >= stdout.length ? undefined : { text: stdout.slice(offset) } },
        stderr: { readFrom: (offset: number) => offset >= stderr.length ? undefined : { text: stderr.slice(offset) } },
      },
    }
  }
}
