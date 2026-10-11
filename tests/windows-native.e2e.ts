/**
 * Windows-native ACL hardening e2e: real restricted-token spawns against
 * hostile root names, a second drive, path aliases, junction redirection,
 * non-caller-owned roots, revocation snapshots, concurrent root sets, ConPTY
 * interruption, and Git Bash. Runs only on Windows; every case cleans its
 * fixtures in `finally`.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import type { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace, REPO_ROOT } from './support/temp-workspace.ts'
import { shortPathName } from './support/windows.ts'

const PLUGIN_RUNNER = join(REPO_ROOT, 'lib', 'windows-runner.js')
const UPSTREAM_RUNNER_ARGS = (): string[] => [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))]

interface Spawned {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

interface Mounted {
  readonly ctx: Context
  readonly provider: MultiRootSandboxProvider
  readonly policy: SandboxPolicy
}

/** Mount the SHIPPED provider and pin the real upstream Windows ACL runner. */
async function mountProvider(workspace: string): Promise<Mounted> {
  const ctx = new Context()
  // Execute the shipped provider: its import.meta.url must locate the built
  // standalone runner, not a nonexistent src/windows-runner.js under Vitest.
  const { MultiRootSandboxProvider } = await import(pathToFileURL(join(REPO_ROOT, 'lib/sandbox.js')).href) as typeof import('../src/sandbox.ts')
  ctx.provide('sandboxPolicy', {} as never)
  await ctx.plugin(MultiRootScopeService)
  await mountCompat(ctx)
  await ctx.plugin(MultiRootSandboxProvider)
  const provider = ctx.sandbox as MultiRootSandboxProvider
  provider.internals = { chain: ['windows-acl'], windowsAclRunnerArgs: UPSTREAM_RUNNER_ARGS() }
  return { ctx, provider, policy: { mode: 'workspace-write', workspaceRoot: canonicalPath(workspace) } }
}

/** Confine `argv` and spawn it, collecting the child's piped output. */
async function spawnConfined(mounted: Mounted, argv: readonly string[], policy = mounted.policy): Promise<Spawned> {
  const confined = await mounted.provider.confine(argv, policy)
  return await spawnArgv(confined.argv[0]!, confined.argv.slice(1))
}

async function spawnArgv(command: string, args: readonly string[], timeout = 120_000): Promise<Spawned> {
  return await new Promise<Spawned>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => stdout.push(chunk as Buffer))
    child.stderr?.on('data', chunk => stderr.push(chunk as Buffer))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`spawn timed out after ${timeout}ms: ${command} ${args.join(' ')}\nstderr: ${Buffer.concat(stderr).toString('utf8')}`))
    }, timeout)
    child.once('error', error => { clearTimeout(timer); resolve({ status: null, stdout: '', stderr: '', error }) })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ status: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

/** A confined spawn whose exit can be awaited later (concurrency cases). */
async function startConfined(mounted: Mounted, argv: readonly string[], policy = mounted.policy): Promise<{ child: ChildProcess; done: Promise<Spawned> }> {
  const confined = await mounted.provider.confine(argv, policy)
  const child = spawn(confined.argv[0]!, confined.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise<Spawned>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => stdout.push(chunk as Buffer))
    child.stderr?.on('data', chunk => stderr.push(chunk as Buffer))
    child.once('error', reject)
    child.once('exit', code => resolve({ status: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
  return { child, done }
}

/** A PowerShell invocation safe for hostile paths: the script goes base64. */
function powershellArgv(script: string): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** Node `-e` payload that writes one file per root and reports allowed/denied. */
function writeProbe(roots: readonly string[], name = 'probe.txt'): string {
  return `const fs=require('fs');const roots=${JSON.stringify(roots)};for(const root of roots){try{fs.writeFileSync(root+${JSON.stringify(`/${name}`)},'ok');console.log('allowed')}catch(e){console.log('denied:'+(e&&e.code||e))}}`
}

/** Find a writable local fixed drive other than the fixture's, if one exists. */
function secondDrive(fixtureDrive: string): string | undefined {
  for (const letter of ['D:\\', 'C:\\']) {
    if (letter.toUpperCase() === fixtureDrive) continue
    try {
      const probe = mkdtempSync(join(letter, 'dsh-mr-xdrive-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return letter
    } catch { continue }
  }
  return undefined
}

describe.runIf(process.platform === 'win32')('Windows ACL native confinement', () => {
  it('confines hostile root names for Node and PowerShell children alike', async () => {
    const fixture = createFixtureWorkspace('win-hostile')
    const primary = join(fixture.base, "主 根 'a'&^%!(1)")
    const extra = join(fixture.base, '额外 根;b,c')
    const third = join(fixture.base, 'third')
    for (const dir of [primary, extra, third]) mkdirSync(dir)
    const mounted = await mountProvider(primary)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(primary, [{ id: 'extra', path: extra, recordedPath: canonicalPath(extra) }])
      const node = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([primary, extra, third])])
      expect(node.error).toBeUndefined()
      expect(node.status, node.stderr).toBe(0)
      expect(node.stdout.trim().split(/\r?\n/)).toEqual(['allowed', 'allowed', expect.stringMatching(/^denied:/)])
      const ps = powershellArgv(`[System.IO.File]::WriteAllText(${JSON.stringify(join(extra, 'ps.txt'))}, 'powershell')`)
      const psResult = await spawnConfined(mounted, ps)
      expect(psResult.status, psResult.stderr).toBe(0)
      expect(readFileSync(join(extra, 'ps.txt'), 'utf8')).toBe('powershell')
      const deniedPs = powershellArgv(`try { [System.IO.File]::WriteAllText(${JSON.stringify(join(third, 'ps.txt'))}, 'bad'); exit 11 } catch { exit 0 }`)
      const deniedResult = await spawnConfined(mounted, deniedPs)
      expect(deniedResult.status, deniedResult.stderr).toBe(0)
      expect(existsSync(join(third, 'ps.txt'))).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 240_000)

  it('grants an additional root on a different drive', async (context) => {
    const fixture = createFixtureWorkspace('win-xdrive')
    const fixtureDrive = canonicalPath(fixture.workspace).slice(0, 2).toUpperCase()
    const drive = secondDrive(fixtureDrive)
    if (drive === undefined) {
      if (process.env.CI !== undefined) expect.unreachable('CI runners have a second fixed drive (C: and D:)')
      context.skip('no second writable fixed drive found')
      return
    }
    const extra = mkdtempSync(join(drive, `dsh-mr-xdrive-${process.pid}-`))
    const third = join(fixture.base, 'third')
    mkdirSync(third)
    const mounted = await mountProvider(fixture.workspace)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'drive', path: extra, recordedPath: canonicalPath(extra) }])
      const result = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([fixture.workspace, extra, third])])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split(/\r?\n/)).toEqual(['allowed', 'allowed', expect.stringMatching(/^denied:/)])
    } finally {
      await mounted.ctx.fiber.dispose()
      rmSync(extra, { recursive: true, force: true })
      fixture.dispose()
    }
  }, 180_000)

  it('grants a root registered under a case variant or its 8.3 alias', async () => {
    const fixture = createFixtureWorkspace('win-alias')
    const mounted = await mountProvider(fixture.workspace)
    try {
      const recorded = canonicalPath(fixture.outside)
      // The scope canonicalizes `path`, so a case variant or the volume's 8.3
      // short name for the same directory carries the same grant.
      const variant = fixture.outside.toUpperCase()
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: variant, recordedPath: recorded }])
      const first = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([fixture.outside], 'variant.txt')])
      expect(first.status, first.stderr).toBe(0)
      expect(first.stdout.trim()).toBe('allowed')
      const short = shortPathName(fixture.outside)
      if (short === fixture.outside || short === recorded) {
        console.info(`8.3 short names are disabled on this volume; skipping the short-alias assertion (${short})`)
        return
      }
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: short, recordedPath: recorded }])
      const second = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([fixture.outside], 'short.txt')])
      expect(second.status, second.stderr).toBe(0)
      expect(second.stdout.trim()).toBe('allowed')
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 180_000)

  it('withholds a junction that is repointed after registration', async () => {
    const fixture = createFixtureWorkspace('win-junction')
    const target = join(fixture.base, 'target')
    const other = join(fixture.base, 'other')
    const link = join(fixture.base, 'link')
    for (const dir of [target, other]) mkdirSync(dir)
    symlinkSync(target, link, 'junction')
    const mounted = await mountProvider(fixture.workspace)
    try {
      // Registering the junction records the TARGET; writes through the link
      // work while the link still resolves there.
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: link, recordedPath: canonicalPath(link) }])
      expect(canonicalPath(link)).toBe(canonicalPath(target))
      const first = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([join(link)], 'via-link.txt')])
      expect(first.status, first.stderr).toBe(0)
      expect(first.stdout.trim()).toBe('allowed')
      expect(existsSync(join(target, 'via-link.txt'))).toBe(true)
      // Repoint the junction: the scope reports redirected and withholds, and
      // the runner never widens a grant onto the new target.
      rmSync(link, { force: true, recursive: true })
      symlinkSync(other, link, 'junction')
      expect(mounted.ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
      const confined = await mounted.provider.confine([process.execPath, '-e', writeProbe([link, other], 'sneaky.txt')], mounted.policy)
      expect(confined.argv[1]).not.toBe(PLUGIN_RUNNER)
      const second = await spawnArgv(confined.argv[0]!, confined.argv.slice(1))
      expect(second.stdout.trim().split(/\r?\n/)).toEqual([expect.stringMatching(/^denied:/), expect.stringMatching(/^denied:/)])
      expect(existsSync(join(other, 'sneaky.txt'))).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 180_000)

  it('exits 127 without running the child when a root is removed between confine and spawn', async () => {
    const fixture = createFixtureWorkspace('win-removed')
    const mounted = await mountProvider(fixture.workspace)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const marker = join(fixture.workspace, 'child-ran.txt')
      const confined = await mounted.provider.confine([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], mounted.policy)
      rmSync(fixture.outside, { recursive: true, force: true })
      const result = await spawnArgv(confined.argv[0]!, confined.argv.slice(1))
      expect(result.status).toBe(127)
      expect(result.stderr).toContain('windows-acl-run:')
      expect(existsSync(marker)).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 120_000)

  it('refuses a root the caller does not own', async (context) => {
    const fixture = createFixtureWorkspace('win-owner')
    const foreign = join(fixture.base, 'foreign-owned')
    mkdirSync(foreign)
    const whoami = execFileSync('whoami', { encoding: 'utf8' }).trim()
    const owner = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? whoami}`.replace(/^\\/, '')
    const icacls = (args: string[]) => spawnSync('icacls', args, { encoding: 'utf8', timeout: 60_000 })
    let hijacked = false
    const restore = (): void => {
      // Every cleanup step is best-effort and logged: takeown works for
      // administrators even while SYSTEM owns the directory, /reset restores
      // inherited ACLs, and /remove:d clears the deny if it survived. The
      // fixture's own rmSync removes the directory afterwards.
      const steps = [
        ['takeown', ['/f', foreign, '/r', '/d', 'y']],
        ['icacls', [foreign, '/reset', '/t', '/c']],
        ['icacls', [foreign, '/remove:d', '*S-1-1-0', '/t', '/c']],
      ] as const
      for (const [command, args] of steps) {
        try {
          const done = spawnSync(command, [...args], { encoding: 'utf8', timeout: 60_000 })
          if (done.status !== 0) console.info(`foreign-owned cleanup \`${command} ${args.slice(1).join(' ')}\` exited ${done.status}: ${done.stderr || done.stdout}`)
        } catch (error) {
          console.info(`foreign-owned cleanup ${command} threw: ${String(error)}`)
        }
      }
    }
    const mounted = await mountProvider(fixture.workspace)
    try {
      const seized = icacls([foreign, '/setowner', 'NT AUTHORITY\\SYSTEM'])
      const locked = seized.status === 0 ? icacls([foreign, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)(RX)`]) : seized
      // A grant-only DACL does not bind an elevated caller — administrators
      // still wrote through it on the CI runner — so an explicit DENY on
      // Everyone's write/delete/delete-child makes the lockout hold under
      // elevation too. WDAC/WO are deliberately not denied so cleanup can
      // still read and repair the ACL afterwards.
      const denied = locked.status === 0 ? icacls([foreign, '/deny', '*S-1-1-0:(OI)(CI)(W,D,DC)']) : locked
      if (denied.status !== 0) {
        restore()
        if (process.env.CI !== undefined) expect.unreachable(`icacls setup failed on CI: ${denied.stderr || denied.stdout}`)
        context.skip(`cannot build a foreign-owned directory on this host: ${denied.stderr || denied.stdout}`)
        return
      }
      hijacked = true
      // The premise to prove first: the setup must be effective. An unconfined
      // WRITE probe is not a valid check on an elevated host — libuv opens
      // files with FILE_FLAG_BACKUP_SEMANTICS and the elevated runner token
      // holds backup/restore privileges, so the unconfined process bypasses
      // the DACL entirely (the restricted-token child cannot). Read the ACL
      // back instead: the Everyone DENY entry must be present.
      const acl = icacls([foreign])
      const aclText = `${acl.stdout}\n${acl.stderr}`
      // icacls renders a deny ACE as e.g. `Everyone:(OI)(CI)(DENY)(W,D,DC)`.
      if (!/(everyone|S-1-1-0)[^\r\n]*\(DENY\)/i.test(aclText)) {
        restore()
        if (process.env.CI !== undefined) expect.unreachable(`the Everyone deny ACE is missing from the ACL; icacls says:\n${aclText}`)
        context.skip(`cannot verify the deny ACE on this host; icacls says:\n${aclText}`)
        return
      }
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: foreign, recordedPath: canonicalPath(foreign) }])
      const third = join(fixture.base, 'third')
      mkdirSync(third)
      // Fail-closed, not a specific exit: either the runner refuses the grant
      // before the child runs (127) or the child runs and the kernel denies
      // every unauthorized write. On an elevated host the precondition
      // failure (127) may never reproduce — the widened grant applies
      // cleanly — which is why both outcomes are accepted.
      const probe = writeProbe([foreign, third], 'owned.txt')
      let result: Spawned
      try {
        result = await spawnConfined(mounted, [process.execPath, '-e', probe])
      } catch (error) {
        console.info(`foreign-owned root: the provider refused at confine (fail-closed): ${String(error)}`)
        expect(existsSync(join(foreign, 'owned.txt'))).toBe(false)
        expect(existsSync(join(third, 'owned.txt'))).toBe(false)
        return
      }
      if (result.status === 127) {
        console.info('foreign-owned root: the runner refused before spawn (exit 127)')
        expect(result.stderr).toContain('windows-acl-run:')
      } else {
        console.info(`foreign-owned root: the grant was applied; asserting the child could not write either dir (status ${String(result.status)})`)
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim().split(/\r?\n/)).toEqual([
          expect.stringMatching(/^denied:/),
          expect.stringMatching(/^denied:/),
        ])
      }
      expect(existsSync(join(foreign, 'owned.txt'))).toBe(false)
      expect(existsSync(join(third, 'owned.txt'))).toBe(false)
    } finally {
      if (hijacked) restore()
      await mounted.ctx.fiber.dispose()
      fixture.dispose()
    }
  }, 180_000)

  it('keeps an already-confined child on its snapshot when a root is revoked', async () => {
    const fixture = createFixtureWorkspace('win-revoke')
    const go = join(fixture.workspace, 'go.flag')
    const writtenByA = join(fixture.outside, 'from-a.txt')
    const mounted = await mountProvider(fixture.workspace)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const waiter = `const fs=require('fs');const go=${JSON.stringify(go)};const t=setInterval(()=>{if(fs.existsSync(go)){clearInterval(t);fs.writeFileSync(${JSON.stringify(writtenByA)},'a');process.exit(0)}},100);setTimeout(()=>process.exit(9),90000)`
      const a = await startConfined(mounted, [process.execPath, '-e', waiter])
      // Revoke X before A is released: A's grant snapshot still covers it.
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
      const b = await spawnConfined(mounted, [process.execPath, '-e', writeProbe([fixture.outside], 'from-b.txt')])
      expect(b.stdout.trim()).toMatch(/^denied:/)
      writeFileSync(go, 'go')
      const aResult = await a.done
      expect(aResult.status, aResult.stderr).toBe(0)
      expect(readFileSync(writtenByA, 'utf8')).toBe('a')
      a.child.kill('SIGKILL')
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 180_000)

  it('confines four children under two root sets with private temps each', async () => {
    const fixture = createFixtureWorkspace('win-concurrent')
    const secondPrimary = join(fixture.base, 'p2')
    const extraY = join(fixture.base, 'extra-y')
    const third = join(fixture.base, 'third')
    for (const dir of [secondPrimary, extraY, third]) mkdirSync(dir)
    const mounted = await mountProvider(fixture.workspace)
    try {
      const payload = (roots: readonly string[]) => `const fs=require('fs');console.log('TEMP='+process.env.TEMP);const roots=${JSON.stringify(roots)};for(const root of roots){try{fs.writeFileSync(root+'/probe.txt','ok');console.log('allowed')}catch(e){console.log('denied:'+(e&&e.code||e))}}`
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'x', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const setX = [
        await startConfined(mounted, [process.execPath, '-e', payload([fixture.outside, extraY])]),
        await startConfined(mounted, [process.execPath, '-e', payload([fixture.outside, extraY])]),
      ]
      const policyY = { ...mounted.policy, workspaceRoot: canonicalPath(secondPrimary) }
      mounted.ctx.multiRootScope.setAdditionalRoots(secondPrimary, [{ id: 'y', path: extraY, recordedPath: canonicalPath(extraY) }])
      const setY = [
        await startConfined(mounted, [process.execPath, '-e', payload([extraY, fixture.outside])], policyY),
        await startConfined(mounted, [process.execPath, '-e', payload([extraY, fixture.outside])], policyY),
      ]
      const results = await Promise.all([...setX, ...setY].map(entry => entry.done))
      const temps: string[] = []
      for (const [index, result] of results.entries()) {
        expect(result.status, result.stderr).toBe(0)
        const lines = result.stdout.trim().split(/\r?\n/)
        temps.push(lines[0]!.replace('TEMP=', ''))
        const verdicts = lines.slice(1)
        // X-set children write X and are denied Y; Y-set the mirror image.
        expect(verdicts, `child ${index}`).toEqual(index < 2
          ? ['allowed', expect.stringMatching(/^denied:/)]
          : ['allowed', expect.stringMatching(/^denied:/)])
      }
      expect(new Set(temps).size).toBe(4)
      const parents = new Set(temps.map(temp => dirname(temp)))
      expect(parents.size, `private temps share the upstream temp parent: ${temps.join(', ')}`).toBe(1)
      for (const temp of temps) expect(existsSync(temp), `${temp} was not removed`).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 300_000)

  it('mirrors the child exit code and carries both output streams', async () => {
    const fixture = createFixtureWorkspace('win-streams')
    const mounted = await mountProvider(fixture.workspace)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const result = await spawnConfined(mounted, [process.execPath, '-e', `process.stdout.write('out');process.stderr.write('err');process.exit(42)`])
      expect(result.status).toBe(42)
      expect(result.stdout).toContain('out')
      expect(result.stderr).toContain('err')
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 120_000)

  it('leaves read-only mode on the upstream runner with no widened grant', async () => {
    const fixture = createFixtureWorkspace('win-readonly')
    const mounted = await mountProvider(fixture.workspace)
    try {
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const confined = await mounted.provider.confine(
        [process.execPath, '-e', `try{require('fs').writeFileSync(${JSON.stringify(join(fixture.outside, 'ro.txt'))},'bad');console.log('allowed')}catch(e){console.log('denied:'+(e&&e.code||e))}`],
        { ...mounted.policy, mode: 'read-only' },
      )
      expect(confined.argv[1]).not.toBe(PLUGIN_RUNNER)
      const result = await spawnArgv(confined.argv[0]!, confined.argv.slice(1))
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toMatch(/^denied:/)
      expect(existsSync(join(fixture.outside, 'ro.txt'))).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 120_000)

  it('keeps upstream Ctrl+C semantics for a confined ConPTY child', async (context) => {
    const fixture = createFixtureWorkspace('win-pty')
    const mounted = await mountProvider(fixture.workspace)
    const terminals: Awaited<ReturnType<typeof mounted.ctx.subprocess.spawnTerminal>>[] = []
    try {
      await mounted.ctx.plugin(LocalSubprocess)
      // The probe program must demonstrably accept a ConPTY Ctrl+C unconfined
      // before it can prove anything under a runner: on the CI runner
      // `powershell -Command Start-Sleep` ignored \x03 even unconfined, so the
      // baseline is picked from candidates in order and the FIRST
      // interruptible one becomes the program both runners execute.
      const candidates: { name: string; argv: string[]; ready?: string }[] = [
        {
          name: 'node-sigint',
          argv: [process.execPath, '-e',
            `process.stdout.write('ready\\n');process.on('SIGINT',()=>{process.stdout.write('sigint\\n');process.exit(130)});setInterval(()=>{},1000)`],
          ready: 'ready',
        },
        { name: 'cmd-ping', argv: ['cmd.exe', '/d', '/c', 'ping -n 60 127.0.0.1'] },
        { name: 'powershell-sleep', argv: ['powershell.exe', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'] },
      ]
      // One run of the same argv per terminal. The upstream runner calls
      // SetConsoleCtrlHandler(NULL, TRUE) — an ignore-Ctrl+C attribute the
      // confined child INHERITS — while our runner's SIGINT handling is a Node
      // handler and is not inherited. So parity is not the property: the
      // property is that the PLUGIN run is interrupted and exits with the
      // child's own code (the runner forwarded Ctrl+C and mirrored the child's
      // exit rather than dying itself).
      type Interrupt = { outcome: 'interrupted' | 'timeout' | 'failed' | 'no-input'; exitCode?: number | null }
      const interruptOutcome = async (argv: readonly string[], ready?: string): Promise<Interrupt> => {
        const terminal = await mounted.ctx.subprocess.spawnTerminal({
          argv: [...argv], cwd: fixture.workspace, rows: 24, cols: 100, terminalType: 'xterm-256color', graceMs: 3000,
        })
        terminals.push(terminal)
        terminal.output.resume()
        if (typeof terminal.write !== 'function') return { outcome: 'no-input' }
        try {
          if (ready !== undefined) {
            // Wait until the child is demonstrably running (its ready marker)
            // rather than racing the \x03 against startup.
            let seen = ''
            terminal.output.on('data', (chunk: Buffer | string) => { seen += chunk.toString() })
            const deadline = Date.now() + 5000
            while (!seen.includes(ready) && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 50))
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
          await terminal.write('\x03')
          return await Promise.race([
            terminal.done.then(
              done => ({ outcome: 'interrupted' as const, exitCode: done.exitCode }),
              () => ({ outcome: 'failed' as const }),
            ),
            new Promise<Interrupt>(resolve => setTimeout(() => resolve({ outcome: 'timeout' }), 20_000)),
          ])
        } finally {
          await terminal.terminate()
        }
      }
      const unconfinedOutcomes: string[] = []
      let baseline: (typeof candidates)[number] | undefined
      let baselineExitCode: number | null | undefined
      for (const candidate of candidates) {
        const result = await interruptOutcome(candidate.argv, candidate.ready)
        unconfinedOutcomes.push(`${candidate.name}=${result.outcome}`)
        console.info(`ConPTY Ctrl+C unconfined candidate ${candidate.name}: ${result.outcome}`)
        if (result.outcome === 'no-input') {
          context.skip('this release exposes no terminal input API')
          return
        }
        if (result.outcome === 'interrupted') {
          baseline = candidate
          baselineExitCode = result.exitCode
          break
        }
      }
      // If NO candidate can be interrupted even unconfined the \x03 delivery
      // mechanism itself is wrong on this host — that is a test bug, not a
      // confinement fact, and the log needs every outcome to see it.
      expect(baseline, `no candidate program was interruptible even unconfined (${unconfinedOutcomes.join(', ')}); the Ctrl+C mechanism itself is broken here`).toBeDefined()
      const upstream = await mounted.provider.confine(baseline!.argv, mounted.policy)
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const widened = await mounted.provider.confine(baseline!.argv, mounted.policy)
      const upstreamResult = await interruptOutcome(upstream.argv, baseline!.ready)
      console.info(`ConPTY Ctrl+C upstream (program=${baseline!.name}): ${upstreamResult.outcome} — ` +
        'an upstream runner characteristic: its SetConsoleCtrlHandler ignore flag is inherited by the confined child, ' +
        'so a timeout here is expected and not asserted')
      const pluginResult = await interruptOutcome(widened.argv, baseline!.ready)
      console.info(`ConPTY Ctrl+C plugin (program=${baseline!.name}): ${pluginResult.outcome} exit=${String(pluginResult.exitCode)}`)
      if (upstreamResult.outcome === 'no-input' || pluginResult.outcome === 'no-input') {
        context.skip('this release exposes no terminal input API')
        return
      }
      expect(pluginResult.outcome, 'the plugin-confined child was not interrupted by \\x03').toBe('interrupted')
      expect(pluginResult.exitCode,
        `the widened runner must mirror the child's own SIGINT exit (the unconfined baseline exited ${String(baselineExitCode)}), not die as the runner itself`)
        .toBe(baselineExitCode)
    } finally {
      for (const terminal of terminals) await terminal.terminate().catch(() => {})
      await mounted.ctx.fiber.dispose()
      fixture.dispose()
    }
  }, 180_000)

  it('runs Git Bash confined when a Git installation is present', async (context) => {
    const fixture = createFixtureWorkspace('win-bash')
    const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    let bash = candidates.find(existsSync)
    if (bash === undefined) {
      try {
        bash = execFileSync('where', ['bash'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim()
      } catch { bash = undefined }
    }
    if (bash === undefined || bash === '') {
      context.skip('no Git Bash on this host')
      return
    }
    const third = join(fixture.base, 'third')
    mkdirSync(third)
    const mounted = await mountProvider(fixture.workspace)
    try {
      const script = `echo x > '${fixture.outside.replace(/\\/g, '/')}/bash.txt' && echo bash-ok`
      // MSYS cannot start under the write-restricted Low-integrity token:
      // `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…): 0xC0000022` on
      // newer releases, `*** fatal error - CreateFileMapping …, Win32 error
      // 5. Terminating.` (exit 256) on 0.1.5-rc.2. That is an upstream
      // restricted-token limitation, not a plugin defect — the property is
      // PARITY between the upstream runner's argv and the widened runner's
      // argv for the same child.
      const msysStartupFailure = (result: Spawned): boolean =>
        /NtCreateDirectoryObject|0xC0000022|\*\*\* fatal error - /i.test(result.stderr) || result.status === 3221225794
      const upstream = await mounted.provider.confine([bash, '-c', script], mounted.policy)
      const upstreamResult = await spawnArgv(upstream.argv[0]!, upstream.argv.slice(1))
      mounted.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
      const pluginResult = await spawnConfined(mounted, [bash, '-c', script])
      const upstreamFailed = msysStartupFailure(upstreamResult)
      const pluginFailed = msysStartupFailure(pluginResult)
      console.info(`Git Bash confined start: upstream=${upstreamFailed ? `msys startup failure (${String(upstreamResult.status)})` : `exit ${String(upstreamResult.status)}`} plugin=${pluginFailed ? `msys startup failure (${String(pluginResult.status)})` : `exit ${String(pluginResult.status)}`}`)
      if (upstreamFailed && pluginFailed) {
        console.info('documented limitation: Git Bash/MSYS cannot start under the restricted token; upstream and plugin agree')
        expect(existsSync(join(fixture.outside, 'bash.txt'))).toBe(false)
        expect(existsSync(join(third, 'bash.txt'))).toBe(false)
        return
      }
      expect(pluginFailed, `plugin runner failed where upstream started.\nplugin stderr: ${pluginResult.stderr}\nupstream stderr: ${upstreamResult.stderr}`).toBe(upstreamFailed)
      expect(pluginResult.status, pluginResult.stderr).toBe(0)
      expect(pluginResult.stdout).toContain('bash-ok')
      expect(readFileSync(join(fixture.outside, 'bash.txt'), 'utf8')).toContain('x')
      const denied = await spawnConfined(mounted, [bash, '-c', `echo x > '${third.replace(/\\/g, '/')}/bash.txt' && echo wrote || echo denied`])
      expect(denied.status, denied.stderr).toBe(0)
      expect(existsSync(join(third, 'bash.txt'))).toBe(false)
    } finally { await mounted.ctx.fiber.dispose(); fixture.dispose() }
  }, 180_000)
})

