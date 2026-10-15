/** Cross-layer regressions for PR #12: unknown temp grants and deny ancestors. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { denyProfileArgs } from '../src/dialects.ts'
import { widenWindowsProfile } from '../src/windows-profile.ts'
import { mountCompat } from './support/compat.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import { parseConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'

type Dialect = 'seatbelt' | 'bwrap' | 'landlock' | 'windows-acl'
async function sandbox(home?: string) {
  const ctx = new Context()
  ctx.provide('sandboxPolicy', {} as never)
  await ctx.plugin(MultiRootScopeService, home === undefined ? {} : { dshHome: home })
  await mountCompat(ctx)
  await ctx.plugin(MultiRootSandboxProvider, {})
  return ctx
}
function pin(ctx: Context, dialect: Dialect) {
  const provider = ctx.sandbox as MultiRootSandboxProvider
  provider.internals = dialect === 'landlock' ? { chain: [dialect], landlockLauncher: '/landlock-run' }
    : dialect === 'windows-acl' ? { chain: [dialect], windowsAclRunnerArgs: ['node', '/runner.js'] }
      : { chain: [dialect] }
  return provider
}

describe('unknown registry authority never grants shared temp writes', () => {
  it.each(['workspace-write', 'danger-full-access'] as const)('refuses the holder\'s temp root in a contended %s stack', async mode => {
    const fixture = createFixtureWorkspace('authority-temp')
    const temp = mkdtempSync(join(tmpdir(), 'mrw-authority-'))
    const home = join(fixture.base, 'home')
    const mount = () => mountRegistryStack(join(home, 'storages'), {}, {
      scopeConfig: { dshHome: home },
      beforeGate: async ctx => {
        await ctx.plugin(SessionProjectionRegistry)
        await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace })
        await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
      },
    })
    const first = await mount()
    let second: Awaited<ReturnType<typeof mount>> | undefined
    try {
      await first.registry.add(fixture.workspace, { path: temp, access: 'read-only' })
      const file = join(temp, 'victim.txt')
      writeFileSync(file, 'original')
      second = await mount()
      expect(second.registry.authority.kind).toBe('contended')
      for (const stack of [first, second]) {
        const target = await stack.ctx.fs.resolve(file)
        await expect(stack.ctx.fs.writeText(target, 'bypass')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        await expect(stack.ctx.fs.editText(target, { oldString: 'original', newString: 'bypass', replaceAll: false }))
          .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      }
      expect(readFileSync(file, 'utf8')).toBe('original')
      await second.ctx.fs.writeText(await second.ctx.fs.resolve(join(fixture.workspace, 'ok.txt')), 'ok')
      await first.dispose()
      await second.registry.refresh(fixture.workspace)
      expect(second.registry.authority.kind).toBe('active')
      await expect(second.ctx.fs.writeText(await second.ctx.fs.resolve(file), 'still denied'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await second.registry.removeAt(fixture.workspace, { kind: 'ordinal', ordinal: 1 })
      await second.ctx.fs.writeText(await second.ctx.fs.resolve(file), 'restored')
      expect(readFileSync(file, 'utf8')).toBe('restored')
    } finally { await second?.dispose(); await first.dispose(); rmSync(temp, { recursive: true, force: true }); fixture.dispose() }
  })

  it.each(['seatbelt', 'bwrap', 'landlock', 'windows-acl'] as const)('%s grants only the primary root while authority is unknown', async dialect => {
    const fixture = createFixtureWorkspace('authority-profile')
    const ctx = await sandbox()
    try {
      const provider = pin(ctx, dialect)
      ctx.multiRootScope.setRegistryAuthority(false)
      const result = await provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      if (dialect === 'windows-acl') {
        expect(result.argv).toContain('read-only')
        expect(result.argv.slice(result.argv.indexOf('--additional-root'))).toEqual(['--additional-root', canonicalPath(fixture.workspace), '--', 'true'])
      } else {
        expect(parseConfined(result.argv, ['true']).subpaths.filter(path => path !== '/dev/null')).toEqual([canonicalPath(fixture.workspace)])
        expect(result.argv).not.toContain('--tmpfs')
      }
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })

  it('does not graft a draining registry\'s fixed-write members into read-only', async () => {
    const fixture = createFixtureWorkspace('authority-drain')
    const ctx = await sandbox()
    try {
      const provider = pin(ctx, 'seatbelt')
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{
        id: 'fixed', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write',
      }])
      ctx.multiRootScope.setRegistryAuthority(false)
      const policy = { mode: 'read-only' as const, workspaceRoot: fixture.workspace }
      expect(ctx.multiRootScope.resolve(policy).writableRoots).toEqual([])
      expect(parseConfined((await provider.confine(['true'], policy)).argv, ['true']).subpaths).toEqual([])
    } finally { await ctx.fiber.dispose(); fixture.dispose() }
  })
})

describe('a deny ancestor wins over a writable descendant', () => {
  it('retains Seatbelt and bwrap denies, including ancestors of temp mounts', () => {
    const home = '/home/dsh', primary = home + '/workspace'
    const sbpl = `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "${primary}") (subpath "/tmp"))`
    expect(denyProfileArgs('seatbelt', ['sandbox-exec', '-p', sbpl], [home]).at(-1))
      .toContain(`(deny file-write* (subpath "${home}"))`)
    const profile = ['bwrap', '--ro-bind', '/', '/', '--bind', primary, primary, '--tmpfs', '/tmp']
    expect(denyProfileArgs('bwrap', profile, [home]).slice(-3)).toEqual(['--ro-bind', home, home])
    expect(denyProfileArgs('bwrap', profile, ['/']).slice(-3)).toEqual(['--ro-bind', '/', '/'])
  })
  it('refuses Landlock and Windows grant/deny overlap in either direction', () => {
    for (const [deny, grant] of [['/home', '/home/ws'], ['/tmp/nested', '/tmp']]) {
      expect(() => denyProfileArgs('landlock', ['landlock-run', '--ro', '/', '--rw', grant!], [deny!])).toThrow('cannot deny')
    }
    for (const mode of ['read-only', 'workspace-write']) {
      const profile = ['node', '/runner.js', '--workspace', 'C:\\home\\ws', '--temp', 'C:\\temp', '--mode', mode]
      expect(() => widenWindowsProfile(profile, ['C:\\home\\ws'], ['C:\\home'])).toThrow('cannot deny')
    }
    expect(() => widenWindowsProfile(['node', '/runner.js', '--workspace', 'C:\\ws', '--temp', 'C:\\temp', '--mode', 'workspace-write'], [], ['C:\\']))
      .toThrow('cannot deny')
  })

  for (const dialect of ['seatbelt', 'bwrap'] as const) it(`enforces primary-only writes and ancestor denies in native ${dialect}`, async test => {
    if ((dialect === 'seatbelt' && process.platform !== 'darwin') || (dialect === 'bwrap' && process.platform !== 'linux')) {
      test.skip('requires the native target platform'); return
    }
    const fixture = createFixtureWorkspace('authority-native')
    const temp = mkdtempSync(join(tmpdir(), 'mrw-authority-native-'))
    const ctx = await sandbox()
    try {
      const provider = pin(ctx, dialect)
      const policy = { mode: 'workspace-write' as const, workspaceRoot: fixture.workspace }
      const probe = await provider.confine(['true'], policy)
      const check = spawnSync(probe.argv[0]!, probe.argv.slice(1), { encoding: 'utf8' })
      if (check.error || check.status !== 0) { test.skip(requireKernelRunner(dialect, check.error?.message ?? check.stderr)); return }
      ctx.multiRootScope.setRegistryAuthority(false)
      const target = join(temp, 'denied.txt'), allowed = join(fixture.workspace, 'ok.txt')
      const command = [process.execPath, '-e',
        'const f=require("fs");f.writeFileSync(process.argv[1],"ok");try{f.writeFileSync(process.argv[2],"bad");process.exit(9)}catch(e){if(!["EPERM","EACCES","EROFS"].includes(e.code))throw e}', allowed, target]
      for (const mode of ['workspace-write', 'danger-full-access'] as const) {
        const full = { mode, workspaceRoot: fixture.workspace }
        const facts = mode === 'workspace-write' ? await provider.confine(command, full)
          : await provider.clampedExecution(full, [])
        const argv = mode === 'workspace-write' ? facts.argv : [...facts.argv, ...command]
        const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(allowed)).toBe(true)
        expect(existsSync(target)).toBe(false)
      }
      const home = canonicalPath(fixture.base)
      const prefix = await provider.clampedExecution({ mode: 'danger-full-access', workspaceRoot: fixture.workspace }, [home])
      const denied = spawnSync(prefix.argv[0]!, [...prefix.argv.slice(1), process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"bad")', allowed], { encoding: 'utf8' })
      expect(denied.status).not.toBe(0)
      expect(readFileSync(allowed, 'utf8')).toBe('ok')
    } finally { await ctx.fiber.dispose(); rmSync(temp, { recursive: true, force: true }); fixture.dispose() }
  })
})
