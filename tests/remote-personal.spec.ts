/**
 * Personal custody mode (ADR-0049 §2): config store permission checks and CAS,
 * toDeploymentManifest parity, credential store leak-freedom, managed ssh_config
 * rendering/linking, relaxed parseSshConfig, and personal-mode RPC refusals.
 * POSIX-only: the file-protection checks require a POSIX uid.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersonalConfig, loadPersonalManifest, savePersonalConfig,
  toDeploymentManifest, type PersonalConfig,
} from '../src/remote/personal/config.ts'
import { CredentialError, CredentialStore, defaultExec } from '../src/remote/personal/credentials.ts'
import { HostKeyScans } from '../src/remote/personal/operations.ts'
import { link, linkStatus, parseSshConfigAliases, renderHostBlock, renderSshConfig } from '../src/remote/personal/ssh-files.ts'
import { directoryListingOf } from '../src/remote/personal/remote-paths.ts'
import { parseSshConfig } from '../src/remote/ssh-environment.ts'
import { installRemoteSettings, readRemoteSettingsValue } from '../src/compat/remote-settings.ts'
import { parseRemotesView } from '../src/remote/panel-contract.ts'
import { parseSshAnswer, parseSshCall, SSH_ENDPOINTS } from '../src/remote/personal-contract.ts'

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
}

const CONFIG = (revision = 0): PersonalConfig => ({
  schemaVersion: 2, revision, environments: [ENV], bindings: [],
})

const writeConfig = (path: string, config: PersonalConfig): void => {
  writeFileSync(path, `${JSON.stringify({ ...config, schemaVersion: 1, environments: config.environments.map(environment => ({ ...environment, workspace: '/' })) })}\n`, { mode: 0o600 })
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

  it('rejects a relative path and a config-inside-bound-primary before any write', async () => {
    await expect(savePersonalConfig(join('relative', 'remote-personal.json'), CONFIG(), 0))
      .rejects.toThrowError(/must be absolute/)
    const dir = tmp()
    const inside = join(dir, 'remote-personal.json')
    const bad = CONFIG()
    bad.bindings = [{ primary: dir, environmentId: 'dev-box', rootId: 'app', path: '/srv/build', actions: ['read'] }]
    await expect(savePersonalConfig(inside, bad, 0)).rejects.toThrowError(/must not lie inside/)
    expect(existsSync(inside)).toBe(false)
  })

  it('refuses to write under a group-writable or symlinked parent before the file exists', async () => {
    const loose = join(tmp(), 'loose')
    mkdirSync(loose)
    chmodSync(loose, 0o770)
    const inside = join(loose, 'remote-personal.json')
    await expect(savePersonalConfig(inside, CONFIG(), 0)).rejects.toThrowError(/group\/other-writable/)
    expect(existsSync(inside)).toBe(false)
    expect(existsSync(`${inside}.lock`)).toBe(false)
    const real = join(tmp(), 'real')
    mkdirSync(real)
    const link = join(tmp(), 'link')
    symlinkSync(real, link)
    await expect(savePersonalConfig(join(link, 'remote-personal.json'), CONFIG(), 0)).rejects.toThrowError(/symlink/)
    expect(readdirSync(real)).toEqual([])
  })

  it('an unsafe parent rejects before touching an existing file', async () => {
    const dir = tmp()
    const path = join(dir, 'remote-personal.json')
    writeConfig(path, CONFIG())
    const before = readFileSync(path, 'utf8')
    chmodSync(dir, 0o770)
    await expect(savePersonalConfig(path, CONFIG(1), 0)).rejects.toThrowError(/group\/other-writable/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('serializes the CAS write under a kernel lease across OS processes', async () => {
    const dir = tmp()
    const path = join(dir, 'remote-personal.json')
    const lock = join(realpathSync(dir), 'remote-personal.json.lock')
    const childSource = fileURLToPath(new URL('./support/personal-lease-child.ts', import.meta.url))
    const child = spawn(process.execPath, ['--experimental-transform-types', childSource, lock], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.stdout?.once('data', () => resolve())
        child.once('exit', (code, signal) => reject(new Error(`lease child exited before ready (code=${String(code)} signal=${String(signal)})`)))
      })
      await expect(savePersonalConfig(path, CONFIG(0), 0)).rejects.toMatchObject({ code: 'personal-config-conflict' })
      expect(existsSync(path)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        child.once('exit', () => resolve())
      })
    }
    const saved = await savePersonalConfig(path, CONFIG(0), 0)
    expect(saved.revision).toBe(0)
    writeConfig(path, { ...CONFIG(0), revision: 1 })
    await expect(savePersonalConfig(path, { ...CONFIG(0), revision: 2 }, 0)).rejects.toThrowError(/personal-config-conflict|revision/)
  })

  it('compare-and-swap refuses a stale expected revision', async () => {
    const path = join(tmp(), 'remote-personal.json')
    await savePersonalConfig(path, CONFIG(0), 0)
    writeConfig(path, CONFIG(1))
    await expect(savePersonalConfig(path, CONFIG(1), 0)).rejects.toThrowError(/personal-config-conflict|revision/)
    const saved = await savePersonalConfig(path, { ...CONFIG(1), revision: 2 }, 1)
    expect(saved.revision).toBe(2)
  })

  it('migrates v1 bindings and drops the old workspace field without using it as a Root', async () => {
    const root = tmp()
    const path = join(root, 'remote-personal.json')
    const binding = { primary: '/workspace', environmentId: 'dev-box', rootId: 'data', path: '/actual/data', actions: ['read'] as const }
    const config = { ...CONFIG(), bindings: [{ ...binding, actions: [...binding.actions] }] }
    writeConfig(path, config)
    const migrated = loadPersonalConfig(path)
    expect(migrated.environments[0]).not.toHaveProperty('workspace')
    expect(migrated.bindings).toEqual(config.bindings)
    await savePersonalConfig(path, { ...migrated, revision: 1 }, 0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 2, environments: [ENV], revision: 1 })
    expect(JSON.parse(readFileSync(path + '.bindings.json', 'utf8'))).toEqual({ schemaVersion: 1, bindings: config.bindings, revision: 1 })
    expect(loadPersonalConfig(path)).toMatchObject({ ...config, revision: 1 })
    chmodSync(path + '.bindings.json', 0o644)
    expect(() => loadPersonalManifest(path)).toThrowError(/owned by the current user/)
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
    expect(block).toContain(`IdentityFile "${join(root, 'keys', 'aa11bb22cc33')}"`)
    expect(block).toContain('IdentitiesOnly yes')
    expect(block).toContain('BatchMode yes')
    renderSshConfig({ schemaVersion: 2, revision: 0, environments: [managed], bindings: [] }, root)
    const rendered = readFileSync(join(root, 'ssh_config'), 'utf8')
    expect(rendered).toContain('Host dsh-dev-box')
    expect(statSync(join(root, 'ssh_config')).mode & 0o077).toBe(0)
  })

  it('loads generated config and known_hosts paths containing spaces through real OpenSSH', () => {
    const root = join(tmp(), 'credentials with spaces')
    const home = tmp()
    mkdirSync(root, { mode: 0o700 })
    const managed = { ...ENV, credential: { kind: 'managed' as const, credentialId: 'aa11bb22cc33' } }
    renderSshConfig({ schemaVersion: 2, revision: 0, environments: [managed], bindings: [] }, root)
    link(root, home)
    const output = execFileSync('ssh', ['-G', '-F', join(home, '.ssh', 'config'), 'dsh-dev-box'], { encoding: 'utf8' })
    expect(output).toContain(`identityfile ${join(root, 'keys', 'aa11bb22cc33')}`)
    expect(parseSshConfig(output, { managedKnownHostsFile: join(root, 'known_hosts') }).knownHostsFiles).toEqual([join(root, 'known_hosts')])
    const other = output.replace(join(root, 'known_hosts'), '/other/known_hosts')
    expect(parseSshConfig(other, { managedKnownHostsFile: join(root, 'known_hosts') }).knownHostsFiles).toEqual(['/other/known_hosts'])
  })

  it('link() prepends the Include line once and backs up the original', () => {
    const home = tmp()
    const ssh = join(home, '.ssh')
    mkdirSync(ssh, { mode: 0o700 })
    writeFileSync(join(ssh, 'config'), 'Host *\n  ServerAliveInterval 30\n', { mode: 0o600 })
    const root = join(tmp(), 'cred')
    mkdirSync(root, { mode: 0o700 })
    renderSshConfig({ schemaVersion: 2, revision: 0, environments: [], bindings: [] }, root)
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

  it.each(['team', 'hardened', 'mystery', null])('fails closed on an unavailable settings mode %s', mode => {
    const warn = vi.fn()
    expect(readRemoteSettingsValue({ enabled: true, mode }, undefined, warn)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('unwraps Schemastery volatile settings fields', () => {
    const volatile = (value: unknown) => ({
      get: () => value,
      [Symbol.for('cosmokit.volatile.write')]: () => value,
    })
    const warn = vi.fn()
    expect(readRemoteSettingsValue({ enabled: volatile(true), mode: volatile('personal') }, undefined, warn)).toBe(true)
    expect(readRemoteSettingsValue({ enabled: true, mode: volatile({}) }, undefined, warn)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reads the live namespace on the legacy configure path', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    const live = { enabled: false, mode: 'personal' }
    let changes = 0
    ctx.provide('settings', {
      configure: () => () => {},
      describe: () => [{ ns: 'multi-root-remote-tools', value: live }],
    } as never)
    const settings = installRemoteSettings(ctx, () => false, () => { changes += 1 })
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settings.read()).toEqual({ enabled: false, mode: 'personal' })
      live.enabled = true
      ctx.emit('settings/document-updated', 'multi-root-remote-tools', 1)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settings.read()).toEqual({ enabled: true, mode: 'personal' })
      expect(changes).toBeGreaterThan(0)
    } finally {
      settings.fiber.dispose()
    }
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

  it('keeps the remote status diagnostic code on the wire', () => {
    const view = parseRemotesView({
      primaryRoot: '/w',
      mode: 'workspace-write',
      status: { state: 'owner-without-remote-protocol', reason: 'registry authority is not ready', code: 'owner-without-remote-plane' },
      endpoints: [],
    })
    expect(view.ok).toBe(true)
    if (view.ok) expect(view.value.status.code).toBe('owner-without-remote-plane')
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
    const view = await store.savePassword('prod', 's3cr3t-p@ssword')
    expect(view.kind).toBe('password')
    const serialized = JSON.stringify(store.list())
    expect(serialized).not.toContain('s3cr3t-p@ssword')
    expect(serialized).not.toContain('secrets/')
    expect(existsSync(join(root, 'secrets', view.id))).toBe(true)
    await expect(store.remove(view.id, () => true)).rejects.toThrowError(/still referenced/)
    await store.remove(view.id, () => false)
    expect(store.list()).toEqual([])
  })

  it('defaultExec delivers options.input to the child stdin and always closes it', async () => {
    const echo = 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(s))'
    const { stdout } = await defaultExec(process.execPath, ['-e', echo], { input: 'stdin-bytes\n', timeoutMs: 5_000 })
    expect(stdout).toBe('stdin-bytes\n')
    const done = 'process.stdin.on("end",()=>process.stdout.write("done"));process.stdin.resume()'
    const empty = await defaultExec(process.execPath, ['-e', done], { timeoutMs: 5_000 })
    expect(empty.stdout).toBe('done')
  })

  it('defaultExec input reaches `ssh-keygen -lf -` (the host-key scan path)', async () => {
    const keyPath = join(tmp(), 'scan-key')
    await defaultExec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'scan', '-f', keyPath], { timeoutMs: 30_000 })
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8')
    const { stdout } = await defaultExec('ssh-keygen', ['-lf', '-'], { input: publicKey, timeoutMs: 10_000 })
    expect(stdout).toMatch(/SHA256:[A-Za-z0-9+/=]+/)
  })

  it('HostKeyScans feeds the scanned key line to `ssh-keygen -lf -` via stdin', async () => {
    const inputs: string[] = []
    const scans = new HostKeyScans(async (file, args, options) => {
      if (file === 'ssh-keygen' && args[0] === '-lf' && args[1] === '-') {
        inputs.push(String(options?.input))
        return { stdout: `256 ${FP}(ED25519)\n`, stderr: '' }
      }
      return { stdout: 'host.example ssh-ed25519 AAAATEST\n', stderr: '' }
    })
    const { keys } = await scans.scan('host.example', 22)
    expect(keys).toHaveLength(1)
    expect(inputs).toEqual(['host.example ssh-ed25519 AAAATEST\n'])
  })

  it('a rejected import never copies the supplied passphrase into the error', async () => {
    const root = join(tmp(), 'cred')
    const store = new CredentialStore(root)
    const source = join(tmp(), 'import-source')
    await defaultExec('ssh-keygen', ['-t', 'ed25519', '-N', 'right-pass', '-C', 'repro', '-f', source], { timeoutMs: 30_000 })
    const privateKey = readFileSync(source, 'utf8')
    const passphrase = 'ZZ-SYNTHETIC-PASS-7a21'
    let thrown: unknown
    try { await store.importKey('repro', privateKey, passphrase) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CredentialError)
    expect((thrown as CredentialError).code).toBe('credential-import-failed')
    expect((thrown as Error).message).not.toContain(passphrase)
  })
})

describe('personal add-flow read helpers', () => {
  it('lists literal Host aliases and skips wildcard or negated patterns', () => {
    const aliases = parseSshConfigAliases([
      '# comment',
      'Host prod',
      '  HostName prod.internal',
      'Host build staging',
      '  User ci',
      'Host *.internal !blocked',
      'Host *',
      'Host prod',
    ].join('\n'))
    expect(aliases).toEqual(['build', 'prod', 'staging'])
  })

  it('returns only sorted child directories with a canonical parent', () => {
    const entry = (name: string, longname: string, permissions?: number) => ({
      name, longname, attrs: { flags: 4, ...(permissions === undefined ? {} : { permissions }) },
    })
    const listing = directoryListingOf('/srv', [
      entry('zeta', 'drwxr-xr-x', 0o040755),
      entry('alpha', 'drwxr-xr-x', 0o040755),
      entry('file.txt', '-rw-r--r--', 0o100644),
      entry('.', 'drwxr-xr-x', 0o040755),
      entry('..', 'drwxr-xr-x', 0o040755),
      entry('opaque-dir', 'drwxr-xr-x'),
    ])
    expect(listing).toEqual({
      path: '/srv',
      parent: '/',
      entries: [
        { name: 'alpha', path: '/srv/alpha' },
        { name: 'opaque-dir', path: '/srv/opaque-dir' },
        { name: 'zeta', path: '/srv/zeta' },
      ],
    })
    expect(directoryListingOf('/', [])).toEqual({ path: '/', parent: '/', entries: [] })
  })

  it('accepts the two read-only endpoint request and answer shapes', () => {
    expect(SSH_ENDPOINTS).toContain('sshConfigAliases')
    expect(SSH_ENDPOINTS).toContain('sshListDirectories')
    expect(parseSshCall('sshConfigAliases', { sessionId: 'session-1' })).toMatchObject({ ok: true })
    expect(parseSshCall('sshListDirectories', { sessionId: 'session-1', environmentId: 'dev-box', path: '/srv' })).toMatchObject({ ok: true })
    expect(parseSshCall('sshListDirectories', { sessionId: 'session-1', environmentId: 'dev-box', extra: true })).toMatchObject({ ok: false })
    expect(parseSshAnswer('sshConfigAliases', { aliases: ['prod.host'] })).toEqual({ ok: true, value: { aliases: ['prod.host'] } })
    expect(parseSshAnswer('sshListDirectories', {
      path: '/srv', parent: '/', entries: [{ name: 'app', path: '/srv/app' }],
    })).toMatchObject({ ok: true })
    expect(parseSshAnswer('sshListDirectories', { path: '/srv' })).toMatchObject({ ok: false })
  })
})

const FP = `SHA256:${'B'.repeat(43)}`
