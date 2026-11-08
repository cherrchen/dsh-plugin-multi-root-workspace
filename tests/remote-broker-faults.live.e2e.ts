/**
 * Broker-side fault injection: the faults that only exist because credentials
 * live in a second account. Trigger protocol — the test (running as the Host
 * user, which cannot signal the broker's processes) writes a mode file that a
 * root-side watcher consumes:
 *
 *   /tmp/dsh-fault-trigger  "broker-ssh"    → pkill -9 -u _dsh_ssh -f vps-build
 *                           "broker-daemon" → systemctl kill -s SIGKILL dsh-ssh-broker.service
 *
 * Gated on DSH_MULTI_ROOT_BROKER_LIVE — the same deployment as
 * remote-broker.live.e2e.ts. The watcher is deployment scaffolding outside
 * the repository.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { runRemoteCommand, type RemoteExecutionBackend } from '../src/remote/exec.ts'
import { runRemoteCopy } from '../src/remote/transfer.ts'
import { attestBroker } from '../src/remote/broker/attest.ts'
import { lazySshExecBackend } from '../src/remote/ssh-exec-backend.ts'
import { SshEndpointVerifier } from '../src/remote/ssh-verifier.ts'
import { loadDeploymentManifest } from '../src/remote/manifest.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'

const LIVE = process.env.DSH_MULTI_ROOT_BROKER_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  manifestPath: string
  socketPath: string; brokerUid: number; credentialRoot: string
  confinementProbe: { verified: boolean; log: string }
  primary: string
  triggerPath?: string
}
const brokerConfig = { socketPath: live.socketPath, brokerUid: live.brokerUid, credentialRoot: live.credentialRoot, confinementProbe: live.confinementProbe }

const TRIGGER = live.triggerPath ?? '/tmp/dsh-fault-trigger'
const fire = (mode: 'broker-ssh' | 'broker-daemon') => writeFileSync(TRIGGER, mode)
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

const stacks: RegistryStack[] = []
const managers: { disposeAll(): Promise<void> }[] = []
const tmpdirs: string[] = []
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.dispose().catch(() => {})
  for (const manager of managers.splice(0)) await manager.disposeAll().catch(() => {})
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function mount(seq: number) {
  const base = mkdtempSync(join(tmpdir(), 'broker-faults-')); tmpdirs.push(base)
  const manifest = loadDeploymentManifest(live.manifestPath).manifest
  const stack = await mountRegistryStack(join(base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: live.manifestPath },
  }, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections); await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: live.primary })
    },
  })
  stacks.push(stack)
  const attestation = await attestBroker(brokerConfig, manifest)
  if (attestation.status !== 'attested') throw new Error(`attestation refused: ${JSON.stringify(attestation)}`)
  const manager = attestation.manager
  managers.push(manager)
  stack.registry.setRemoteEndpointVerifier(new SshEndpointVerifier(manager as never))
  const backends = new Map<string, RemoteExecutionBackend | undefined>()
  return {
    stack, manager,
    backendFor: (environmentId: string) => {
      if (!backends.has(environmentId)) {
        const environment = manifest.environments.find(e => e.environmentId === environmentId)
        backends.set(environmentId, environment === undefined ? undefined : lazySshExecBackend(environment, manager as never))
      }
      return backends.get(environmentId)
    },
    session: () => stack.ctx.sessions.create(SessionId(`broker-fault-${seq}-${Date.now()}`), { meta: { cwd: live.primary } }),
  }
}

liveDescribe('broker-side fault injection', () => {
  it('killing the broker ssh mid-transfer never commits and the next open regenerates', async () => {
    const m = await mount(1)
    await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-app', rootId: 'app' })
    await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    const seeded = await runRemoteCommand(m.stack.registry, m.backendFor, {
      session: m.session(), environmentId: 'vps-app', rootId: 'app',
      command: 'head -c 24M /dev/urandom > broker-big.bin && echo seeded', timeoutMs: 30_000,
    } as never, 'remote_bash', new AbortController().signal)
    expect(seeded, JSON.stringify(seeded)).toMatchObject({ status: 'scope-exited', exitCode: 0 })

    const generationBefore = m.manager.generationOf('vps-app')
    // onStage('staging') fires as the stream begins: the kill lands mid-flow.
    const killed = await runRemoteCopy(m.stack.registry, {
      manager: m.manager as never,
      onStage: async stage => { if (stage === 'staging') fire('broker-ssh') },
    }, {
      session: m.session(),
      from: { environmentId: 'vps-app', rootId: 'app', relativePath: 'broker-big.bin' },
      to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'broker-killed.bin' },
    } as never, 'remote_copy', new AbortController().signal)
    expect(killed.status, JSON.stringify(killed)).not.toBe('committed')
    expect(['unknown', 'failed', 'cancelled'], JSON.stringify(killed)).toContain(killed.status)

    // The server reopened its dead environment; the client must observe the
    // fresh generation rather than replay the corpse proxy.
    for (let i = 0; i < 120 && m.manager.generationOf('vps-app') === generationBefore; i++) {
      await m.manager.open('vps-app').catch(() => {})
      if (m.manager.generationOf('vps-app') !== generationBefore) break
      await sleep(50)
    }
    expect(m.manager.generationOf('vps-app')).not.toBe(generationBefore)
    const sftp = await m.manager.openSftp('vps-xfer')
    const names = (await sftp.client.readdir('/import').catch(() => [])).map(e => e.name)
    expect(names).not.toContain('broker-killed.bin')
    expect(names.filter(name => name.startsWith('.dsh-staging-'))).toEqual([])
    await runRemoteCommand(m.stack.registry, m.backendFor, {
      session: m.session(), environmentId: 'vps-app', rootId: 'app',
      command: 'rm -f broker-big.bin', timeoutMs: 10_000,
    } as never, 'remote_bash', new AbortController().signal).catch(() => {})
  }, 240_000)

  it('SIGKILLing the broker daemon severs custody: ops fail closed, re-attestation recovers', async () => {
    const m = await mount(2)
    await m.stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    // Daemon kill → every op on this connection fails closed; no silent fallback.
    fire('broker-daemon')
    await sleep(800)
    const after = await runRemoteCopy(m.stack.registry, { manager: m.manager as never }, {
      session: m.session(),
      from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'anything.bin' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'never.bin' },
    } as never, 'remote_copy', new AbortController().signal)
    expect(after.status, JSON.stringify(after)).not.toBe('committed')
    expect(m.manager.generationOf('vps-app')).toBe('stale')
    expect(m.manager.sftpGenerationOf('vps-xfer')).toBe('stale')

    // systemd restarts the unit, but custody is only regained through a NEW
    // attestation — the documented semantics, verified live.
    let recovered: Awaited<ReturnType<typeof mount>> | undefined
    for (let i = 0; i < 150 && recovered === undefined; i++) {
      recovered = await mount(3).catch(() => undefined)
      if (recovered === undefined) await sleep(200)
    }
    expect(recovered, 'broker did not accept a fresh attested connection after restart').toBeDefined()
    await recovered!.stack.registry.addRemote(live.primary, { environmentId: 'vps-xfer', rootId: 'import' })
    const env = await recovered!.manager.openSftp('vps-xfer')
    expect(env.generation).toBeDefined()
    const names = (await env.client.readdir('/import').catch(() => [])).map(e => e.name)
    expect(names).not.toContain('never.bin')
  }, 240_000)
})
