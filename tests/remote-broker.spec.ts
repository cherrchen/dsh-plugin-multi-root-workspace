/**
 * The credential broker's local interface (ADR-0039): framing and bounds,
 * same-uid refusal, kernel peer authentication, the SFTP/exec proxies over a
 * real socket, and the attestation failures that keep the remote tools
 * unmounted. The success path of attestation needs a real second OS account
 * and is a deployment test, not this suite.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { fakeExecBackend, FakeManager, FakeRemote, fakeManifest, FAKE_EXEC } from './support/fake-remote.ts'
import { attestBroker, type BrokerConfig } from '../src/remote/broker/attest.ts'
import { BrokerConnection, BrokerEnvironmentManager } from '../src/remote/broker/client.ts'
import { BROKER_PROTOCOL, encodeData, MAX_COMMAND_OUTPUT, MAX_DATA, parseBrokerEvent, parseBrokerRequest } from '../src/remote/broker/protocol.ts'
import { BrokerServer } from '../src/remote/broker/server.ts'
import { manifestDigest, type DeploymentManifest } from '../src/remote/manifest.ts'
import type { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { P_CREAT, P_EXCL, P_WRITE } from '../src/remote/sftp.ts'

const fakeStats = vi.hoisted(() => new Map<string, { uid: number; mode: number; kind: 'file' | 'dir' | 'socket' | 'link' }>())
const fakeAccess = vi.hoisted(() => new Map<string, string | null>())
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    lstatSync: (path: string, options?: unknown) => {
      const fake = fakeStats.get(String(path))
      if (fake === undefined) return real.lstatSync(path, options as never)
      return {
        uid: fake.uid, mode: fake.mode,
        isSymbolicLink: () => fake.kind === 'link',
        isFile: () => fake.kind === 'file',
        isDirectory: () => fake.kind === 'dir',
        isSocket: () => fake.kind === 'socket',
      }
    },
    accessSync: (path: string, mode?: unknown) => {
      const verdict = fakeAccess.get(String(path))
      if (verdict === undefined) { real.accessSync(path, mode as never); return }
      if (verdict !== null) throw Object.assign(new Error(`mocked ${verdict}`), { code: verdict })
    },
  }
})

const fakeConnections = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../src/remote/broker/client.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/remote/broker/client.ts')>()
  const realConnect = real.BrokerConnection.connect
  const MockConnection = function () { throw new Error('the mock connection is not instantiable') } as unknown as typeof real.BrokerConnection
  Object.setPrototypeOf(MockConnection, real.BrokerConnection)
  Object.setPrototypeOf(MockConnection.prototype, real.BrokerConnection.prototype)
  ;(MockConnection as unknown as { connect: typeof realConnect }).connect = (...args: Parameters<typeof realConnect>) => {
    const fake = fakeConnections.get(String(args[0]))
    if (fake !== undefined) return fake as ReturnType<typeof realConnect>
    return realConnect(...args)
  }
  return { ...real, BrokerConnection: MockConnection }
})

const uid = process.getuid?.() ?? -1
const POSIX = process.platform !== 'win32' && uid >= 0

let base: string
let socketPath: string
let build: FakeRemote
let manager: FakeManager
let server: BrokerServer | undefined
let connection: BrokerConnection | undefined

function startOptions(path: string, overrides: Record<string, unknown> = {}) {
  return {
    socketPath: path,
    clientUid: uid,
    allowSameUidForTesting: true,
    allowRestrictedForTesting: true,
    manager: manager as unknown as SshEnvironmentManager,
    ...overrides,
  }
}

beforeEach(() => {
  base = mkdtempSync('/tmp/dsh-broker-test-')
  socketPath = join(base, 'b.sock')
  build = new FakeRemote('build')
  build.directory('/srv/root')
  build.directory('/srv/root/src')
  build.directory('/srv/root/dist')
  build.seed('/srv/root/src/a.txt', 'a')
  build.seed('/srv/root/src/b.txt', 'b')
  const remotes = new Map([['build', build], ['device', new FakeRemote('device')]])
  const backends = new Map([['build', fakeExecBackend(build, FAKE_EXEC)]])
  manager = new FakeManager(fakeManifest({ primary: '/tmp/primary' }), remotes, backends)
})

afterEach(async () => {
  connection?.close()
  connection = undefined
  await server?.stop().catch(() => {})
  server = undefined
  rmSync(base, { recursive: true, force: true })
})

async function started(path = socketPath): Promise<BrokerServer> {
  const instance = new BrokerServer(startOptions(path))
  await instance.start()
  return instance
}

describe.skipIf(!POSIX)('the credential broker boundary', () => {
  it('refuses to start under the trusted Host uid in production mode', async () => {
    const instance = new BrokerServer({ socketPath, clientUid: uid, manager: manager as unknown as SshEnvironmentManager })
    await expect(instance.start()).rejects.toThrow(/account other than the trusted Host user/)
  })

  it('refuses a world-accessible socket directory', async () => {
    chmodSync(base, 0o755)
    const instance = new BrokerServer(startOptions(socketPath, { allowRestrictedForTesting: undefined }))
    await expect(instance.start()).rejects.toThrow(/world-accessible/)
  })

  it('rejects a sandboxed peer when restricted peers are not allowed', async () => {
    const strictPath = join(base, 'strict.sock')
    server = new BrokerServer(startOptions(strictPath, { allowRestrictedForTesting: undefined }))
    await server.start()
    // This suite runs inside the DSH sandbox; the native peer check must
    // refuse it exactly as it refuses an Agent-spawned client. An unsandboxed
    // CI host cannot demonstrate the negative and skips it.
    const availability = await nativeHostAvailability()
    if (availability.available) return
    await expect(BrokerConnection.connect(join(base, 'strict.sock'), uid, 2_000)).rejects.toThrow()
  })

  it('serves the SFTP primitives the transfer pipeline needs', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const sftp = await broker.openSftp('build')
    const handle = await sftp.client.open('/srv/root/probe.bin', P_WRITE | P_CREAT | P_EXCL, 0o600)
    await sftp.client.write(handle, 0, Buffer.from('hello'))
    await sftp.client.fsync(handle)
    await sftp.client.close(handle)
    expect((await sftp.client.lstat('/srv/root/probe.bin')).size).toBe(5)
    expect(await sftp.client.realpath('/srv/root/probe.bin')).toBe('/srv/root/probe.bin')
    await sftp.client.hardlink('/srv/root/probe.bin', '/srv/root/probe.link')
    expect(build.read('/srv/root/probe.link')!.toString()).toBe('hello')
    await sftp.client.remove('/srv/root/probe.link')
    await expect(sftp.client.lstat('/srv/root/probe.link')).rejects.toThrow()
    expect(build.sftpCalls).toContain('hardlink /srv/root/probe.bin /srv/root/probe.link')
  })

  it('forwards confine/spawn with the generation and the exit scope', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    expect(confined).toMatchObject({ enforcement: 'full', argv: ['/bin/sh', '-c', 'build app'] })
    const handle = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: {},
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } },
      graceMs: 10,
    }) as { done: Promise<{ exitCode: number | null }>; waitForExit(ms?: number): Promise<boolean>; collected: { stdout: { readFrom(offset: number): { text: string } | undefined } } }
    expect(await handle.done).toMatchObject({ exitCode: 0 })
    expect(handle.collected.stdout.readFrom(0)?.text).toBe('built app\n')
    expect(await handle.waitForExit(10)).toBe(true)
    expect(build.read('/srv/root/dist/app.tar')).toEqual(Buffer.concat([Buffer.from('app\n'), Buffer.from('a'), Buffer.from('--\n'), Buffer.from('b')]))
  })

  it('reports a stale generation instead of spawning', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    broker.markStale('build')
    const handle = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void>; exited: Promise<unknown> }
    await expect(handle.started).rejects.toMatchObject({ code: 'generation-changed' })
    await expect(handle.exited).rejects.toMatchObject({ code: 'generation-changed' })
    expect(broker.generationOf('build')).toBe('stale')
  })

  it('denies a spawn that was never confined, and a replayed or tampered ticket', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    const raw = environment.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'raw'], cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(raw.started).rejects.toMatchObject({ code: 'confinement-ticket-missing' })
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    const altered = environment.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'two'], cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(altered.started).rejects.toMatchObject({ code: 'confinement-ticket-missing' })
    const second = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    const outside = environment.subprocess.spawn({
      argv: second.argv, cwd: '/etc', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(outside.started).rejects.toMatchObject({ code: 'confinement-ticket-cwd' })
    const first = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } }, graceMs: 10,
    }) as { done: Promise<unknown> }
    await first.done
    const replay = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(replay.started).rejects.toMatchObject({ code: 'confinement-ticket-invalid' })
  })

  it('rejects a full-access confine at the schema edge and refuses stale SFTP generations', async () => {
    expect(() => parseBrokerRequest({
      protocol: BROKER_PROTOCOL, id: 1, method: 'confine',
      params: { environmentId: 'build', argv: ['/bin/sh'], policy: { mode: 'danger-full-access', workspaceRoot: '/srv/root', sessionId: 's' } },
    })).toThrow()
    expect(() => parseBrokerRequest({
      protocol: BROKER_PROTOCOL, id: 1, method: 'spawn',
      params: { environmentId: 'build', argv: ['/bin/sh'], cwd: '/srv/root', env: {}, stdoutLimit: 1, stderrLimit: 1, graceMs: 0, generation: 'g' },
    })).toThrow()
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const sftp = await broker.openSftp('build')
    await expect(connection.request('sftp', { environmentId: 'build', generation: 'stale-gen', op: 'lstat', path: '/srv/root' }))
      .rejects.toMatchObject({ code: 'generation-changed' })
    await expect(connection.request('sftp', { environmentId: 'build', generation: sftp.generation, op: 'lstat', path: '/srv/root' }))
      .resolves.toBeTruthy()
  })

  it('greets the broker-side SSH capability and rejects malformed or absent hello capability', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    expect(connection.hello.sshCapability).toMatchObject({ eligible: true })
    expect(parseBrokerEvent({ event: 'hello', protocol: BROKER_PROTOCOL, brokerUid: uid, environmentIds: [], manifestDigest: 'a'.repeat(64), sshCapability: { eligible: true } })).toBeTruthy()
    expect(() => parseBrokerEvent({ event: 'hello', protocol: BROKER_PROTOCOL, brokerUid: uid, environmentIds: [], manifestDigest: 'a'.repeat(64) })).toThrow()
    const headless = new BrokerServer(startOptions(join(base, 'nocap.sock'), {
      manager: Object.assign(Object.create(manager), { capability: undefined }) as SshEnvironmentManager,
    }))
    await headless.start()
    const peer = await BrokerConnection.connect(join(base, 'nocap.sock'), uid, 5_000)
    expect(peer.hello.sshCapability).toMatchObject({ eligible: false, reason: 'capability-unreported' })
    peer.close()
    await headless.stop()
  })

  it('expires a confinement ticket after thirty seconds', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(31_000)
      const late = environment.subprocess.spawn({
        argv: confined.argv, cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
      }) as { started: Promise<void> }
      await expect(late.started).rejects.toMatchObject({ code: 'confinement-ticket-expired' })
    } finally { vi.useRealTimers() }
  })

  it('classifies a reply lost mid-request as connection loss, not a remote status', async () => {
    const hanging = Object.assign(Object.create(manager), {
      openSftp: async (environmentId: string) => {
        const env = await manager.openSftp(environmentId)
        const client = { ...env.client, hardlink: () => new Promise(() => {}) }
        return { ...env, client }
      },
    })
    server = new BrokerServer(startOptions(join(base, 'lost.sock'), { manager: hanging as unknown as SshEnvironmentManager }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'lost.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const sftp = await broker.openSftp('build')
    const call = sftp.client.hardlink('/a', '/b')
    connection.close()
    await expect(call).rejects.toMatchObject({ name: 'SftpConnectionLost' })
  })

  it('binds the ticket to the argv the confiner returns, not the argv sent', async () => {
    const rewriting = Object.assign(Object.create(manager), {
      open: async (environmentId: string) => {
        const env = await manager.open(environmentId)
        return {
          ...env,
          sandbox: {
            ...env.sandbox,
            confine: async (argv: readonly string[], policy: unknown, signal?: AbortSignal) => {
              const confined = await (env.sandbox.confine as (...a: unknown[]) => Promise<{ argv: readonly string[]; enforcement: string }>)(argv, policy, signal)
              return { ...confined, argv: ['/trusted/sandbox-runner', '--', ...confined.argv] }
            },
          },
        }
      },
    })
    server = new BrokerServer(startOptions(join(base, 'rewrite.sock'), { manager: rewriting as unknown as SshEnvironmentManager }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'rewrite.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    expect(confined.argv[0]).toBe('/trusted/sandbox-runner')
    const raw = environment.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'build app'], cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(raw.started).rejects.toMatchObject({ code: 'confinement-ticket-missing' })
    const tamperedArgv = [...confined.argv]
    tamperedArgv[tamperedArgv.length - 1] = 'rm -rf /'
    const tampered = environment.subprocess.spawn({
      argv: tamperedArgv, cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(tampered.started).rejects.toMatchObject({ code: 'confinement-ticket-missing' })
    ;(confined.argv as string[])[confined.argv.length - 1] = 'rm -rf /'
    const mutated = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void> }
    await expect(mutated.started).rejects.toMatchObject({ code: 'confinement-ticket-argv' })
    const again = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    const executed = environment.subprocess.spawn({
      argv: again.argv, cwd: '/srv/root', env: {},
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } }, graceMs: 10,
    }) as { done: Promise<unknown> }
    await executed.done
    const last = build.execCalls.at(-1)!
    expect(last.argv[0]).toBe('/trusted/sandbox-runner')
    expect(last.argv[last.argv.length - 1]).toBe('build app')
  })

  it('refuses loader-injection env keys before the remote runs anything', async () => {
    server = await started()
    connection = await BrokerConnection.connect(socketPath, uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const environment = await broker.open('build')
    for (const env of [{ LD_PRELOAD: '/x.so' }, { DYLD_INSERT_LIBRARIES: '/x.dylib' }, { NODE_OPTIONS: '--require x' }, { NODE_PATH: '/x' }]) {
      const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
      const before = build.execCalls.length
      const bad = environment.subprocess.spawn({
        argv: confined.argv, cwd: '/srv/root', env, stdio: {}, graceMs: 0,
      }) as { started: Promise<void> }
      await expect(bad.started).rejects.toMatchObject({ code: 'confinement-ticket-env' })
      expect(build.execCalls).toHaveLength(before)
    }
    const confined = await environment.sandbox.confine(['/bin/sh', '-c', 'build app'], { mode: 'workspace-write', workspaceRoot: '/srv/root', sessionId: 'broker-spec' })
    const good = environment.subprocess.spawn({
      argv: confined.argv, cwd: '/srv/root', env: { LD_PRELOAD: '', PATH: '/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } }, graceMs: 10,
    }) as { done: Promise<unknown> }
    await good.done
  })

  it('never lets an older SFTP proxy write through a reopened session', async () => {
    let generation = 'gen-1'
    const wrapped = Object.assign(Object.create(manager), {
      openSftp: async (environmentId: string) => {
        const environment = await manager.openSftp(environmentId)
        return { ...environment, generation }
      },
      sftpGenerationOf: () => generation,
    })
    server = new BrokerServer(startOptions(join(base, 'reopen.sock'), { manager: wrapped as unknown as SshEnvironmentManager }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'reopen.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const first = await broker.openSftp('build')
    await connection.request('sftp', { environmentId: 'build', generation: 'gen-1', op: 'dispose' })
    generation = 'gen-2'
    const second = await broker.openSftp('build')
    expect(second).not.toBe(first)
    expect(second.generation).toBe('gen-2')
    // A stale generation is a definite refusal: the operation never ran.
    await expect(first.client.lstat('/srv/root')).rejects.toMatchObject({ code: 'generation-changed' })
    await first.dispose()
    await expect(second.client.lstat('/srv/root')).resolves.toBeTruthy()
  })

  it('publishes a hardlink whose reply is lost exactly once, with no replay', async () => {
    let calls = 0
    const wrapped = Object.assign(Object.create(manager), {
      openSftp: async (environmentId: string) => {
        const env = await manager.openSftp(environmentId)
        const original = env.client.hardlink.bind(env.client)
        const client = {
          ...env.client,
          hardlink: async (target: string, link: string) => { calls++; const result = await original(target, link); connection!.close(); return result },
        }
        return { ...env, client }
      },
    })
    server = new BrokerServer(startOptions(join(base, 'lost-pub.sock'), { manager: wrapped as unknown as SshEnvironmentManager }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'lost-pub.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const sftp = await broker.openSftp('build')
    const handle = await sftp.client.open('/srv/root/payload', P_CREAT | P_WRITE, 0o600)
    await sftp.client.write(handle, 0, Buffer.from('x'))
    await sftp.client.close(handle)
    await expect(sftp.client.hardlink('/srv/root/payload', '/srv/root/published'))
      .rejects.toMatchObject({ name: 'SftpConnectionLost' })
    expect(calls).toBe(1)
    const again = await BrokerConnection.connect(join(base, 'lost-pub.sock'), uid, 5_000)
    const sftp2 = await new BrokerEnvironmentManager(manager.deployment, again).openSftp('build')
    await expect(sftp2.client.lstat('/srv/root/published')).resolves.toBeTruthy()
    again.close()
  })

  it('destroys the connection and settles every pending request on request timeout', async () => {
    const hanging = Object.assign(Object.create(manager), {
      openSftp: () => new Promise<never>(() => {}),
    })
    server = new BrokerServer(startOptions(join(base, 'timeout.sock'), { manager: hanging as unknown as SshEnvironmentManager }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'timeout.sock'), uid, 5_000)
    vi.useFakeTimers()
    try {
      const pending = connection.request('openSftp', { environmentId: 'build' }, 1_000)
      const rejection = expect(pending).rejects.toMatchObject({ code: 'broker-timeout' })
      vi.advanceTimersByTime(1_100)
      await rejection
      await expect(connection.request('openSftp', { environmentId: 'build' }, 1_000))
        .rejects.toMatchObject({ code: 'broker-disconnected' })
    } finally { vi.useRealTimers() }
  })

  it('bounds requests and data at the protocol edge', () => {
    expect(parseBrokerRequest({ protocol: BROKER_PROTOCOL, id: 1, method: 'openSftp', params: { environmentId: 'build' } })).toMatchObject({ method: 'openSftp' })
    expect(() => parseBrokerRequest({ protocol: BROKER_PROTOCOL, id: 1, method: 'steal-keys', params: {} })).toThrow(/protocol version/)
    expect(() => parseBrokerRequest({ protocol: BROKER_PROTOCOL, id: 1, method: 'openSftp', params: { environmentId: 'build', extra: true } })).toThrow()
    expect(() => parseBrokerRequest({ protocol: 2, id: 1, method: 'openSftp', params: {} })).toThrow()
    expect(() => encodeData(Buffer.alloc(MAX_DATA + 1))).toThrow(/budget/)
  })

  it('reopens environments a closed connection released instead of serving the corpse', async () => {
    // The real manager caches openings globally; per-connection disposal must
    // go through it or the next connection is handed a dead environment.
    const opens: string[] = []
    const cache = new Map<string, { generation: string }>()
    const counting = {
      deployment: manager.deployment,
      open: async (environmentId: string) => {
        opens.push(environmentId)
        const generation = `gen-${opens.length}`
        cache.set(environmentId, { generation })
        return { environmentId, generation, hello: {}, fs: {}, sandbox: { confine: async () => ({ argv: [], enforcement: 'full' }) }, subprocess: { spawn: () => { throw new Error('unused') } }, assertAlive: () => {}, dispose: async () => {} }
      },
      generationOf: (environmentId: string) => cache.get(environmentId)?.generation ?? 'stale',
      dispose: async (environmentId: string) => { cache.delete(environmentId) },
      openSftp: async (environmentId: string) => { throw new Error(`no sftp ${environmentId}`) },
      sftpGenerationOf: () => 'stale',
      disposeSftp: async () => {},
      disposeAll: async () => {},
    }
    server = new BrokerServer(startOptions(join(base, 'cycle.sock'), { manager: counting as unknown as SshEnvironmentManager }))
    await server.start()
    const first = await BrokerConnection.connect(join(base, 'cycle.sock'), uid, 5_000)
    await new BrokerEnvironmentManager(manager.deployment, first).open('build')
    first.close()
    // closeConnection runs asynchronously on the socket 'close' event; wait
    // for the manager-level dispose to land before reconnecting.
    for (let i = 0; i < 100 && cache.has('build'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(cache.has('build')).toBe(false)
    connection = await BrokerConnection.connect(join(base, 'cycle.sock'), uid, 5_000)
    await new BrokerEnvironmentManager(manager.deployment, connection).open('build')
    expect(opens).toEqual(['build', 'build'])
    expect(cache.get('build')?.generation).toBe('gen-2')
  })

  const managed = (deployment: DeploymentManifest) =>
    new FakeManager(deployment, new Map([['build', build], ['device', new FakeRemote('device')]]), new Map([['build', fakeExecBackend(build, FAKE_EXEC)]])) as unknown as SshEnvironmentManager

  it('refuses work on a revoked environment even though its bindings stay', async () => {
    const deployment: DeploymentManifest = { ...fakeManifest({ primary: '/tmp/primary' }), revocations: [{ environmentId: 'device', reason: 'credential rotated' }] }
    server = new BrokerServer(startOptions(join(base, 'revoked.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'revoked.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    await expect(broker.openSftp('device')).rejects.toMatchObject({ code: 'environment-revoked' })
    await expect(broker.open('device')).rejects.toMatchObject({ code: 'environment-revoked' })
    await expect(connection.request('dispose', { environmentId: 'device' })).resolves.toBeTruthy()
    const sftp = await broker.openSftp('build')
    await expect(sftp.client.lstat('/srv/root')).resolves.toBeTruthy()
  })

  it('charges every environment-bound operation against its rolling window', async () => {
    const baseDeployment = fakeManifest({ primary: '/tmp/primary' })
    const deployment: DeploymentManifest = {
      ...baseDeployment,
      environments: baseDeployment.environments.map(environment => environment.environmentId === 'build'
        ? { ...environment, quotas: { windowMs: 60_000, maxOperations: 3, maxBytes: 1_000_000 } }
        : environment),
    }
    server = new BrokerServer(startOptions(join(base, 'quota-ops.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'quota-ops.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    const sftp = await broker.openSftp('build')
    await sftp.client.lstat('/srv/root')
    await sftp.client.lstat('/srv/root/src')
    await expect(sftp.client.lstat('/srv/root/dist')).rejects.toMatchObject({ code: 'quota-exceeded' })
    // A different environment has its own window and keeps answering.
    const other = await broker.openSftp('device')
    await expect(other.client.realpath('/')).resolves.toBe('/')
  })

  it('charges SFTP payload bytes against the same window', async () => {
    const baseDeployment = fakeManifest({ primary: '/tmp/primary' })
    const deployment: DeploymentManifest = {
      ...baseDeployment,
      environments: baseDeployment.environments.map(environment => environment.environmentId === 'build'
        ? { ...environment, quotas: { windowMs: 60_000, maxOperations: 1_000, maxBytes: 8 } }
        : environment),
    }
    server = new BrokerServer(startOptions(join(base, 'quota-bytes.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'quota-bytes.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    const sftp = await broker.openSftp('build')
    const handle = await sftp.client.open('/srv/root/quota.bin', P_WRITE | P_CREAT | P_EXCL, 0o600)
    await sftp.client.write(handle, 0, Buffer.from('12345'))
    await expect(sftp.client.write(handle, 5, Buffer.from('6789'))).rejects.toMatchObject({ code: 'quota-exceeded' })
  })

  it('applies the broker-global window across every environment', async () => {
    const deployment: DeploymentManifest = { ...fakeManifest({ primary: '/tmp/primary' }), quotas: { windowMs: 60_000, maxOperations: 2, maxBytes: 1_000_000 } }
    server = new BrokerServer(startOptions(join(base, 'quota-global.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'quota-global.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    await broker.openSftp('build')
    await broker.openSftp('device')
    await expect(broker.openSftp('build')).rejects.toMatchObject({ code: 'quota-exceeded' })
  })

  it('never leaks a refused operation into the other scope’s budget', async () => {
    const baseDeployment = fakeManifest({ primary: '/tmp/primary' })
    const deployment: DeploymentManifest = {
      ...baseDeployment,
      quotas: { windowMs: 60_000, maxOperations: 5, maxBytes: 1_000_000 },
      environments: baseDeployment.environments.map(environment => environment.environmentId === 'build'
        ? { ...environment, quotas: { windowMs: 60_000, maxOperations: 2, maxBytes: 1_000_000 } }
        : environment),
    }
    server = new BrokerServer(startOptions(join(base, 'quota-leak.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'quota-leak.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    const sftp = await broker.openSftp('build')
    await sftp.client.lstat('/srv/root')
    // Two env-denied operations: the global window must still hold only the
    // two admitted 'build' operations, so 'device' keeps three slots.
    await expect(sftp.client.lstat('/srv/root/src')).rejects.toMatchObject({ code: 'quota-exceeded' })
    await expect(sftp.client.lstat('/srv/root/src')).rejects.toMatchObject({ code: 'quota-exceeded' })
    const other = await broker.openSftp('device')
    await expect(other.client.realpath('/')).resolves.toBe('/')
    await expect(other.client.realpath('/')).resolves.toBe('/')
    await expect(other.client.realpath('/')).rejects.toMatchObject({ code: 'quota-exceeded' })
  })

  it('readmits requests once the window rolls', async () => {
    const baseDeployment = fakeManifest({ primary: '/tmp/primary' })
    const deployment: DeploymentManifest = {
      ...baseDeployment,
      environments: baseDeployment.environments.map(environment => environment.environmentId === 'build'
        ? { ...environment, quotas: { windowMs: 1_000, maxOperations: 2, maxBytes: 1_000_000 } }
        : environment),
    }
    server = new BrokerServer(startOptions(join(base, 'quota-roll.sock'), { manager: managed(deployment) }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'quota-roll.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(deployment, connection)
    const sftp = await broker.openSftp('build')
    await sftp.client.lstat('/srv/root')
    await expect(sftp.client.lstat('/srv/root/src')).rejects.toMatchObject({ code: 'quota-exceeded' })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(1_100)
      await expect(sftp.client.lstat('/srv/root/src')).resolves.toBeTruthy()
    } finally { vi.useRealTimers() }
  })

  it('rotates the append-only audit at its size budget, keeping it broker-private', async () => {
    const auditPath = join(base, 'audit.jsonl')
    server = new BrokerServer(startOptions(join(base, 'audit.sock'), { auditPath, auditMaxBytes: 640, auditKeep: 2 }))
    await server.start()
    connection = await BrokerConnection.connect(join(base, 'audit.sock'), uid, 5_000)
    const broker = new BrokerEnvironmentManager(manager.deployment, connection)
    const sftp = await broker.openSftp('build')
    for (let i = 0; i < 24; i++) await sftp.client.lstat('/srv/root')
    const { readdirSync, statSync } = await import('node:fs')
    const rotated = readdirSync(base).filter(name => name.startsWith('audit.jsonl')).sort()
    expect(rotated).toContain('audit.jsonl.1')
    expect(rotated).not.toContain('audit.jsonl.3')
    for (const name of rotated) {
      const info = statSync(join(base, name))
      expect(info.mode & 0o777).toBe(0o600)
      expect(info.size).toBeLessThanOrEqual(640)
    }
  })

  it('refuses to start when the audit path is a planted foreign file', async () => {
    const auditPath = join(base, 'planted.jsonl')
    fakeStats.set(auditPath, { uid: uid + 1, mode: 0o600, kind: 'file' })
    const instance = new BrokerServer(startOptions(join(base, 'audit-refused.sock'), { auditPath }))
    await expect(instance.start()).rejects.toThrow(/real file owned by the broker/)
    fakeStats.set(auditPath, { uid, mode: 0o600, kind: 'link' })
    const linked = new BrokerServer(startOptions(join(base, 'audit-refused2.sock'), { auditPath }))
    await expect(linked.start()).rejects.toThrow(/real file owned by the broker/)
    fakeStats.delete(auditPath)
  })
})

describe.skipIf(!POSIX || process.getuid?.() === 0)('the Host attestation', () => {
  const config = (overrides: Partial<BrokerConfig> = {}): BrokerConfig => ({
    socketPath,
    brokerUid: uid + 1,
    credentialRoot: join(base, 'keys'),
    fullAccessDisabled: true,
    confinementProbe: { verified: true },
    ...overrides,
  })

  const attestManifest = (): DeploymentManifest => ({
    ...manager.deployment,
    environments: manager.deployment.environments.map(environment => environment.environmentId === 'device'
      ? { ...environment, transfer: { ...environment.transfer!, destinationIsolation: 'chroot-sftp' as const } }
      : environment),
    bindings: manager.deployment.bindings.map(binding => binding.environmentId === 'build'
      ? { ...binding, transfers: binding.transfers?.filter(transfer => transfer.direction !== 'import') }
      : binding),
  })

  const brokerSocket = (path: string) => {
    fakeStats.set(path, { uid: uid + 1, mode: 0o660, kind: 'socket' })
    fakeStats.set(dirname(path), { uid: uid + 1, mode: 0o750, kind: 'dir' })
  }

  const fakeConnection = (hello: Record<string, unknown>) => ({
    hello, close() {}, on() {}, once() {}, off() {}, removeListener() {}, onClose() {},
    request: async () => { throw new Error('fake connection has no requests') },
  })

  const validHello = (manifest: DeploymentManifest, overrides: Record<string, unknown> = {}) => ({
    event: 'hello', protocol: BROKER_PROTOCOL, brokerUid: uid + 1,
    environmentIds: manifest.environments.map(environment => environment.environmentId),
    manifestDigest: manifestDigest(manifest),
    sshCapability: { eligible: true },
    ...overrides,
  })

  afterEach(() => { fakeStats.clear(); fakeAccess.clear(); fakeConnections.clear(); vi.restoreAllMocks() })

  it('refuses the Host account itself', async () => {
    await expect(attestBroker(config({ brokerUid: uid }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'broker-same-uid' })
  })

  it('refuses a root Host or a root broker', async () => {
    await expect(attestBroker(config({ brokerUid: 0 }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'broker-root-uid' })
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(0)
    try {
      await expect(attestBroker(config(), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'broker-root-uid' })
    } finally { spy.mockRestore() }
  })

  it('requires the deployment confinement evidence', async () => {
    await expect(attestBroker(config({ confinementProbe: undefined }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'confinement-unproven' })
    await expect(attestBroker(config({ confinementProbe: { verified: false } }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'confinement-unproven' })
  })

  it('requires the deployment to exclude unrestricted local Agent processes', async () => {
    await expect(attestBroker(config({ fullAccessDisabled: undefined }), attestManifest()))
      .resolves.toMatchObject({ status: 'unavailable', code: 'full-access-unrestricted' })
    await expect(attestBroker(config({ fullAccessDisabled: false }), attestManifest()))
      .resolves.toMatchObject({ status: 'unavailable', code: 'full-access-unrestricted' })
  })

  it('refuses command output budgets that cannot fit broker frames', async () => {
    const manifest = attestManifest()
    const environments = manifest.environments.map(env => env.exec === undefined
      ? env
      : { ...env, exec: { ...env.exec, stdoutLimit: MAX_COMMAND_OUTPUT + 1 } })
    await expect(attestBroker(config(), { ...manifest, environments }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'broker-output-limit' })
  })

  it('requires import destinations to be independent chroot SFTP accounts', async () => {
    await expect(attestBroker(config(), manager.deployment))
      .resolves.toMatchObject({ status: 'unavailable', code: 'destination-isolation-required' })
    const helperDestination = {
      ...attestManifest(),
      bindings: attestManifest().bindings.map(binding => ({ ...binding, environmentId: 'build' })),
    }
    await expect(attestBroker(config(), helperDestination))
      .resolves.toMatchObject({ status: 'unavailable', code: 'destination-isolation-required' })
    const shared = attestManifest()
    const withHelper = {
      ...shared,
      environments: [
        ...shared.environments,
        { ...shared.environments[0]!, environmentId: 'device-admin', account: 'deploy', namespace: 'device' },
      ],
    }
    await expect(attestBroker(config(), withHelper))
      .resolves.toMatchObject({ status: 'unavailable', code: 'destination-isolation-required' })
  })

  it('fails when the Host can read the credential root', async () => {
    const readable = join(base, 'readable')
    mkdirSync(readable, { recursive: true })
    fakeStats.set(readable, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    await expect(attestBroker(config({ credentialRoot: readable }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'credentials-readable' })
  })

  it('requires a real broker-owned 0700 credential directory', async () => {
    const creds = join(base, 'creds-shape')
    mkdirSync(creds, { recursive: true })
    fakeStats.set(creds, { uid: uid, mode: 0o700, kind: 'dir' })
    await expect(attestBroker(config({ credentialRoot: creds }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'credential-root-owner' })
    fakeStats.set(creds, { uid: uid + 1, mode: 0o750, kind: 'dir' })
    await expect(attestBroker(config({ credentialRoot: creds }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'credential-root-mode' })
    fakeStats.set(creds, { uid: uid + 1, mode: 0o700, kind: 'link' })
    await expect(attestBroker(config({ credentialRoot: creds }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'credential-root-not-directory' })
  })

  it('reports a missing socket only after the credential check passes', async () => {
    const unreadable = join(base, 'unreadable')
    mkdirSync(unreadable, { recursive: true })
    fakeStats.set(unreadable, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    fakeAccess.set(unreadable, 'EACCES')
    await expect(attestBroker(config({ credentialRoot: unreadable }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'socket-missing' })
  })

  it('refuses a socket owned by a different account', async () => {
    server = await started()
    const unreadable = join(base, 'unreadable2')
    mkdirSync(unreadable, { recursive: true })
    fakeStats.set(unreadable, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    fakeAccess.set(unreadable, 'EACCES')
    await expect(attestBroker(config({ credentialRoot: unreadable }), attestManifest())).resolves.toMatchObject({ status: 'unavailable', code: 'socket-owner-mismatch' })
  })

  it('attests a fully compliant deployment against a valid hello', async () => {
    const manifest = attestManifest()
    const sock = join(base, 'attest-positive.sock')
    const creds = join(base, 'attest-creds')
    fakeStats.set(creds, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    fakeAccess.set(creds, 'EACCES')
    brokerSocket(sock)
    fakeConnections.set(sock, fakeConnection(validHello(manifest)))
    const result = await attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest)
    expect(result).toMatchObject({ status: 'attested' })
    if (result.status === 'attested') result.connection.close()
  })

  it('refuses a hello that reports the wrong account or manifest', async () => {
    const manifest = attestManifest()
    const sock = join(base, 'attest-hello.sock')
    const creds = join(base, 'attest-creds2')
    fakeStats.set(creds, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    fakeAccess.set(creds, 'EACCES')
    brokerSocket(sock)
    fakeConnections.set(sock, fakeConnection(validHello(manifest, { brokerUid: uid + 7 })))
    await expect(attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest))
      .resolves.toMatchObject({ status: 'unavailable', code: 'broker-uid-mismatch' })
    fakeConnections.set(sock, fakeConnection(validHello(manifest, { manifestDigest: 'f'.repeat(64) })))
    await expect(attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest))
      .resolves.toMatchObject({ status: 'unavailable', code: 'manifest-mismatch' })
  })

  it('refuses a hello with a missing, false, or malformed SSH capability', async () => {
    const manifest = attestManifest()
    const sock = join(base, 'attest-cap.sock')
    const creds = join(base, 'attest-creds3')
    fakeStats.set(creds, { uid: uid + 1, mode: 0o700, kind: 'dir' })
    fakeAccess.set(creds, 'EACCES')
    brokerSocket(sock)
    const hello = validHello(manifest) as Record<string, unknown>
    delete hello.sshCapability
    fakeConnections.set(sock, fakeConnection(hello))
    await expect(attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest))
      .resolves.toMatchObject({ status: 'unavailable', code: 'ssh-capability-absent' })
    fakeConnections.set(sock, fakeConnection(validHello(manifest, { sshCapability: { eligible: false, reason: 'no ssh packages' } })))
    await expect(attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest))
      .resolves.toMatchObject({ status: 'unavailable', code: 'ssh-capability-absent' })
    fakeConnections.set(sock, fakeConnection(validHello(manifest, { sshCapability: { eligible: 'yes' } })))
    await expect(attestBroker(config({ socketPath: sock, credentialRoot: creds }), manifest))
      .resolves.toMatchObject({ status: 'unavailable', code: 'ssh-capability-absent' })
  })
})
