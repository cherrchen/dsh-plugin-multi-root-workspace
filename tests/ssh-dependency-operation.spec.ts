/** Host-side fixed SSH dependency repair: trusted target, idempotence, restart semantics, and bounded public diagnostics. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SSH_PEER_PACKAGES } from '../src/compat/dsh-version.ts'
import { captureSshProfile, inspectSshProfile, sshDependencyInstallTarget } from '../src/compat/ssh-profile.ts'
import { installOrUpgradeSshDependencies } from '../src/remote/ssh-dependency-operation.ts'
import { SshDependencyInstallError } from '../src/remote/install-ssh-deps.ts'
import { sshDependencyInstallRequestSchema } from '../src/remote/personal-contract.ts'
import { fakeDsh } from './support/fake-dsh.ts'
import { installFixtureSsh, provideSshProfile } from './support/ssh-profile.ts'

const release = '0.2.2-rc.5'
const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mrfw-ssh-op-'))
  roots.push(value)
  return value
}

afterEach(() => {
  delete process.env.FAKE_ARGS_LOG
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function host(version = release): Context {
  const ctx = new Context()
  ctx.provide('multiRootCompat', { report: { release: version, verdict: 'supported' } } as never)
  return ctx
}

function prepare(ctx: Context, home: string, profile = 'web'): string {
  const dir = provideSshProfile(ctx, home, profile, release)
  const cli = fakeDsh(home)
  const target = join(home, 'host', 'lib', 'bin.js')
  writeFileSync(target, readFileSync(cli, 'utf8'))
  chmodSync(target, 0o755)
  return dir
}

describe.skipIf(process.platform === 'win32')('installOrUpgradeSshDependencies', () => {
  it('realigns the fixed four exact Host-release packages, then reports restart-required and stays idempotent', async () => {
    const base = root()
    const home = join(base, 'DSH Home 测试')
    const argsLog = join(base, 'args.log')
    process.env.FAKE_ARGS_LOG = argsLog
    const ctx = host()
    try {
      installFixtureSsh(prepare(ctx, home), '0.2.2-rc.4')
      captureSshProfile(ctx)
      expect(sshDependencyInstallTarget(ctx)).toMatchObject({ profile: 'web', home, release, cwd: home })
      expect(inspectSshProfile(ctx).view.capabilities).toEqual({ install: true })

      const first = await installOrUpgradeSshDependencies(ctx)
      expect(first.status).toBe('restart-required')
      expect(first.dependencies.code).toBe('ssh-deps-restart')
      const args = JSON.parse(readFileSync(argsLog, 'utf8').trim()) as string[]
      const packages = args.filter(arg => arg.startsWith('@deepseek-ai/'))
      expect(packages).toEqual(SSH_PEER_PACKAGES.map(name => `${name}@${release}`))
      expect(args).toContain('--save-exact')

      const again = await installOrUpgradeSshDependencies(ctx)
      expect(again.status).toBe('restart-required')
      expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('realigns a version mismatch', async () => {
    const base = root()
    const home = join(base, 'home')
    const ctx = host()
    try {
      const dir = prepare(ctx, home, 'mismatch')
      installFixtureSsh(dir, '0.2.2-rc.4')
      captureSshProfile(ctx)
      expect(inspectSshProfile(ctx).view.code).toBe('ssh-deps-version')
      const result = await installOrUpgradeSshDependencies(ctx)
      expect(result.status).toBe('restart-required')
      expect(result.dependencies.packages.every(pkg => pkg.version === release)).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('merges concurrent calls for the same trusted target', async () => {
    const base = root()
    const home = join(base, 'home')
    const ctx = host()
    const gate = Promise.withResolvers<{ status: 'installed'; packages: [] }>()
    const install = vi.fn(() => gate.promise)
    try {
      installFixtureSsh(prepare(ctx, home), '0.2.2-rc.4')
      captureSshProfile(ctx)
      const one = installOrUpgradeSshDependencies(ctx, { install })
      const two = installOrUpgradeSshDependencies(ctx, { install })
      await new Promise(resolve => setImmediate(resolve))
      expect(install).toHaveBeenCalledTimes(1)
      gate.resolve({ status: 'installed', packages: [] })
      await expect(one).resolves.toMatchObject({ status: 'restart-required' })
      await expect(two).resolves.toMatchObject({ status: 'restart-required' })
      expect(install).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps package-manager details and environment text out of the public failure', async () => {
    const base = root()
    const home = join(base, 'home')
    const ctx = host()
    const secret = 'SECRET_TOKEN_VALUE'
    try {
      installFixtureSsh(prepare(ctx, home), '0.2.2-rc.4')
      captureSshProfile(ctx)
      await expect(installOrUpgradeSshDependencies(ctx, {
        install: async () => {
          throw new SshDependencyInstallError('install-failed', `npm said ${secret}`)
        },
      })).rejects.toMatchObject({ code: 'ssh-deps-install-failed' })
      await expect(installOrUpgradeSshDependencies(ctx, {
        install: async () => {
          throw new SshDependencyInstallError('install-failed', `npm said ${secret}`)
        },
      })).rejects.not.toThrowError(expect.objectContaining({ message: expect.stringContaining(secret) }))
    } finally { await ctx.fiber.dispose() }
  })

  it('admits no caller-controlled package, version, argv, cwd, or profile fields', () => {
    expect(sshDependencyInstallRequestSchema.safeParse({}).success).toBe(true)
    for (const payload of [
      { package: '@deepseek-ai/dsh-ssh' }, { release }, { argv: ['x'] }, { cwd: '/tmp' }, { profile: 'other' }, { command: 'rm -rf /' },
    ]) expect(sshDependencyInstallRequestSchema.safeParse(payload).success).toBe(false)
  })
})
