/**
 * Personal custody mode (ADR-0041 §2): config store permission checks and CAS,
 * toDeploymentManifest parity, credential store leak-freedom, managed ssh_config
 * rendering/linking, relaxed parseSshConfig, and personal-mode RPC refusals.
 * POSIX-only: the file-protection checks require a POSIX uid.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPersonalConfig, loadPersonalManifest, savePersonalConfig,
  toDeploymentManifest, type PersonalConfig,
} from '../src/remote/personal/config.ts'
import { CredentialStore } from '../src/remote/personal/credentials.ts'
import { link, linkStatus, renderHostBlock, renderSshConfig } from '../src/remote/personal/ssh-files.ts'
import { parseSshConfig } from '../src/remote/ssh-environment.ts'
import { readRemoteSettingsValue } from '../src/compat/remote-settings.ts'
import { parseRemotesView } from '../src/remote/panel-contract.ts'
import { parseSshCall, SSH_ENDPOINTS } from '../src/remote/personal-contract.ts'

const fixture = { dirs: [] as string[] }
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mrfw-personal-'))
  fixture.dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of fixture.dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ENV = {
  environmentId: 'dev-box',
  platform: 'linux' as const,
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'ssh-config' as const, alias: 'devbox' },
  hostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  helper: null,
  workspace: '/srv/build',
}

const CONFIG = (revision = 0): PersonalConfig => ({
  schemaVersion: 1, revision, environments: [ENV], bindings: [],
})

const writeConfig = (path: string, config: PersonalConfig): void => {
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 })
}

describe.skipIf(process.platform === 'win32')('personal config store', () => {
  it('a missing file loads as the empty manifest', () => {
    const path = join(tmp(), 'remote-personal.json')
    const loaded = loadPersonalManifest(path)
    expect(loaded.manifest.environments).toEqual([])
    expect(loaded.manifest.bindings).toEqual([])
    expect(loadPersonalConfig(path).environments).toEqual([])
  })

  it('refuses a group/other-accessible file, a symlink, and a group-writable parent', () => {
    const dir = tmp()
    const path = join(dir, 'remote-personal.json')
    writeConfig(path, CONFIG())
    chmodSync(path, 0o644)
    expect(() => loadPersonalManifest(path)).toThrowError(/owned by the current user/)
    chmodSync(path, 0o600)
    const linked = join(dir, 'linked.json')
    symlinkSync(path, linked)
    expect(() => loadPersonalManifest(linked)).toThrowError(/not a symlink/)
    const loose = join(dir, 'loose')
    mkdirSync(loose)
    chmodSync(loose, 0o770)
    const inside = join(loose, 'remote-personal.json')
    writeConfig(inside, CONFIG())
    expect(() => loadPersonalManifest(inside)).toThrowError(/group\/other-writable/)
  })

  it('compare-and-swap refuses a stale expected revision', () => {
    const path = join(tmp(), 'remote-personal.json')
    savePersonalConfig(path, CONFIG(0), 0)
    writeConfig(path, CONFIG(1))
    expect(() => savePersonalConfig(path, CONFIG(1), 0)).toThrowError(/personal-config-conflict|revision/)
    const saved = savePersonalConfig(path, { ...CONFIG(1), revision: 2 }, 1)
    expect(saved.revision).toBe(2)
  })

  it('toDeploymentManifest converts to the shared manifest shape', () => {
    const { manifest, digest } = toDeploymentManifest(CONFIG(), '/nowhere.json')
    const environment = manifest.environments[0]!
    expect(environment.account).toBe('builder')
    expect(environment.namespace).toBe('dev-box')
    expect(environment.transport).toBe('sftp')
    expect(environment.connection.host).toBe('devbox')
    expect(environment.credentialIsolation).toBe('unattested')
    expect(manifest.configVersion).toBe('personal-0')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe.skipIf(process.platform === 'win32')('managed ssh files', () => {
  it('renders the managed host block and regenerates ssh_config', () => {
    const root = join(tmp(), 'ssh')
    mkdirSync(root, { mode: 0o700 })
    const managed = { ...ENV, credential: { kind: 'managed' as const, credentialId: 'aa11bb22cc33' } }
    const block = renderHostBlock(managed, root)
    expect(block).toContain('Host dsh-dev-box')
    expect(block).toContain(`IdentityFile ${join(root, 'keys', 'aa11bb22cc33')}`)
    expect(block).toContain('IdentitiesOnly yes')
    expect(block).toContain('BatchMode yes')
    renderSshConfig({ schemaVersion: 1, revision: 0, environments: [managed], bindings: [] }, root)
    const rendered = readFileSync(join(root, 'ssh_config'), 'utf8')
    expect(rendered).toContain('Host dsh-dev-box')
    expect(statSync(join(root, 'ssh_config')).mode & 0o077).toBe(0)
  })

  it('link() prepends the Include line once and backs up the original', () => {
    const home = tmp()
    const ssh = join(home, '.ssh')
    mkdirSync(ssh, { mode: 0o700 })
    writeFileSync(join(ssh, 'config'), 'Host *\n  ServerAliveInterval 30\n', { mode: 0o600 })
    const root = join(tmp(), 'cred')
    mkdirSync(root, { mode: 0o700 })
    renderSshConfig({ schemaVersion: 1, revision: 0, environments: [], bindings: [] }, root)
    expect(linkStatus(root, home).linked).toBe(false)
    link(root, home)
    const content = readFileSync(join(ssh, 'config'), 'utf8')
    expect(content.split('\n')[0]).toBe(`Include "${join(root, 'ssh_config')}"`)
    expect(linkStatus(root, home).linked).toBe(true)
    link(root, home)
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toBe(content)
    const backups = readdirSync(ssh).filter(file => file.startsWith('config.dsh-backup-'))
    expect(backups.length).toBe(1)
  })
})

describe('relaxed ssh -G parsing and fail-closed settings', () => {
  const strictOutput = 'user builder\nhostname build.internal\nstricthostkeychecking yes\nbatchmode yes\nforwardagent no\nuserknownhostsfile ~/.ssh/known_hosts\nport 22\n'
  const relaxedOutput = 'user builder\nhostname build.internal\nstricthostkeychecking ask\nbatchmode no\nforwardagent yes\nport 22\n'

  it('strict parsing refuses relaxed flags; relaxed parsing accepts them', () => {
    expect(parseSshConfig(strictOutput).user).toBe('builder')
    expect(() => parseSshConfig(relaxedOutput)).toThrowError(/strictHostKeyChecking/)
    expect(parseSshConfig(relaxedOutput, { relaxed: true }).user).toBe('builder')
    expect(() => parseSshConfig('hostname build.internal\n', { relaxed: true })).toThrowError(/no user\/hostname/)
  })

  it('an unknown settings mode fails closed to disabled', () => {
    const warnings: string[] = []
    const read = readRemoteSettingsValue({ enabled: true, mode: 'mystery' }, message => warnings.push(message))
    expect(read.enabled).toBe(false)
    expect(warnings.length).toBe(1)
    expect(readRemoteSettingsValue({ enabled: true, mode: 'team' }, () => {}).enabled).toBe(true)
  })

  it('unwraps Schemastery volatile settings fields', () => {
    const volatile = (value: unknown) => ({
      get: () => value,
      [Symbol.for('cosmokit.volatile.write')]: () => value,
    })
    const read = readRemoteSettingsValue({ enabled: volatile(true), mode: volatile('team') }, () => {})
    expect(read).toEqual({ enabled: true, mode: 'team' })
    // The wrapper is not a mode; an enabled document with one still fails closed.
    const warnings: string[] = []
    expect(readRemoteSettingsValue({ enabled: true, mode: volatile({}) }, message => warnings.push(message)))
      .toEqual({ enabled: false })
    expect(warnings.length).toBe(1)
  })

  it('treats an unreadable optional custodyMode as absent, not a bad view', () => {
    const view = parseRemotesView({
      primaryRoot: '/w',
      mode: 'workspace-write',
      custodyMode: {},
      status: { state: 'ready' },
      endpoints: [],
    })
    expect(view.ok).toBe(true)
    if (view.ok) expect(view.value.custodyMode).toBeUndefined()
  })

  it('every personal endpoint parses sessionId and rejects unknown keys', () => {
    for (const endpoint of SSH_ENDPOINTS) {
      const bad = parseSshCall(endpoint, { sessionId: 's1', bogus: 1 })
      expect(bad.ok).toBe(false)
    }
    const state = parseSshCall('sshState', { sessionId: 's1' })
    expect(state.ok).toBe(true)
    const scan = parseSshCall('sshHostKeyScan', { sessionId: 's1', hostname: 'h', port: 2222 })
    expect(scan.ok).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('credential store', () => {
  it('password credentials list metadata only — never the secret', async () => {
    const root = join(tmp(), 'cred')
    const store = new CredentialStore(root)
    const view = store.savePassword('prod', 's3cr3t-p@ssword')
    expect(view.kind).toBe('password')
    const serialized = JSON.stringify(store.list())
    expect(serialized).not.toContain('s3cr3t-p@ssword')
    expect(serialized).not.toContain('secrets/')
    expect(existsSync(join(root, 'secrets', view.id))).toBe(true)
    expect(() => store.remove(view.id, () => true)).toThrowError(/still referenced/)
    store.remove(view.id, () => false)
    expect(store.list()).toEqual([])
  })
})
