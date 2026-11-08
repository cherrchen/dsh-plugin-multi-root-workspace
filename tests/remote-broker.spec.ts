/**
 * The credential broker's local interface (ADR-0036): framing and bounds,
 * same-uid refusal, kernel peer authentication, the SFTP/exec proxies over a
 * real socket, and the attestation failures that keep the remote tools
 * unmounted. The success path of attestation needs a real second OS account
 * and is a deployment test, not this suite.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { fakeExecBackend, FakeManager, FakeRemote, fakeManifest, FAKE_EXEC } from './support/fake-remote.ts'
import { attestBroker, type BrokerConfig } from '../src/remote/broker/attest.ts'
import { BrokerConnection, BrokerEnvironmentManager } from '../src/remote/broker/client.ts'
import { encodeData, MAX_DATA, parseBrokerRequest } from '../src/remote/broker/protocol.ts'
import { BrokerServer } from '../src/remote/broker/server.ts'
import type { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { P_CREAT, P_EXCL, P_WRITE } from '../src/remote/sftp.ts'

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
    broker.markStale('build')
    const handle = environment.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'true'], cwd: '/srv/root', env: {}, stdio: {}, graceMs: 0,
    }) as { started: Promise<void>; exited: Promise<unknown> }
    await expect(handle.started).rejects.toMatchObject({ code: 'generation-changed' })
    await expect(handle.exited).rejects.toMatchObject({ code: 'generation-changed' })
    expect(broker.generationOf('build')).toBe('stale')
  })

  it('bounds requests and data at the protocol edge', () => {
    expect(parseBrokerRequest({ protocol: 1, id: 1, method: 'openSftp', params: { environmentId: 'build' } })).toMatchObject({ method: 'openSftp' })
    expect(() => parseBrokerRequest({ protocol: 1, id: 1, method: 'steal-keys', params: {} })).toThrow(/protocol-1/)
    expect(() => parseBrokerRequest({ protocol: 1, id: 1, method: 'openSftp', params: { environmentId: 'build', extra: true } })).toThrow()
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
        return { environmentId, generation, hello: {}, fs: {}, sandbox: { confine: async () => ({ argv: [], enforcement: 'full' }) }, subprocess: { spawn: () => { throw new Error('unused') } }, dispose: async () => {} }
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
})

describe.skipIf(!POSIX || process.getuid?.() === 0)('the Host attestation', () => {
  const config = (overrides: Partial<BrokerConfig> = {}): BrokerConfig => ({
    socketPath,
    brokerUid: uid + 1,
    credentialRoot: join(base, 'keys'),
    confinementProbe: { verified: true },
    ...overrides,
  })

  it('refuses the Host account itself', async () => {
    await expect(attestBroker(config({ brokerUid: uid }), manager.deployment)).resolves.toMatchObject({ status: 'unavailable', code: 'broker-same-uid' })
  })

  it('requires the deployment confinement evidence', async () => {
    await expect(attestBroker(config({ confinementProbe: undefined }), manager.deployment)).resolves.toMatchObject({ status: 'unavailable', code: 'confinement-unproven' })
  })

  it('fails when the Host can read the credential root', async () => {
    const readable = join(base, 'readable')
    mkdirSync(readable, { recursive: true })
    await expect(attestBroker(config({ credentialRoot: readable }), manager.deployment)).resolves.toMatchObject({ status: 'unavailable', code: 'credentials-readable' })
  })

  it('reports a missing socket only after the credential check passes', async () => {
    const unreadable = join(base, 'unreadable')
    mkdirSync(unreadable, { recursive: true })
    chmodSync(unreadable, 0o000)
    try {
      await expect(attestBroker(config({ credentialRoot: unreadable }), manager.deployment)).resolves.toMatchObject({ status: 'unavailable', code: 'socket-missing' })
    } finally { chmodSync(unreadable, 0o700) }
  })

  it('refuses a socket owned by a different account', async () => {
    server = await started()
    const unreadable = join(base, 'unreadable2')
    mkdirSync(unreadable, { recursive: true })
    chmodSync(unreadable, 0o000)
    try {
      await expect(attestBroker(config({ credentialRoot: unreadable }), manager.deployment)).resolves.toMatchObject({ status: 'unavailable', code: 'socket-owner-mismatch' })
    } finally { chmodSync(unreadable, 0o700) }
  })
})


