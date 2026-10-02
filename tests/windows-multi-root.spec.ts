import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { parseWindowsProfile, workspaceScopeSid, widenWindowsProfile } from '../src/windows-profile.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace, REPO_ROOT } from './support/temp-workspace.ts'

const profile = ['node', 'runner.js', '--workspace', 'C:\\primary', '--temp', 'C:\\temp', '--mode', 'workspace-write']
describe('Windows root-set capability', () => {
  it('is stable across ordering and casing, and changes on revocation', () => {
    const sid = workspaceScopeSid(['C:\\primary', 'D:\\extra'])
    expect(sid).toBe(workspaceScopeSid(['d:\\EXTRA', 'c:\\PRIMARY', 'C:\\primary']))
    expect(sid).not.toBe(workspaceScopeSid(['C:\\primary']))
    expect(sid).not.toBe(workspaceScopeSid(['D:\\extra']))
    expect(sid).toMatch(/^S-1-4-(\d+-){4}2$/)
  })
  it('preserves argv boundaries for paths with spaces, quotes, and -- tokens', () => {
    const roots = ['D:\\repo space', 'D:\\quote"repo', '--mode']
    const widened = widenWindowsProfile(profile, roots)
    expect(widened.slice(2, profile.length)).toEqual(profile.slice(2))
    expect(parseWindowsProfile(widened.slice(2), true).additionalRoots).toEqual(roots)
  })
  it('fails closed on unknown, duplicated, missing, or unpaired flags', () => {
    for (const flags of [profile.slice(2).concat('--future', 'yes'), profile.slice(2).concat('--temp', 'x'), profile.slice(2).concat('--write-sid', 'sid'), profile.slice(2, -1)]) {
      expect(() => parseWindowsProfile(flags)).toThrow()
    }
    expect(() => widenWindowsProfile(profile, ['D:\\extra'], 'C:\\different')).toThrow('does not match')
  })
  it('ships a standalone runner and fails closed when invoked on a different OS', () => {
    const runner = join(REPO_ROOT, 'lib/windows-runner.js')
    expect(existsSync(runner)).toBe(true)
    if (process.platform === 'win32') return
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('windows-acl-run: Windows ACL runner requires Windows')
  })
})

it.runIf(process.platform === 'win32')('enforces real Windows writes in both roots and denies a sibling and a removed root', async () => {
  const fixture = createFixtureWorkspace('windows-kernel')
  const third = join(fixture.base, 'third'); mkdirSync(third)
  const ctx = new Context()
  try {
    // Select the real public Windows ACL runner; no permissive runner fallback.
    ctx.provide('sandboxPolicy', {} as never)
    await ctx.plugin(MultiRootScopeService)
    await mountCompat(ctx)
    await ctx.plugin(MultiRootSandboxProvider)
    const provider = ctx.sandbox as MultiRootSandboxProvider
    provider.internals = { chain: ['windows-acl'], windowsAclRunnerArgs: [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))] }
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
    const policy = { mode: 'workspace-write' as const, workspaceRoot: canonicalPath(fixture.workspace) }
    const execute = async (provider: LocalSandboxProvider, roots: string[]) => {
      const payload = `const fs=require('fs'); const roots=${JSON.stringify(roots)}; for(const root of roots){try {fs.writeFileSync(root+'/probe.txt','ok');console.log('allowed')}catch(e){console.log('denied:'+e.code)}}`
      const confined = await provider.confine([process.execPath, '-e', payload], policy)
      return spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8', timeout: 60000 })
    }
    const result = await execute(ctx.sandbox as MultiRootSandboxProvider, [fixture.workspace, fixture.outside, third])
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['allowed', 'allowed', expect.stringMatching(/^denied:/)])
    expect(readFileSync(join(fixture.outside, 'probe.txt'), 'utf8')).toBe('ok')
    const psPath = join(fixture.outside, 'powershell.txt').replace(/'/g, "''")
    const psArgv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `[System.IO.File]::WriteAllText('${psPath}', 'powershell')`]
    const ps = await ctx.sandbox.confine(psArgv, policy)
    const psResult = spawnSync(ps.argv[0]!, ps.argv.slice(1), { encoding: 'utf8', timeout: 60000 })
    expect(psResult.status, psResult.stderr).toBe(0)
    expect(readFileSync(join(fixture.outside, 'powershell.txt'), 'utf8')).toBe('powershell')
    // Exercise the real ConPTY transport with the same confined argv seam.
    await ctx.plugin(LocalSubprocess)
    const psLiteral = (path: string) => path.replace(/'/g, "''")
    const ptyCommand = `[System.IO.File]::WriteAllText('${psLiteral(join(fixture.workspace, 'pty.txt'))}', 'primary'); [System.IO.File]::WriteAllText('${psLiteral(join(fixture.outside, 'pty.txt'))}', 'extra'); try { [System.IO.File]::WriteAllText('${psLiteral(join(third, 'pty.txt'))}', 'bad'); exit 11 } catch { [System.IO.File]::WriteAllText('${psLiteral(join(fixture.outside, 'pty-denied.txt'))}', 'denied') }; exit 23`
    const ptyArgv = await ctx.sandbox.confine(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ptyCommand], policy)
    const ptySpec = { argv: ptyArgv.argv, cwd: fixture.workspace, rows: 24, cols: 100, terminalType: 'xterm-256color', graceMs: 500 }
    const terminal = await ctx.subprocess.spawnTerminal(ptySpec)
    terminal.output.resume()
    let ptyTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([terminal.done, new Promise<never>((_, reject) => {
        ptyTimeout = setTimeout(() => { reject(new Error('Windows restricted PTY timed out')) }, 60000)
      })])
      expect(outcome.exitCode).toBe(23)
      expect(readFileSync(join(fixture.workspace, 'pty.txt'), 'utf8')).toBe('primary')
      expect(readFileSync(join(fixture.outside, 'pty.txt'), 'utf8')).toBe('extra')
      expect(readFileSync(join(fixture.outside, 'pty-denied.txt'), 'utf8')).toBe('denied')
      expect(existsSync(join(third, 'pty.txt'))).toBe(false)
    } finally {
      clearTimeout(ptyTimeout)
      await terminal.terminate()
    }
    const readOnly = await ctx.sandbox.confine([process.execPath, '-e', `try { require('fs').writeFileSync(${JSON.stringify(join(fixture.outside, 'readonly.txt'))}, 'bad'); process.exit(1) } catch { console.log('denied') }`], { ...policy, mode: 'read-only' })
    const readOnlyResult = spawnSync(readOnly.argv[0]!, readOnly.argv.slice(1), { encoding: 'utf8', timeout: 60000 })
    expect(readOnlyResult.status, readOnlyResult.stderr).toBe(0)
    expect(readOnlyResult.stdout.trim()).toBe('denied')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    // Empty scope delegates to upstream; its SID cannot use the old scope ACEs.
    const denied = await execute(ctx.sandbox as MultiRootSandboxProvider, [fixture.outside])
    expect(denied.status, denied.stderr).toBe(0); expect(denied.stdout).toMatch(/^denied:/)
  } finally { await ctx.fiber.dispose(); fixture.dispose() }
}, 180000)
