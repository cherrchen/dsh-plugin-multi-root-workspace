/**
 * G5a live evidence: the credential broker under a REAL second OS account.
 * Gated on DSH_MULTI_ROOT_BROKER_LIVE (path to a broker-live.json) and a
 * POSIX initiator — without it the whole file skips cleanly. The deployment
 * is provisioned by scripts/ssh-broker/install.sh; this suite runs as the
 * trusted Host user, so its own inability to read the credential root is the
 * two-account proof (the Agent-sandbox denial is recorded out of band as the
 * deployment's confinementProbe evidence).
 */
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { runRemoteCommand, type RemoteExecutionBackend } from '../src/remote/exec.ts'
import { runRemoteCopy, type RemoteCopyDeps } from '../src/remote/transfer.ts'
import { loadDeploymentManifest } from '../src/remote/manifest.ts'
import { attestBroker, type BrokerConfig } from '../src/remote/broker/attest.ts'
import type { BrokerEnvironmentManager } from '../src/remote/broker/client.ts'
import { sshExecBackend } from '../src/remote/ssh-exec-backend.ts'
import { SshEndpointVerifier } from '../src/remote/ssh-verifier.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'

const LIVE = process.env.DSH_MULTI_ROOT_BROKER_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  socketPath: string; brokerUid: number; credentialRoot: string; manifestPath: string
  confinementProbe: { verified: boolean; evidence?: string }
  primary: string; outsideSentinel: string; workspaceApp: string; workspaceLib: string
}

const brokerConfig: BrokerConfig = LIVE === undefined ? {} as never : {
  socketPath: live.socketPath,
  brokerUid: live.brokerUid,
  credentialRoot: live.credentialRoot,
  confinementProbe: live.confinementProbe,
}
const manifestOf = () => loadDeploymentManifest(live.manifestPath).manifest

let seq = 0
const sessionOf = (stack: RegistryStack, mode?: string) => {
  const session = stack.ctx.sessions.create(SessionId(`live-${++seq}`), { meta: { cwd: live.primary } })
  if (mode !== undefined) session.append('sandbox/mode', { mode })
  return session
}

const stacks: RegistryStack[] = []
const managers: BrokerEnvironmentManager[] = []
afterEach(async () => {
  for (const stack of stacks.reverse()) await stack.dispose()
  stacks.length = 0
  for (const manager of managers.reverse()) await manager.disposeAll().catch(() => {})
  managers.length = 0
})

async function mount() {
  const manifest = manifestOf()
  const attestation = await attestBroker(brokerConfig, manifest)
  if (attestation.status !== 'attested') throw new Error(`attestation failed: ${attestation.code} ${attestation.reason}`)
  managers.push(attestation.manager)
  const base = mkdtempSync(join(tmpdir(), 'g5a-live-store-'))
  const stack = await mountRegistryStack(join(base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: live.manifestPath },
  }, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections); await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: live.primary })
    },
  })
  stacks.push(stack)
  stack.registry.setRemoteEndpointVerifier(new SshEndpointVerifier(attestation.manager))
  const backends = new Map<string, RemoteExecutionBackend>()
  const backendFor = (environmentId: string) => backends.get(environmentId)
  const openBackend = async (environmentId: string) => {
    const environment = manifest.environments.find(e => e.environmentId === environmentId)!
    const env = await attestation.manager.open(environmentId)
    backends.set(environmentId, sshExecBackend(environment, env, attestation.manager)!)
  }
  return { stack, manager: attestation.manager, backends, backendFor, openBackend }
}

const run = (m: Awaited<ReturnType<typeof mount>>, request: Record<string, unknown>) => runRemoteCommand(
  m.stack.registry, m.backendFor,
  { session: sessionOf(m.stack), environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 15_000, ...request } as never,
  'remote_bash', new AbortController().signal,
)

const remoteFile = async (manager: BrokerEnvironmentManager, environmentId: string, path: string) => {
  const env = await manager.openSftp(environmentId)
  const h = await env.client.open(path, 1)
  const chunks: Buffer[] = []
  for (let off = 0;;) { const d = await env.client.read(h, off, 64 * 1024); if (d.length === 0) break; chunks.push(d); off += d.length }
  await env.client.close(h)
  return Buffer.concat(chunks)
}

/** The broker proxies no `readdir`; clean only the names this suite creates. */
const purge = async (manager: BrokerEnvironmentManager, environmentId: string, names: readonly string[]) => {
  const env = await manager.openSftp(environmentId).catch(() => undefined)
  if (env === undefined) return
  for (const name of names) await env.client.remove(`/import/${name}`).catch(() => {})
}
const CREATED = ['g5a-up.txt', 'g5a-xlib.txt', 'g5a-seed.bin', 'g5a-down.bin', 'g5a-relay.bin']

liveDescribe('the credential custody boundary on two real accounts', () => {
  it('keeps the credential root unreadable and the socket inside the deployer group', () => {
    // This suite runs as the trusted Host uid. Success on any read is a
    // custody failure — EACCES/EPERM is the pass.
    for (const path of [live.credentialRoot, join(live.credentialRoot, '.ssh'), join(live.credentialRoot, '.ssh', 'id_ed25519')]) {
      expect(() => accessSync(path, constants.R_OK), `${path} must not be readable`).toThrowError(/EACCES|EPERM/)
    }
    const socket = lstatSync(live.socketPath)
    expect(socket.isSocket()).toBe(true)
    expect(socket.uid).toBe(live.brokerUid)
    expect(socket.mode & 0o007).toBe(0)
    const directory = lstatSync(dirname(live.socketPath))
    expect(directory.isDirectory() && directory.uid === live.brokerUid && (directory.mode & 0o007) === 0).toBe(true)
  })

  it('attests and opens every manifest environment through the broker', async () => {
    const manifest = manifestOf()
    const attestation = await attestBroker(brokerConfig, manifest)
    expect(attestation.status).toBe('attested')
    if (attestation.status !== 'attested') return
    managers.push(attestation.manager)
    expect(attestation.connection.hello?.brokerUid).toBe(live.brokerUid)
    for (const environment of manifest.environments) {
      expect(attestation.connection.hello?.environmentIds).toContain(environment.environmentId)
    }
    for (const environment of manifest.environments.filter(environment => environment.transport === 'helper')) {
      const env = await attestation.manager.open(environment.environmentId)
      expect(env.hello.platform).toBe('linux')
    }
    for (const environment of manifest.environments.filter(environment => environment.transfer !== undefined)) {
      const env = await attestation.manager.openSftp(environment.environmentId)
      expect(env.version.extensions['hardlink@openssh.com']).toBeDefined()
      expect(env.version.extensions['fsync@openssh.com']).toBeDefined()
    }
  }, 240_000)

  it('fails closed without a recorded confinement probe', async () => {
    const attestation = await attestBroker({ ...brokerConfig, confinementProbe: undefined }, manifestOf())
    expect(attestation).toMatchObject({ status: 'unavailable', code: 'confinement-unproven' })
  })
})

liveDescribe('remote_bash and remote_copy through the broker', () => {
  it('runs confined commands through broker custody with the same boundaries', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    await m.openBackend('vps-app')
    await expect(run(m, { command: 'echo broker-ok > inside.txt && cat inside.txt' })).resolves.toMatchObject({
      status: 'scope-exited', scope: 'confirmed', stdout: expect.stringContaining('broker-ok'),
    })
    const sentinel = await run(m, { command: `echo owned > ${live.outsideSentinel}` })
    expect(sentinel.status === 'scope-exited' || sentinel.status === 'exited' ? sentinel.exitCode !== 0 : false).toBe(true)
    const sibling = await run(m, { command: `echo x > ${live.workspaceLib}/escape.txt` })
    expect(sibling.status === 'scope-exited' || sibling.status === 'exited' ? sibling.exitCode !== 0 : false).toBe(true)
    await expect(run(m, { command: 'exit 7' })).resolves.toMatchObject({ status: 'scope-exited', exitCode: 7 })
    const timeout = await run(m, { command: 'sleep 30', timeoutMs: 3_000 })
    expect(['exited', 'scope-exited']).toContain(timeout.status)
    const ro = sessionOf(m.stack, 'read-only')
    const denied = await runRemoteCommand(m.stack.registry, m.backendFor, {
      session: ro, environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 1_000,
    }, 'remote_bash', new AbortController().signal)
    expect(denied).toMatchObject({ status: 'not-started', code: 'mode-denies' })
    await run(m, { command: 'rm -f inside.txt' })
  }, 240_000)

  it('copies in all three directions and verifies bytes end to end', async () => {
    const m = await mount()
    const extra = mkdtempSync(join(tmpdir(), 'g5a-xlib-'))
    try {
      await purge(m.manager, 'vps-xfer', CREATED)
      await purge(m.manager, 'vps-xfer2', CREATED)
      writeFileSync(join(extra, 'x.txt'), 'xlib-payload')
      const statuses = await m.stack.registry.add(live.primary, { path: extra })
      await m.stack.registry.setAliasId(live.primary, { kind: 'id', id: statuses[0]!.id }, 'xlib')
      await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
      await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer2', rootId: 'import' })
      const deps: RemoteCopyDeps = { manager: m.manager }
      const copy = (request: Record<string, unknown>, session?: ReturnType<typeof sessionOf>) => runRemoteCopy(
        m.stack.registry, deps,
        {
          session: session ?? sessionOf(m.stack),
          from: { environmentId: 'local', rootId: 'primary', relativePath: 'src.txt' },
          to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-out.bin' },
          ...request,
        } as never, 'remote_copy', new AbortController().signal,
      )

      // local -> sftp
      writeFileSync(join(live.primary, 'src.txt'), 'primary-payload')
      const up = await copy({ to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-up.txt' } })
      expect(up).toMatchObject({ status: 'committed' })
      expect((await remoteFile(m.manager, 'vps-xfer', '/import/g5a-up.txt')).toString()).toBe('primary-payload')
      const upXlib = await copy({ from: { environmentId: 'local', rootId: 'xlib', relativePath: 'x.txt' }, to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-xlib.txt' } })
      expect(upXlib).toMatchObject({ status: 'committed' })
      expect((await remoteFile(m.manager, 'vps-xfer', '/import/g5a-xlib.txt')).toString()).toBe('xlib-payload')

      // sftp -> local, byte-identical binary
      const payload = randomBytes(96 * 1024)
      const env = await m.manager.openSftp('vps-xfer')
      const h = await env.client.open('/import/g5a-seed.bin', 0x02 | 0x08 | 0x10, 0o600)
      for (let offset = 0; offset < payload.length; offset += 32 * 1024) await env.client.write(h, offset, payload.subarray(offset, offset + 32 * 1024))
      await env.client.close(h)
      const down = await copy({
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-seed.bin' },
        to: { environmentId: 'local', rootId: 'primary', relativePath: 'g5a-down.bin' },
      })
      expect(down).toMatchObject({ status: 'committed', bytes: payload.length, staging: 'removed' })
      expect(readFileSync(join(live.primary, 'g5a-down.bin')).equals(payload)).toBe(true)

      // sftp -> sftp across two physical machines, byte-identical
      const relay = await copy({
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-seed.bin' },
        to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g5a-relay.bin' },
      })
      expect(relay).toMatchObject({ status: 'committed', bytes: payload.length })
      expect(createHash('sha256').update(await remoteFile(m.manager, 'vps-xfer2', '/import/g5a-relay.bin')).digest('hex'))
        .toBe(createHash('sha256').update(payload).digest('hex'))
      expect(readdirSync(live.primary).filter(name => name.startsWith('.dsh-staging-'))).toEqual([])

      // an existing destination refuses before staging, bytes untouched
      const again = await copy({
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g5a-seed.bin' },
        to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g5a-relay.bin' },
      })
      expect(again).toMatchObject({ status: 'failed', code: 'target-exists' })
      expect((await remoteFile(m.manager, 'vps-xfer2', '/import/g5a-relay.bin')).equals(payload)).toBe(true)

      // a read-only session denies before any SFTP session opens
      let opens = 0
      const realOpen = m.manager.openSftp.bind(m.manager)
      m.manager.openSftp = async (id: string) => { opens++; return await realOpen(id) }
      const denied = await copy({}, sessionOf(m.stack, 'read-only'))
      expect(denied).toMatchObject({ status: 'failed', code: 'mode-denies' })
      expect(opens).toBe(0)
      m.manager.openSftp = realOpen
    } finally {
      await purge(m.manager, 'vps-xfer', CREATED).catch(() => {})
      await purge(m.manager, 'vps-xfer2', CREATED).catch(() => {})
      rmSync(extra, { recursive: true, force: true })
      rmSync(join(live.primary, 'src.txt'), { force: true })
      rmSync(join(live.primary, 'g5a-down.bin'), { force: true })
    }
  }, 300_000)
})
