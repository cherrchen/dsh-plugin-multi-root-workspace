/**
 * R9 coverage for the personal custody mode (ADR-0041): pre-write validation,
 * ssh -G endpoint resolution, helper drop on identity change, access-key
 * lifecycle, RPC refusals, askpass argv/env, helper hash checks, team
 * attestation shape, plane reload, and secrets never leaving RPC answers.
 * Every external command goes through the injected ExecFile seam.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteControlPlane } from '../src/remote/plane.ts'
import { RemoteClient } from '../src/remote/protocol.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, type RemoteToolsWorld } from './support/remote-tools.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { handlePersonalEndpoint } from '../src/remote/personal-endpoints.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from '../src/remote/personal/config.ts'
import type { ExecFile } from '../src/remote/personal/credentials.ts'
import { installAccessKey, installHelper } from '../src/remote/personal/operations.ts'
import { attestBroker, assertBrokerDestinations } from '../src/remote/broker/attest.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import type { Context } from '@deepseek-ai/cordis'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'mrfw-ops-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MANAGED: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:' + 'A'.repeat(43),
  helper: { nodePath: '/usr/bin/node', helperPath: '/h/lib/helper.js', sha256: 'a'.repeat(64), protocol: 3 },
  workspace: '/srv/build',
}
const SSH_CONFIG_ENV: PersonalEnvironment = { ...MANAGED, credential: { kind: 'ssh-config', alias: 'devbox' } }
const CONFIG = (envs: PersonalEnvironment[] = [MANAGED]): PersonalConfig => ({ schemaVersion: 1, revision: 0, environments: envs, bindings: [] })

/** A world: tmp personalPath + credentialRoot, a stub registry in personal mode. */
const world = (options: { mode?: 'personal' | 'team' | 'hardened'; enabled?: boolean } = {}) => {
  const dir = tmp()
  const personalPath = join(dir, 'remote-personal.json')
  const credentialRoot = join(dir, 'cred')
  const registry = {
    remoteEnabled: options.enabled ?? true,
    remoteMode: options.mode ?? 'personal',
    remotePersonalPath: personalPath,
    remoteCredentialRoot: credentialRoot,
    refreshRemotePersonal: async () => {},
  } as unknown as MultiRootRegistry
  return { registry, personalPath, credentialRoot }
}

const FP_OK = 'SHA256:' + 'B'.repeat(43)
const writeConfig = (path: string, config: PersonalConfig): void => {
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 })
}

describe.skipIf(process.platform === 'win32')('personal endpoint behaviours (R1/R4/R5/R6, refusals, secrets)', () => {
  it('refuses every endpoint when the switch is off or the mode is not personal', async () => {
    for (const options of [{ enabled: false }, { mode: 'team' as const }, { mode: 'hardened' as const }]) {
      const { registry } = world(options)
      await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w', { endpoint: 'sshState', sessionId: 's' }))
        .rejects.toMatchObject({ code: 'remote-personal-unavailable' })
    }
  })

  it('R1: a config that fails semantic validation is refused BEFORE the write', () => {
    const { personalPath } = world()
    savePersonalConfig(personalPath, CONFIG(), 0)
    const bad = CONFIG()
    bad.bindings = [{ primary: '/w', environmentId: 'dev-box', rootId: 'app', path: 'relative/not-absolute', actions: ['read'] }]
    expect(() => savePersonalConfig(personalPath, { ...bad, revision: 1 }, 0))
      .toThrowError(/personal-config-invalid|absolute/)
    expect(JSON.parse(readFileSync(personalPath, 'utf8'))).toMatchObject({ revision: 0 })
  })

  it('R4: an ssh-config save resolves the endpoint through ssh -G, not the draft', async () => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG([]))
    const calls: string[][] = []
    const exec: ExecFile = async (file, args) => {
      calls.push([file, ...args])
      if (args[0] === '-G') {
        return { stdout: 'user remoteuser\nhostname real.internal\nport 2222\nuserknownhostsfile /u/.ssh/known_hosts\nglobalknownhostsfile /dev/null\n', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-F') return { stdout: '[real.internal]:2222 ssh-ed25519 AAAAKEY\n', stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP_OK} (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const draft = {
      environmentId: 'dev-box', platform: 'linux' as const,
      endpoint: { hostname: 'lie.example', port: 1, user: 'liar' },
      credential: { kind: 'ssh-config' as const, alias: 'devbox' },
      workspace: '/srv/build',
    }
    const state = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', revision: 0, environment: draft, fingerprint: FP_OK },
      { exec }) as { environments: PersonalEnvironment[] }
    const saved = state.environments[0]!
    expect(saved.endpoint).toEqual({ hostname: 'real.internal', port: 2222, user: 'remoteuser' })
    expect(calls.some(args => args[1] === '-G' && args[2] === 'devbox')).toBe(true)
    // A fingerprint that does not match the resolved known_hosts is refused.
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', revision: 1, environment: draft, fingerprint: 'SHA256:WRONG' },
      { exec })).rejects.toMatchObject({ code: 'host-key-mismatch' })
  })

  it('an alias scan returns the known_hosts fingerprint and the resolved endpoint', async () => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG([]))
    const exec: ExecFile = async (file, args) => {
      if (args[0] === '-G') {
        return { stdout: 'user remoteuser\nhostname real.internal\nport 2222\nuserknownhostsfile /u/.ssh/known_hosts\nglobalknownhostsfile /dev/null\n', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-F') return { stdout: '[real.internal]:2222 ssh-ed25519 AAAAKEY\n', stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP_OK} (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const scan = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', alias: 'devbox', port: 22 }, { exec }) as
      { token: string; keys: { type: string; fingerprint: string }[]; endpoint: { hostname: string; port: number; user: string } }
    expect(scan.keys).toEqual([{ type: 'known-hosts', fingerprint: FP_OK }])
    expect(scan.endpoint).toEqual({ hostname: 'real.internal', port: 2222, user: 'remoteuser' })
    // A scan whose alias resolves zero usable known_hosts keys is refused.
    const execNoKey: ExecFile = async (file, args) => {
      if (args[0] === '-G') {
        return { stdout: 'user u\nhostname h\nport 22\nuserknownhostsfile /u/.ssh/known_hosts\nglobalknownhostsfile /dev/null\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', alias: 'devbox', port: 22 }, { exec: execNoKey }))
      .rejects.toMatchObject({ code: 'host-identity-unverifiable' })
  })

  it('R5: saving over a changed host/account/credential drops the stored helper', async () => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG())
    const exec: ExecFile = async (file) => {
      if (file === 'ssh-keyscan') return { stdout: 'build.internal ssh-ed25519 AAAAKEY\n', stderr: '' }
      if (file === 'ssh-keygen') return { stdout: `256 ${FP_OK} (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const scan = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', hostname: 'other.internal', port: 22 }, { exec }) as { token: string }
    const draft = { ...MANAGED, credential: { kind: 'managed' as const, credentialId: 'aabbccddeeff' }, endpoint: { hostname: 'other.internal', port: 22, user: 'builder' } }
    const state = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', revision: 0, environment: draft, fingerprint: FP_OK, hostKeyToken: scan.token },
      { exec }) as { environments: PersonalEnvironment[] }
    expect(state.environments[0]!.helper).toBeNull()
  })

  it('R6: a failed access-key install removes the orphan key; env remove cleans its access key', async () => {
    const { registry, personalPath, credentialRoot } = world()
    writeConfig(personalPath, CONFIG())
    let failInstall = true
    const exec: ExecFile = async (file, args) => {
      if (file === 'ssh-keygen' && args[0] === '-t') {
        writeFileSync(String(args.at(-1)), 'PRIV', { mode: 0o600 })
        writeFileSync(`${String(args.at(-1))}.pub`, 'ssh-ed25519 AAAAPUB\n', { mode: 0o644 })
        return { stdout: '', stderr: '' }
      }
      if (file === 'ssh' && failInstall) throw new Error('remote refused the key')
      return { stdout: '', stderr: '' }
    }
    await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshCredentialPassword', sessionId: 's', label: 'pw', password: 's3cr3t' }, { exec })
    const saved = loadPersonalConfig(personalPath)
    const env = { ...MANAGED, credential: { kind: 'managed' as const, credentialId: '' } }
    env.credential = { kind: 'managed', credentialId: JSON.parse(readFileSync(join(credentialRoot, 'credentials.json'), 'utf8'))[0].id }
    writeConfig(personalPath, { ...saved, environments: [env] })
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshAccessKeyInstall', sessionId: 's', revision: 0, environmentId: 'dev-box' }, { exec }))
      .rejects.toThrowError(/remote refused the key/)
    // No orphan access key survives the failed install.
    const records = JSON.parse(readFileSync(join(credentialRoot, 'credentials.json'), 'utf8')) as { purpose?: string }[]
    expect(records.filter(record => record.purpose === 'access-key')).toEqual([])
    // Success path marks the key and environment removal deletes it.
    failInstall = false
    await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshAccessKeyInstall', sessionId: 's', revision: 0, environmentId: 'dev-box' }, { exec })
    const afterInstall = JSON.parse(readFileSync(join(credentialRoot, 'credentials.json'), 'utf8')) as { purpose?: string; environmentId?: string }[]
    expect(afterInstall.some(record => record.purpose === 'access-key' && record.environmentId === 'dev-box')).toBe(true)
    const rev = loadPersonalConfig(personalPath).revision
    await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentRemove', sessionId: 's', revision: rev, environmentId: 'dev-box' }, { exec })
    const final = JSON.parse(readFileSync(join(credentialRoot, 'credentials.json'), 'utf8')) as { purpose?: string }[]
    expect(final.filter(record => record.purpose === 'access-key')).toEqual([])
  })

  it('no RPC answer ever serializes private-key or password bytes', async () => {
    const { registry, personalPath, credentialRoot } = world()
    writeConfig(personalPath, CONFIG())
    const exec: ExecFile = async (file, args) => {
      if (file === 'ssh-keygen' && args[0] === '-t') {
        writeFileSync(String(args.at(-1)), 'OPENSSH-PRIVATE-KEY-BYTES', { mode: 0o600 })
        writeFileSync(`${String(args.at(-1))}.pub`, 'ssh-ed25519 AAAAPUB\n', { mode: 0o644 })
        return { stdout: '', stderr: '' }
      }
      if (file === 'ssh-keygen' && args[0] === '-y') return { stdout: 'ssh-ed25519 AAAAPUB\n', stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: '256 SHA256:FP (ED25519)\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const answers: unknown[] = []
    answers.push(await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshCredentialGenerate', sessionId: 's', label: 'gen' }, { exec }))
    answers.push(await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshCredentialImport', sessionId: 's', label: 'imp', privateKey: 'OPENSSH-PRIVATE-KEY-BYTES' }, { exec }))
    answers.push(await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshCredentialPassword', sessionId: 's', label: 'pw', password: 's3cr3t-p@ss' }, { exec }))
    answers.push(await handlePersonalEndpoint(undefined as never as Context, registry, '/w', { endpoint: 'sshState', sessionId: 's' }, { exec }))
    const wire = JSON.stringify(answers)
    expect(wire).not.toContain('OPENSSH-PRIVATE-KEY-BYTES')
    expect(wire).not.toContain('s3cr3t-p@ss')
    expect(credentialRoot).toBeTruthy()
  })
})

describe.skipIf(process.platform === 'win32')('operations argv/env and hash checks', () => {
  const accessKeyEnv = SSH_CONFIG_ENV
  it('installAccessKey uses the askpass argv/env contract', async () => {
    const credentialRoot = join(tmp(), 'cred')
    let captured: { args: readonly string[]; env?: Record<string, string>; input?: string } | undefined
    const exec: ExecFile = async (_file, args, options) => { captured = { args, env: options?.env, input: options?.input }; return { stdout: '', stderr: '' } }
    await installAccessKey(exec, accessKeyEnv, credentialRoot, { publicKey: 'ssh-ed25519 AAAAPUB' }, join(credentialRoot, 'secrets', 'id1'))
    expect(captured!.args).toContain('-F')
    expect(captured!.args).toContain('BatchMode=no')
    expect(captured!.args).toContain('PubkeyAuthentication=no')
    expect(captured!.args).toContain('dsh-dev-box')
    expect(captured!.args.at(-1)).toBe('umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys')
    expect(captured!.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'dsh', DSH_SSH_SECRET_FILE: join(credentialRoot, 'secrets', 'id1') })
    expect(captured!.input).toBe('ssh-ed25519 AAAAPUB\n')
  })

  it('installHelper resolves node remotely, rejects non-absolute, and verifies the hash', async () => {
    const credentialRoot = join(tmp(), 'cred')
    const hostHelper = join(tmp(), 'helper.js')
    writeFileSync(hostHelper, 'HELPER-BYTES')
    const { createHash } = await import('node:crypto')
    const hostHash = createHash('sha256').update('HELPER-BYTES').digest('hex')
    const commands: string[] = []
    const exec: ExecFile = async (_file, args) => {
      const remote = String(args.at(-1))
      commands.push(remote)
      if (remote === 'command -v node') return { stdout: '/usr/local/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') return { stdout: '/home/builder', stderr: '' }
      if (remote.startsWith('sha256sum ')) return { stdout: `${hostHash}  helper.js\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const result = await installHelper(exec, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper })
    expect(result.nodePath).toBe('/usr/local/bin/node')
    expect(result.helperPath).toBe('/home/builder/.dsh-helper/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js')
    expect(commands.some(cmd => cmd.includes('sha256sum'))).toBe(true)

    await expect(installHelper(async (_f, args) => {
      const remote = String(args.at(-1))
      if (remote === 'command -v node') return { stdout: 'node\n', stderr: '' } // not absolute
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toMatchObject({ code: 'helper-node-missing' })

    await expect(installHelper(async (_f, args) => {
      const remote = String(args.at(-1))
      if (remote === 'command -v node') return { stdout: '/usr/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') return { stdout: '/home/builder', stderr: '' }
      if (remote.startsWith('sha256sum ')) return { stdout: `${'0'.repeat(64)}  helper.js\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toMatchObject({ code: 'helper-hash-mismatch' })
  })
})

describe.skipIf(process.platform === 'win32')('team attestation shape and plane reload', () => {
  const sharedDest: DeploymentManifest = {
    configVersion: 'deploy-1',
    environments: [
      { environmentId: 'dst', platform: 'linux', account: 'build', hostKey: 'SHA256:x', namespace: 'ns', transport: 'sftp', connection: { host: 'h1' }, transfer: { maxBytes: 1, timeoutMs: 1, destinationIsolation: 'chroot-sftp' }, credentialIsolation: 'attested' },
      { environmentId: 'src', platform: 'linux', account: 'build', hostKey: 'SHA256:y', namespace: 'ns', transport: 'helper', connection: { host: 'h2', nodePath: '/n', helperPath: '/h', workspace: '/w' }, exec: { shell: ['/bin/sh', '-c'], env: {}, timeoutMs: 1, stdoutLimit: 1, stderrLimit: 1, terminateGraceMs: 1 }, helper: { sha256: 'a'.repeat(64), protocol: 3 }, credentialIsolation: 'attested' },
    ],
    bindings: [{ primary: '/w', environmentId: 'dst', rootId: 'app', path: '/srv', actions: ['read', 'write'], transfers: [{ direction: 'import', peer: { environmentId: 'src', rootId: 'app' } }] }],
    revocations: [],
  }
  it('assertBrokerDestinations relaxed keeps chroot-sftp but skips the writer loop', () => {
    // The shared-account writer loop would refuse this manifest unrelaxed…
    expect(() => assertBrokerDestinations(sharedDest)).toThrowError(/shares the copy destination account/)
    // …and team mode skips exactly that check while keeping chroot-sftp.
    expect(() => assertBrokerDestinations(sharedDest, { relaxed: true })).not.toThrow()
    const noChroot = { ...sharedDest, environments: sharedDest.environments.map(e => e.environmentId === 'dst' ? { ...e, transfer: { maxBytes: 1, timeoutMs: 1 } } : e) }
    expect(() => assertBrokerDestinations(noChroot, { relaxed: true })).toThrowError(/chroot-sftp/)
  })

  it('attestBroker(mode: team) skips confinement/full-access/independent-writer evidence', async () => {
    const root = join(tmp(), 'broker-cred')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(root, { mode: 0o700 })
    const otherUid = (process.getuid?.() ?? 0) + 1
    const config = { socketPath: '/sock', brokerUid: otherUid, credentialRoot: root }
    const attested = await attestBroker(config, sharedDest, { mode: 'team' })
    // It must get PAST the three relaxed checks — never confinement-unproven
    // or full-access-unrestricted — and reach a later check or succeed.
    if (attested.status === 'unavailable') {
      expect(['confinement-unproven', 'full-access-unrestricted', 'destination-isolation-required']).not.toContain(attested.code)
    }
    const hardened = await attestBroker(config, sharedDest, { mode: 'hardened' })
    expect(hardened.status).toBe('unavailable')
    if (hardened.status === 'unavailable') {
      expect(['confinement-unproven', 'full-access-unrestricted']).toContain(hardened.code)
    }
  })

  it('labels a follower whose owner does not serve the remote-1 plane', async () => {
    const dir = tmp()
    const personalPath = join(dir, 'remote-personal.json')
    writeConfig(personalPath, CONFIG())
    const plane = new RemoteControlPlane(
      { enabled: true, mode: 'personal', personalPath, credentialRoot: join(dir, 'cred') },
      { warn: () => {} },
    )
    const spy = vi.spyOn(RemoteClient, 'connect').mockRejectedValue(new Error('registry authority is not ready'))
    try {
      await plane.connectFollower({
        id: 'store', root: dir, endpoint: join(dir, 'v1.sock'), remoteEndpoint: join(dir, 'remote-1.sock'),
      }, 'epoch')
      expect(plane.status).toMatchObject({
        state: 'owner-without-remote-protocol',
        reason: 'registry authority is not ready',
        code: 'owner-without-remote-plane',
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('refreshPersonal reloads on file identity change and re-digests', () => {
    const dir = tmp()
    const path = join(dir, 'remote-personal.json')
    writeConfig(path, CONFIG())
    const plane = new RemoteControlPlane({ enabled: true, mode: 'personal', personalPath: path, credentialRoot: join(dir, 'cred') }, { warn: () => {} })
    expect(plane.mode).toBe('personal')
    expect(plane.manifestDigest).toMatch(/^[0-9a-f]{64}$/)
    const before = plane.manifestDigest!
    expect(plane.refreshPersonal()).toBe('unchanged')
    writeConfig(path, { ...CONFIG(), revision: 1 })
    const result = plane.refreshPersonal()
    expect(result).toBe('reloaded')
    expect(plane.manifestDigest).not.toBe(before)
    expect(plane.personalRevision).toBe(1)
    // A deleted file reloads to the empty manifest rather than erroring.
    rmSync(path)
    expect(plane.refreshPersonal()).toBe('reloaded')
    expect(plane.manifest?.environments).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('personal RPC refusals through the real command row', () => {
  let fixture: FixtureWorkspace
  let world: RemoteToolsWorld | undefined
  beforeEach(() => { fixture = createFixtureWorkspace('remote-personal-rpc') })
  afterEach(async () => { await world?.dispose(); world = undefined; fixture.dispose() })

  it('answers remote-personal-unavailable when the switch is off', async () => {
    world = await mountRemoteTools(fixture, { withPanel: true, remote: { enabled: false } })
    expect(world.stack.registry.remoteEnabled).toBe(false)
    expect(await world.panel('sshState', { sessionId: world.session.id }))
      .toMatchObject({ ok: false, error: { code: 'remote-personal-unavailable' } })
    expect(await world.panel('sshCredentialGenerate', { sessionId: world.session.id, label: 'key' }))
      .toMatchObject({ ok: false, error: { code: 'remote-personal-unavailable' } })
  })

  it('answers remote-personal-unavailable when the custody mode is not personal', async () => {
    world = await mountRemoteTools(fixture, { withPanel: true, remote: { enabled: true } })
    expect(world.stack.registry.remoteStatus.state).toBe('ready')
    expect(world.stack.registry.remoteMode).toBe('hardened')
    expect(await world.panel('sshState', { sessionId: world.session.id }))
      .toMatchObject({ ok: false, error: { code: 'remote-personal-unavailable' } })
    expect(await world.panel('sshEnvironmentRemove', { sessionId: world.session.id, revision: 0, environmentId: 'dev-box' }))
      .toMatchObject({ ok: false, error: { code: 'remote-personal-unavailable' } })
  })
})

describe.skipIf(process.platform === 'win32')('the personal plane digest rebind across authority shapes', () => {
  let fixture: FixtureWorkspace
  let stacks: RegistryStack[]
  beforeEach(() => { fixture = createFixtureWorkspace('remote-personal-rebind'); stacks = [] })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const stack of stacks.reverse()) await stack.dispose()
    fixture.dispose()
  })

  const planeOf = (stack: RegistryStack): RemoteControlPlane =>
    (stack.registry as unknown as { remotePlane: RemoteControlPlane }).remotePlane

  it('re-listens the owner and reconnects the follower on a digest change', async () => {
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    const base: PersonalConfig = { ...CONFIG(), environments: [{ ...MANAGED, helper: null }] }
    writeConfig(personalPath, base)

    const mount = async (): Promise<RegistryStack> => {
      const stack = await mountRegistryStack(join(fixture.base, 'store'), {
        remoteEnvironments: { enabled: false, personalPath, credentialRoot },
      }, {
        allowUserOwnedRemoteManifestForTesting: true,
        beforeGate: async ctx => {
          await ctx.plugin(Projections)
          await ctx.plugin(Sessions)
          await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
        },
      })
      stacks.push(stack)
      await stack.registry.refresh(fixture.workspace)
      return stack
    }

    const owner = await mount()
    await owner.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(owner.registry.remoteStatus.state).toBe('ready')
    const digest1 = planeOf(owner).manifestDigest

    const follower = await mount()
    expect(follower.registry.authority.kind).toBe('follower')
    await follower.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(follower.registry.remoteStatus.state).toBe('ready')

    const reopen = vi.spyOn(planeOf(owner), 'openOwner')
    const drop = vi.spyOn(planeOf(follower), 'dropFollower')
    const connect = vi.spyOn(planeOf(follower), 'connectFollower')

    // A real digest change in the shared personal file.
    writeConfig(personalPath, {
      ...base, revision: 1,
      environments: [
        { ...MANAGED, helper: null },
        { ...SSH_CONFIG_ENV, environmentId: 'dev-two', workspace: '/srv/two', helper: null },
      ],
    })

    // Owner-side refresh re-listens remote-1 under the new digest.
    await owner.registry.refreshRemotePersonal()
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(planeOf(owner).manifestDigest).not.toBe(digest1)

    // Follower-side refresh drops and reconnects against the owner's new listener.
    await follower.registry.refreshRemotePersonal()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(follower.registry.remoteStatus.state).toBe('ready')
    expect(planeOf(follower).manifestDigest).toBe(planeOf(owner).manifestDigest)
    // The reconnected channel really serves remote-1 requests.
    await expect(follower.registry.remoteList(fixture.workspace)).resolves.toMatchObject({ grants: expect.any(Array) })
  })
})
