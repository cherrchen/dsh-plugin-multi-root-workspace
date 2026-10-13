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
import { canonicalPath, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider, SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSandboxProvider as UpstreamSandbox } from '@deepseek-ai/dsh-sandbox-local'
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
 * stubbed: `ctx.shell.execute` and `ctx.ptcRuntime.execute` run their command
 * through `ctx.subprocess.spawn` exactly the way the upstream consumers do.
 */
async function mountStack(
  dialect: Dialect,
  mode: SandboxPolicy['mode'] | 'danger-full-access',
  sessions: ReadonlyMap<string, Session> = new Map(),
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
          return { pid: 1 }
        },
        spawnTerminal: async (spec: SubprocessTerminalSpawnSpec) => {
          captured.terminals.push(spec)
          return { pid: 2 }
        },
      } as never)
      fiber.provide('shell', { execute } as never)
      fiber.provide('ptcRuntime', { execute } as never)
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
    expect(prefix).toContain('--ro-bind')
    const bindIndex = prefix.indexOf('--bind')
    expect(prefix[bindIndex + 1]).toBe('/')
    const roIndex = prefix.lastIndexOf('--ro-bind')
    expect(prefix[roIndex + 1]).toBe(denied)
    expect(prefix[prefix.length - 1]).toBe('--')
  })

  it('fails closed on Landlock — its allowlist cannot subtract', async () => {
    for (const dialect of ['landlock'] as const) {
      const { provider } = await mountStack(dialect, 'danger-full-access')
      // `confine` is synchronous on some supported releases: wrapping the
      // call in Promise.resolve().then() folds a synchronous throw into the
      // same rejection shape the async releases produce.
      const call = Promise.resolve().then(() => (provider as MultiRootSandboxProvider)
        .restrictedArgvPrefix({ ...policy, workspaceRoot: fixture.workspace }, [canonicalPath(fixture.outside)]))
      await expect(call).rejects.toBeInstanceOf(SandboxUnavailableError)
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
  it('confines an ambient spawn when a read-only root exists under Full-access', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned).toHaveLength(1)
    const argv = captured.spawned[0]!.argv
    expect(argv.join(' ')).toContain(`(deny file-write* ${sbplSubpath(canonicalPath(fixture.outside))}`)
    expect(argv.slice(-COMMAND.length)).toEqual(COMMAND)
  })

  it('passes the bare argv through when nothing is denied', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'inherit')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]!.argv).toEqual(COMMAND)
  })

  it('does not touch a non-full-access call — upstream confine still owns it', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'workspace-write')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    await shell.execute({ sandboxPolicy: { mode: 'workspace-write', workspaceRoot: fixture.workspace } })
    expect(captured.spawned[0]!.argv).toEqual(COMMAND)
  })

  it('confines ptcRuntime.execute through the same store', async () => {
    const { ctx, captured } = await mountStack('bwrap', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const runtime = ctx.get('ptcRuntime') as { execute(spec: unknown): Promise<unknown> }
    await runtime.execute({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } })
    const argv = captured.spawned[0]!.argv
    expect(argv).toContain('--ro-bind')
    expect(argv[argv.indexOf('--ro-bind') + 1]).toBe(canonicalPath(fixture.outside))
    expect(argv.slice(-COMMAND.length)).toEqual(COMMAND)
  })

  it('revocation applies to the NEXT process — a later call sees the new scope', async () => {
    const { ctx, captured } = await mountStack('seatbelt', 'danger-full-access')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(fixture.outside, 'read-only')])
    const shell = ctx.get('shell') as { execute(spec: unknown): Promise<unknown> }
    const spec = { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture.workspace } }
    await shell.execute(spec)
    expect(captured.spawned[0]!.argv.join(' ')).toContain('deny file-write*')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await shell.execute(spec)
    expect(captured.spawned[1]!.argv).toEqual(COMMAND)
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

  it('relies on the tmpfs mask on bwrap — a denied root under it needs no rebind', async () => {
    const root = tempMember()
    try {
      const upstreamCtx = new Context()
      fibers.push(
        await upstreamCtx.plugin(SessionProjectionRegistry),
        await upstreamCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
        await upstreamCtx.plugin(UpstreamSandbox, {}),
      )
      const upstream = upstreamCtx.sandbox as LocalSandboxProvider
      upstream.internals = internalsFor('bwrap')
      const upstreamResult = await confined(upstream, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      const { ctx, provider } = await mountStack('bwrap', 'workspace-write')
      ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [member(root.path, 'read-only')])
      const result = await confined(provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      // The member sits under the temp area upstream mounts as --tmpfs: the
      // mask already denies it, so no extra --ro-bind appears over upstream.
      expect(result.argv).toEqual(upstreamResult.argv)
    } finally { root.cleanup() }
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
