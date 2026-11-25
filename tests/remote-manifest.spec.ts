/** Deployment manifest parsing, digests, and load-time protection checks. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindingDigest, environmentDigest, loadDeploymentManifest, manifestDigest, parseDeploymentManifest } from '../src/remote/manifest.ts'
import { primaryKey } from '../src/roots.ts'
import type { RemoteGrant } from '../src/remote/contract.ts'
import { grantState } from '../src/remote/records.ts'
import { RemoteControlPlane } from '../src/remote/plane.ts'

const fakeStats = vi.hoisted(() => new Map<string, { uid: number; mode: number; kind: 'file' | 'dir' | 'link' }>())
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    lstatSync: (path: string, options?: unknown) => {
      const fake = fakeStats.get(String(path))
      if (fake === undefined) return real.lstatSync(path, options as never)
      return {
        uid: fake.uid, mode: fake.mode,
        isSymbolicLink: () => fake.kind === 'link',
        isFile: () => fake.kind === 'file',
        isDirectory: () => fake.kind === 'dir',
      }
    },
  }
})

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'mrw-manifest-')); dirs.push(d); return d }

const env = (over: Record<string, unknown> = {}) => ({
  environmentId: 'build-01', platform: 'linux', account: 'ci', hostKey: `SHA256:${'A'.repeat(43)}`,
  namespace: 'ns-build', transport: 'sftp', helper: null,
  connection: { host: 'vps' }, credentialIsolation: 'unattested', ...over,
})
const binding = (over: Record<string, unknown> = {}) => ({
  primary: '/ws/app', environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write'], ...over,
})
const text = (envs: unknown[] = [env()], bindings: unknown[] = [binding()], over: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, configVersion: 'cfg-1', environments: envs, bindings: bindings, ...over })

describe('deployment manifest', () => {
  it('parses a valid manifest and derives a stable digest', () => {
    const a = parseDeploymentManifest(text(), '/m.json')
    const b = parseDeploymentManifest(text(), '/other.json')
    expect(a.digest).toBe(b.digest)
    expect(a.digest).toBe(manifestDigest(a.manifest))
    expect(bindingDigest(a.manifest.environments[0]!, a.manifest.bindings[0]!)).toMatch(/^[0-9a-f]{64}$/)
    expect(a.manifest.bindings[0]!.primary).toBe('/ws/app')
  })

  it.each([
    ['windows target', { environments: [env({ platform: 'win32' })] }, 'windows-target-unsupported'],
    ['windows spelling', { environments: [env({ platform: 'windows' })] }, 'windows-target-unsupported'],
    ['other platform', { environments: [env({ platform: 'plan9' })] }, 'unsupported-platform'],
    ['unknown env', { bindings: [binding({ environmentId: 'ghost' })] }, 'unknown-environment'],
    ['dup env id', { environments: [env(), env()] }, 'duplicate-environment'],
    ['dup binding', { bindings: [binding(), binding()] }, 'duplicate-binding'],
    ['nested alias', { environments: [env(), env({ environmentId: 'build-02', namespace: 'ns-build' })], bindings: [binding(), binding({ environmentId: 'build-02', rootId: 'app2', path: '/work/app/inner' })] }, 'alias-conflict'],
    ['equal-path alias', { environments: [env(), env({ environmentId: 'build-02' })], bindings: [binding(), binding({ environmentId: 'build-02', rootId: 'app2' })] }, 'alias-conflict'],
    ['dot-dot path', { bindings: [binding({ path: '/work/../etc' })] }, 'invalid-manifest'],
    ['double slash', { bindings: [binding({ path: '/work//app' })] }, 'invalid-manifest'],
    ['trailing slash', { bindings: [binding({ path: '/work/app/' })] }, 'invalid-manifest'],
    ['relative path', { bindings: [binding({ path: 'work/app' })] }, 'invalid-manifest'],
    ['NUL path', { bindings: [binding({ path: '/work/\0' })] }, 'invalid-manifest'],
    ['relative primary', { bindings: [binding({ primary: 'ws/app' })] }, 'invalid-manifest'],
    ['helper transport without helper', { environments: [env({ transport: 'helper', helper: null })] }, 'invalid-manifest'],
    ['sftp transport with helper', { environments: [env({ transport: 'sftp', helper: { sha256: 'a'.repeat(64), protocol: 1 } })] }, 'invalid-manifest'],
    ['helper transport with helper', { environments: [env({ transport: 'helper', helper: { sha256: 'a'.repeat(64), protocol: 1 }, connection: { host: 'vps', nodePath: '/opt/n/bin/node', helperPath: '/opt/h/helper.js', workspace: '/w' } }) ] }, null],
    ['helper without connection paths', { environments: [env({ transport: 'helper', helper: { sha256: 'a'.repeat(64), protocol: 1 } })] }, 'invalid-manifest'],
    ['sftp with nodePath', { environments: [env({ connection: { host: 'vps', nodePath: '/opt/n/bin/node' } })] }, 'invalid-manifest'],
    ['sftp with exec', { environments: [env({ exec: { shell: ['/bin/sh'], env: {}, maxTimeoutMs: 10, stdoutLimit: 8, stderrLimit: 8, terminateGraceMs: 1 } })] }, 'invalid-manifest'],
    ['exec with relative shell', { environments: [env({ transport: 'helper', helper: { sha256: 'a'.repeat(64), protocol: 1 }, connection: { host: 'vps', nodePath: '/opt/n/bin/node', helperPath: '/opt/h/helper.js', workspace: '/w' }, exec: { shell: ['sh'], env: {}, maxTimeoutMs: 10, stdoutLimit: 8, stderrLimit: 8, terminateGraceMs: 1 } })] }, 'invalid-manifest'],
    ['missing connection', { environments: [env({ connection: undefined })] }, 'invalid-manifest'],
    ['missing credentialIsolation', { environments: [env({ credentialIsolation: undefined })] }, 'invalid-manifest'],
    ['extra key', { environments: [env({ sneaky: true })] }, 'invalid-manifest'],
    ['binding unknown env', { bindings: [binding({ environmentId: 'missing' })] }, 'unknown-environment'],
    ['bad environmentId', { environments: [env({ environmentId: 'UPPER' })] }, 'invalid-manifest'],
    ['bad hostKey', { environments: [env({ hostKey: 'SHA256:short' })] }, 'invalid-manifest'],
    ['dup actions', { bindings: [binding({ actions: ['read', 'read'] })] }, 'invalid-manifest'],
  ])('rejects %s', (_name, over, code) => {
    const merged = { environments: [env()], bindings: [binding()], ...over }
    const run = () => parseDeploymentManifest(JSON.stringify({ schemaVersion: 1, configVersion: 'cfg-1', ...merged }), '/m.json')
    if (code === null) expect(run).not.toThrow()
    else expect(run).toThrowError(expect.objectContaining({ code }) as Error)
  })

  it('accepts aggregate quotas and a revocation list inside the attested digest', () => {
    const quota = { windowMs: 60_000, maxOperations: 100, maxBytes: 8 * 1024 * 1024 }
    const isolated = env({ quotas: quota })
    const parsed = parseDeploymentManifest(text([isolated], [binding()], { quotas: quota, revocations: [{ environmentId: 'build-01', reason: 'key rotation' }] }), '/m.json')
    expect(parsed.manifest.quotas).toEqual(quota)
    expect(parsed.manifest.environments[0]!.quotas).toEqual(quota)
    expect(parsed.manifest.revocations).toEqual([{ environmentId: 'build-01', reason: 'key rotation' }])
    // A manifest without the new fields still parses; the controls default off.
    expect(() => parseDeploymentManifest(text(), '/m.json')).not.toThrow()
  })

  it.each([
    ['revocation of unknown env', { revocations: [{ environmentId: 'ghost-01' }] }, 'unknown-environment'],
    ['duplicate revocation', { revocations: [{ environmentId: 'build-01' }, { environmentId: 'build-01', reason: 'again' }] }, 'duplicate-revocation'],
    ['revocation extra key', { revocations: [{ environmentId: 'build-01', sneaky: true }] }, 'invalid-manifest'],
    ['global quota missing bound', { quotas: { windowMs: 60_000, maxOperations: 10 } }, 'invalid-manifest'],
    ['global quota zero ops', { quotas: { windowMs: 60_000, maxOperations: 0, maxBytes: 8 } }, 'invalid-manifest'],
    ['env quota extra key', { environments: [env({ quotas: { windowMs: 60_000, maxOperations: 10, maxBytes: 8, sneaky: 1 } })] }, 'invalid-manifest'],
  ])('rejects %s', (_name, over, code) => {
    const merged = { environments: [env()], bindings: [binding()], ...over }
    const run = () => parseDeploymentManifest(JSON.stringify({ schemaVersion: 1, configVersion: 'cfg-1', ...merged }), '/m.json')
    if (code === null) expect(run).not.toThrow()
    else expect(run).toThrowError(expect.objectContaining({ code }) as Error)
  })

  it('accepts the destination isolation declaration only as its literal', () => {
    const isolated = env({ transfer: { maxBytes: 8, timeoutMs: 10, destinationIsolation: 'chroot-sftp' } })
    expect(() => parseDeploymentManifest(text([isolated]), '/m.json')).not.toThrow()
    const wrong = env({ transfer: { maxBytes: 8, timeoutMs: 10, destinationIsolation: 'sftp-chroot' } })
    expect(() => parseDeploymentManifest(text([wrong]), '/m.json')).toThrowError(expect.objectContaining({ code: 'invalid-manifest' }) as Error)
    const onPair = binding({ transfers: [{ direction: 'import', peer: { environmentId: 'b', rootId: 'r' }, destinationIsolation: 'chroot-sftp' }] })
    expect(() => parseDeploymentManifest(text([isolated], [onPair]), '/m.json')).toThrowError(expect.objectContaining({ code: 'invalid-manifest' }) as Error)
  })

  it.skipIf(process.platform === 'win32')('loads a protected manifest file and refuses untrusted ones', () => {
    const testing = { allowUserOwnedForTesting: true }
    const d = dir(), path = join(d, 'deploy.json')
    writeFileSync(path, text())
    const loaded = loadDeploymentManifest(path, testing)
    expect(loaded.manifest.configVersion).toBe('cfg-1')
    chmodSync(path, 0o660)
    expect(() => loadDeploymentManifest(path, testing)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
    chmodSync(path, 0o600)
    const link = join(d, 'link.json')
    symlinkSync(path, link)
    expect(() => loadDeploymentManifest(link, testing)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
  })

  it.skipIf(process.platform === 'win32')('refuses a manifest inside a bound local primary', () => {
    const d = dir(), primary = join(d, 'ws')
    mkdirSync(primary)
    const path = join(primary, 'deploy.json')
    writeFileSync(path, text([env()], [binding({ primary })]))
    expect(() => loadDeploymentManifest(path, { allowUserOwnedForTesting: true })).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
  })

  it.skipIf(process.platform === 'win32')('refuses a non-root-owned manifest under the strict production checks', () => {
    const d = dir(), path = join(d, 'deploy.json')
    writeFileSync(path, text())
    expect(() => loadDeploymentManifest(path)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
  })

  it.skipIf(process.platform === 'win32')('walks every ancestor under the strict production checks', () => {
    const untrusted = expect.objectContaining({ code: 'manifest-untrusted' }) as Error
    const file = '/etc/dsh-test/deploy.json'
    try {
      fakeStats.set(file, { uid: 0, mode: 0o600, kind: 'file' })
      fakeStats.set('/etc/dsh-test', { uid: 0, mode: 0o755, kind: 'dir' })
      fakeStats.set('/etc', { uid: 65_534, mode: 0o755, kind: 'dir' })
      expect(() => loadDeploymentManifest(file)).toThrowError(untrusted)
      fakeStats.set('/etc', { uid: 0, mode: 0o777, kind: 'dir' })
      expect(() => loadDeploymentManifest(file)).toThrowError(untrusted)
      fakeStats.set('/etc', { uid: 0, mode: 0o755, kind: 'dir' })
      fakeStats.set('/etc/dsh-test', { uid: 0, mode: 0o755, kind: 'link' })
      expect(() => loadDeploymentManifest(file)).toThrowError(untrusted)
    } finally { fakeStats.clear() }
  })

  it.each(['team', 'hardened', undefined] as const)('disables the deployment manifest path in production (%s)', mode => {
    const d = dir(), path = join(d, 'deploy.json')
    writeFileSync(path, text())
    const plane = new RemoteControlPlane({
      enabled: true, ...(mode === undefined ? {} : { mode }), manifestPath: path, personalPath: join(d, 'personal.json'),
    }, { warn: () => {} })
    expect(plane.status.state).toBe('disabled')
    expect(plane.enabled).toBe(false)
    expect(plane.manifest).toBeUndefined()
    plane.configure({ enabled: true, mode: 'personal' })
    expect(plane.status.state).toBe('disabled')
  })

  it.each(['team', 'hardened'] as const)('rejects a live request to activate %s custody', mode => {
    const plane = new RemoteControlPlane({ personalPath: join(dir(), 'personal.json') }, { warn: () => {} })
    plane.configure({ enabled: true, mode })
    expect(plane.status.state).toBe('disabled')
    expect(plane.enabled).toBe(false)
    expect(plane.manifest).toBeUndefined()
  })

  it('withholds the same recorded Root when the effective initiator changes', () => {
    const identity = { hostname: 'vps', port: 22, credentialDigest: 'a'.repeat(64) }
    const variants = [undefined, { kind: 'windows-openssh' }, { kind: 'wsl', distribution: 'Ubuntu 24.04', user: 'ci' },
      { kind: 'wsl', distribution: 'Debian 开发', user: 'ci' }, { kind: 'wsl', distribution: 'Ubuntu 24.04', user: 'other' }]
    const manifests = variants.map(initiator => parseDeploymentManifest(text([env({ personalIdentity: { ...identity, initiator } })], [binding()], initiator === undefined ? {} : { personalInitiator: initiator }), '/m.json', { personal: true }))
    const [legacy, native] = manifests
    expect(legacy!.manifest.environments[0]!.personalIdentity).toEqual(identity)
    expect(new Set(manifests.map(row => environmentDigest(row.manifest.environments[0]!))).size).toBe(variants.length)
    expect(new Set(manifests.map(row => row.digest)).size).toBe(variants.length)
    const { manifest: original } = native!
    const grant: RemoteGrant = { environmentId: 'build-01', rootId: 'app', displayPath: '/work/app', verifiedTarget: { kind: 'path', value: '/work/app' },
      configVersion: original.configVersion, bindingDigest: bindingDigest(original.environments[0]!, original.bindings[0]!), addedAt: '2026-11-25T00:00:00.000Z' }
    for (const row of manifests) expect(grantState(row.manifest, primaryKey(original.bindings[0]!.primary), grant)).toBe(row === native ? 'registered' : 'withheld')
  })

  it('reserves the root initiator for personal manifests and requires it to match the nested identity', () => {
    const invalid = expect.objectContaining({ code: 'invalid-manifest' }) as Error
    const identity = { hostname: 'vps', port: 22, credentialDigest: 'a'.repeat(64) }
    const initiator = { kind: 'wsl' as const, distribution: 'Ubuntu 24.04', user: 'ci' }
    // The root attestation is a personal fact even with no environments.
    const empty = text([], [], { personalInitiator: initiator })
    expect(() => parseDeploymentManifest(empty, '/m.json')).toThrowError(invalid)
    expect(() => parseDeploymentManifest(empty, '/m.json', { personal: true })).not.toThrow()
    // A nested identity inconsistent with the root fails in either direction.
    const mismatch = text([env({ personalIdentity: { ...identity, initiator } })], [binding()], { personalInitiator: { kind: 'windows-openssh' } })
    expect(() => parseDeploymentManifest(mismatch, '/m.json', { personal: true })).toThrowError(invalid)
    const orphan = text([env({ personalIdentity: { ...identity, initiator } })])
    expect(() => parseDeploymentManifest(orphan, '/m.json', { personal: true })).toThrowError(invalid)
    const missing = text([env({ personalIdentity: identity })], [binding()], { personalInitiator: initiator })
    expect(() => parseDeploymentManifest(missing, '/m.json', { personal: true })).toThrowError(invalid)
  })

  it.runIf(process.platform === 'win32')('defers configure on Windows and refresh never publishes a manifest', () => {
    const plane = new RemoteControlPlane({ personalPath: join(dir(), 'missing.json'), credentialRoot: join(dir(), 'cred') }, { warn: () => {} })
    plane.configure({ enabled: true, mode: 'personal', initiator: { kind: 'windows-openssh' } })
    expect(plane.status.state).toBe('platform-deferred')
    expect(plane.refreshPersonal()).toBe('disabled')
    expect(plane.manifest).toBeUndefined()
    expect(plane.manifestDigest).toBeUndefined()
    expect(plane.status.state).toBe('platform-deferred')
  })
})
