/**
 * S3a live evidence: the REAL official SSH stack behind the G1a/G3/G4 seams.
 * Gated on DSH_MULTI_ROOT_SSH_LIVE (path to ~/.dsh-ssh-test/live.json) and a
 * POSIX initiator — without it the whole file skips cleanly.
 */
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const LIVE = process.env.DSH_MULTI_ROOT_SSH_LIVE
const liveDescribe = describe.skipIf(LIVE === undefined || process.platform === 'win32')
const live = LIVE === undefined ? {} as never : JSON.parse(readFileSync(LIVE, 'utf8')) as {
  hostKey: string; account: string; buildHost: string; xferHost: string
  xfer2Host?: string; xfer2Account?: string
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
    environments: [
      base('vps-app', live.workspaceApp, 'ns-app'),
      base('vps-lib', live.workspaceLib, 'ns-lib'),
      envOverrides({
        environmentId: 'vps-xfer', platform: 'linux', account: (live as { xferAccount?: string }).xferAccount ?? 'dshxfer',
        hostKey: live.hostKey, namespace: 'ns-xfer', transport: 'sftp', helper: null,
        connection: { host: live.xferHost }, transfer: { maxBytes: 2 * 1024 * 1024, timeoutMs: 60_000 },
        credentialIsolation: 'unattested',
      }),
      envOverrides({
        environmentId: 'vps-xfer2', platform: 'linux', account: live.xfer2Account ?? 'dshxfer2',
        hostKey: live.hostKey, namespace: 'ns-xfer2', transport: 'sftp', helper: null,
        connection: { host: live.xfer2Host ?? 'dsh-vps-xfer2' }, transfer: { maxBytes: 2 * 1024 * 1024, timeoutMs: 60_000 },
        credentialIsolation: 'unattested',
      }),
    ] as never,
    bindings: [
      { primary: '', environmentId: 'vps-app', rootId: 'app', path: live.workspaceApp, actions: ['read', 'write', 'exec'] },
      { primary: '', environmentId: 'vps-lib', rootId: 'lib', path: live.workspaceLib, actions: ['read', 'write', 'exec'] },
      { primary: '', environmentId: 'vps-xfer', rootId: 'import', path: '/import', actions: ['read', 'write'], transfers: [
        { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
        { direction: 'import', peer: { environmentId: 'local', rootId: 'xlib' } },
        { direction: 'export', peer: { environmentId: 'local', rootId: 'primary' } },
        { direction: 'export', peer: { environmentId: 'local', rootId: 'xlib' } },
        { direction: 'export', peer: { environmentId: 'local', rootId: 'rodst' } },
        { direction: 'export', peer: { environmentId: 'vps-xfer2', rootId: 'import' } },
      ] },
      { primary: '', environmentId: 'vps-xfer2', rootId: 'import', path: '/import', actions: ['read', 'write'], transfers: [
        { direction: 'import', peer: { environmentId: 'vps-xfer', rootId: 'import' } },
      ] },
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

liveDescribe('remote_copy over the managed SFTP account', () => {
  const created = new Set<string>()
  const depsFor = (m: Awaited<ReturnType<typeof mount>>, onStage?: RemoteCopyDeps['onStage']): RemoteCopyDeps => ({ manager: m.manager, onStage })
  const copy = (m: Awaited<ReturnType<typeof mount>>, request: Record<string, unknown>, onStage?: RemoteCopyDeps['onStage'], session?: ReturnType<typeof sessionOf>) =>
    runRemoteCopy(m.stack.registry, depsFor(m, onStage), {
      session: session ?? sessionOf(m.stack),
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src.txt' },
      to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'dst.txt' },
      ...request,
    } as never, 'remote_copy', new AbortController().signal)
  const remoteFileOf = async (m: Awaited<ReturnType<typeof mount>>, environmentId: string, path: string) => {
    const env = await m.manager.openSftp(environmentId)
    const h = await env.client.open(path, 1)
    const chunks: Buffer[] = []
    for (let off = 0;;) { const d = await env.client.read(h, off, 64 * 1024); if (d.length === 0) break; chunks.push(d); off += d.length }
    await env.client.close(h)
    return Buffer.concat(chunks)
  }
  const remoteFile = (m: Awaited<ReturnType<typeof mount>>, path: string) => remoteFileOf(m, 'vps-xfer', path)
  const cleanupRemote = async (m: Awaited<ReturnType<typeof mount>>) => {
    for (const environmentId of ['vps-xfer', 'vps-xfer2']) {
      const env = await m.manager.openSftp(environmentId).catch(() => undefined)
      if (env === undefined) continue
      for (const entry of await env.client.readdir('/import').catch(() => [])) {
        if (entry.name.startsWith('g2-')) await env.client.remove(`/import/${entry.name}`).catch(() => {})
      }
      const staging = (await env.client.readdir('/import').catch(() => [])).map(entry => entry.name).filter(name => name.startsWith('.dsh-staging-'))
      expect(staging).toEqual([])
    }
    created.clear()
  }
  const seed = async (m: Awaited<ReturnType<typeof mount>>, name: string, data: Buffer | string, environmentId = 'vps-xfer') => {
    const env = await m.manager.openSftp(environmentId)
    const payload = Buffer.from(data)
    // P_WRITE | P_CREAT | P_TRUNC: overwrite a leftover from an interrupted
    // run, and never put more than one bounded chunk into a single WRITE frame.
    const h = await env.client.open(`/import/${name}`, 0x02 | 0x08 | 0x10, 0o600)
    for (let offset = 0; offset < payload.length; offset += 32 * 1024) {
      await env.client.write(h, offset, payload.subarray(offset, offset + 32 * 1024))
    }
    await env.client.close(h)
    created.add(name)
  }
  const addGrants = async (m: Awaited<ReturnType<typeof mount>>, ...refs: { environmentId: string; rootId: string }[]) => {
    for (const ref of refs) await m.stack.registry.addRemote(fixture.workspace, ref)
  }

  it('copies primary and additional local roots and verifies sha256 remotely', async () => {
    const m = await mount()
    const extra = mkdtempSync(join(tmpdir(), 'g2-extra-'))
    writeFileSync(join(extra, 'x.txt'), 'xlib-payload')
    const statuses = await m.stack.registry.add(fixture.workspace, { path: extra })
    await m.stack.registry.setAliasId(fixture.workspace, { kind: 'id', id: statuses[0]!.id }, 'xlib')
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    writeFileSync(join(fixture.workspace, 'src.txt'), 'primary-payload')
    const one = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-primary.txt' } })
    const two = await copy(m, { from: { environmentId: 'local', rootId: 'xlib', relativePath: 'x.txt' }, to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-xlib.txt' } })
    created.add('g2-primary.txt'); created.add('g2-xlib.txt')
    expect(one.status).toBe('committed'); expect(two.status).toBe('committed')
    expect((await remoteFile(m, '/import/g2-primary.txt')).toString()).toBe('primary-payload')
    expect((await remoteFile(m, '/import/g2-xlib.txt')).toString()).toBe('xlib-payload')
    await cleanupRemote(m)
  }, 120_000)

  it('round-trips a 0-byte file and a 1 MiB random binary', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    const big = randomBytes(1024 * 1024)
    writeFileSync(join(fixture.workspace, 'src.txt'), big)
    const bigResult = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-big.bin' } })
    created.add('g2-big.bin')
    expect(bigResult).toMatchObject({ status: 'committed', bytes: 1024 * 1024 })
    expect(createHash('sha256').update(await remoteFile(m, '/import/g2-big.bin')).digest('hex')).toBe(bigResult.sha256)
    writeFileSync(join(fixture.workspace, 'src.txt'), '')
    const empty = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-empty.bin' } })
    created.add('g2-empty.bin')
    expect(empty).toMatchObject({ status: 'committed', bytes: 0 })
    await cleanupRemote(m)
  }, 240_000)

  it('refuses an existing target before staging and leaves it untouched', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    await seed(m, 'g2-taken.txt', 'existing-bytes')
    writeFileSync(join(fixture.workspace, 'src.txt'), 'new')
    const result = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-taken.txt' } })
    expect(result).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect((await remoteFile(m, '/import/g2-taken.txt')).toString()).toBe('existing-bytes')
    await cleanupRemote(m)
  }, 120_000)

  it('refuses symlink and multilinked sources', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    writeFileSync(join(fixture.workspace, 'real.txt'), 'x')
    symlinkSync('real.txt', join(fixture.workspace, 'src.txt'))
    const sym = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-sym.txt' } })
    expect(sym).toMatchObject({ status: 'failed', stage: 'source' })
    const { rmSync } = await import('node:fs')
    rmSync(join(fixture.workspace, 'src.txt'))
    linkSync(join(fixture.workspace, 'real.txt'), join(fixture.workspace, 'src.txt'))
    const multi = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-multi.txt' } })
    expect(multi).toMatchObject({ status: 'failed', code: 'source-multilinked' })
    await cleanupRemote(m)
  }, 120_000)

  it('detects a source mutated during staging and never publishes', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    writeFileSync(join(fixture.workspace, 'src.txt'), 'before')
    const result = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-mutate.txt' } }, async stage => {
      if (stage === 'staging') writeFileSync(join(fixture.workspace, 'src.txt'), 'after!!')
    })
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed' })
    await cleanupRemote(m)
  }, 120_000)

  it('cancels when the binding is revoked between staging and publish', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    writeFileSync(join(fixture.workspace, 'src.txt'), 'x')
    const result = await copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-revoke.txt' } }, async stage => {
      if (stage === 'verify') await m.stack.registry.removeRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    })
    expect(result).toMatchObject({ status: 'cancelled', code: 'admission-changed' })
    const env = await m.manager.openSftp('vps-xfer')
    await expect(env.client.lstat('/import/g2-revoke.txt')).rejects.toMatchObject({ code: 2 })
    await cleanupRemote(m)
  }, 120_000)

  it('commits exactly one of two concurrent copies to the same target', async () => {
    const m = await mount()
    await m.stack.registry.addRemote(fixture.workspace, { environmentId: 'vps-xfer', rootId: 'import' })
    const [a, b] = await Promise.all([
      (() => { writeFileSync(join(fixture.workspace, 'src.txt'), 'winner-A'); return copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-race.txt' } }) })(),
      (() => { writeFileSync(join(fixture.workspace, 'src.txt'), 'winner-B'); return copy(m, { to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-race.txt' } }) })(),
    ])
    created.add('g2-race.txt')
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(['committed', 'failed'])
    const loser = [a, b].find(r => r.status === 'failed')!
    expect(loser.code).toBe('target-exists')
    expect((await remoteFile(m, '/import/g2-race.txt')).toString()).toMatch(/^winner-[AB]$/)
    await cleanupRemote(m)
  }, 120_000)

  it('downloads from the managed SFTP account into the primary and an additional local root', async () => {
    const m = await mount()
    const extra = mkdtempSync(join(tmpdir(), 'g2-download-'))
    try {
      const statuses = await m.stack.registry.add(fixture.workspace, { path: extra })
      await m.stack.registry.setAliasId(fixture.workspace, { kind: 'id', id: statuses[0]!.id }, 'xlib')
      await addGrants(m, { environmentId: 'vps-xfer', rootId: 'import' })
      const payload = randomBytes(96 * 1024)
      await seed(m, 'g2-download-src.bin', payload)
      const toPrimary = await copy(m, {
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-download-src.bin' },
        to: { environmentId: 'local', rootId: 'primary', relativePath: 'g2-downloaded.bin' },
      })
      expect(toPrimary).toMatchObject({ status: 'committed', bytes: payload.length, staging: 'removed' })
      expect(readFileSync(join(fixture.workspace, 'g2-downloaded.bin')).equals(payload)).toBe(true)
      const toExtra = await copy(m, {
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-download-src.bin' },
        to: { environmentId: 'local', rootId: 'xlib', relativePath: 'g2-downloaded.bin' },
      })
      expect(toExtra).toMatchObject({ status: 'committed', bytes: payload.length })
      expect(readFileSync(join(extra, 'g2-downloaded.bin')).equals(payload)).toBe(true)
      expect(readdirSync(fixture.workspace).filter(name => name.startsWith('.dsh-staging-'))).toEqual([])
      expect(readdirSync(extra).filter(name => name.startsWith('.dsh-staging-'))).toEqual([])
      await cleanupRemote(m)
    } finally { rmSync(extra, { recursive: true, force: true }) }
  }, 180_000)

  it('refuses a read-only local destination and an existing local target', async () => {
    const m = await mount()
    const readOnly = mkdtempSync(join(tmpdir(), 'g2-readonly-'))
    try {
      const statuses = await m.stack.registry.add(fixture.workspace, { path: readOnly, access: 'read-only' })
      await m.stack.registry.setAliasId(fixture.workspace, { kind: 'id', id: statuses[0]!.id }, 'rodst')
      await addGrants(m, { environmentId: 'vps-xfer', rootId: 'import' })
      await seed(m, 'g2-download-src.bin', 'payload')
      const denied = await copy(m, {
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-download-src.bin' },
        to: { environmentId: 'local', rootId: 'rodst', relativePath: 'denied.bin' },
      })
      expect(denied).toMatchObject({ status: 'failed', code: 'local-destination-read-only', stage: 'admission' })
      expect(readdirSync(readOnly)).toEqual([])

      writeFileSync(join(fixture.workspace, 'g2-taken.bin'), 'keep-me')
      const taken = await copy(m, {
        from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-download-src.bin' },
        to: { environmentId: 'local', rootId: 'primary', relativePath: 'g2-taken.bin' },
      })
      expect(taken).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
      expect(readFileSync(join(fixture.workspace, 'g2-taken.bin'), 'utf8')).toBe('keep-me')
      await cleanupRemote(m)
    } finally { rmSync(readOnly, { recursive: true, force: true }) }
  }, 180_000)

  it('relays a file between two managed SFTP accounts and refuses an existing destination', async () => {
    const m = await mount()
    await addGrants(m, { environmentId: 'vps-xfer', rootId: 'import' }, { environmentId: 'vps-xfer2', rootId: 'import' })
    const payload = randomBytes(96 * 1024)
    await seed(m, 'g2-relay-src.bin', payload)
    const relayed = await copy(m, {
      from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-relay-src.bin' },
      to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g2-relay.bin' },
    })
    expect(relayed).toMatchObject({ status: 'committed', bytes: payload.length, staging: 'removed' })
    expect((await remoteFileOf(m, 'vps-xfer2', '/import/g2-relay.bin')).equals(payload)).toBe(true)
    expect((await remoteFile(m, '/import/g2-relay-src.bin')).equals(payload)).toBe(true)
    const again = await copy(m, {
      from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-relay-src.bin' },
      to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g2-relay.bin' },
    })
    expect(again).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect((await remoteFileOf(m, 'vps-xfer2', '/import/g2-relay.bin')).equals(payload)).toBe(true)
    await cleanupRemote(m)
  }, 180_000)

  it('detects a remote source changed during the relay and leaves no destination staging', async () => {
    const m = await mount()
    await addGrants(m, { environmentId: 'vps-xfer', rootId: 'import' }, { environmentId: 'vps-xfer2', rootId: 'import' })
    await seed(m, 'g2-mutate-src.bin', 'before')
    const result = await copy(m, {
      from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-mutate-src.bin' },
      to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g2-mutate.bin' },
    }, async stage => {
      if (stage !== 'staging') return
      const env = await m.manager.openSftp('vps-xfer')
      const h = await env.client.open('/import/g2-mutate-src.bin', 0x02 | 0x10)
      // Overwrite the same number of bytes: only the mtime version check can
      // notice this mutation.
      await env.client.write(h, 0, Buffer.from('after!'))
      await env.client.close(h)
    })
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed' })
    const env2 = await m.manager.openSftp('vps-xfer2')
    const names = (await env2.client.readdir('/import')).map(entry => entry.name)
    expect(names.filter(name => name.startsWith('.dsh-staging-'))).toEqual([])
    expect(names).not.toContain('g2-mutate.bin')
    await cleanupRemote(m)
  }, 180_000)

  it('refuses an over-budget remote source before the stream', async () => {
    // A deployment-small cap keeps this evidence cheap over a high-latency link.
    const m = await mount(env => env.transport === 'sftp' ? { ...env, transfer: { maxBytes: 1024, timeoutMs: 60_000 } } : env)
    await addGrants(m, { environmentId: 'vps-xfer', rootId: 'import' }, { environmentId: 'vps-xfer2', rootId: 'import' })
    await seed(m, 'g2-huge-src.bin', randomBytes(2048))
    const huge = await copy(m, {
      from: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'g2-huge-src.bin' },
      to: { environmentId: 'vps-xfer2', rootId: 'import', relativePath: 'g2-huge.bin' },
    })
    expect(huge).toMatchObject({ status: 'failed', code: 'source-too-large', stage: 'source' })
    await cleanupRemote(m)
  }, 180_000)

  it('denies a read-only session before any SFTP session opens', async () => {
    const m = await mount()
    let opens = 0
    const real = m.manager.openSftp.bind(m.manager)
    m.manager.openSftp = async (id: string) => { opens++; return await real(id) }
    const ro = sessionOf(m.stack, 'read-only')
    const result = await copy(m, {}, undefined, ro)
    expect(result).toMatchObject({ status: 'failed', code: 'mode-denies' })
    expect(opens).toBe(0)
  }, 60_000)

  it('refuses an unattested environment without the test flag before ssh -G', async () => {
    const calls: string[] = []
    const manager = new SshEnvironmentManager({
      manifest: liveManifest(), logger,
      exec: async (file, args) => { calls.push(`${file} ${args.join(' ')}`); return { stdout: '', stderr: '' } },
    })
    managers.push(manager)
    await expect(manager.openSftp('vps-xfer')).rejects.toMatchObject({ code: 'credential-isolation-unattested' })
    expect(calls.filter(call => call.startsWith('ssh -G'))).toHaveLength(0)
  })
})
