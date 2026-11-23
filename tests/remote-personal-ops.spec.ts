/**
 * R9 coverage for the personal custody mode (ADR-0049): pre-write validation,
 * ssh -G endpoint resolution, helper drop on identity change, access-key
 * lifecycle, RPC refusals, askpass argv/env, helper hash checks, team
 * attestation shape, plane reload, and secrets never leaving RPC answers.
 * Every external command goes through the injected ExecFile seam.
 */
import { createHash as hashServerKey } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteControlPlane } from '../src/remote/plane.ts'
import { SftpClient } from '../src/remote/sftp.ts'
import { RemoteClient } from '../src/remote/protocol.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, type RemoteToolsWorld } from './support/remote-tools.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { handlePersonalEndpoint } from '../src/remote/personal-endpoints.ts'
import { parseSshCall, type SshCall, type SshStateView } from '../src/remote/personal-contract.ts'
import { loadPersonalConfig, savePersonalConfig, toDeploymentManifest, type PersonalConfig, type PersonalEnvironment } from '../src/remote/personal/config.ts'
import { CommandExecutionError, defaultExec, type ExecFile } from '../src/remote/personal/credentials.ts'
import { helperEntryCurrentPath, installAccessKey, installHelper } from '../src/remote/personal/operations.ts'
import { attestBroker, assertBrokerDestinations } from '../src/remote/broker/attest.ts'
import { bindingDigest, type DeploymentManifest } from '../src/remote/manifest.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import { Context } from '@deepseek-ai/cordis'
import { provideReadySshProfile, provideSshProfile } from './support/ssh-profile.ts'
import { readInstalledVersion, SUPPORTED_SSH_RELEASES } from '../src/compat/dsh-version.ts'
import { remoteNodeVersionStatus } from '../src/remote/ssh-diagnostics.ts'
import { SSH_SETTINGS_CHANNEL } from '../src/remote/personal-contract.ts'
import { parseErrorView } from '../src/contract.ts'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'mrfw-ops-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MANAGED: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:' + 'A'.repeat(43),
  helper: { nodePath: '/usr/bin/node', helperPath: '/h/lib/helper.js', sha256: 'a'.repeat(64), protocol: 3 },
}
const SSH_CONFIG_ENV: PersonalEnvironment = { ...MANAGED, credential: { kind: 'ssh-config', alias: 'devbox' } }
const CONFIG = (envs: PersonalEnvironment[] = [MANAGED]): PersonalConfig => ({ schemaVersion: 2, revision: 0, environments: envs, bindings: [] })

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
  writeFileSync(path, `${JSON.stringify({ ...config, schemaVersion: 1, environments: config.environments.map(environment => ({ ...environment, workspace: '/' })) })}\n`, { mode: 0o600 })
}

describe.skipIf(process.platform === 'win32')('personal endpoint behaviours (R1/R4/R5/R6, refusals, secrets)', () => {
  it('refuses every endpoint when the switch is off or the mode is not personal', async () => {
    for (const options of [{ enabled: false }, { mode: 'team' as const }, { mode: 'hardened' as const }]) {
      const { registry } = world(options)
      await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w', { endpoint: 'sshState', sessionId: 's' }))
        .rejects.toMatchObject({ code: 'remote-personal-unavailable' })
    }
  })

  it('R1: a config that fails semantic validation is refused BEFORE the write', async () => {
    const { personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG(), 0)
    const bad = CONFIG()
    bad.bindings = [{ primary: '/w', environmentId: 'dev-box', rootId: 'app', path: 'relative/not-absolute', actions: ['read'] }]
    await expect(savePersonalConfig(personalPath, { ...bad, revision: 1 }, 0))
      .rejects.toThrowError(/personal-config-invalid|absolute/)
    expect(JSON.parse(readFileSync(personalPath, 'utf8'))).toMatchObject({ revision: 0 })
  })

  it('rejects non-normalized paths at the Workspace binding endpoint', async () => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG())
    for (const path of ['/root/', '~/x', '/a//b', 'relative/path', '/a/./b']) {
      await expect(handlePersonalEndpoint(undefined as never, registry, '/w', {
        endpoint: 'sshBindingSave', sessionId: 's', revision: 0,
        binding: { environmentId: 'dev-box', path, actions: ['read'] },
      })).rejects.toMatchObject({ code: 'workspace-invalid' })
    }
    expect(loadPersonalConfig(personalPath).bindings).toEqual([])
  })

  it('isolates bindings by Workspace, shares the SSH environment, and gives recreated Roots a fresh identity', async () => {
    const { registry, personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG(), 0)
    const call = async (primary: string, payload: SshCall) =>
      await handlePersonalEndpoint(undefined as never, registry, primary, payload) as SshStateView
    const app = { environmentId: 'dev-box', path: '/srv/app', actions: ['read'] as const }
    const logs = { environmentId: 'dev-box', path: '/srv/logs', actions: ['read', 'write'] as const }
    await call('/one', { endpoint: 'sshBindingSave', sessionId: 's', revision: 0, binding: { ...app, actions: [...app.actions] } })
    const environmentBytes = readFileSync(personalPath, 'utf8')
    const firstId = loadPersonalConfig(personalPath).bindings[0]!.bindingId
    const both = await call('/one', { endpoint: 'sshBindingSave', sessionId: 's', revision: 1, binding: { ...logs, actions: [...logs.actions] } })
    expect(both.bindings).toMatchObject([{ ...app, rootId: 'app' }, { ...logs, rootId: 'logs' }])
    const another = await call('/two', { endpoint: 'sshBindingSave', sessionId: 't', revision: 2, binding: { ...app, actions: ['read'], path: '/opt/app' } })
    expect(another.bindings).toMatchObject([{ ...app, rootId: 'app', path: '/opt/app' }])
    expect(another.environments).toHaveLength(1)
    expect(readFileSync(personalPath, 'utf8')).toBe(environmentBytes)
    await expect(call('/two', { endpoint: 'sshEnvironmentRemove', sessionId: 't', revision: 3, environmentId: 'dev-box' }))
      .rejects.toMatchObject({ code: 'environment-in-use' })
    const removed = await call('/one', { endpoint: 'sshBindingRemove', sessionId: 's', revision: 3, environmentId: 'dev-box', rootId: 'app' })
    expect(removed.bindings).toMatchObject([{ ...logs, rootId: 'logs' }])
    await call('/one', { endpoint: 'sshBindingSave', sessionId: 's', revision: 4, binding: { ...app, actions: ['read'] } })
    expect(loadPersonalConfig(personalPath).bindings.find(binding => binding.primary === '/one' && binding.rootId === 'app')?.bindingId)
      .not.toBe(firstId)
  })

  it('generates a Root ID from the directory, falls back on collisions, and keeps the ID on edits', async () => {
    const { registry, personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG(), 0)
    const save = async (revision: number, path: string, rootId?: string): Promise<SshStateView> => {
      const parsed = parseSshCall('sshBindingSave', {
        sessionId: 's', revision,
        binding: { environmentId: 'dev-box', path, actions: ['read'], ...(rootId === undefined ? {} : { rootId }) },
      })
      if (!parsed.ok) throw new Error(parsed.message)
      return await handlePersonalEndpoint(undefined as never, registry, '/one', parsed.value) as SshStateView
    }

    await expect(save(0, '/srv/Release_Café')).resolves.toMatchObject({ bindings: [{ rootId: 'release-cafe' }] })
    const collision = await save(1, '/opt/release-cafe')
    const fallback = collision.bindings[1]!.rootId
    expect(fallback).toMatch(/^[a-f0-9]{8}$/)
    const unicode = await save(2, '/srv/构建')
    expect(unicode.bindings[2]!.rootId).toMatch(/^[a-f0-9]{8}$/)
    expect(unicode.bindings[2]!.rootId).not.toBe(fallback)
    const longName = 'x'.repeat(70)
    await expect(save(3, `/srv/${longName}`)).resolves.toMatchObject({
      bindings: expect.arrayContaining([expect.objectContaining({ rootId: longName.slice(0, 63) })]),
    })
    await expect(save(4, '/opt/renamed', fallback)).resolves.toMatchObject({
      bindings: expect.arrayContaining([expect.objectContaining({ path: '/opt/renamed', rootId: fallback })]),
    })
    await expect(save(5, '/tmp/unknown', 'chosen-id')).rejects.toMatchObject({ code: 'personal-config-conflict' })
    // A create-shaped re-save of an existing environment+path edits that
    // binding in place (no-op here — actions/transfers unchanged).
    const resave = await save(5, '/srv/Release_Café')
    expect(resave.bindings.filter(binding => binding.path === '/srv/Release_Café')).toMatchObject([{ rootId: 'release-cafe' }])
    expect(loadPersonalConfig(personalPath)).toMatchObject({ revision: 5 })
  })

  it('retains an existing remote transfer peer on capability edits without adding new remote peers', async () => {
    const { registry, personalPath } = world()
    const transfer = { direction: 'export' as const, peer: { environmentId: 'dev-two', rootId: 'logs' } }
    const binding = { environmentId: 'dev-box', rootId: 'app', path: '/srv/app', actions: ['read'] as const, transfers: [transfer] }
    await savePersonalConfig(personalPath, {
      ...CONFIG([MANAGED, { ...SSH_CONFIG_ENV, environmentId: 'dev-two' }]),
      bindings: [
        { ...binding, primary: '/one', actions: [...binding.actions] },
        { primary: '/one', environmentId: 'dev-two', rootId: 'logs', path: '/srv/logs', actions: ['write'] },
      ],
    }, 0)
    const request = { endpoint: 'sshBindingSave' as const, sessionId: 's', revision: 0, binding: { ...binding, actions: ['read', 'write'] as const } }
    await expect(handlePersonalEndpoint(undefined as never, registry, '/one', {
      ...request, binding: { ...request.binding, actions: [...request.binding.actions] },
    })).resolves.toMatchObject({ bindings: expect.arrayContaining([expect.objectContaining({ environmentId: 'dev-box', transfers: [transfer] })]) })
    await expect(handlePersonalEndpoint(undefined as never, registry, '/one', {
      ...request, revision: 1, binding: { ...request.binding, actions: ['read'], transfers: [{ ...transfer, direction: 'import' }] },
    })).rejects.toMatchObject({ code: 'personal-config-invalid' })
  })

  it('refuses a create over an existing connection ID and keeps its binding on the original host', async () => {
    const { registry, personalPath, credentialRoot } = world()
    const binding = { primary: '/w', environmentId: MANAGED.environmentId, rootId: 'app', path: '/srv/app', actions: ['read'] as ['read'] }
    await savePersonalConfig(personalPath, { ...CONFIG(), bindings: [binding] }, 0)
    const exec: ExecFile = async (file, args) => ({
      stdout: file === 'ssh-keyscan' ? `${args.at(-1)} ssh-ed25519 AAAAKEY\n` : `256 ${FP_OK} (ED25519)\n`, stderr: '',
    })
    const target = { ...MANAGED.endpoint, hostname: 'other.internal' }
    const scan = await handlePersonalEndpoint(undefined as never, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', hostname: target.hostname, port: target.port }, { exec }) as { token: string }
    await expect(handlePersonalEndpoint(undefined as never, registry, '/w', {
      endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'create', revision: 0,
      environment: { ...MANAGED, endpoint: target }, fingerprint: FP_OK, hostKeyToken: scan.token,
    }, { exec })).rejects.toMatchObject({ code: 'environment-id-conflict' })
    expect(loadPersonalConfig(personalPath)).toMatchObject({ revision: 0, environments: [MANAGED], bindings: [binding] })
    expect(existsSync(join(credentialRoot, 'known_hosts'))).toBe(false)
  })

  it.each([
    ['host', 'host-identity-unverifiable'], ['port', 'host-identity-unverifiable'],
    ['account', 'account-mismatch'], ['fingerprint', 'host-key-mismatch'],
    ['unchanged', undefined],
  ] as const)('verifies the saved alias identity before opening directory SFTP (%s)', async (changed, code) => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG([{ ...SSH_CONFIG_ENV, hostKey: FP_OK }]))
    const open = vi.spyOn(SftpClient, 'connect').mockReturnValue({
      init: async () => {}, realpath: async () => '/srv/app', readdir: async () => [], dispose() {},
    } as never)
    const host = changed === 'host' ? 'other.internal' : 'build.internal'
    const port = changed === 'port' ? 2222 : 22
    const user = changed === 'account' ? 'someone' : 'builder'
    const fp = changed === 'fingerprint' ? MANAGED.hostKey : FP_OK
    const exec: ExecFile = async (file, args) => {
      if (file === 'ssh') return { stdout: `user ${user}\nhostname ${host}\nport ${port}\nuserknownhostsfile /u/.ssh/known_hosts\n`, stderr: '' }
      if (args[0] === '-F') return { stdout: `${host} ssh-ed25519 AAAAKEY\n`, stderr: '' }
      return { stdout: `256 ${fp} (ED25519)\n`, stderr: '' }
    }
    try {
      const listing = handlePersonalEndpoint(undefined as never, registry, '/w',
        { endpoint: 'sshListDirectories', sessionId: 's', environmentId: 'dev-box' }, { exec })
      if (code === undefined) {
        await expect(listing).resolves.toEqual({ path: '/srv/app', parent: '/srv', entries: [] })
        expect(open).toHaveBeenCalledWith('devbox', {})
      } else {
        await expect(listing).rejects.toMatchObject({ code })
        expect(open).not.toHaveBeenCalled()
      }
    } finally { open.mockRestore() }
  })

  it('the wire contract refuses an environmentId the store would reject (3–63 chars)', async () => {
    const draft = {
      environmentId: 'ab', platform: 'linux',
      endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
      credential: { kind: 'ssh-config', alias: 'devbox' },
        }
    const save = (environmentId: string) => parseSshCall('sshEnvironmentSave', {
      sessionId: 's', revision: 0, intent: 'create', fingerprint: FP_OK,
      environment: { ...draft, environmentId },
    })
    for (const id of ['a', 'ab', 'UPPER', 'has space', '-lead', 'x'.repeat(64)]) {
      expect(save(id).ok, id).toBe(false)
    }
    for (const id of ['abc', 'dev-box', '0kay', 'x'.repeat(63)]) {
      expect(save(id).ok, id).toBe(true)
    }
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
        }
    const scan = await handlePersonalEndpoint(undefined as never, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', alias: 'devbox', port: 22 }, { exec }) as { token: string }
    const state = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'create', revision: 0, environment: draft, fingerprint: FP_OK, hostKeyToken: scan.token },
      { exec }) as { environments: PersonalEnvironment[] }
    const saved = state.environments[0]!
    expect(saved.endpoint).toEqual({ hostname: 'real.internal', port: 2222, user: 'remoteuser' })
    expect(calls.some(args => args[1] === '-G' && args[2] === 'devbox')).toBe(true)
    // A fingerprint that does not match the resolved known_hosts is refused.
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 1, environment: draft, fingerprint: 'SHA256:WRONG', hostKeyToken: scan.token },
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

  it.each(['name', 'host', 'port', 'user', 'credential', 'host-key'] as const)('preserves the installed access key only for the same identity: %s', async change => {
    const { registry, personalPath, credentialRoot } = world()
    const original: PersonalEnvironment = { ...MANAGED, hostKey: FP_OK,
      credential: { kind: 'managed', credentialId: 'aabbccddeeff', accessKeyId: '112233445566' } }
    writeConfig(personalPath, CONFIG([original]))
    const fingerprint = change === 'host-key' ? MANAGED.hostKey : FP_OK
    const exec: ExecFile = async file => ({ stdout: file === 'ssh-keyscan' ? 'build.internal ssh-ed25519 AAAAKEY\n' : `256 ${fingerprint} (ED25519)\n`, stderr: '' })
    const scan = await handlePersonalEndpoint(undefined as never, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', hostname: change === 'host' ? 'other.internal' : original.endpoint.hostname,
        port: change === 'port' ? 2222 : 22 }, { exec }) as { token: string }
    const state = await handlePersonalEndpoint(undefined as never, registry, '/w', {
      endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 0, fingerprint, hostKeyToken: scan.token,
      environment: { environmentId: original.environmentId, platform: 'linux', displayName: 'renamed',
        endpoint: { hostname: change === 'host' ? 'other.internal' : original.endpoint.hostname,
          port: change === 'port' ? 2222 : 22, user: change === 'user' ? 'other' : original.endpoint.user },
        credential: { kind: 'managed', credentialId: change === 'credential' ? 'ffeeddccbbaa' : 'aabbccddeeff' } },
    }, { exec }) as { environments: PersonalEnvironment[] }
    const credential = state.environments[0]!.credential
    expect(credential.kind === 'managed' ? credential.accessKeyId : undefined).toBe(change === 'name' ? '112233445566' : undefined)
    if (change === 'name') expect(readFileSync(join(credentialRoot, 'ssh_config'), 'utf8')).toContain('/keys/112233445566')
  })

  it('reuses the recorded host key for identity-stable updates and still requires a token otherwise', async () => {
    const { registry, personalPath } = world()
    const original: PersonalEnvironment = { ...MANAGED, hostKey: FP_OK }
    writeConfig(personalPath, CONFIG([original]))
    const draft = {
      environmentId: original.environmentId,
      platform: 'linux' as const,
      endpoint: { ...original.endpoint },
      credential: { kind: 'managed' as const, credentialId: 'aabbccddeeff' },
      displayName: 'Updated connection',
    }
    const updated = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 0, environment: draft, fingerprint: FP_OK }) as { environments: PersonalEnvironment[] }
    expect(updated.environments[0]!.displayName).toBe('Updated connection')
    expect(updated.environments[0]!.helper).not.toBeNull()

    // A changed target still needs a fresh scan token even with the recorded fingerprint.
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 1,
        environment: { ...draft, endpoint: { ...draft.endpoint, hostname: 'other.internal' } }, fingerprint: FP_OK }))
      .rejects.toMatchObject({ code: 'host-key-token-required' })

    // A fingerprint that is not the recorded one is not a token substitute.
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 1, environment: draft, fingerprint: `SHA256:${'C'.repeat(43)}` }))
      .rejects.toMatchObject({ code: 'host-key-token-required' })
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
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 0, environment: draft, fingerprint: FP_OK, hostKeyToken: scan.token },
      { exec }) as { environments: PersonalEnvironment[] }
    expect(state.environments[0]!.helper).toBeNull()
  })

  it('exec without a surviving helper is refused before the token/known_hosts; a preserved helper allows it', async () => {
    const { registry, personalPath, credentialRoot } = world()
    writeConfig(personalPath, CONFIG([]))
    const exec: ExecFile = async (file) => {
      if (file === 'ssh-keyscan') return { stdout: 'build.internal ssh-ed25519 AAAAKEY\n', stderr: '' }
      if (file === 'ssh-keygen') return { stdout: `256 ${FP_OK} (ED25519)\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const scan = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshHostKeyScan', sessionId: 's', hostname: 'build.internal', port: 22 }, { exec }) as { token: string }
    const execStanza = {
      shell: ['/bin/sh', '-c'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      maxTimeoutMs: 600_000, stdoutLimit: 1_048_576, stderrLimit: 262_144, terminateGraceMs: 2_000,
    }
    await expect(handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'create', revision: 0,
        environment: { ...MANAGED, exec: execStanza }, fingerprint: FP_OK, hostKeyToken: scan.token },
      { exec })).rejects.toMatchObject({ code: 'exec-requires-helper' })
    expect(existsSync(join(credentialRoot, 'known_hosts'))).toBe(false)
    writeConfig(personalPath, CONFIG())
    const state = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshEnvironmentSave', sessionId: 's', intent: 'update', revision: 0,
        environment: { ...MANAGED, exec: execStanza }, fingerprint: FP_OK, hostKeyToken: scan.token },
      { exec }) as { environments: PersonalEnvironment[] }
    expect(state.environments[0]!.exec).toMatchObject(execStanza)
    expect(state.environments[0]!.helper).not.toBeNull()
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
      if (file === 'ssh' && failInstall && String(args.at(-1)).includes('printf')) throw new Error('remote refused the key')
      return { stdout: '', stderr: '' }
    }
    await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshCredentialPassword', sessionId: 's', label: 'pw', password: 's3cr3t' }, { exec })
    const saved = loadPersonalConfig(personalPath)
    const serverKey = 'AAAA'
    const fingerprint = hashServerKey('sha256').update(Buffer.from(serverKey, 'base64')).digest('base64').replace(/=+$/, '')
    writeFileSync(join(credentialRoot, 'known_hosts'), `build.internal ssh-ed25519 ${serverKey}\n`, { mode: 0o600 })
    const env = { ...MANAGED, hostKey: 'SHA256:' + fingerprint, credential: { kind: 'managed' as const, credentialId: '' } }
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
    expect(captured!.args.at(-1)).toContain('mv -f "$tmp" authorized_keys')
    expect(captured!.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'dsh', DSH_SSH_SECRET_FILE: join(credentialRoot, 'secrets', 'id1') })
    expect(captured!.input).toBe('ssh-ed25519 AAAAPUB\n')
  })

  const helperFixture = () => {
    const hostHelperPath = join(tmp(), 'helper.js')
    writeFileSync(hostHelperPath, 'HELPER-BYTES')
    const helperHash = hashServerKey('sha256').update('HELPER-BYTES').digest('hex')
    const options = { sshVersion: '0.2.2-rc.2', hostHelperPath }
    return { options, helperHash, credentialRoot: join(tmp(), 'cred') }
  }

  const stageOf = (command: string): string => {
    if (command.includes('uname -s')) return 'ssh-connect'
    if (command.includes('npm.status===0') && !command.includes('mkdirSync')) return 'remote-prerequisites'
    if (command.includes('mkdirSync')) return 'remote-install'
    if (command.includes('renameSync')) return 'entry-generation'
    return 'artifact-verification'
  }
  const fakeHelper = (helperHash: string, overrides: Record<string, unknown | (() => unknown)> = {}) => {
    const defaults: Record<string, unknown> = {
      'ssh-connect': 'Linux\n/usr/bin/node\n/home/builder\n',
      'remote-prerequisites': { version: 'v24.9.0', npm: true },
      'remote-install': { outcome: 'installed' },
      'artifact-verification': { tree: 'd'.repeat(64), lib: { 'helper.js': helperHash } },
      'entry-generation': { written: true },
    }
    return vi.fn<ExecFile>(async (_file, args) => {
      const stage = stageOf(args.at(-1)!)
      const override = overrides[stage]
      const response = typeof override === 'function' ? override() : override ?? defaults[stage]
      return { stdout: typeof response === 'string' ? response : JSON.stringify(response), stderr: '' }
    })
  }

  it('uses the Host Helper bytes and deploys its pinned entry after all read-only checks', async () => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const exec = fakeHelper(helperHash)
    const result = await installHelper(exec, MANAGED, credentialRoot, options)
    expect(result).toEqual({
      nodePath: '/usr/bin/node',
      helperPath: '/home/builder/.dsh-helper/0.2.2-rc.2/helper-entry.mjs',
      sha256: helperHash, integrity: 2, treeSha256: 'd'.repeat(64),
    })
    expect(exec.mock.calls.map(([, args]) => stageOf(args.at(-1)!))).toEqual([
      'ssh-connect', 'remote-prerequisites', 'remote-install', 'artifact-verification', 'entry-generation',
    ])
    const entries = JSON.parse(exec.mock.calls[4]![2]?.input ?? '{}') as { legacy?: string; current?: string }
    expect(entries.legacy).toContain('integrity check failed')
    expect(entries.legacy).not.toContain('ECDHE-PSK-CHACHA20-POLY1305')
    expect(entries.legacy).toContain('import("./node_modules/@deepseek-ai/dsh-ssh/lib/helper.js")')
    expect(entries.legacy).toContain('d'.repeat(64))
    expect(entries.current).toContain('ECDHE-PSK-CHACHA20-POLY1305')
    expect(entries.current).toContain('syncTlsExports()')
    expect(exec.mock.calls.every(([, args]) => args.includes('BatchMode=yes'))).toBe(true)
  })

  it('keeps a registered binding digest stable when the additive stream entry is installed', async () => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const exec = fakeHelper(helperHash)
    const first = await installHelper(exec, MANAGED, credentialRoot, options)
    const environment: PersonalEnvironment = { ...MANAGED, helper: { ...first, protocol: 3 } }
    const binding = { primary: '/w', environmentId: 'dev-box', rootId: 'app', path: '/srv/app', actions: ['read'] as ['read'] }
    const before = toDeploymentManifest({ ...CONFIG([environment]), bindings: [binding] }, '/tmp/remote-personal.json')
    const digest = bindingDigest(before.manifest.environments[0]!, before.manifest.bindings[0]!)

    const again = await installHelper(exec, MANAGED, credentialRoot, options)
    const after = toDeploymentManifest({ ...CONFIG([{ ...MANAGED, helper: { ...again, protocol: 3 } }]), bindings: [binding] }, '/tmp/remote-personal.json')
    expect(again).toEqual(first)
    expect(bindingDigest(after.manifest.environments[0]!, after.manifest.bindings[0]!)).toBe(digest)
  })

  it.skipIf(remoteNodeVersionStatus(process.version) !== 'ok')('runs the real preflight, npm wrapper, digest and atomic entry scripts in a temporary server home', async () => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const home = tmp()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const nodePath = join(bin, 'node')
    symlinkSync(process.execPath, nodePath)
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
if [ "$1" = '--version' ]; then echo 11.0.0; exit 0; fi
lib="$3/node_modules/@deepseek-ai/dsh-ssh/lib"
mkdir -p "$lib" || exit 1
printf %s HELPER-BYTES > "$lib/helper.js"
`, { mode: 0o700 })
    const exec: ExecFile = async (_file, args, opts) => await defaultExec('sh', ['-c', args.at(-1)!], {
      ...opts, env: { ...opts?.env, HOME: home, PATH: bin + ':/usr/bin:/bin' },
    })
    const result = await installHelper(exec, MANAGED, credentialRoot, { ...options, nodePath })
    expect(result.sha256).toBe(helperHash)
    expect(readFileSync(result.helperPath, 'utf8')).toContain(result.treeSha256)
    expect(readFileSync(helperEntryCurrentPath(result.helperPath), 'utf8')).toContain('ECDHE-PSK-CHACHA20-POLY1305')
  })

  it.each([
    ['ssh-connect', 'Linux\n\n/home/builder\n', 'helper-node-missing', 'remote-prerequisites'],
    ['ssh-connect', 'Linux\nrelative/node\n/home/builder\n', 'helper-node-path', 'remote-prerequisites'],
    ['ssh-connect', 'FreeBSD\n/usr/bin/node\n/home/builder\n', 'helper-remote-platform', 'remote-prerequisites'],
    ['remote-prerequisites', { version: 'v24.8.0', npm: true }, 'node-too-old', 'remote-prerequisites'],
    ['remote-prerequisites', { version: 'unparseable', npm: true }, 'helper-node-version', 'remote-prerequisites'],
    ['remote-prerequisites', { version: 'v24.9.0', npm: false }, 'helper-npm-missing', 'remote-prerequisites'],
    ['remote-prerequisites', { version: 'v24.9.0', directory: 'EACCES' }, 'helper-remote-directory', 'remote-prerequisites'],
    ['remote-install', { outcome: 'npm', exitCode: 1, code: 'ENOTFOUND' }, 'helper-npm-network', 'remote-install'],
    ['remote-install', { outcome: 'npm', exitCode: 1, code: 'ETARGET' }, 'helper-npm-package', 'remote-install'],
    ['remote-install', { outcome: 'npm', exitCode: 17 }, 'helper-npm-exit', 'remote-install'],
    ['remote-install', { outcome: 'npm', exitCode: 1, code: 'ENOSPC' }, 'helper-disk-space', 'remote-install'],
    ['remote-install', { outcome: 'process', code: 'ETIMEDOUT' }, 'helper-install-timeout', 'remote-install'],
    ['remote-install', 'no record', 'helper-stage-unexpected', 'remote-install'],
    ['artifact-verification', { artifact: 'missing' }, 'helper-artifact-missing', 'artifact-verification'],
    ['artifact-verification', { tree: 'x' }, 'helper-tree-invalid', 'artifact-verification'],
    ['artifact-verification', 'null', 'helper-artifact-invalid', 'artifact-verification'],
    ['artifact-verification', { tree: 'a'.repeat(64), lib: { 'helper.js': 'a'.repeat(64) } }, 'helper-hash-mismatch', 'artifact-verification'],
    ['entry-generation', { written: false, code: 'EACCES' }, 'helper-entry-write', 'entry-generation'],
  ] as const)('diagnoses %s as %s with an explicit phase', async (step, result, code, stage) => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const exec = fakeHelper(helperHash, { [step]: result })
    await expect(installHelper(exec, MANAGED, credentialRoot, options)).rejects.toMatchObject({ code, details: { stage } })
    const observed = exec.mock.calls.map(([, args]) => stageOf(args.at(-1)!))
    expect(observed.at(-1)).toBe(step)
    expect(observed.filter(observedStage => observedStage === 'remote-install')).toHaveLength(stage === 'remote-prerequisites' ? 0 : 1)
  })

  it.each([
    ['secret user@name: Permission denied (publickey).', 'ssh-connect-auth'],
    ['Host key verification failed.', 'ssh-connect-host-key'],
    ['ssh: Could not resolve hostname secret: nodename nor servname provided, or not known', 'ssh-connect-unreachable'],
    ['ssh: connect to host secret port 22: Connection timed out', 'ssh-connect-timeout'],
    ['Connection reset by secret', 'ssh-connect-interrupted'],
    ['arbitrary secret password text', 'ssh-connect-unknown'],
  ])('keeps process facts, safe excerpts, and the underlying cause for %s', async (stderr, code) => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const cause = new CommandExecutionError(255, undefined, false, stderr, new Error('secret argv'))
    const exec = fakeHelper(helperHash, { 'ssh-connect': () => { throw cause } })
    const failure = await installHelper(exec, MANAGED, credentialRoot, options).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code, cause, details: { stage: 'ssh-connect', exitCode: 255 } })
    expect(JSON.stringify(failure)).not.toContain('secret')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('classifies a lost SSH response during npm without rerunning the command', async () => {
    const { options, helperHash, credentialRoot } = helperFixture()
    const exec = fakeHelper(helperHash, {
      'remote-install': () => { throw new CommandExecutionError(undefined, undefined, true, 'secret', new Error('secret')) },
    })
    await expect(installHelper(exec, MANAGED, credentialRoot, options)).rejects.toMatchObject({
      code: 'helper-install-timeout',
      details: { stage: 'remote-install', remoteState: 'may-have-changed', retryable: false },
    })
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it.each(['saved', 'conflict', 'write failure'] as const)('records remote completion separately from Host outcome %s', async outcome => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG())
    const ctx = new Context()
    const release = '0.2.2-rc.5'
    ctx.provide('multiRootCompat', { report: { release, verdict: 'supported' } } as never)
    const profile = provideReadySshProfile(ctx, tmp(), release)
    const helperPath = join(profile, 'node_modules', '@deepseek-ai', 'dsh-ssh', 'lib', 'helper.js')
    writeFileSync(helperPath, 'HELPER-BYTES')
    const helperHash = hashServerKey('sha256').update('HELPER-BYTES').digest('hex')
    const exec = fakeHelper(helperHash, { 'entry-generation': () => {
      if (outcome === 'conflict') writeConfig(personalPath, { ...CONFIG(), revision: 1 })
      if (outcome === 'write failure') { rmSync(personalPath); writeFileSync(personalPath, 'secret config bytes') }
      return { written: true }
    } })
    const result = handlePersonalEndpoint(ctx, registry, '/w',
      { endpoint: 'sshHelperInstall', sessionId: 's', revision: 0, environmentId: 'dev-box' }, { exec })
    if (outcome === 'saved') {
      await expect(result).resolves.toMatchObject({ revision: 1, environments: [{ helper: { sha256: helperHash, protocol: 3, integrity: 2 } }] })
    } else {
      const failure = await result.catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code: outcome === 'conflict' ? 'personal-config-conflict' : 'helper-config-commit',
        details: { stage: 'config-commit', remoteState: 'verified', registration: 'unconfirmed', retryable: false },
      })
      expect(JSON.stringify(failure)).not.toContain('secret')
    }
    expect(exec.mock.calls.filter(([, args]) => args.at(-1)!.includes('mkdirSync'))).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('defaultExec keeps process status and stderr separate from the safe error message', async () => {
    await expect(defaultExec('sh', ['-c', 'echo secret >&2; exit 255']))
      .rejects.toMatchObject({ exitCode: 255, stderr: 'secret\n', message: 'External command failed (exit 255)' })
    await expect(defaultExec('sh', ['-c', 'exec sleep 10'], { timeoutMs: 20 }))
      .rejects.toMatchObject({ timedOut: true })
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
    // Match the store's atomic replacement. Same-size in-place writes can share an mtime.
    const replacement = join(dir, 'next.json')
    writeConfig(replacement, { ...CONFIG(), revision: 1 })
    renameSync(replacement, path)
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

  it('returns dependency guidance and a structured Helper refusal without affecting the local Roots RPC', async () => {
    const personalPath = join(fixture.base, 'personal.json')
    writeConfig(personalPath, CONFIG())
    world = await mountRemoteTools(fixture, {
      withPanel: true,
      beforePanel: ctx => { provideSshProfile(ctx, fixture.base) },
      remote: { enabled: false, personalPath, credentialRoot: join(fixture.base, 'cred') },
    })
    const initial = await world.panel('status', {}, SSH_SETTINGS_CHANNEL)
    expect(initial).toMatchObject({ ok: true, value: { status: { state: 'disabled' }, dependencies: { packages: expect.any(Array) } } })
    await world.stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    const result = await world.panel('status', {}, SSH_SETTINGS_CHANNEL)
    const dependencies = (result.value as { dependencies: { code: string; command?: string; packages: unknown[] } }).dependencies
    expect(dependencies.packages).toHaveLength(4)
    if (dependencies.code !== 'ssh-host-unsupported') {
      expect(dependencies.code).toMatch(/^ssh-deps-(?:private|missing)$/)
      expect(dependencies.command).toContain('dsh plugin --profile web add --save-exact')
    }
    const response = await world.panel('sshHelperInstall', { revision: 0, environmentId: 'dev-box' }, SSH_SETTINGS_CHANNEL)
    expect(response.ok).toBe(false)
    expect(parseErrorView(response.error)).toMatchObject({
      code: dependencies.code, ssh: { stage: 'host-preflight', retryable: false },
    })
    expect(await world.panel('list', { sessionId: world.session.id })).toMatchObject({ ok: true })
  })

  it.skipIf(!SUPPORTED_SSH_RELEASES.some(version => version === readInstalledVersion('@deepseek-ai/dsh')))('serializes a real SSH child failure without leaking its command output or credentials', async () => {
    const personalPath = join(fixture.base, 'personal.json')
    writeConfig(personalPath, CONFIG())
    const bin = join(fixture.base, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "alice-test-secret: Permission denied (publickey)." >&2\necho "PASSWORD=test-secret-value" >&2\nexit 255\n', { mode: 0o700 })
    world = await mountRemoteTools(fixture, {
      withPanel: true,
      beforePanel: ctx => {
        const dir = provideReadySshProfile(ctx, fixture.base, ctx.multiRootCompat.report.release!)
        writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-ssh', 'lib', 'helper.js'), 'HELPER')
      },
      remote: { enabled: false, personalPath, credentialRoot: join(fixture.base, 'cred') },
    })
    await world.stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    vi.stubEnv('PATH', bin + ':' + process.env.PATH)
    try {
      const response = await world.panel('sshHelperInstall', { revision: 0, environmentId: 'dev-box' }, SSH_SETTINGS_CHANNEL)
      expect(response).toMatchObject({ ok: false, error: { code: 'ssh-connect-auth' } })
      expect(parseErrorView(response.error)).toMatchObject({
        ssh: { stage: 'ssh-connect', exitCode: 255, stderr: 'Permission denied (SSH authentication).', remediation: 'authentication' },
      })
      expect(JSON.stringify(response)).not.toContain('test-secret')
    } finally {
      vi.unstubAllEnvs()
    }
  })

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

  it('keeps the owner store and follower IPC live across a digest change', async () => {
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
        { ...SSH_CONFIG_ENV, environmentId: 'dev-two', helper: null },
      ],
    })

    // A follower request refreshes both Hosts even if the owner has not
    // observed the edit yet. Neither side tears down its live resources.
    await expect(follower.registry.remoteList(fixture.workspace)).resolves.toMatchObject({ grants: expect.any(Array) })
    expect(reopen).not.toHaveBeenCalled()
    expect(drop).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(follower.registry.remoteStatus.state).toBe('ready')
    expect(planeOf(owner).manifestDigest).not.toBe(digest1)
    expect(planeOf(follower).manifestDigest).toBe(planeOf(owner).manifestDigest)
  })
})

describe.skipIf(process.platform === 'win32')('the personal plane fails closed on an invalid refresh', () => {
  let fixture: FixtureWorkspace
  let stacks: RegistryStack[]
  beforeEach(() => { fixture = createFixtureWorkspace('remote-personal-invalid'); stacks = [] })
  afterEach(async () => {
    for (const stack of stacks.reverse()) await stack.dispose()
    fixture.dispose()
  })

  const planeOf = (stack: RegistryStack): RemoteControlPlane =>
    (stack.registry as unknown as { remotePlane: RemoteControlPlane }).remotePlane

  it('a corrupted file refuses operations and a repair restores the retained grants', async () => {
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    const config: PersonalConfig = {
      ...CONFIG(),
      environments: [{ ...SSH_CONFIG_ENV, helper: null }],
      bindings: [{
        primary: fixture.workspace, environmentId: 'dev-box', rootId: 'app', path: '/srv/build',
        actions: ['read', 'write', 'exec'],
        transfers: [
          { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
          { direction: 'export', peer: { environmentId: 'local', rootId: 'primary' } },
        ],
      }],
    }
    writeConfig(personalPath, config)

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
    await stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(stack.registry.remoteStatus.state).toBe('ready')
    stack.registry.setRemoteEndpointVerifier({
      verify: async () => ({ platform: 'linux' as const, target: { kind: 'path' as const, value: '/srv/build' } }),
    })
    await stack.registry.addRemote(fixture.workspace, { environmentId: 'dev-box', rootId: 'app' })
    expect(JSON.stringify(await stack.registry.remoteList(fixture.workspace))).toContain('dev-box')
    const digestBefore = planeOf(stack).manifestDigest

    writeFileSync(personalPath, '{broken\n', { mode: 0o600 })
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('config-invalid')
    expect(planeOf(stack).manifest).toBeUndefined()
    expect(planeOf(stack).manifestDigest).toBeUndefined()
    await expect(stack.registry.remoteList(fixture.workspace)).rejects.toMatchObject({ code: 'remote-unavailable' })

    rmSync(personalPath)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('ready')
    expect(planeOf(stack).manifest?.environments).toEqual([])
    const emptied = await stack.registry.remoteList(fixture.workspace) as { grants: { environmentId: string; state: string }[] }
    expect(emptied.grants.every(grant => grant.state === 'revoked')).toBe(true)

    writeConfig(personalPath, config)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('ready')
    expect(planeOf(stack).manifestDigest).toBe(digestBefore)
    expect(JSON.stringify(await stack.registry.remoteList(fixture.workspace))).toContain('dev-box')
  })

  it('a file deleted while config-invalid reloads to ready with the empty manifest', async () => {
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    writeFileSync(personalPath, '{broken\n', { mode: 0o600 })
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
    await stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(stack.registry.remoteStatus.state).toBe('config-invalid')
    rmSync(personalPath)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('ready')
    expect(planeOf(stack).manifest?.environments).toEqual([])
  })

  it('a chmod that voids protection is detected as an identity change', async () => {
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    writeConfig(personalPath, { ...CONFIG(), environments: [{ ...SSH_CONFIG_ENV, helper: null }] })
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
    await stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(stack.registry.remoteStatus.state).toBe('ready')

    const { chmodSync } = await import('node:fs')
    chmodSync(personalPath, 0o644)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('config-invalid')
  })
})

describe.skipIf(process.platform === 'win32')('the personal plane rechecks protection on every refresh', () => {
  let fixture: FixtureWorkspace
  let stacks: RegistryStack[]
  beforeEach(() => { fixture = createFixtureWorkspace('remote-personal-guard'); stacks = [] })
  afterEach(async () => {
    for (const stack of stacks.reverse()) await stack.dispose()
    fixture.dispose()
  })

  it('unchanged bytes with a widened parent dir or a symlinked path still fail closed', async () => {
    const { chmodSync, symlinkSync, renameSync, rmSync: rm } = await import('node:fs')
    const { dirname } = await import('node:path')
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    writeConfig(personalPath, { ...CONFIG(), environments: [{ ...SSH_CONFIG_ENV, helper: null }] })
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
    await stack.registry.configureRemote({ enabled: true, mode: 'personal' })
    expect(stack.registry.remoteStatus.state).toBe('ready')

    chmodSync(dirname(personalPath), 0o770)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('config-invalid')
    chmodSync(dirname(personalPath), 0o700)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('ready')

    const aside = join(fixture.base, 'remote-personal.real.json')
    renameSync(personalPath, aside)
    symlinkSync(aside, personalPath)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('config-invalid')
    rm(personalPath)
    renameSync(aside, personalPath)
    await stack.registry.refreshRemotePersonal()
    expect(stack.registry.remoteStatus.state).toBe('ready')
  })
})

describe.skipIf(process.platform === 'win32')('the remote tools row waits for the plane to become ready', () => {
  it('notifies remote listeners when the owner plane turns ready at acquisition', async () => {
    const fixture = createFixtureWorkspace('remote-tools-ready')
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    writeConfig(personalPath, { ...CONFIG(), environments: [{ ...SSH_CONFIG_ENV, helper: null }] })
    // A prototype-level spy catches the notify the acquisition's openOwner
    // emits — the transition used to land with no remote event at all.
    const { default: RegistryClass } = await import('../src/registry.ts')
    const notify = vi.spyOn(RegistryClass.prototype as never, 'notifyRemoteChange' as never)
    const stack = await mountRegistryStack(join(fixture.base, 'store'), {
      remoteEnvironments: { enabled: true, mode: 'personal', personalPath, credentialRoot },
    }, { allowUserOwnedRemoteManifestForTesting: true })
    try {
      await vi.waitFor(() => expect(stack.registry.remoteStatus.state).toBe('ready'))
      expect(notify).toHaveBeenCalled()
    } finally {
      await stack.dispose()
      fixture.dispose()
    }
  })

  it('registers the verifier and tools when the plane becomes ready', async () => {
    const { Context: CordisContext } = await import('@deepseek-ai/cordis')
    const RemoteToolsRow = await import('../src/remote/tools.ts')
    const { fakeManifest } = await import('./support/fake-remote.ts')
    const ctx = new CordisContext()
    const listeners = new Set<() => void>()
    const setVerifier = vi.fn(() => () => {})
    const registerTool = vi.fn(() => () => {})
    const registry = {
      remoteEnabled: true,
      remoteManifest: fakeManifest({ primary: '/w' }),
      remoteManifestDigest: 'digest-1',
      remoteCredentialRoot: undefined as string | undefined,
      remoteStatus: { state: 'owner-without-remote-protocol' },
      configureRemote: vi.fn(async () => undefined),
      onRemoteChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      setRemoteEndpointVerifier: setVerifier,
    }
    // The report's release must equal the version the SSH packages actually
    // resolve to here — the SSH dev pin floats inside its floor, so a
    // hardcoded release flips the gate to `identity-mismatch` on a re-pin.
    const { sshPackageVersion } = await import('../src/compat/dsh-version.ts')
    ctx.provide('multiRootCompat', { report: { verdict: 'supported', release: sshPackageVersion('@deepseek-ai/dsh-ssh') } } as never)
    provideReadySshProfile(ctx, tmp(), ctx.multiRootCompat.report.release!)
    ctx.provide('multiRootProviders', {} as never)
    ctx.provide('multiRootRegistry', registry)
    ctx.provide('tools', { register: registerTool } as never)
    ctx.provide('sandboxPolicy', {} as never)
    ctx.provide('permissionPresets', {} as never)
    ctx.provide('sandbox', {} as never)
    ctx.provide('subprocess', {} as never)
    ctx.provide('sessions', {} as never)
    try {
      await ctx.plugin(RemoteToolsRow as never, { enabled: true, mode: 'personal' })
      await vi.waitFor(() => expect(registry.configureRemote).toHaveBeenCalled())
      // Wait for the ready notification before mounting the tools.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(setVerifier).not.toHaveBeenCalled()
      expect(registerTool).not.toHaveBeenCalled()

      // A ready notification causes the first mount.
      registry.remoteStatus = { state: 'ready' }
      for (const listener of listeners) listener()
      await vi.waitFor(() => expect(setVerifier).toHaveBeenCalledTimes(1))
      expect(registerTool).toHaveBeenCalledTimes(2)

      // A later identical notification does not churn live tools.
      for (const listener of listeners) listener()
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(setVerifier).toHaveBeenCalledTimes(1)
      expect(registerTool).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
