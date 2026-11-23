/** The published SSH dependency installer: exact target, one CLI operation, idempotent. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  main, parseSshDependencyInstallArgs, runSshDependencyInstall, SshDependencyInstallError,
} from '../src/remote/install-ssh-deps.ts'
import { SSH_PEER_PACKAGES } from '../src/compat/dsh-version.ts'

const release = '0.2.2-rc.5'

function fakeDsh(root: string, options: { release?: string; fail?: boolean; skip?: string } = {}): string {
  const path = join(root, 'fake dsh.mjs')
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const log = process.env.FAKE_LOG
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(options.release ?? release)} + '\\n'); process.exit(0) }
const profile = args[args.indexOf('--profile') + 1]
const home = process.env.DSH_HOME
const dir = join(home, 'profiles', profile)
mkdirSync(dir, { recursive: true })
const dependencies = {}
for (const arg of args) {
  if (!arg.startsWith('@deepseek-ai/')) continue
  const at = arg.lastIndexOf('@')
  const name = arg.slice(0, at)
  if (name === ${JSON.stringify(options.skip ?? '')}) continue
  const pkgRoot = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name, version: arg.slice(at + 1) }))
  dependencies[name] = arg.slice(at + 1)
}
writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
if (log !== undefined) appendFileSync(log, 'add\\n')
process.exit(${options.fail === true ? 1 : 0})
`, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

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

describe('runSshDependencyInstall', () => {
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
    } finally {
      delete process.env.FAKE_LOG
      rmSync(root, { recursive: true, force: true })
    }
  })
})
