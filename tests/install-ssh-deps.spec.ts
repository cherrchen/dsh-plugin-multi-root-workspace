/** The published SSH dependency installer: exact target, one CLI operation, idempotent. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  main, parseSshDependencyInstallArgs, runSshDependencyInstall, SshDependencyInstallError,
} from '../src/remote/install-ssh-deps.ts'
import { SSH_PEER_PACKAGES } from '../src/compat/dsh-version.ts'
import { fakeDsh } from './support/fake-dsh.ts'

const release = '0.2.2-rc.5'

function fixture(): { root: string; home: string; profile: string; dsh: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "mrfw-install-'"))
  const home = join(root, 'DSH Home 测试')
  const profile = 'web'
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  const log = join(root, 'calls.log')
  const dsh = fakeDsh(root)
  return { root, home, profile, dsh, log }
}

describe('parseSshDependencyInstallArgs', () => {
  it('accepts the exact target and rejects unknown, duplicate, or unsafe values', () => {
    const root = mkdtempSync(join(tmpdir(), 'mrfw-args-'))
    try {
      const dsh = fakeDsh(root)
      const request = parseSshDependencyInstallArgs(['--dsh', dsh, '--profile=web', '--home', root, '--release', release])
      expect(request).toMatchObject({ profile: 'web', home: root, release, dsh })
      expect(() => parseSshDependencyInstallArgs(['--profile', 'web', '--home', root, '--release', release, '--dsh', dsh, '--extra', 'x']))
        .toThrowError(SshDependencyInstallError)
      expect(() => parseSshDependencyInstallArgs(['--profile', 'web', '--profile', 'web', '--home', root, '--release', release, '--dsh', dsh]))
        .toThrowError(/duplicate/)
      expect(() => parseSshDependencyInstallArgs(['--profile', '../web', '--home', root, '--release', release, '--dsh', dsh]))
        .toThrowError(/invalid profile/)
      expect(() => parseSshDependencyInstallArgs(['--profile', 'web', '--home', root, '--release', '0.2.1-rc.5', '--dsh', dsh]))
        .toThrowError(/support matrix/)
      expect(() => parseSshDependencyInstallArgs(['--profile', 'web', '--home', root, '--release', release, '--dsh', join(root, 'missing')]))
        .toThrowError(/does not exist/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// Personal SSH is deferred on Windows, so the Host never offers this
// command there; the CLI-path tests remain portable, while the spawn-based
// installer tests are POSIX (the fixture DSH is a shebang script).
describe.skipIf(process.platform === 'win32')('runSshDependencyInstall', () => {
  it('runs exactly one CLI add with the four exact peers, including a spaced non-ASCII home', async () => {
    const { root, home, profile, dsh, log } = fixture()
    process.env.FAKE_LOG = log
    try {
      const result = await runSshDependencyInstall({ profile, home, release, dsh })
      expect(result.status).toBe('installed')
      expect(result.packages.map(pkg => pkg.name)).toEqual([...SSH_PEER_PACKAGES])
      expect(result.packages.every(pkg => pkg.version === release)).toBe(true)
      expect(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8')).toContain(release)
      expect(readFileSync(log, 'utf8')).toBe('add\n')
      expect(await runSshDependencyInstall({ profile, home, release, dsh })).toMatchObject({ status: 'ready' })
      expect(readFileSync(log, 'utf8')).toBe('add\n')
    } finally {
      delete process.env.FAKE_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a CLI at another release before writing the profile', async () => {
    const { root, home, profile } = fixture()
    const dsh = fakeDsh(root, { release: '0.2.1-rc.5' })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }))
        .rejects.toMatchObject({ code: 'release-mismatch' })
      expect(existsSync(join(home, 'profiles', profile, 'package.json'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts the same spaced and non-ASCII profile names the command generator quotes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mrfw-profile-name-'))
    const home = join(root, 'DSH Home')
    const profile = '团队 Web'
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    const dsh = fakeDsh(root)
    try {
      const request = parseSshDependencyInstallArgs(['--dsh', dsh, '--profile', profile, '--home', home, '--release', release])
      expect(request.profile).toBe(profile)
      const result = await runSshDependencyInstall(request)
      expect(result).toMatchObject({ status: 'installed', profile, release })
      expect(existsSync(join(dir, 'node_modules', ...SSH_PEER_PACKAGES[0].split('/'), 'index.js'))).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('does not report ready when a matching package has no resolvable entry', async () => {
    const { root, home, profile } = fixture()
    const dsh = fakeDsh(root, { noEntry: SSH_PEER_PACKAGES[1] })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }))
        .rejects.toMatchObject({ code: 'install-incomplete' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses an uninitialized Desktop profile before writing', async () => {
    const { root, home, dsh } = fixture()
    try {
      await expect(runSshDependencyInstall({ profile: 'desktop', home, release, dsh }))
        .rejects.toMatchObject({ code: 'profile-missing' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reports a partial install after the CLI claims success', async () => {
    const { root, home, profile } = fixture()
    const dsh = fakeDsh(root, { skip: SSH_PEER_PACKAGES[2] })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }))
        .rejects.toMatchObject({ code: 'install-incomplete' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('completes a partial install in one fixed operation', async () => {
    const { root, home, profile, dsh, log } = fixture()
    process.env.FAKE_LOG = log
    try {
      const dir = join(home, 'profiles', profile)
      const first = SSH_PEER_PACKAGES[0]
      mkdirSync(join(dir, 'node_modules', ...first.split('/')), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [first]: release } }))
      writeFileSync(join(dir, 'node_modules', ...first.split('/'), 'package.json'), JSON.stringify({ name: first, version: release, main: './index.js' }))
      writeFileSync(join(dir, 'node_modules', ...first.split('/'), 'index.js'), 'module.exports = {}')
      await expect(runSshDependencyInstall({ profile, home, release, dsh })).resolves.toMatchObject({ status: 'installed' })
      expect(readFileSync(log, 'utf8')).toBe('add\n')
      await expect(runSshDependencyInstall({ profile, home, release, dsh })).resolves.toMatchObject({ status: 'ready' })
    } finally {
      delete process.env.FAKE_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds package-manager diagnostics and does not expose later output bytes', async () => {
    const { root, home, profile } = fixture()
    const dsh = fakeDsh(root, { fail: true, noisyFailure: true })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh })).rejects.toMatchObject({
        code: 'install-failed',
        message: expect.not.stringContaining('SECRET_TOKEN_SHOULD_NOT_CROSS'),
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('runs a JavaScript CLI with the current Host runtime even when PATH has no node', async () => {
    const { root, home, profile, dsh } = fixture()
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh })).resolves.toMatchObject({ status: 'installed' })
    } finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('times out a hung package-manager process and allows a later retry', async () => {
    const { root, home, profile } = fixture()
    const dsh = fakeDsh(root, { hang: true })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'install-timeout' })
      fakeDsh(root)
      await expect(runSshDependencyInstall({ profile, home, release, dsh }, { timeoutMs: 5_000 })).resolves.toMatchObject({ status: 'installed' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('terminates the whole subprocess tree on timeout, including a SIGTERM-proof package manager', async () => {
    const { root, home, profile } = fixture()
    process.env.FAKE_PID_LOG = join(root, 'pids.log')
    const dsh = fakeDsh(root, { treeHang: true })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }, { timeoutMs: 1_000 }))
        .rejects.toMatchObject({ code: 'install-timeout' })
      // The grandchild ignores SIGTERM and never writes, so only the
      // escalated group SIGKILL can end it; the signal lands two seconds
      // after the timeout. Poll instead of asserting a fixed clock.
      const pid = Number(readFileSync(join(root, 'pids.log'), 'utf8').trim().split('\n').at(-1))
      const deadline = Date.now() + 6_000
      let alive = true
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0)
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch { alive = false }
      }
      expect(alive).toBe(false)
    } finally {
      delete process.env.FAKE_PID_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('settles within a bounded period when an escaped descendant keeps the pipes open', async () => {
    const { root, home, profile } = fixture()
    process.env.FAKE_PID_LOG = join(root, 'pids.log')
    const dsh = fakeDsh(root, { detachedHang: true })
    try {
      await expect(runSshDependencyInstall({ profile, home, release, dsh }, { timeoutMs: 1_000 }))
        .rejects.toMatchObject({ code: 'install-timeout' })
      // The detached grandchild leaves the installer's process group, so the
      // group signals cannot reach it: the rejection above can only have
      // arrived through the bounded pipe cleanup. Prove the scenario was
      // real — the descendant is still alive — then end it manually.
      const pid = Number(readFileSync(join(root, 'pids.log'), 'utf8').trim().split('\n').at(-1))
      expect(() => process.kill(pid, 0)).not.toThrow()
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    } finally {
      delete process.env.FAKE_PID_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not leak signal forwarders across operations', async () => {
    const { root, home, profile, dsh } = fixture()
    try {
      const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')
      await runSshDependencyInstall({ profile, home, release, dsh })
      expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('prints a result with the profile and the restart instruction', async () => {
    const { root, home, profile, dsh, log } = fixture()
    process.env.FAKE_LOG = log
    try {
      const outcome = await main(['--dsh', dsh, '--profile', profile, '--home', home, '--release', release])
      expect(outcome.code).toBe(0)
      expect(outcome.message).toContain('installed')
      expect(outcome.message).toContain(profile)
      expect(outcome.message).toContain('Restart')
      expect(existsSync(join(home, 'profiles', profile, 'node_modules', ...SSH_PEER_PACKAGES[0].split('/'), 'package.json'))).toBe(true)
      const again = await main(['--dsh', dsh, '--profile', profile, '--home', home, '--release', release])
      expect(again.code).toBe(0)
      expect(again.message).toContain('already installed')
      expect(again.message).toContain('No write')
    } finally {
      delete process.env.FAKE_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })
})
