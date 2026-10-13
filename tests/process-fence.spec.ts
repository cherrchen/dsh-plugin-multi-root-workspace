/**
 * The B9 process fence: `danger-full-access` must not write an explicit
 * `read-only` additional root, and the seam that enforces it must never widen
 * an ordinary spawn.
 *
 * Upstream's shell executor, PTC runtime and PTY backend all skip
 * `ctx.sandbox.confine` in that mode, so the fence wraps their public
 * entries: an AsyncLocalStorage deny context set around `execute` rewrites
 * the argv `ctx.subprocess.spawn` receives, and `spawnTerminal` resolves its
 * caller from the `DSH_SESSION_ID` environment marker.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider, SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { denyProfileArgs } from '../src/dialects.ts'
import * as ProcessFence from '../src/process-fence.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { confined } from './support/confine.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('process-fence')
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  fixture.dispose()
})

type Dialect = 'seatbelt' | 'bwrap' | 'landlock' | 'windows-acl'
const COMMAND = ['bash', '-c', 'echo hi']

function internalsFor(dialect: Dialect): SandboxInternals {
  switch (dialect) {
    case 'seatbelt': return { chain: ['seatbelt'] }
    case 'bwrap': return { chain: ['bwrap'] }
    case 'landlock': return { chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run' }
    case 'windows-acl': return { chain: ['windows-acl'], windowsAclRunnerArgs: ['node', '/fake/runner.js'] }
  }
}

interface Captured {
  spawned: SubprocessSpawnSpec[]
  terminals: SubprocessTerminalSpawnSpec[]
}

interface Stack {
  ctx: Context
  provider: LocalSandboxProvider
  captured: Captured
}

/**
 * Mount the real providers and the fence row, with the spawned surfaces
 * stubbed: `ctx.shell.execute` and `ctx.ptcRuntime.run` run their command
 * through `ctx.subprocess.spawn` exactly the way the upstream consumers do.
 */
async function mountStack(
  dialect: Dialect,
  mode: SandboxPolicy['mode'] | 'danger-full-access',
  sessions: ReadonlyMap<string, Session> = new Map(),
  legacyShell = false,
  spawnResult: unknown = { pid: 1 },
): Promise<Stack> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
    await ctx.plugin(MultiRootScopeService),
  )
  await mountCompat(ctx)
  fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = internalsFor(dialect)
  await mountProviderGate(ctx)

  const captured: Captured = { spawned: [], terminals: [] }
  const execute = async (_spec: { command?: string }) =>
    ctx.subprocess.spawn({ argv: COMMAND, cwd: fixture.workspace })
  await ctx.plugin({
    name: 'process-surfaces',
    apply(fiber: Context) {
      fiber.provide('subprocess', {
        spawn: (spec: SubprocessSpawnSpec) => {
          captured.spawned.push(spec)
          return spawnResult
        },
        spawnTerminal: async (spec: SubprocessTerminalSpawnSpec) => {
          captured.terminals.push(spec)
          return { pid: 2 }
        },
      } as never)
      fiber.provide('shell', legacyShell ? { run: execute, start: execute } as never : { execute } as never)
      fiber.provide('ptcRuntime', { run: execute } as never)
      fiber.provide('sessions', { get: (id: string) => sessions.get(id) } as never)
    },
  })
  fibers.push(await ctx.plugin(ProcessFence))
  return { ctx, provider, captured }
}

function member(path: string, access: 'inherit' | 'read-only' | 'read-write', index = 0) {
  return { id: `root-${index}`, path, recordedPath: canonicalPath(path), access }
}

/** The SBPL spelling of a subpath literal — backslashes and quotes escaped. */
const sbplSubpath = (path: string): string =>
  `(subpath "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`

describe('the restricted argv prefix', () => {
  const policy = { mode: 'danger-full-access', workspaceRoot: '' } as unknown as SandboxPolicy

  it('is an allow-default seatbelt profile with subpath denies', async () => {
    const { provider } = await mountStack('seatbelt', 'danger-full-access')
    const denied = canonicalPath(fixture.outside)
    const prefix = await (provider as MultiRootSandboxProvider)
      .restrictedArgvPrefix({ ...policy, workspaceRoot: fixture.workspace }, [denied])
    expect(prefix[prefix.length - 1]).toBe('--')
    const sbpl = prefix[prefix.length - 2]!
    expect(sbpl).toContain('(allow default)')
    expect(sbpl).toContain(`(deny file-write* ${sbplSubpath(denied)})`)
    expect(sbpl).not.toContain('(allow file-write*')
  })

  it('re-mounts / writable and each denied root read-only on bwrap', async () => {
    const { provider } = await mountStack('bwrap', 'danger-full-access')
    const denied = canonicalPath(fixture.outside)
    const prefix = await (provider as MultiRootSandboxProvider)
      .restrictedArgvPrefix({ ...policy, workspaceRoot: fixture.workspace }, [denied])
    expect(prefix).toContain('--bind')
    expect(prefix).not.toContain('--tmpfs')
    expect(prefix).not.toContain('--unshare-pid')
    expect(prefix).not.toContain('--proc')
    expect(prefix).not.toContain('--dev')
    expect(prefix).toContain('--ro-bind-try')
    const bindIndex = prefix.indexOf('--bind')
    expect(prefix[bindIndex + 1]).toBe('/')
    const roIndex = prefix.lastIndexOf('--ro-bind-try')
    expect(prefix[roIndex + 1]).toBe(denied)
    expect(prefix[prefix.length - 1]).toBe('--')
  })

  it('selects bubblewrap when the selected Landlock allowlist cannot subtract', async () => {
    for (const dialect of ['landlock'] as const) {
      const { provider } = await mountStack(dialect, 'danger-full-access')
      // `confine` is synchronous on some supported releases: wrapping the
      // call in Promise.resolve().then() folds a synchronous throw into the
      // same rejection shape the async releases produce.
      const call = Promise.resolve().then(() => (provider as MultiRootSandboxProvider)
        .restrictedArgvPrefix({ ...policy, workspaceRoot: fixture.workspace }, [canonicalPath(fixture.outside)]))
      const prefix = await call
      expect(prefix[0]).toBe('bwrap')
      expect(prefix).toContain('--bind')
      expect(prefix.slice(prefix.indexOf('--ro-bind-try'))).toEqual(['--ro-bind-try', canonicalPath(fixture.outside), canonicalPath(fixture.outside), '--'])
    }
  })

  it('selects the standalone ambient deny runner on Windows ACL', async () => {
    const { provider } = await mountStack('windows-acl', 'danger-full-access')
    const denied = canonicalPath(fixture.outside)
    const prefix = await (provider as MultiRootSandboxProvider)
      .restrictedArgvPrefix({ ...policy, workspaceRoot: fixture.workspace }, [denied])
    expect(prefix).toContain('danger-full-access')
    expect(prefix.slice(prefix.indexOf('--deny-root'))).toEqual(['--deny-root', denied, '--'])
    expect(prefix).not.toContain('--additional-root')
  })
})

describe('shell and PTC execute entries', () => {
  it('confines the legacy foreground run entry which bypasses execute and start', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', new Map(), true)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { run(spec: unknown): Promise<unknown> }
    await shell.run({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]?.argv).toContain('-p')
    expect(captured.spawned[0]?.argv.join(' ')).toContain('(deny file-write*')
  })
  it('confines an ambient spawn when a read-only root exists under Full-access', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { run(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned).toHaveLength(1)
    const argv = captured.spawned[0]!.argv
    expect(argv.join(' ')).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
    expect(argv.slice(-COMMAND.length)).toEqual(COMMAND)
  })

  it('passes the bare argv through when nothing is denied', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'inherit')])
    const shell = ctx.get('shell') as { run(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]!.argv).toEqual(COMMAND)
  })

  it('does not touch a non-full-access call — upstream confine still owns it', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'workspace-write')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { run(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'workspace-write', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]!.argv).toEqual(COMMAND)
  })

  it('confines ptcRuntime.run through the same store', async () => {
    const { ctx, captured } = await mountStack('bwrap', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const runtime = ctx.get('ptcRuntime') as { run(spec: unknown): Promise<unknown> }
    await runtime.run({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    const argv = captured.spawned[0]!.argv
    expect(argv).toContain('--ro-bind-try')
    expect(argv[argv.indexOf('--ro-bind-try') + 1]).toBe(canonicalPath(fixture.outside))
    expect(argv.slice(-COMMAND.length)).toEqual(COMMAND)
  })

  it('stamps a live legacy start() handle at settle from the captured stderr tail', async () => {
    let resolveDone!: (outcome: unknown) => void
    const handle = {
      status: 'running',
      exitCode: 1,
      signal: null,
      collected: { stderr: { readFrom: () => ({ text: 'denied: Operation not permitted' }) } },
      done: new Promise(resolve => { resolveDone = resolve }),
      sandbox: undefined as unknown,
    }
    const { ctx } = await mountStack('seatbelt', 'danger-full-access', new Map(), true, handle)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { start(spec: unknown): Promise<unknown> }
    const proc = await shell.start({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    // The fenced handle is the same live object — identity, not a snapshot.
    expect(proc).toBe(handle)
    expect(handle.sandbox).toBeUndefined()
    resolveDone(undefined)
    await handle.done
    expect(handle.sandbox).toMatchObject({ mode: 'danger-full-access', enforcement: 'full', denied: true })
  })

  it('revocation applies to the NEXT process — a later call sees the new scope', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { run(spec: unknown): Promise<unknown> }
    const spec = { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } }
    await shell.execute(spec)
    expect(captured.spawned[0]!.argv.join(' ')).toContain('deny file-write*')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await shell.execute(spec)
    expect(captured.spawned[1]!.argv).toEqual(COMMAND)
  })
})

describe('the unavailable-authority downgrade', () => {
  it('clamps shell execute to the upstream workspace-write profile, not the restricted one', async () => {
    const { ctx, provider, captured } = await mountStack('seatbelt', 'danger-full-access')
    // The registry marks the scope unavailable when it is not the store's
    // authority; an empty deny set then means "unknown", not "nothing".
    ctx.multiRootScope.setRegistryAuthority(false)
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned).toHaveLength(1)
    // The clamp is exactly the argv upstream `confine` would produce under
    // workspace-write: primary root + temp grants, no additional roots, and
    // no ambient "(allow default) + subpath deny" restricted profile.
    const expected = await confined(provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(captured.spawned[0]!.argv).toEqual(expected.argv)
    expect(captured.spawned[0]!.argv.join(' ')).not.toContain('(deny file-write* (subpath')
  })

  it('clamps ptcRuntime.run through the same workspace-write profile', async () => {
    const { ctx, provider, captured } = await mountStack('bwrap', 'danger-full-access')
    ctx.multiRootScope.setRegistryAuthority(false)
    const runtime = ctx.get('ptcRuntime') as { run(spec: unknown): Promise<unknown> }
    await runtime.run({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    const expected = await confined(provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(captured.spawned[0]!.argv).toEqual(expected.argv)
  })

  it('keeps the restricted profile for deny roots once authority is restored', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setRegistryAuthority(false)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    ctx.multiRootScope.setRegistryAuthority(true)
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]!.argv.join(' '))
      .toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
  })
})

describe('spawnTerminal', () => {
  const spec = (env: Record<string, string>): SubprocessTerminalSpawnSpec => ({
    argv: ['/bin/bash', '-l'],
    cwd: fixture.workspace,
    env,
    rows: 24,
    cols: 80,
    terminalType: 'dumb',
    graceMs: 500,
  })

  const liveSession = (id: string): Session =>
    Session.create(SessionId(id), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: 0,
      isSeeded: false,
      cwd: fixture.workspace,
    })

  it('rewrites the PTY argv when its session runs Full-access over a denied root', async () => {
    const session = liveSession('sess-pty-1')
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', new Map([[session.id, session]]))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: session.id }))
    expect(captured.terminals).toHaveLength(1)
    expect(captured.terminals[0]!.argv.join(' ')).toContain('(deny file-write*')
    expect(captured.terminals[0]!.argv.slice(-2)).toEqual(['/bin/bash', '-l'])
  })

  it('passes through when the session is not Full-access or nothing is denied', async () => {
    const session = liveSession('sess-pty-2')
    const { ctx, captured } = await mountStack('seatbelt', 'workspace-write', new Map([[session.id, session]]))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: session.id }))
    expect(captured.terminals[0]!.argv).toEqual(['/bin/bash', '-l'])
  })

  it('fails closed on an unresolvable session when restricted roots exist', async () => {
    const { ctx } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await expect(ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: 'sess-gone' }))).rejects.toThrow('read-only roots')
  })

  it('clamps a resolved terminal session to workspace-write while the registry authority is unavailable', async () => {
    const session = liveSession('sess-pty-clamped')
    const { ctx, provider, captured } = await mountStack('seatbelt', 'danger-full-access', new Map([[session.id, session]]))
    ctx.multiRootScope.setRegistryAuthority(false)
    await ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: session.id }))
    expect(captured.terminals).toHaveLength(1)
    const expected = await confined(provider, ['/bin/bash', '-l'], { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(captured.terminals[0]!.argv).toEqual(expected.argv)
  })

  it('refuses an unresolvable terminal session while the registry authority is unavailable', async () => {
    const { ctx } = await mountStack('seatbelt', 'danger-full-access')
    // Authority alone flips the fail-closed flag: an unattributable terminal
    // must not spawn ambient while restrictions cannot even be enumerated.
    ctx.multiRootScope.setRegistryAuthority(false)
    await expect(ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: 'sess-gone' }))).rejects.toThrow()
  })

  it('passes an unresolvable session through when no primary holds a restricted root', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'inherit')])
    await ctx.subprocess.spawnTerminal(spec({ DSH_SESSION_ID: 'sess-gone' }))
    expect(captured.terminals[0]!.argv).toEqual(['/bin/bash', '-l'])
  })

  it('passes a spawn without the session marker straight through', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(spec({}))
    expect(captured.terminals[0]!.argv).toEqual(['/bin/bash', '-l'])
  })
})

describe('the workspace-write deny edge', () => {
  /** A member inside the platform temp grant — the only overlap registration allows. */
  const tempMember = (): { path: string; cleanup: () => void } => {
    const path = mkdtempSync(join(canonicalPath(tmpdir()), 'dsh-mr-deny-'))
    return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
  }

  it('appends a seatbelt deny form for a read-only root inside a granted subtree', async () => {
    const root = tempMember()
    try {
      const { ctx, provider } = await mountStack('seatbelt', 'workspace-write')
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(root.path, 'read-only')])
      const result = await confined(provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      const sbpl = result.argv.find(arg => arg.includes('file-write*'))!
      expect(sbpl).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(root.path))}`)
    } finally { root.cleanup() }
  })

  it('makes a denied root under bwrap temp masking readable through a readonly bind', () => {
    const profile = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/workspace', '/workspace']
    // `--ro-bind-try`: a missing source skips the bind instead of failing the
    // whole launch, so a deleted read-only root cannot break every command.
    expect(denyProfileArgs('bwrap', profile, ['/tmp/readonly']))
      .toEqual([...profile, '--ro-bind-try', '/tmp/readonly', '/tmp/readonly'])
  })

  it('fails closed on Landlock — a denied root under a --rw grant cannot be subtracted', () => {
    // Landlock's launcher grammar cannot subtract a subtree from a granted
    // --rw ancestor; the transform must refuse rather than widen silently.
    const temp = canonicalPath(tmpdir())
    expect(() => denyProfileArgs(
      'landlock',
      ['/nonexistent/landlock-run', '--ro', '/', '--rw', temp],
      [join(temp, 'dsh-mr-deny')],
    )).toThrow(/cannot deny.*inside a writable grant/)
  })
})
