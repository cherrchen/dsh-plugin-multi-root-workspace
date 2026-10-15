/**
 * The B9 process fence: `danger-full-access` must not write an explicit
 * `read-only` additional root, and the seam that enforces it must never widen
 * an ordinary spawn.
 *
 * Upstream's shell executor, PTC runtime and PTY backend all skip
 * `ctx.sandbox.confine` in that mode, so the fence wraps their public
 * entries: an AsyncLocalStorage deny context set around `execute` rewrites
 * the argv `ctx.subprocess.spawn` receives, and `spawnTerminal` confines only
 * a spec carrying the agent-PTY `DSH_PTY_SESSION_ID` marker — a spawn without
 * it (the panel's controller, i.e. a user terminal) stays untouched.
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
import type { Config as ScopeConfig } from '../src/scope.ts'
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
  scopeConfig: ScopeConfig = {},
  legacyShell = false,
  spawnResult: unknown = { pid: 1 },
  sessions: ReadonlyMap<string, Session> = new Map(),
): Promise<Stack> {
  const ctx = new Context()
  fibers.push(
    // `sandboxPolicy.resolve({ session })` reads the session's logged mode
    // override through this service, so it stays mounted.
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
    await ctx.plugin(MultiRootScopeService, scopeConfig),
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
    // The deny form pins the root's ancestors as literals too: renaming the
    // parent directory must not carry the tree past its deny boundary. The
    // ancestor walk only reads POSIX spellings — a Windows-spelled root
    // contributes none (its deny ACE follows the directory object, so the
    // platform needs no pinning; ADR-0017).
    expect(sbpl).toContain(`(deny file-write* ${sbplSubpath(denied)}`)
    if (process.platform !== 'win32') {
      expect(sbpl).toContain(`(literal "${canonicalPath(fixture.base)}")`)
    }
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
    expect(prefix).toContain('--ro-bind')
    const bindIndex = prefix.indexOf('--bind')
    expect(prefix[bindIndex + 1]).toBe('/')
    const roIndex = prefix.lastIndexOf('--ro-bind')
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
      expect(prefix.slice(prefix.indexOf('--ro-bind'))).toEqual(['--ro-bind', canonicalPath(fixture.outside), canonicalPath(fixture.outside), '--'])
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
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', {}, true)
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
    expect(argv).toContain('--ro-bind')
    expect(argv[argv.indexOf('--ro-bind') + 1]).toBe(canonicalPath(fixture.outside))
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
    const { ctx } = await mountStack('seatbelt', 'danger-full-access', {}, true, handle)
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
  it('limits shell execute to the primary root without shared temp grants', async () => {
    const { ctx, provider, captured } = await mountStack('seatbelt', 'danger-full-access')
    // The registry marks the scope unavailable when it is not the store's
    // authority; an empty deny set then means "unknown", not "nothing".
    ctx.multiRootScope.setRegistryAuthority(false)
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned).toHaveLength(1)
    const expected = await confined(provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(captured.spawned[0]!.argv).toEqual(expected.argv)
    expect(captured.spawned[0]!.argv.join(' ')).not.toContain(sbplSubpath(canonicalPath(tmpdir())))
  })

  it('limits ptcRuntime.run to the primary root', async () => {
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

describe('agent and user terminals', () => {
  const spec = (env: Record<string, string> = {}): SubprocessTerminalSpawnSpec => ({
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

  /** The controller-shaped spec: env carries only the session marker, like the panel. */
  const userSpec = (sessionId: string): SubprocessTerminalSpawnSpec =>
    spec({ DSH_SESSION_ID: sessionId })

  /** The backend-shaped spec: env carries both markers, like dsh-terminal-bash. */
  const agentSpec = (sessionId: string, ptyId = 'pty-1'): SubprocessTerminalSpawnSpec =>
    spec({ DSH_SESSION_ID: sessionId, DSH_PTY_SESSION_ID: ptyId })

  it('never confines a user terminal — the panel controller stamps no PTY marker, in any mode', async () => {
    const session = liveSession('sess-user-pty')
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', {}, false, { pid: 1 }, new Map([[session.id, session]]))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(userSpec(session.id))
    expect(captured.terminals).toHaveLength(1)
    expect(captured.terminals[0]!.argv).toEqual(['/bin/bash', '-l'])
    // Same under an unavailable registry authority: still user behavior.
    ctx.multiRootScope.setRegistryAuthority(false)
    await ctx.subprocess.spawnTerminal(userSpec(session.id))
    expect(captured.terminals[1]!.argv).toEqual(['/bin/bash', '-l'])
  })

  it('confines an agent PTY under Full-access with a denied root', async () => {
    const session = liveSession('sess-agent-pty')
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', {}, false, { pid: 1 }, new Map([[session.id, session]]))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(agentSpec(session.id))
    expect(captured.terminals).toHaveLength(1)
    expect(captured.terminals[0]!.argv.join(' '))
      .toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
    expect(captured.terminals[0]!.argv.slice(-2)).toEqual(['/bin/bash', '-l'])
  })

  it('limits an agent PTY to the primary root while the registry authority is unavailable', async () => {
    const session = liveSession('sess-agent-clamped')
    const { ctx, provider, captured } = await mountStack('seatbelt', 'danger-full-access', {}, false, { pid: 1 }, new Map([[session.id, session]]))
    ctx.multiRootScope.setRegistryAuthority(false)
    await ctx.subprocess.spawnTerminal(agentSpec(session.id))
    const expected = await confined(provider, ['/bin/bash', '-l'], { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(captured.terminals[0]!.argv).toEqual(expected.argv)
  })

  it('applies the DSH-home deny inside the clamped prefix when a grant covers it', async () => {
    const home = canonicalPath(tmpdir())
    const session = liveSession('sess-agent-home')
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access', { dshHome: home }, false, { pid: 1 }, new Map([[session.id, session]]))
    ctx.multiRootScope.setRegistryAuthority(false)
    await ctx.subprocess.spawnTerminal(agentSpec(session.id))
    // The shared temp grant is gone: this home is already outside all grants.
    const sbpl = captured.terminals[0]!.argv.join(' ')
    expect(sbpl).not.toContain(sbplSubpath(home))
    expect(sbpl).toContain('(allow file-write*')
  })

  it('leaves a workspace-write agent PTY untouched by the fence', async () => {
    const session = liveSession('sess-ww-pty')
    const { ctx, captured } = await mountStack('seatbelt', 'workspace-write', {}, false, { pid: 1 }, new Map([[session.id, session]]))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await ctx.subprocess.spawnTerminal(agentSpec(session.id))
    expect(captured.terminals[0]!.argv).toEqual(['/bin/bash', '-l'])
  })

  it('fails closed on an agent PTY whose session marker does not resolve while restrictions exist', async () => {
    const { ctx } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    await expect(ctx.subprocess.spawnTerminal(agentSpec('sess-gone'))).rejects.toThrow('read-only roots')
    // Authority alone flips the flag: an unattributable agent terminal must
    // not spawn ambient while restrictions cannot even be enumerated.
    ctx.multiRootScope.setRegistryAuthority(false)
    await expect(ctx.subprocess.spawnTerminal(agentSpec('sess-gone'))).rejects.toThrow()
  })

  it('passes an unresolvable agent PTY through when no primary holds a restricted root', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'inherit')])
    await ctx.subprocess.spawnTerminal(agentSpec('sess-gone'))
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
    // Mandatory sources keep a vanished deny root from becoming writable.
    expect(denyProfileArgs('bwrap', profile, ['/tmp/readonly']))
      .toEqual([...profile, '--ro-bind', '/tmp/readonly', '/tmp/readonly'])
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
