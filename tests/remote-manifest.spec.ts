/** Deployment manifest parsing, digests, and load-time protection checks. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindingDigest, loadDeploymentManifest, manifestDigest, parseDeploymentManifest } from '../src/remote/manifest.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'mrw-manifest-')); dirs.push(d); return d }

const env = (over: Record<string, unknown> = {}) => ({
  environmentId: 'build-01', platform: 'linux', account: 'ci', hostKey: `SHA256:${'A'.repeat(43)}`,
  namespace: 'ns-build', transport: 'sftp', helper: null, ...over,
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
    ['helper transport with helper', { environments: [env({ transport: 'helper', helper: { sha256: 'a'.repeat(64), protocol: 1 } })] }, null],
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

  it('loads a protected manifest file and refuses untrusted ones', () => {
    const d = dir(), path = join(d, 'deploy.json')
    writeFileSync(path, text())
    const loaded = loadDeploymentManifest(path)
    expect(loaded.manifest.configVersion).toBe('cfg-1')
    chmodSync(path, 0o660)
    expect(() => loadDeploymentManifest(path)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
    chmodSync(path, 0o600)
    const link = join(d, 'link.json')
    symlinkSync(path, link)
    expect(() => loadDeploymentManifest(link)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
  })

  it('refuses a manifest inside a bound local primary', () => {
    const d = dir(), primary = join(d, 'ws')
    mkdirSync(primary)
    const path = join(primary, 'deploy.json')
    writeFileSync(path, text([env()], [binding({ primary })]))
    expect(() => loadDeploymentManifest(path)).toThrowError(expect.objectContaining({ code: 'manifest-untrusted' }) as Error)
  })
})
