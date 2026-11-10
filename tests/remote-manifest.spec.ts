/** Deployment manifest parsing, digests, and load-time protection checks. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindingDigest, loadDeploymentManifest, manifestDigest, parseDeploymentManifest } from '../src/remote/manifest.ts'
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

  it.skipIf(process.platform === 'win32')('offers no config bypass for the strict production checks', () => {
    const d = dir(), path = join(d, 'deploy.json')
    writeFileSync(path, text())
    const plane = new RemoteControlPlane({ enabled: true, manifestPath: path }, { warn: () => {} })
    expect(plane.status.state).toBe('config-invalid')
  })
})
