/**
 * Regression coverage for the two reproducible P1 bypasses the B9 external
 * review reported against `danger-full-access`.
 *
 * - **Unknown authority must not read as "nothing is restricted".** A process
 *   that lost the registry lease publishes an empty scope — with zero
 *   `deniedRoots`, so Full-access used to write anywhere, including inside a
 *   `read-only` root another process registered. While the registry is not
 *   the store's authority, Full-access is now enforced as upstream
 *   `workspace-write` on the fs fence and on the process fence.
 * - **A stale `FsTarget` must not smuggle a write past the deny set.** A
 *   target resolved before its parent directory was swapped for a symlink
 *   into a `read-only` root used to write the protected file: Full-access
 *   checked the STALE target key against the deny set. With deny roots the
 *   fence now re-resolves the display path and checks (and mutates) the FRESH
 *   target, exactly like the confined modes always did.
 */

import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootFileSystem } from '../src/fs.ts'
import type { Config as ScopeConfig } from '../src/scope.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason } from './support/temp-workspace.ts'

/** Mount one Full-access stack: real storage + registry + the multi-root fs fence. */
async function stack(store: string, primary: string, scopeConfig: ScopeConfig = {}): Promise<RegistryStack> {
  return await mountRegistryStack(store, {}, {
    scopeConfig,
    beforeGate: async ctx => {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: primary })
      await ctx.plugin(MultiRootFileSystem, { cwd: primary })
    },
  })
}

describe('an unknown registry authority is not "no restrictions"', () => {
  it('enforces a contended Full-access stack as workspace-write until it takes the lease over', async () => {
    const fixture = createFixtureWorkspace('review-contended')
    const first = await stack(join(fixture.base, 'store'), fixture.workspace)
    let second: RegistryStack | undefined
    try {
      await first.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
      const file = join(fixture.outside, 'victim.txt')
      writeFileSync(file, 'original')
      // The active authority still refuses the registered read-only root.
      await expect(first.ctx.fs.writeText(await first.ctx.fs.resolve(file), 'first'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

      second = await stack(join(fixture.base, 'store'), fixture.workspace)
      expect(second.registry.authority.kind).toBe('contended')
      expect(second.scope.resolve({ mode: 'danger-full-access', workspaceRoot: fixture.workspace }).authority)
        .toBe('unavailable')

      // The store this process cannot read may hold `read-only`
      // registrations — so instead of trusting the empty deny set,
      // Full-access writes only the primary root and the temp grants here.
      await expect(second.ctx.fs.writeText(await second.ctx.fs.resolve(file), 'bypass'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(file, 'utf8')).toBe('original')

      // `fixture.base` is outside the platform temp grants by fixture
      // construction (`assertOutsideTempGrants`), outside the primary root,
      // and outside every registered root — ambient territory a real
      // Full-access would write.
      const stray = join(fixture.base, 'stray.txt')
      await expect(second.ctx.fs.writeText(await second.ctx.fs.resolve(stray), 'stray'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

      // The primary root stays writable: the downgrade is upstream
      // workspace-write semantics, not a lockout.
      await second.ctx.fs.writeText(await second.ctx.fs.resolve(join(fixture.workspace, 'inside.txt')), 'inside')

      // After the holder exits, takeover restores real Full-access
      // semantics: the persisted read-only boundary is denied again and the
      // ambient write is free again.
      await first.dispose()
      await second.registry.refresh(fixture.workspace)
      expect(second.registry.authority.kind).toBe('active')
      expect(second.scope.resolve({ mode: 'danger-full-access', workspaceRoot: fixture.workspace }).authority)
        .toBe('available')
      await expect(second.ctx.fs.writeText(await second.ctx.fs.resolve(file), 'still denied'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(file, 'utf8')).toBe('original')
      await second.ctx.fs.writeText(await second.ctx.fs.resolve(stray), 'stray')
      expect(readFileSync(stray, 'utf8')).toBe('stray')
    } finally {
      await second?.dispose()
      await first.dispose()
      fixture.dispose()
    }
  })
})

describe('the DSH-home boundary under Full-access', () => {
  it('refuses ambient writes under the configured home while restrictions apply', async () => {
    const fixture = createFixtureWorkspace('review-home')
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const service = await stack(join(fixture.base, 'store'), fixture.workspace, { dshHome: home })
    try {
      // With zero additional roots and a healthy authority the home boundary
      // does not engage — Full-access stays upstream-exact.
      const free = join(home, 'early.txt')
      await service.ctx.fs.writeText(await service.ctx.fs.resolve(free), 'before')
      expect(readFileSync(free, 'utf8')).toBe('before')

      // Once any deny boundary exists, the home is protected too.
      await service.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
      const victim = join(home, 'victim.txt')
      writeFileSync(victim, 'config')
      await expect(service.ctx.fs.writeText(await service.ctx.fs.resolve(victim), 'tampered'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(victim, 'utf8')).toBe('config')
      await expect(service.ctx.fs.writeText(await service.ctx.fs.resolve(victim), 'tampered'))
        .rejects.toThrow('DSH home directory')
    } finally {
      await service.dispose()
      fixture.dispose()
    }
  })

  it('denies the home under the unavailable-authority clamp', async () => {
    const fixture = createFixtureWorkspace('review-home-clamp')
    const home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
    const service = await stack(join(fixture.base, 'store'), fixture.workspace, { dshHome: home })
    try {
      service.scope.setRegistryAuthority(false)
      const victim = join(home, 'victim.txt')
      writeFileSync(victim, 'config')
      await expect(service.ctx.fs.writeText(await service.ctx.fs.resolve(victim), 'tampered'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(victim, 'utf8')).toBe('config')
    } finally {
      await service.dispose()
      fixture.dispose()
    }
  })

  it('lets the deny win when the primary root sits inside the home', async () => {
    const fixture = createFixtureWorkspace('review-home-primary')
    const home = join(fixture.base, 'dsh-home')
    const primary = join(home, 'workspace')
    mkdirSync(primary, { recursive: true })
    const service = await stack(join(fixture.base, 'store'), primary, { dshHome: home })
    try {
      await service.registry.add(primary, { path: fixture.outside, access: 'read-only' })
      const target = await service.ctx.fs.resolve(join(primary, 'work.txt'))
      await expect(service.ctx.fs.writeText(target, 'inside primary'))
        .rejects.toThrow('DSH home directory')
    } finally {
      await service.dispose()
      fixture.dispose()
    }
  })
})

describe('a stale FsTarget under Full-access', () => {
  it('is re-resolved and refused instead of written into a read-only subtree', async context => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
    const fixture = createFixtureWorkspace('review-stale')
    const service = await stack(join(fixture.base, 'store'), fixture.workspace)
    try {
      const protectedSub = join(fixture.outside, 'sub')
      const parent = join(fixture.workspace, 'parent')
      mkdirSync(protectedSub)
      mkdirSync(parent)
      const victim = join(protectedSub, 'victim.txt')
      writeFileSync(victim, 'protected')
      writeFileSync(join(parent, 'victim.txt'), 'ordinary')
      await service.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })

      const oldTarget = await service.ctx.fs.resolve(join(parent, 'victim.txt'))
      renameSync(parent, `${parent}-old`)
      symlinkSync(protectedSub, parent, 'dir')

      // workspace-write already re-resolved; Full-access now does too — the
      // target is checked as what the display path resolves to NOW.
      await expect(service.ctx.fs.writeText(oldTarget, 'workspace control', undefined, undefined,
        { mode: 'workspace-write', workspaceRoot: fixture.workspace }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(service.ctx.fs.writeText(oldTarget, 'stale bypass'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(service.ctx.fs.editText(oldTarget,
        { oldString: 'protected', newString: 'stale bypass', replaceAll: false }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(victim, 'utf8')).toBe('protected')
      // The fresh spelling of the same file is equally refused.
      await expect(service.ctx.fs.writeText(await service.ctx.fs.resolve(join(parent, 'victim.txt')), 'fresh'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(victim, 'utf8')).toBe('protected')
    } finally {
      await service.dispose()
      fixture.dispose()
    }
  })
})
