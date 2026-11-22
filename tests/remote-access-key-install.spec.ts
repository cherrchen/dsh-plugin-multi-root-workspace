/**
 * `sshAccessKeyInstall` conflict handling (ADR-0049 §2): the revision is
 * checked before any key generation or remote write; a CAS conflict after the
 * install retries once against the fresh revision when the environment is
 * still the same install target, and removes the generated key when it is
 * not — no remote grant is ever left orphaned.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePersonalEndpoint } from '../src/remote/personal-endpoints.ts'
import type { SshStateView } from '../src/remote/personal-contract.ts'
import * as personalConfig from '../src/remote/personal/config.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from '../src/remote/personal/config.ts'
import type { ExecFile } from '../src/remote/personal/credentials.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import type { Context } from '@deepseek-ai/cordis'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'ak-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const SERVER_KEY = 'AAAA'
const SERVER_FINGERPRINT = createHash('sha256').update(Buffer.from(SERVER_KEY, 'base64')).digest('base64').replace(/=+$/, '')

const MANAGED: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:' + SERVER_FINGERPRINT,
  helper: null,
}
const CONFIG: PersonalConfig = { schemaVersion: 2, revision: 0, environments: [MANAGED], bindings: [] }

const world = () => {
  const dir = tmp()
  const personalPath = join(dir, 'remote-personal.json')
  const credentialRoot = join(dir, 'cred')
  const registry = {
    remoteEnabled: true,
    remoteMode: 'personal',
    remotePersonalPath: personalPath,
    remoteCredentialRoot: credentialRoot,
    refreshRemotePersonal: async () => {},
  } as unknown as MultiRootRegistry
  // Seed the managed credential record + secret file the env references.
  const secretsDir = join(credentialRoot, 'secrets')
  const keysDir = join(credentialRoot, 'keys')
  mkdirSync(credentialRoot, { mode: 0o700 })
  mkdirSync(secretsDir, { mode: 0o700 })
  mkdirSync(keysDir, { mode: 0o700 })
  writeFileSync(join(credentialRoot, 'known_hosts'), `build.internal ssh-ed25519 ${SERVER_KEY}\n`, { mode: 0o600 })
  writeFileSync(join(secretsDir, 'aabbccddeeff'), 's3cret', { mode: 0o600 })
  writeFileSync(join(credentialRoot, 'credentials.json'), JSON.stringify([
    { id: 'aabbccddeeff', label: 'builder password', kind: 'password', secretFile: join(secretsDir, 'aabbccddeeff'), createdAt: '2026-11-22T00:00:00.000Z' },
  ]), { mode: 0o600 })
  return { registry, personalPath, credentialRoot, keysDir }
}

const execFactory = (commands: string[], onAuthorizedKeys?: () => Promise<void> | void): ExecFile => async (file, args) => {
  const remote = String(args.at(-1))
  commands.push(file === 'ssh' ? `ssh ${remote}` : `${file} ${String(args[0])}`)
  if (file === 'ssh-keygen' && args[0] === '-t') {
    const keyPath = String(args.at(-1))
    writeFileSync(keyPath, 'PRIV', { mode: 0o600 })
    writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAPUB\n', { mode: 0o644 })
    return { stdout: '', stderr: '' }
  }
  if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 SHA256:${'C'.repeat(43)} comment (ED25519)\n`, stderr: '' }
  if (file === 'ssh' && remote.includes('authorized_keys')) {
    if (remote.includes('printf')) await onAuthorizedKeys?.()
    return { stdout: '', stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

const call = (registry: MultiRootRegistry, revision: number, exec: ExecFile): Promise<SshStateView> =>
  handlePersonalEndpoint(undefined as never as Context, registry, '/w', {
    endpoint: 'sshAccessKeyInstall', sessionId: 's', revision, environmentId: 'dev-box',
  }, { exec }) as Promise<SshStateView>

describe.skipIf(process.platform === 'win32')('sshAccessKeyInstall revision safety', () => {
  it('a stale revision refuses before any key generation or remote write', async () => {
    const { registry, personalPath, keysDir } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const commands: string[] = []
    await expect(call(registry, 7, execFactory(commands))).rejects.toMatchObject({ code: 'personal-config-conflict' })
    expect(commands).toHaveLength(0)
    expect(existsSync(keysDir) ? readdirSync(keysDir) : []).toHaveLength(0)
    const credential = loadPersonalConfig(personalPath).environments[0]!.credential
    expect(credential.kind === 'managed' ? credential.accessKeyId : undefined).toBeUndefined()
  })

  it('a revision bump after the install retries once and attaches the installed key', async () => {
    const { registry, personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const commands: string[] = []
    const exec = execFactory(commands, async () => {
      const current = loadPersonalConfig(personalPath)
      await savePersonalConfig(personalPath, { ...current, revision: current.revision + 1 }, current.revision)
    })
    const state = await call(registry, 0, exec)
    const accessKeyId = state.environments[0]!.credential.kind === 'managed' ? state.environments[0]!.credential.accessKeyId : undefined
    expect(accessKeyId).toMatch(/^[0-9a-f]{12}$/)
    // One key generated, one remote append, one retry that recorded it.
    expect(commands.filter(command => command.startsWith('ssh-keygen -t'))).toHaveLength(1)
    expect(commands.filter(command => command.includes('authorized_keys'))).toHaveLength(1)
    expect(loadPersonalConfig(personalPath).revision).toBe(2)
    expect(state.credentials.some(credential => credential.id === accessKeyId && credential.purpose === 'access-key')).toBe(true)
  })

  it('an environment change after the install removes the key and surfaces the conflict', async () => {
    const { registry, personalPath, keysDir } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const commands: string[] = []
    const exec = execFactory(commands, async () => {
      const current = loadPersonalConfig(personalPath)
      const [environment, ...rest] = current.environments
      const moved: PersonalEnvironment = { ...environment!, endpoint: { ...environment!.endpoint, hostname: 'other.internal' } }
      await savePersonalConfig(personalPath, { ...current, environments: [moved, ...rest], revision: current.revision + 1 }, current.revision)
    })
    await expect(call(registry, 0, exec)).rejects.toMatchObject({ code: 'personal-config-conflict' })
    expect(commands.filter(command => command.includes('authorized_keys'))).toHaveLength(2)
    expect(commands.at(-1)).not.toContain('printf')
    // The generated key is gone: record removed, key files removed.
    expect(readdirSync(keysDir)).toHaveLength(0)
    const credential = loadPersonalConfig(personalPath).environments[0]!.credential
    expect(credential.kind === 'managed' ? credential.accessKeyId : undefined).toBeUndefined()
  })
  it('rolls back both sides when the fresh CAS also fails', async () => {
    const { registry, personalPath, keysDir } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const commands: string[] = []
    let retry: ReturnType<typeof vi.spyOn> | undefined
    const exec = execFactory(commands, async () => {
      const current = loadPersonalConfig(personalPath)
      await savePersonalConfig(personalPath, { ...current, revision: 1, environments: [{ ...MANAGED, displayName: 'Renamed' }] }, 0)
      retry = vi.spyOn(personalConfig, 'savePersonalConfig').mockRejectedValueOnce(
        Object.assign(new Error('second CAS conflict'), { code: 'personal-config-conflict' }),
      )
    })
    try {
      await expect(call(registry, 0, exec)).rejects.toThrow('second CAS conflict')
      expect(commands.filter(command => command.includes('authorized_keys'))).toHaveLength(2)
      expect(commands.at(-1)).not.toContain('printf')
      expect(readdirSync(keysDir)).toHaveLength(0)
    } finally { retry?.mockRestore() }
  })

})
