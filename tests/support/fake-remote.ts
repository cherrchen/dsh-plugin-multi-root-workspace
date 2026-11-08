/**
 * A bounded in-memory remote for the G5 headless composition: one SFTP
 * endpoint and (optionally) one exec endpoint per environment, sharing a
 * per-environment file table so a build can consume what a copy delivered and
 * a later copy can relay the artifact.
 *
 * This is a controllable backend, not a fake of our own code: admission,
 * binding checks, staging, hashing, publication and the two-admission command
 * contract all run for real — only the wire to a remote host is replaced.
 */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { SftpClient } from '../../src/remote/sftp.ts'
import { SftpStatusError } from '../../src/remote/sftp.ts'
import type { DeploymentManifest, RemoteEnvironment } from '../../src/remote/manifest.ts'
import type { RemoteExecutionBackend, RemoteExecDeployment, RemoteProcessHandle } from '../../src/remote/exec.ts'
import type { RemoteToolsManager } from '../../src/remote/tools.ts'
import type { SshEnvironment, SftpEnvironment } from '../../src/remote/ssh-environment.ts'

const P_WRITE = 0x02, P_CREAT = 0x08, P_EXCL = 0x20
const NO_SUCH_FILE = 2, FAILURE = 4

interface FakeFile { data: Buffer; mtime: number; permissions: number }

/** One remote host: a path-keyed file table and an optional shell. */
export class FakeRemote {
  readonly generation = randomUUID()
  readonly files = new Map<string, FakeFile>()
  readonly sftpCalls: string[] = []
  readonly execCalls: { argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }[] = []
  private tick = 1_700_000_000

  constructor(readonly environmentId: string) {}

  /** Seed a directory; every ancestor of a seeded path must exist. */
  directory(path: string): void { this.files.set(path, { data: Buffer.alloc(0), mtime: ++this.tick, permissions: 0o040755 }) }

  seed(path: string, data: Buffer | string): void {
    this.directory(posix.dirname(path))
    this.files.set(path, { data: Buffer.from(data), mtime: ++this.tick, permissions: 0o100644 })
  }

  read(path: string): Buffer | undefined { return this.files.get(path)?.data }
  sha256(path: string): string | undefined {
    const file = this.files.get(path)
    return file === undefined || (file.permissions & 0o170000) !== 0o100000 ? undefined : createHash('sha256').update(file.data).digest('hex')
  }

  private attrs(path: string) {
    const file = this.files.get(path)
    if (file === undefined) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
    return { flags: (file.permissions & 0o170000) === 0o040000 ? 2 : 5, size: file.data.length, permissions: file.permissions, mtime: file.mtime }
  }

  /** The SFTP v3 subset the transfer pipeline uses. */
  readonly sftp = {
    realpath: async (path: string) => { this.sftpCalls.push(`realpath ${path}`); return path },
    lstat: async (path: string) => { this.sftpCalls.push(`lstat ${path}`); return this.attrs(path) },
    open: async (path: string, flags: number) => {
      this.sftpCalls.push(`open ${path} ${flags}`)
      const exists = this.files.has(path)
      if ((flags & P_EXCL) !== 0 && exists) throw new SftpStatusError(FAILURE, 'Failure')
      if ((flags & P_CREAT) !== 0 && !exists) this.seed(path, Buffer.alloc(0))
      if (!this.files.has(path)) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
      if ((flags & (P_WRITE | P_CREAT)) !== 0) this.files.set(path, { ...this.files.get(path)!, mtime: ++this.tick })
      return Buffer.from(path)
    },
    write: async (handle: Buffer, offset: number, data: Buffer) => {
      const path = handle.toString(), file = this.files.get(path)
      if (file === undefined) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
      const grown = Buffer.alloc(Math.max(file.data.length, offset + data.length))
      file.data.copy(grown); data.copy(grown, offset)
      this.files.set(path, { ...file, data: grown, mtime: ++this.tick })
    },
    read: async (handle: Buffer, offset: number, length: number) => {
      const file = this.files.get(handle.toString())
      if (file === undefined) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
      return file.data.subarray(offset, offset + length)
    },
    fsync: async () => {},
    close: async () => {},
    remove: async (path: string) => {
      this.sftpCalls.push(`remove ${path}`)
      if (!this.files.delete(path)) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
    },
    hardlink: async (oldPath: string, newPath: string) => {
      this.sftpCalls.push(`hardlink ${oldPath} ${newPath}`)
      if (this.files.has(newPath)) throw new SftpStatusError(FAILURE, 'Failure')
      const file = this.files.get(oldPath)
      if (file === undefined) throw new SftpStatusError(NO_SUCH_FILE, 'No such file')
      this.files.set(newPath, { ...file })
    },
  }

  client(): SftpClient { return this.sftp as unknown as SftpClient }

  /**
   * The helper handshake the endpoint verifier probes: one confined
   * `node -e` stat of the binding path, answered from this remote's table.
   * The dev/ino identity is synthetic but stable for the lifetime of the fake.
   */
  helper(): SshEnvironment {
    const remote = this
    const identity = { dev: '41', ino: String(7 + this.environmentId.length) }
    return {
      environmentId: this.environmentId,
      generation: this.generation,
      hello: { platform: 'linux', workspace: '/srv/root', executable: '/opt/node/bin/node', protocol: 1 },
      fs: {},
      sandbox: { async confine(argv: readonly string[]) { return { argv, enforcement: 'full' } } },
      subprocess: {
        spawn(spec: unknown) {
          const input = spec as { argv: readonly string[]; cwd?: string; stdio?: { stdout?: { maxBytes?: number }; stderr?: { maxBytes?: number } } }
          const argv = input.argv
          let collected = { stdout: '', stderr: '' }
          // A shell command goes through the same grammar the exec backend
          // understands; anything else is the verifier's node stat probe.
          const command = argv.length >= 3 && argv[argv.length - 2] === '-c' ? argv[argv.length - 1]! : undefined
          if (command !== undefined) {
            remote.execCalls.push({ argv: [...argv], cwd: input.cwd ?? '', env: {} })
          }
          const done = Promise.resolve().then(() => {
            if (command !== undefined) {
              const run = COMMANDS[command]
              if (run === undefined) {
                collected = { stdout: '', stderr: `fake shell: unsupported command ${JSON.stringify(command)}\n` }
                return { exitCode: 127, signal: null }
              }
              const result = run(remote, input.cwd ?? '')
              collected = { stdout: result.stdout, stderr: '' }
              return { exitCode: result.exitCode, signal: null }
            }
            const path = argv[argv.length - 1] ?? ''
            const file = remote.files.get(path)
            collected = {
              stdout: JSON.stringify({
                real: path, dev: identity.dev, ino: identity.ino,
                isDirectory: file !== undefined && (file.permissions & 0o170000) === 0o040000,
              }),
              stderr: '',
            }
            return { exitCode: 0, signal: null }
          })
          return {
            done,
            waitForExit: async () => true,
            terminate: () => {},
            collected: {
              get stdout() { return { readFrom: () => ({ text: collected.stdout }) } },
              get stderr() { return { readFrom: () => ({ text: collected.stderr }) } },
            },
          }
        },
      },
      dispose: async () => {},
    }
  }
}

/** The exec grammar this fake understands; anything else exits 127. */
const COMMANDS: Record<string, (remote: FakeRemote, cwd: string) => { stdout: string; exitCode: number }> = {
  // The build consumes the two delivered sources and produces one artifact.
  'build app': (remote, cwd) => {
    const a = remote.read(posix.join(cwd, 'src/a.txt')), b = remote.read(posix.join(cwd, 'src/b.txt'))
    if (a === undefined || b === undefined) return { stdout: '', exitCode: 2 }
    remote.seed(posix.join(cwd, 'dist/app.tar'), Buffer.concat([Buffer.from('app\n'), a, Buffer.from('--\n'), b]))
    return { stdout: 'built app\n', exitCode: 0 }
  },
  'test app': (remote, cwd) => {
    const artifact = remote.read(posix.join(cwd, 'dist/app.tar'))
    return artifact === undefined ? { stdout: '', exitCode: 2 } : { stdout: `artifact ${artifact.length} bytes\n`, exitCode: 0 }
  },
}

/** One controllable execution backend, sharing the remote's file table. */
export function fakeExecBackend(remote: FakeRemote, deployment: RemoteExecDeployment): RemoteExecutionBackend {
  return {
    deployment,
    async confine(argv, _policy, _signal) { return { argv, enforcement: 'full' as const, generation: remote.generation } },
    currentGeneration: () => remote.generation,
    spawn(argv, options, sink) {
      remote.execCalls.push({ argv: [...argv], cwd: options.cwd, env: options.env })
      const command = argv[argv.length - 1] ?? ''
      const run = COMMANDS[command]
      const exited = Promise.resolve().then(() => {
        if (run === undefined) { sink.stderr(new TextEncoder().encode(`fake shell: unsupported command ${JSON.stringify(command)}\n`)); return { exitCode: 127, signal: null } }
        const result = run(remote, options.cwd)
        if (result.stdout !== '') sink.stdout(new TextEncoder().encode(result.stdout))
        return { exitCode: result.exitCode, signal: null }
      })
      return { started: Promise.resolve(), exited, terminate: () => {}, waitForExit: async () => true } satisfies RemoteProcessHandle
    },
  }
}

/** The manager the tools row sees: deployment plus per-environment openings. */
export class FakeManager implements RemoteToolsManager {
  constructor(
    readonly deployment: DeploymentManifest,
    private readonly remotes: ReadonlyMap<string, FakeRemote>,
    private readonly backends: ReadonlyMap<string, RemoteExecutionBackend>,
  ) {}

  private remote(environmentId: string): FakeRemote {
    const remote = this.remotes.get(environmentId)
    if (remote === undefined) throw new Error(`no fake remote "${environmentId}"`)
    return remote
  }

  async openSftp(environmentId: string): Promise<SftpEnvironment> {
    const remote = this.remote(environmentId)
    return {
      environmentId, generation: remote.generation, client: remote.client(),
      version: { version: 3, extensions: { 'hardlink@openssh.com': '1', 'fsync@openssh.com': '1' } },
      dispose: async () => {},
    }
  }
  sftpGenerationOf(environmentId: string): string { return this.remotes.get(environmentId)?.generation ?? 'stale' }
  generationOf(environmentId: string): string { return this.remotes.get(environmentId)?.generation ?? 'stale' }
  async open(environmentId: string): Promise<SshEnvironment> { return this.remote(environmentId).helper() }
  async disposeAll(): Promise<void> {}
  backend(environmentId: string): RemoteExecutionBackend | undefined { return this.backends.get(environmentId) }
}

/** The exec stanza the fake build machine advertises. */
export const FAKE_EXEC: RemoteExecDeployment = {
  shell: ['/bin/sh', '-c'], env: { PATH: '/bin' }, maxTimeoutMs: 60_000,
  stdoutLimit: 8 * 1024, stderrLimit: 8 * 1024, terminateGraceMs: 10,
}

/** A manifest fixture: build (helper + exec + transfer) and device (sftp + transfer). */
export function fakeManifest(options: {
  primary: string
  buildPath?: string
  devicePath?: string
  localRootIds?: readonly string[]
  /** Device binding actions; default `['read','write']` (a transfer-only device). */
  deviceActions?: readonly ('read' | 'write' | 'exec')[]
}): DeploymentManifest {
  const buildPath = options.buildPath ?? '/srv/root'
  const devicePath = options.devicePath ?? '/srv/root'
  const localRootIds = options.localRootIds ?? ['primary']
  const helper = {
    environmentId: 'build', displayName: 'build machine', platform: 'linux', account: 'builder',
    hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'build', transport: 'helper' as const,
    helper: { sha256: 'b'.repeat(64), protocol: 1 },
    connection: { host: 'build-host', nodePath: '/opt/node', helperPath: '/opt/helper.js', workspace: buildPath },
    exec: { shell: ['/bin/sh', '-c'], env: { PATH: '/bin' }, maxTimeoutMs: 60_000, stdoutLimit: 8 * 1024, stderrLimit: 8 * 1024, terminateGraceMs: 10 },
    transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000 },
    credentialIsolation: 'unattested' as const,
  }
  const device = {
    environmentId: 'device', displayName: 'device', platform: 'linux', account: 'deploy',
    hostKey: `SHA256:${'C'.repeat(43)}`, namespace: 'device', transport: 'sftp' as const,
    helper: null, connection: { host: 'device-host' },
    transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000 },
    credentialIsolation: 'unattested' as const,
  }
  return {
    schemaVersion: 1, configVersion: 'cfg-g5',
    environments: [helper as RemoteEnvironment, device as RemoteEnvironment],
    bindings: [
      {
        primary: options.primary, environmentId: 'build', rootId: 'app', path: buildPath,
        actions: ['read', 'write', 'exec'],
        transfers: [
          ...localRootIds.map(rootId => ({ direction: 'import' as const, peer: { environmentId: 'local', rootId } })),
          ...localRootIds.map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local', rootId } })),
          { direction: 'export' as const, peer: { environmentId: 'device', rootId: 'out' } },
        ],
      },
      {
        primary: options.primary, environmentId: 'device', rootId: 'out', path: devicePath,
        actions: [...(options.deviceActions ?? ['read', 'write'])],
        transfers: [
          { direction: 'import' as const, peer: { environmentId: 'build', rootId: 'app' } },
          ...localRootIds.map(rootId => ({ direction: 'export' as const, peer: { environmentId: 'local', rootId } })),
        ],
      },
    ],
  }
}
