/** G4: the SSH compatibility gate and the host-anchored loader. */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyInstallation,
  classifySshCapability,
  sshPackageVersion,
  sshPrivateCopy,
  SSH_PEER_PACKAGES,
  SUPPORTED_DSH_RELEASES,
  SUPPORTED_SSH_RELEASES,
  type CompatReport,
  type VersionReader,
} from '../src/compat/dsh-version.ts'
import { loadHostSshPackages } from '../src/compat/ssh-packages.ts'

const report = (verdict: CompatReport['verdict'], release: string | undefined): CompatReport =>
  ({ verdict, release, packages: [], message: verdict }) as CompatReport
const readers = (version: string | undefined, versions: Record<string, string | undefined> = {}) => {
  const map: Record<string, string | undefined> = { ...Object.fromEntries(SSH_PEER_PACKAGES.map(name => [name, version])), ...versions }
  const read: VersionReader = name => map[name]
  return read
}
const gate = (over: Partial<{
  platform: NodeJS.Platform
  local: CompatReport
  readVersion: VersionReader
  privateCopy: (name: string) => boolean
}> = {}) => classifySshCapability({
  platform: 'darwin',
  local: report('supported', '0.2.2-rc.1'),
  readVersion: readers('0.2.2-rc.1'),
  ...over,
} as never)

const realGate = classifySshCapability({
  platform: process.platform,
  local: classifyInstallation(),
  readVersion: sshPackageVersion,
  privateCopy: sshPrivateCopy,
})
const realTree = it.skipIf(realGate.status !== 'eligible')

describe('classifySshCapability', () => {
  it('is platform-deferred on win32 and other non-POSIX initiators', () => {
    expect(gate({ platform: 'win32' })).toMatchObject({ status: 'absent', reason: 'platform-deferred' })
    expect(gate({ platform: 'freebsd' })).toMatchObject({ status: 'absent', reason: 'platform-deferred' })
  })

  it('absents when the local verdict is not supported', () => {
    expect(gate({ local: report('unsupported', '0.9.9') })).toMatchObject({ status: 'absent', reason: 'local-compat-not-supported' })
    expect(gate({ local: report('mixed', undefined) })).toMatchObject({ status: 'absent', reason: 'local-compat-not-supported' })
    expect(gate({ local: report('incomplete', undefined) })).toMatchObject({ status: 'absent', reason: 'local-compat-not-supported' })
  })

  it('is host-below-floor on a supported-but-older host — and the local verdict stays supported', () => {
    expect(gate({ local: report('supported', '0.1.5-rc.2') })).toMatchObject({ status: 'absent', reason: 'host-below-floor' })
    // The floor check is silent: it never touches the ordinary verdict.
    expect(report('supported', '0.1.5-rc.2').verdict).toBe('supported')
    expect(SUPPORTED_DSH_RELEASES).toContain('0.1.5-rc.2')
    expect(SUPPORTED_SSH_RELEASES).not.toContain('0.1.5-rc.2')
  })

  it('reports each SSH package and absents on missing, mixed, or private copies', () => {
    const missing = gate({ readVersion: readers('0.2.2-rc.1', { '@deepseek-ai/dsh-ssh': undefined }) })
    expect(missing).toMatchObject({ status: 'absent', reason: 'missing-optional-package' })
    expect(missing.status === 'absent' && missing.detail).toContain('@deepseek-ai/dsh-ssh')
    expect(missing.status === 'absent' && missing.packages.length).toBe(4)
    expect(gate({ readVersion: readers('0.2.2-rc.1', { '@deepseek-ai/dsh-fs-ssh': '0.2.1-rc.5' }) }))
      .toMatchObject({ status: 'absent', reason: 'identity-mismatch' })
    expect(gate({ privateCopy: name => name === '@deepseek-ai/dsh-subprocess-ssh' }))
      .toMatchObject({ status: 'absent', reason: 'identity-mismatch' })
    expect(gate({ privateCopy: name => name === 'unrelated' })).toMatchObject({ status: 'eligible', release: '0.2.2-rc.1' })
  })

  realTree(`is eligible on the real installed tree (skipped: ${realGate.status === 'absent' ? realGate.reason : 'n/a'})`, () => {
    const capability = classifySshCapability({
      platform: 'darwin',
      local: classifyInstallation(),
      readVersion: sshPackageVersion,
      privateCopy: sshPrivateCopy,
    })
    const installed = classifyInstallation().release
    expect(SUPPORTED_SSH_RELEASES).toContain(installed)
    expect(capability).toMatchObject({ status: 'eligible', release: installed })
    for (const name of SSH_PEER_PACKAGES) expect(sshPackageVersion(name), `${name} must resolve`).toBe(installed)
  })
})

describe('loadHostSshPackages', () => {
  it('refuses a non-eligible gate before touching any module', async () => {
    const importer = vi.fn(async () => ({}))
    await expect(loadHostSshPackages(
      { status: 'absent', reason: 'host-below-floor', detail: 'too old', packages: [] },
      importer as never,
    )).rejects.toThrow(/host-below-floor/)
    expect(importer).not.toHaveBeenCalled()
  })

  realTree(`loads the four installed packages and finds their classes without constructing them (skipped: ${realGate.status === 'absent' ? realGate.reason : 'n/a'})`, async () => {
    const modules = await loadHostSshPackages({ status: 'eligible', release: classifyInstallation().release! })
    expect(Object.keys(modules).sort()).toEqual([...SSH_PEER_PACKAGES].sort())
    const expected: Record<string, string> = {
      '@deepseek-ai/dsh-ssh': 'SshConnection',
      '@deepseek-ai/dsh-fs-ssh': 'SshFileSystem',
      '@deepseek-ai/dsh-subprocess-ssh': 'SshSubprocessRuntime',
      '@deepseek-ai/dsh-sandbox-ssh': 'SshSandboxProvider',
    }
    for (const [name, className] of Object.entries(expected)) {
      const ns = modules[name] as Record<string, unknown> & { default?: Record<string, unknown> }
      const klass = ns[className] ?? ns.default?.[className]
      expect(typeof klass, `${name} must export ${className}`).toBe('function')
    }
  })
})
