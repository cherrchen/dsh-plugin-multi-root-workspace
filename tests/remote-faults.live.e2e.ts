/**
 * Fault-injection live evidence over the REAL official SSH stack: host-key
 * rotation recovery, a mid-transfer connection kill, the orphaned-remote-child
 * probe, and the registry-level rollback drill (revoke → historical reference
 * refuses → re-admit recovers). Gated on DSH_MULTI_ROOT_SSH_LIVE — the same
 * deployment as remote-ssh.live.e2e.ts.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { runRemoteCommand, type RemoteExecutionBackend } from '../src/remote/exec.ts'
import { runRemoteCopy, type RemoteCopyDeps } from '../src/remote/transfer.ts'
import { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { sshExecBackend } from '../src/remote/ssh-exec-backend.ts'
import { SshEndpointVerifier } from '../src/remote/ssh-verifier.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'

const LIVE = process.env.DSH_MULTI_ROOT_SSH_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  hostKey: string; account: string; buildHost: string; xferHost: string
  nodePath: string; helperPath: string; helperSha256: string
  workspaceApp: string; workspaceLib: string; outsideSentinel: string
}

const logger = { debug: (m: string) => console.debug(m), warn: (m: string) => console.warn(m) }
const exec = promisify(execFile)

const base = () => mkdtempSync(join(tmpdir(), 'remote-faults-live-'))
const sessionOf = (stack: RegistryStack, workspace: string, seq: number) =>
  stack.ctx.sessions.create(SessionId(`fault-${seq}`), { meta: { cwd: workspace } })
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
/** SIGKILL every ssh client of this initiator that talks to the build host. */
const killBuildSsh = () => exec('pkill', ['-9', '-f', `ssh.*${live.buildHost}`]).then(() => undefined, () => undefined)

function manifest(overrides: (env: Record<string, unknown>) => Record<string, unknown> = env => env): DeploymentManifest {
  const helperEnv = (environmentId: string, root: string, namespace: string) => overrides({
    environmentId, platform: 'linux', account: live.account, hostKey: live.hostKey,
    namespace, transport: 'helper', helper: { sha256: live.helperSha256, protocol: 3 },
    connection: { host: live.buildHost, nodePath: live.nodePath, helperPath: live.helperPath, workspace: root },
    exec: { shell: ['/bin/bash', '-c'], env: { PATH: '/usr/bin:/bin' }, maxTimeoutMs: 60_000, stdoutLimit: 8 * 1024, stderrLimit: 4 * 1024, terminateGraceMs: 2_000 },
    credentialIsolation: 'unattested',
  })
  return {
    schemaVersion: 1, configVersion: 'fault-1',
    environments: [
      helperEnv('vps-app', live.workspaceApp, 'ns-app'),
      overrides({
        environmentId: 'vps-xfer', platform: 'linux', account: 'dshxfer',
        hostKey: live.hostKey, namespace: 'ns-xfer', transport: 'sftp', helper: null,
        connection: { host: live.xferHost }, transfer: { maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000 },
        credentialIsolation: 'unattested',
      }),
    ] as never,
    bindings: [
      { primary: '', environmentId: 'vps-app', rootId: 'app', path: live.workspaceApp, actions: ['read', 'write', 'exec'], transfers: [
        { direction: 'export', peer: { environmentId: 'vps-xfer', rootId: 'import' } },
      ] },
      { primary: '', environmentId: 'vps-xfer', rootId: 'import', path: '/import', actions: ['read', 'write'], transfers: [
        { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
        { direction: 'export', peer: { environmentId: 'local', rootId: 'primary' } },
        { direction: 'import', peer: { environmentId: 'vps-app', rootId: 'app' } },
      ] },
    ] as never,
  }
}

const stacks: RegistryStack[] = []
const managers: SshEnvironmentManager[] = []
const dirs: string[] = []
afterAll(async () => {
  for (const stack of stacks.reverse()) await stack.dispose().catch(() => {})
  for (const manager of managers.reverse()) await manager.disposeAll().catch(() => {})
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function mount(overrides?: (env: Record<string, unknown>) => Record<string, unknown>) {
  const workspace = base(); dirs.push(workspace)
  const m = manifest(overrides)
  const doc = JSON.parse(JSON.stringify(m)) as { bindings: { primary: string }[] }
  for (const binding of doc.bindings) binding.primary = workspace
  const manifestPath = join(workspace, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(doc)); chmodSync(manifestPath, 0o600)
  const manager = new SshEnvironmentManager({ manifest: m, logger, allowUnattestedForTesting: true }); managers.push(manager)
  const stack = await mountRegistryStack(join(workspace, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath },
  }, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections); await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace })
    },
  })
  stacks.push(stack)
  stack.registry.setRemoteEndpointVerifier(new SshEndpointVerifier(manager))
  const backends = new Map<string, RemoteExecutionBackend>()
  return {
    stack, manager, manifest: m, workspace,
    openBackend: async (environmentId: string) => {
      const environment = m.environments.find(e => e.environmentId === environmentId)!
      backends.set(environmentId, sshExecBackend(environment, await manager.open(environmentId), manager)!)
    },
    run: (request: Record<string, unknown>, seq = 1) => runRemoteCommand(
      stack.registry, (id: string) => backends.get(id),
      { session: sessionOf(stack, workspace, seq), environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 60_000, ...request } as never,
      'remote_bash', new AbortController().signal,
    ),
    copy: (request: Record<string, unknown>, seq: number, onStage?: RemoteCopyDeps['onStage']) => runRemoteCopy(
      stack.registry, { manager, onStage }, {
        session: sessionOf(stack, workspace, seq),
        from: { environmentId: 'local', rootId: 'primary', relativePath: 'a.txt' },
        to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'fault.txt' },
        ...request,
      } as never, 'remote_copy', new AbortController().signal,
    ),
    listing: async (environmentId: string, dir: string) => {
      const env = await manager.openSftp(environmentId)
      return (await env.client.readdir(dir).catch(() => [])).map(entry => entry.name)
    },
  }
}

liveDescribe('real-stack fault injection and rollback', () => {
  it('host-key rotation: wrong fingerprint refuses, corrected manifest recovers', async () => {
    const wrong = await mount(env => env.environmentId === 'vps-app' ? { ...env, hostKey: `SHA256:${'C'.repeat(43)}` } : env)
    await expect(wrong.manager.open('vps-app')).rejects.toMatchObject({ code: 'host-key-mismatch' })
    await wrong.stack.dispose()

    const recovered = await mount()
    await expect(recovered.manager.open('vps-app')).resolves.toBeDefined()
    await recovered.stack.registry.addRemote(recovered.workspace, { environmentId: 'vps-app', rootId: 'app' })
    const list = await recovered.stack.registry.remoteList(recovered.workspace)
    expect(list.grants.some(g => g.environmentId === 'vps-app' && g.state === 'registered')).toBe(true)
  }, 120_000)

  it('mid-transfer connection kill: never committed, stale generation replaced, no destination residue', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(m.workspace, { environmentId: 'vps-app', rootId: 'app' })
    await m.stack.registry.addRemote(m.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    await m.openBackend('vps-app')
    const seeded = await m.run({ command: 'head -c 24M /dev/urandom > big.bin && echo seeded' })
    expect(seeded, JSON.stringify(seeded)).toMatchObject({ status: 'scope-exited', exitCode: 0 })

    const generationBefore = m.manager.generationOf('vps-app')
    const killed = await m.copy({
      from: { environmentId: 'vps-app', rootId: 'app', relativePath: 'big.bin' },
      to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'killed-relay.bin' },
    }, 2, async stage => { if (stage === 'staging') await killBuildSsh() })
    expect(killed.status, JSON.stringify(killed)).not.toBe('committed')
    expect(['unknown', 'failed', 'cancelled'], JSON.stringify(killed)).toContain(killed.status)

    // The killed connection is stale; the next open must be a fresh generation.
    await m.manager.open('vps-app')
    expect(m.manager.generationOf('vps-app')).not.toBe(generationBefore)
    // The destination never published the killed name and left no staging file.
    const names = await m.listing('vps-xfer', '/import')
    expect(names).not.toContain('killed-relay.bin')
    expect(names.filter(name => name.startsWith('.dsh-staging-'))).toEqual([])
    await m.run({ command: 'rm -f big.bin' }, 3)
  }, 240_000)

  it('killing the ssh session leaves no orphaned remote child', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(m.workspace, { environmentId: 'vps-app', rootId: 'app' })
    await m.openBackend('vps-app')
    const orphan = m.run({ command: 'sleep 45' }, 4)
    await sleep(400)
    await killBuildSsh()
    const result = await orphan
    expect(result.status, JSON.stringify(result)).not.toBe('scope-exited')

    // A fresh connection proves sshd reaped the dead session's process group.
    await m.openBackend('vps-app')
    const check = await m.run({ command: 'pgrep -x sleep || echo clean' }, 5)
    expect(check.status === 'scope-exited' || check.status === 'exited' ? check.stdout : '', JSON.stringify(check)).toContain('clean')
  }, 240_000)

  it('rollback drill: revoke refuses historical references, re-admit recovers', async () => {
    const m = await mount()
    writeFileSync(join(m.workspace, 'a.txt'), 'rollback-payload\n')
    await m.stack.registry.addRemote(m.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    const admitted = await m.copy({}, 6)
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 'committed' })

    // Rollback: revoke the registration — the previously admitted reference
    // is history now and must be refused, not cached.
    await m.stack.registry.removeRemote(m.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    const refused = await m.copy({}, 7)
    expect(refused).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })

    await m.stack.registry.addRemote(m.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    const readmitted = await m.copy({}, 8)
    expect(readmitted, JSON.stringify(readmitted)).toMatchObject({ status: 'committed' })
    const env = await m.manager.openSftp('vps-xfer')
    await env.client.remove('/import/fault.txt').catch(() => {})
  }, 180_000)
})
