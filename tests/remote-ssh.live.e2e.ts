/**
 * S3a live evidence: the REAL official SSH stack behind the G1a/G3/G4 seams.
 * Gated on DSH_MULTI_ROOT_SSH_LIVE (path to ~/.dsh-ssh-test/live.json) and a
 * POSIX initiator — without it the whole file skips cleanly.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { runRemoteCommand, type RemoteExecutionBackend } from '../src/remote/exec.ts'
import { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { sshExecBackend } from '../src/remote/ssh-exec-backend.ts'
import { SshEndpointVerifier } from '../src/remote/ssh-verifier.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const LIVE = process.env.DSH_MULTI_ROOT_SSH_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  hostKey: string; account: string; buildHost: string; xferHost: string
  nodePath: string; helperPath: string; helperSha256: string
  workspaceApp: string; workspaceLib: string; outsideSentinel: string
}

const logger = { debug: (m: string) => console.debug(m), warn: (m: string) => console.warn(m) }
function liveManifest(envOverrides: (env: Record<string, unknown>) => Record<string, unknown> = env => env): DeploymentManifest {
  const base = (environmentId: string, root: string, namespace: string) => envOverrides({
    environmentId, platform: 'linux', account: live.account, hostKey: live.hostKey,
    namespace, transport: 'helper', helper: { sha256: live.helperSha256, protocol: 3 },
    connection: { host: live.buildHost, nodePath: live.nodePath, helperPath: live.helperPath, workspace: root },
    exec: { shell: ['/bin/bash', '-c'], env: { PATH: '/usr/bin:/bin' }, maxTimeoutMs: 30_000, stdoutLimit: 8 * 1024, stderrLimit: 4 * 1024, terminateGraceMs: 2_000 },
    credentialIsolation: 'unattested',
  })
  return {
    schemaVersion: 1, configVersion: 'live-1',
    environments: [base('vps-app', live.workspaceApp, 'ns-app'), base('vps-lib', live.workspaceLib, 'ns-lib')] as never,
    bindings: [
      { primary: '', environmentId: 'vps-app', rootId: 'app', path: live.workspaceApp, actions: ['read', 'write', 'exec'] },
      { primary: '', environmentId: 'vps-lib', rootId: 'lib', path: live.workspaceLib, actions: ['read', 'write', 'exec'] },
    ] as never,
  }
}

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
let managers: SshEnvironmentManager[]
beforeEach(() => { fixture = createFixtureWorkspace('remote-ssh-live'); stacks = []; managers = [] })
afterEach(async () => {
  for (const stack of stacks.reverse()) await stack.dispose()
  for (const manager of managers.reverse()) await manager.disposeAll().catch(() => {})
  fixture.dispose()
})

function manifestFile(manifest: DeploymentManifest) {
  const path = join(fixture.base, 'deploy-live.json')
  const doc = JSON.parse(JSON.stringify(manifest)) as { bindings: { primary: string }[] }
  for (const binding of doc.bindings) binding.primary = fixture.workspace
  writeFileSync(path, JSON.stringify(doc)); chmodSync(path, 0o600)
  return path
}

async function mount(overrides?: (env: Record<string, unknown>) => Record<string, unknown>) {
  const manifest = liveManifest(overrides)
  const manager = new SshEnvironmentManager({ manifest, logger, allowUnattestedForTesting: true })
  managers.push(manager)
  const stack = await mountRegistryStack(join(fixture.base, `store-${stacks.length}`), {
    remoteEnvironments: { enabled: true, manifestPath: manifestFile(manifest) },
  }, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections); await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  stacks.push(stack)
  stack.registry.setRemoteEndpointVerifier(new SshEndpointVerifier(manager))
  const backends = new Map<string, RemoteExecutionBackend>()
  const backendFor = (environmentId: string) => backends.get(environmentId)
  const openBackend = async (environmentId: string) => {
    const environment = manifest.environments.find(e => e.environmentId === environmentId)!
    const env = await manager.open(environmentId)
    backends.set(environmentId, sshExecBackend(environment, env, manager)!)
  }
  return { stack, manager, manifest, backends, backendFor, openBackend }
}

let seq = 0
const sessionOf = (stack: RegistryStack, mode?: string) => {
  const session = stack.ctx.sessions.create(SessionId(`live-${++seq}`), { meta: { cwd: fixture.workspace } })
  if (mode !== undefined) session.append('sandbox/mode', { mode })
  return session
}
const run = (m: Awaited<ReturnType<typeof mount>>, request: Record<string, unknown>) => runRemoteCommand(
  m.stack.registry, m.backendFor,
  { session: sessionOf(m.stack), environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 15_000, ...request } as never,
  'remote_bash', new AbortController().signal,
)

liveDescribe('the real SSH stack behind the registry seams', () => {
  it('registers both environments and refuses identity drift before any connection', async () => {
    const m = await mount()
    for (const ref of [{ environmentId: 'vps-app', rootId: 'app' }, { environmentId: 'vps-lib', rootId: 'lib' }]) {
      await m.stack.registry.addRemote(fixture.workspace, ref)
    }
    const snapshot = await m.stack.registry.remoteList(fixture.workspace)
    for (const grant of snapshot.grants) expect(grant.verifiedTarget.kind).toBe('object')
    expect(snapshot.grants.every(grant => grant.state === 'registered')).toBe(true)

    const badKey = await mount(env => env.environmentId === 'vps-app' ? { ...env, hostKey: `SHA256:${'B'.repeat(43)}` } : env)
    await expect(badKey.manager.open('vps-app')).rejects.toMatchObject({ code: 'host-key-mismatch' })
    const badAccount = await mount(env => env.environmentId === 'vps-app' ? { ...env, account: 'other' } : env)
    await expect(badAccount.manager.open('vps-app')).rejects.toMatchObject({ code: 'account-mismatch' })
    const badHelper = await mount(env => env.environmentId === 'vps-app' ? { ...env, helper: { sha256: '0'.repeat(64), protocol: 3 } } : env)
    const helperError = await badHelper.manager.open('vps-app').catch((error: unknown) => error)
    expect(helperError).toBeInstanceOf(Error)
    expect((helperError as { code?: string }).code ?? (helperError as Error).message).not.toBe('host-key-mismatch')
  }, 120_000)

  it('runs confined commands, honors boundaries, truncation and timeout', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-app', rootId: 'app' })
    await m.openBackend('vps-app')
    await expect(run(m, { command: 'echo live-ok > inside.txt && cat inside.txt' })).resolves.toMatchObject({ status: 'scope-exited', scope: 'confirmed', stdout: expect.stringContaining('live-ok') })
    await expect(run(m, { command: 'cat inside.txt' })).resolves.toMatchObject({ stdout: expect.stringContaining('live-ok') })
    const sentinel = await run(m, { command: `echo owned > ${live.outsideSentinel}` })
    expect(sentinel.status === 'scope-exited' || sentinel.status === 'exited' ? sentinel.exitCode !== 0 : false).toBe(true)
    await expect(run(m, { command: `sha256sum ${live.outsideSentinel}` })).resolves.toMatchObject({ stdout: expect.stringContaining('bed43df') })
    const escape = await run(m, { command: `echo x > ${live.workspaceLib}/escape.txt` })
    expect(escape.status === 'scope-exited' || escape.status === 'exited' ? escape.exitCode !== 0 : false).toBe(true)
    await expect(run(m, { command: 'exit 7' })).resolves.toMatchObject({ status: 'scope-exited', exitCode: 7 })
    const big = await run(m, { command: 'head -c 20000 /dev/zero | tr "\\0" "x"' })
    expect(big.status === 'scope-exited' || big.status === 'exited' ? big.truncated.stdout : false).toBe(true)
    const timeout = await run(m, { command: 'sleep 30', timeoutMs: 3_000 })
    expect(['exited', 'scope-exited']).toContain(timeout.status)
    if (timeout.status === 'exited' || timeout.status === 'scope-exited') expect(timeout.termination).toBe('timeout')
    const ro = sessionOf(m.stack, 'read-only')
    const denied = await runRemoteCommand(m.stack.registry, m.backendFor, {
      session: ro, environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 1_000,
    }, 'remote_bash', new AbortController().signal)
    expect(denied).toMatchObject({ status: 'not-started', code: 'mode-denies' })
    const danger = sessionOf(m.stack, 'danger-full-access')
    await expect(runRemoteCommand(m.stack.registry, m.backendFor, {
      session: danger, environmentId: 'vps-app', rootId: 'app', command: 'echo ok', timeoutMs: 10_000,
    }, 'remote_bash', new AbortController().signal)).resolves.toMatchObject({ status: 'scope-exited', stdout: expect.stringContaining('ok') })
    await run(m, { command: 'rm -f inside.txt' })
  }, 240_000)

  it('denies a mid-admission revocation on the real backend with zero spawns', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-app', rootId: 'app' })
    await m.openBackend('vps-app')
    const real = m.backends.get('vps-app')!
    const gate = Promise.withResolvers<void>()
    let spawns = 0
    const wrapped: RemoteExecutionBackend = {
      ...real,
      confine: async (argv, policy, signal) => { const c = await real.confine(argv, policy, signal); await gate.promise; return c },
      spawn: (argv, options, sink) => { spawns++; return real.spawn(argv, options, sink) },
    }
    const pending = runRemoteCommand(m.stack.registry, () => wrapped, {
      session: sessionOf(m.stack), environmentId: 'vps-app', rootId: 'app', command: 'true', timeoutMs: 10_000,
    }, 'remote_bash', new AbortController().signal)
    void pending.catch(() => {})
    for (let i = 0; i < 200 && spawns === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await m.stack.registry.removeRemote(fixture.workspace, { environmentId: 'vps-app', rootId: 'app' })
    gate.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'not-started' })
    expect(spawns).toBe(0)
  }, 120_000)

  it('isolates environments: disposing one leaves the other and a reopen regenerates', async () => {
    const m = await mount()
    for (const ref of [{ environmentId: 'vps-app', rootId: 'app' }, { environmentId: 'vps-lib', rootId: 'lib' }]) {
      await m.stack.registry.addRemote(fixture.workspace, ref)
      await m.openBackend(ref.environmentId)
    }
    const appEnv = await m.manager.open('vps-app')
    const oldGeneration = appEnv.generation
    const libRun = run(m, { environmentId: 'vps-lib', rootId: 'lib', command: 'echo lib-ok', timeoutMs: 20_000 })
    await m.manager.dispose('vps-app')
    await expect(libRun).resolves.toMatchObject({ status: 'scope-exited', stdout: expect.stringContaining('lib-ok') })
    const reopened = await m.manager.open('vps-app')
    expect(reopened.generation).not.toBe(oldGeneration)
    expect(m.manager.generationOf('vps-app')).toBe(reopened.generation)
  }, 240_000)

  it('refuses a non-eligible injected gate before ssh -G runs', async () => {
    const calls: string[] = []
    const manager = new SshEnvironmentManager({
      manifest: liveManifest(), logger,
      gate: { status: 'absent', reason: 'host-below-floor', detail: 'x', packages: [] },
      allowUnattestedForTesting: true,
      exec: async (file, args) => { calls.push(`${file} ${args.join(' ')}`); return { stdout: '', stderr: '' } },
    })
    managers.push(manager)
    await expect(manager.open('vps-app')).rejects.toMatchObject({ code: 'ssh-capability-absent:host-below-floor' })
    expect(calls.filter(call => call.startsWith('ssh -G'))).toHaveLength(0)
  })
})
