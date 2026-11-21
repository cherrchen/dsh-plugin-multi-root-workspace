/**
 * R9 coverage for the personal custody mode (ADR-0049): pre-write validation,
 * ssh -G endpoint resolution, helper drop on identity change, access-key
 * lifecycle, RPC refusals, askpass argv/env, helper hash checks, team
 * attestation shape, plane reload, and secrets never leaving RPC answers.
 * Every external command goes through the injected ExecFile seam.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    await expect(save(5, '/srv/Release_Café')).rejects.toMatchObject({ code: 'personal-config-invalid' })
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

  it('sshHelperInstall resolves the host helper.js through the package root — exports never publishes lib/*', async () => {
    const { registry, personalPath } = world()
    writeConfig(personalPath, CONFIG())
    const { createRequire } = await import('node:module')
    const { createHash } = await import('node:crypto')
    const { dirname } = await import('node:path')
    const require = createRequire(import.meta.url)
    const hostHelper = join(dirname(require.resolve('@deepseek-ai/dsh-ssh/package.json')), 'lib', 'helper.js')
    const hostHash = createHash('sha256').update(readFileSync(hostHelper)).digest('hex')
    const commands: string[] = []
    const exec: ExecFile = async (_file, args) => {
      const remote = String(args.at(-1))
      commands.push(remote)
      if (remote === 'command -v node || true') return { stdout: '/usr/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') return { stdout: '/home/builder\n', stderr: '' }
      if (remote.startsWith('sha256sum ')) return { stdout: `${hostHash}  helper.js\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const state = await handlePersonalEndpoint(undefined as never as Context, registry, '/w',
      { endpoint: 'sshHelperInstall', sessionId: 's', revision: 0, environmentId: 'dev-box' }, { exec }) as { environments: PersonalEnvironment[] }
    const helper = state.environments[0]!.helper
    expect(helper?.sha256).toBe(hostHash)
    expect(helper?.helperPath).toContain('node_modules/@deepseek-ai/dsh-ssh/lib/helper.js')
    expect(helper?.protocol).toBe(3)
    expect(commands.some(cmd => cmd.includes('npm install'))).toBe(true)
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
      if (remote === 'command -v node || true') return { stdout: '/usr/local/bin/node\n', stderr: '' }
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
      if (remote === 'command -v node || true') return { stdout: 'node\n', stderr: '' } // not absolute
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toMatchObject({ code: 'helper-node-missing' })

    // A host with no node at all: `|| true` exits 0 with empty output, so the
    // check — not a bare `Command failed:` — produces `helper-node-missing`.
    await expect(installHelper(async (_f, args) => {
      const remote = String(args.at(-1))
      if (remote === 'command -v node || true') return { stdout: '', stderr: '' }
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toMatchObject({ code: 'helper-node-missing' })

    await expect(installHelper(async (_f, args) => {
      const remote = String(args.at(-1))
      if (remote === 'command -v node || true') return { stdout: '/usr/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') return { stdout: '/home/builder', stderr: '' }
      if (remote.startsWith('sha256sum ')) return { stdout: `${'0'.repeat(64)}  helper.js\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toMatchObject({ code: 'helper-hash-mismatch' })
  })

  it('installHelper retries each second-scale probe once but never retries npm install', async () => {
    const credentialRoot = join(tmp(), 'cred')
    const hostHelper = join(tmp(), 'helper.js')
    writeFileSync(hostHelper, 'HELPER-BYTES')
    const { createHash } = await import('node:crypto')
    const hostHash = createHash('sha256').update('HELPER-BYTES').digest('hex')
    const attempts = new Map<string, number>()
    const exec: ExecFile = async (_file, args) => {
      const remote = String(args.at(-1))
      attempts.set(remote, (attempts.get(remote) ?? 0) + 1)
      // Every probe flaps once — the observed post-install link flap.
      if (!remote.includes('npm install') && attempts.get(remote) === 1) {
        throw new Error('ssh: connect to host build.internal port 22: Connection timed out')
      }
      if (remote === 'command -v node || true') return { stdout: '/usr/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') return { stdout: '/home/builder', stderr: '' }
      if (remote.startsWith('sha256sum ')) return { stdout: `${hostHash}  helper.js\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const result = await installHelper(exec, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper })
    expect(result.nodePath).toBe('/usr/bin/node')
    expect(attempts.get('command -v node || true')).toBe(2)
    expect(attempts.get('printf %s "$HOME"')).toBe(2)
    const hashCommand = [...attempts.keys()].find(command => command.startsWith('sha256sum '))!
    expect(attempts.get(hashCommand)).toBe(2)
    const npmCommand = [...attempts.keys()].find(command => command.includes('npm install'))!
    expect(attempts.get(npmCommand)).toBe(1)

    // A persistent probe failure still surfaces after the single retry.
    let printfAttempts = 0
    await expect(installHelper(async (_f, args) => {
      const remote = String(args.at(-1))
      if (remote === 'command -v node || true') return { stdout: '/usr/bin/node\n', stderr: '' }
      if (remote === 'printf %s "$HOME"') { printfAttempts++; throw new Error('killed by timeout') }
      return { stdout: '', stderr: '' }
    }, SSH_CONFIG_ENV, credentialRoot, { sshVersion: '0.2.2-rc.2', hostHelperPath: hostHelper }))
      .rejects.toThrowError(/killed by timeout/)
    expect(printfAttempts).toBe(2)
  })

  it('defaultExec surfaces the exit status and stderr a bare Command failed hides', async () => {
    const { defaultExec } = await import('../src/remote/personal/credentials.ts')
    await expect(defaultExec('sh', ['-c', 'echo host key verification failed >&2; exit 255']))
      .rejects.toThrowError(/exit 255.*host key verification failed/)
    await expect(defaultExec('sh', ['-c', 'exit 1'])).rejects.toThrowError(/\(exit 1\)$/)
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
