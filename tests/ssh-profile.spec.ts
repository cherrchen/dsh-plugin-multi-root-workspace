import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { captureSshProfile, inspectSshProfile } from '../src/compat/ssh-profile.ts'
import { SSH_PEER_PACKAGES } from '../src/compat/dsh-version.ts'
import { installFixtureSsh, provideReadySshProfile, provideSshProfile } from './support/ssh-profile.ts'

const release = '0.2.2-rc.5'
const host = (version = release) => {
  const ctx = new Context()
  ctx.provide('multiRootCompat', { report: { release: version, verdict: 'supported' } } as never)
  return ctx
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('Host SSH Profile admission', () => {
  it('reports a missing or private package set, then requires a fresh Host after repair', async () => {
    const home = mkdtempSync(join(tmpdir(), "mrfw-profile-'"))
    const running = host()
    const restarted = host()
    try {
      const dir = provideSshProfile(running, home, 'ssh-dev')
      captureSshProfile(running)
      const before = inspectSshProfile(running)
      expect(before.gate).toBeUndefined()
      expect(before.view.code).toMatch(/^ssh-deps-(?:missing|private)$/)
      expect(before.view.command).toContain('install-ssh-deps.mjs')
      expect(before.view.command).toContain('--profile ssh-dev')
      expect(before.view.command).toContain(`--release ${release}`)
      expect(before.view.command).toContain("'\\''")
      expect(before.view.command).toContain('--dsh')

      installFixtureSsh(dir, release)
      expect(inspectSshProfile(running)).toMatchObject({ view: { code: 'ssh-deps-restart' } })
      expect(inspectSshProfile(running).gate).toBeUndefined()
      captureSshProfile(running)
      expect(inspectSshProfile(running).view.code).toBe('ssh-deps-restart')

      restarted.provide('profileContext', { ...running.get('profileContext') } as never)
      restarted.provide('pluginPackages', running.get('pluginPackages') as never)
      captureSshProfile(restarted)
      expect(inspectSshProfile(restarted)).toMatchObject({ view: { code: 'ready' }, gate: { status: 'eligible', release } })
      expect(inspectSshProfile(restarted).view.command).toBeUndefined()
    } finally {
      await running.fiber.dispose()
      await restarted.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports a partially installed set separately from a fully missing one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mrfw-profile-'))
    const ctx = host()
    try {
      const dir = provideSshProfile(ctx, home, 'ssh-partial')
      installFixtureSsh(dir, release, SSH_PEER_PACKAGES.slice(1))
      captureSshProfile(ctx)
      const state = inspectSshProfile(ctx)
      // The development tree also carries a plugin-private copy of the missing
      // peer, so the gate reports that stronger refusal; the per-package view
      // still separates the three installed peers from the missing one.
      expect(['ssh-deps-partial', 'ssh-deps-private']).toContain(state.view.code)
      expect(state.view).toMatchObject({ profile: 'ssh-partial', release })
      expect(['missing', 'private']).toContain(state.view.packages.find(pkg => pkg.name === SSH_PEER_PACKAGES[0])?.state)
      expect(state.view.packages.slice(1).every(pkg => pkg.state === 'installed')).toBe(true)
      expect(state.view.command).toContain('--profile ssh-partial')
    } finally {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects wrong versions and packages whose entry does not resolve', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mrfw-profile-'))
    const ctx = host()
    try {
      const dir = provideReadySshProfile(ctx, home, release)
      const name = SSH_PEER_PACKAGES[1]
      const manifest = join(dir, 'node_modules', name, 'package.json')
      writeFileSync(manifest, JSON.stringify({ name, version: '0.2.2-rc.4', main: './index.js' }))
      expect(inspectSshProfile(ctx)).toMatchObject({
        view: { code: 'ssh-deps-version', packages: expect.arrayContaining([{ name, state: 'version-mismatch', version: '0.2.2-rc.4' }]) },
      })
      expect(inspectSshProfile(ctx).gate).toBeUndefined()
      writeFileSync(manifest, JSON.stringify({ name, version: release, main: './missing.js', exports: './missing.js' }))
      rmSync(join(dir, 'node_modules', name, 'index.js'))
      expect(inspectSshProfile(ctx).view.code).toBe('ssh-deps-resolution')
      expect(inspectSshProfile(ctx).gate).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('never generates an install command for an unsupported release', async () => {
    const ctx = host('0.2.1-rc.5')
    try {
      const state = inspectSshProfile(ctx)
      expect(state.view.code).toBe('ssh-host-unsupported')
      expect(state.view.command).toBeUndefined()
      expect(state.gate).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
