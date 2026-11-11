/**
 * The plugin's scope-based widening must COMPOSE with upstream's own
 * `SandboxExecutionPolicy.additionalWritableRoots` (0.2.2-alpha.2): a policy
 * that already carries a native extra writable root X must keep X when the
 * plugin's registered scope also grants Y — both spelled by the produced
 * dialect profile, neither dropped nor duplicated, with the fs fence agreeing.
 *
 * This plugin never sets that field itself; the overlap is a host that does.
 * The whole suite is structural: `workspaceWritableRoots` is probed by export
 * name, so a release without the field skips with that reason rather than
 * pretending the composition exists.
 */

import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as sandboxPackage from '@deepseek-ai/dsh-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { confined } from './support/confine.ts'
import { parseConfined, runConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

const DIALECTS = ['seatbelt', 'bwrap', 'landlock'] as const
type Dialect = (typeof DIALECTS)[number]
const COMMAND = ['bash', '-c', 'echo hi']

const hasUpstreamAdditionalRoots = typeof (sandboxPackage as Record<string, unknown>).workspaceWritableRoots === 'function'

/**
 * 0.2.2-rc.2 added the per-Session grant seam on the policy service. Probe
 * the prototype by name: on an older release the member is absent and the
 * section skips with that reason instead of pretending the composition exists.
 */
const hasRegisterWritableRoot = typeof (SandboxPolicyService.prototype as unknown as {
  registerWritableRoot?: unknown
}).registerWritableRoot === 'function'

/** The structural face of the rc.2 Session grant, used without depending on its declaration. */
interface SessionWritableRoots {
  registerWritableRoot(session: Session, directory: string): () => void
}

/** The directory a registered Session grant points at, beside the fixture workspace. */
let sessionRoot = ''

const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
let fixture: FixtureWorkspace
/** The native extra writable root (X) and the outside-neither root (Z). */
let nativeRoot = ''
let outsideEvery = ''

beforeEach(async () => {
  fixture = createFixtureWorkspace('upstream-roots')
  nativeRoot = join(fixture.base, 'native')
  outsideEvery = join(fixture.base, 'neither')
  sessionRoot = join(fixture.base, 'session-grant')
  await mkdir(nativeRoot, { recursive: true })
  await mkdir(outsideEvery, { recursive: true })
  await mkdir(sessionRoot, { recursive: true })
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  fixture.dispose()
})

function internalsFor(dialect: Dialect): SandboxInternals {
  switch (dialect) {
    case 'seatbelt': return { chain: ['seatbelt'] }
    case 'bwrap': return { chain: ['bwrap'] }
    case 'landlock': return { chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run' }
  }
}

interface World {
  ctx: Context
  provider: LocalSandboxProvider
}

/**
 * Mount the plugin's fs fence and kernel provider with one dialect forced,
 * the scope granting the registered additional root (fixture's `out` tree),
 * and the policy service configured with the native extra root.
 */
async function mountWorld(dialect: Dialect): Promise<World> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace, additionalWritableRoots: [nativeRoot] }),
    await ctx.plugin(MultiRootScopeService),
  )
  await mountCompat(ctx)
  fibers.push(await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }))
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
    { id: 'root-0', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' },
  ])
  fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { ...internalsFor(dialect) }
  return { ctx, provider }
}

/** The policy upstream's `sandboxPolicy.resolve` would emit for this fixture. */
function policy(): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot: fixture.workspace, additionalWritableRoots: [nativeRoot] }
}

describe.skipIf(!hasUpstreamAdditionalRoots)('native additionalWritableRoots composed with the scope (POSIX runner argv only)', () => {
  it('spells both the native root and the scope root as writable grants, per dialect', async () => {
    for (const dialect of DIALECTS) {
      const world = await mountWorld(dialect)
      const ours = await confined(world.provider, COMMAND, policy())
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.dialect, dialect).toBe(dialect)
      expect(grants.subpaths, `${dialect}: native extra root`).toContain(canonicalPath(nativeRoot))
      expect(grants.subpaths, `${dialect}: scope additional root`).toContain(canonicalPath(fixture.outside))
      expect(grants.subpaths, `${dialect}: outside both`).not.toContain(canonicalPath(outsideEvery))
      // No duplicated or malformed grants for the same physical directory.
      expect(grants.subpaths.filter(path => path === canonicalPath(nativeRoot)), dialect).toHaveLength(1)
      expect(grants.subpaths.filter(path => path === canonicalPath(fixture.outside)), dialect).toHaveLength(1)
    }
  })

  it('keeps the native grant while adding the scope root (upstream vs ours)', async () => {
    const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
    const upstream = new Context()
    fibers.push(
      await upstream.plugin(SessionProjectionRegistry),
      await upstream.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await upstream.plugin(LocalSandboxProvider, {}),
    )
    const upstreamProvider = upstream.sandbox as LocalSandboxProvider
    for (const dialect of DIALECTS) {
      upstreamProvider.internals = { ...internalsFor(dialect) }
      const world = await mountWorld(dialect)
      const ours = await confined(world.provider, COMMAND, policy())
      const native = await confined(upstreamProvider, COMMAND, policy())
      const upstreamGrants = parseConfined(native.argv, COMMAND)
      expect(upstreamGrants.subpaths, `${dialect}: upstream keeps X`).toContain(canonicalPath(nativeRoot))
      expect(upstreamGrants.subpaths, `${dialect}: upstream never had Y`).not.toContain(canonicalPath(fixture.outside))
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.subpaths, `${dialect}: ours keeps X AND Y`).toEqual(expect.arrayContaining([canonicalPath(nativeRoot), canonicalPath(fixture.outside)]))
    }
  })

  it('lets the fs fence mutate both the native root and the scope root, and only those', async () => {
    const world = await mountWorld('seatbelt')
    const write = async (path: string): Promise<'allow' | 'deny'> => {
      const target = await world.ctx.fs.resolve(path)
      try {
        await world.ctx.fs.writeText(target, 'payload', undefined, undefined, world.ctx.sandboxPolicy.resolve())
        return 'allow'
      } catch (error: unknown) {
        if (error instanceof FsError && (error as FsError & { code?: string }).code === 'FS_SANDBOX_DENIED') return 'deny'
        throw error
      }
    }
    expect(await write(join(nativeRoot, 'fence-native.txt')), 'native extra root').toBe('allow')
    expect(await write(join(fixture.outside, 'fence-scope.txt')), 'scope additional root').toBe('allow')
    expect(await write(join(fixture.workspace, 'fence-primary.txt')), 'primary root').toBe('allow')
    expect(await write(join(outsideEvery, 'fence-outside.txt')), 'outside every root').toBe('deny')
  })
})

describe.skipIf(!hasRegisterWritableRoot)('native per-Session writable roots composed with the scope (POSIX runner argv only)', () => {
  /**
   * Mount the plugin world and register one Session-scoped directory through
   * the rc.2 policy seam, exactly as an upstream consumer would.
   * @param dialect - the forced runner dialect.
   * @returns the mounted world and the Session holding the grant.
   */
  async function sessionWorld(dialect: Dialect): Promise<{ world: World; session: Session }> {
    const world = await mountWorld(dialect)
    const id = SessionId('sess-native-writable-root')
    const session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      isSeeded: false,
      cwd: fixture.workspace,
    })
    ;(world.ctx.sandboxPolicy as unknown as SessionWritableRoots).registerWritableRoot(session, sessionRoot)
    return { world, session }
  }

  it('spells the registered directory beside the scope root as a writable grant, per dialect', async () => {
    for (const dialect of DIALECTS) {
      const { world, session } = await sessionWorld(dialect)
      const resolved = world.ctx.sandboxPolicy.resolve({ session })
      expect(resolved.additionalWritableRoots, `${dialect}: the policy resolves the registration`).toContain(canonicalPath(sessionRoot))
      const ours = await confined(world.provider, COMMAND, resolved)
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.dialect, dialect).toBe(dialect)
      expect(grants.subpaths, `${dialect}: Session-registered root`).toContain(canonicalPath(sessionRoot))
      expect(grants.subpaths, `${dialect}: scope additional root`).toContain(canonicalPath(fixture.outside))
      expect(grants.subpaths.filter(path => path === canonicalPath(sessionRoot)), dialect).toHaveLength(1)
    }
  })

  it('lets the fs fence write the registered directory, while a scope read-only denial still wins', async () => {
    const { world, session } = await sessionWorld('seatbelt')
    const policy = world.ctx.sandboxPolicy.resolve({ session })
    const write = async (path: string): Promise<'allow' | 'deny'> => {
      const target = await world.ctx.fs.resolve(path)
      try {
        await world.ctx.fs.writeText(target, 'payload', undefined, undefined, policy)
        return 'allow'
      } catch (error: unknown) {
        if (error instanceof FsError && (error as FsError & { code?: string }).code === 'FS_SANDBOX_DENIED') return 'deny'
        throw error
      }
    }
    expect(await write(join(sessionRoot, 'fence-native.txt')), 'the registered directory is upstream-writable and fence-visible').toBe('allow')
    // The same directory as an explicit read-only scope root: deny precedes
    // containment, so the native grant must not carry the write.
    world.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { id: 'root-0', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' },
      { id: 'root-1', path: sessionRoot, recordedPath: canonicalPath(sessionRoot), access: 'read-only' },
    ])
    expect(await write(join(sessionRoot, 'fence-denied.txt')), 'a scope read-only denial outranks the native registration').toBe('deny')
    expect(existsSync(join(sessionRoot, 'fence-denied.txt'))).toBe(false)
  })
})

describe.skipIf(!hasUpstreamAdditionalRoots)('real Seatbelt execution of the composed grant', () => {
  it('lets a confined command write X and Y, and refuses the outside', async (context) => {
    const world = await mountWorld('seatbelt')
    const insideNative = join(nativeRoot, 'confined-native.txt')
    const insideScope = join(fixture.outside, 'confined-scope.txt')
    const outside = join(outsideEvery, 'confined-outside.txt')

    const writeNative = runConfined(await confined(world.provider, ['bash', '-c', `echo payload > ${JSON.stringify(insideNative)}`], policy()), fixture.workspace)
    if (writeNative.kind === 'unavailable' || writeNative.kind === 'runner-failed') {
      context.skip(requireKernelRunner('seatbelt', writeNative.detail))
      return
    }
    expect(writeNative.kind, `write into the native extra root: ${writeNative.kind === 'denied' ? writeNative.detail : ''}`).toBe('ok')
    expect(existsSync(insideNative)).toBe(true)

    const writeScope = runConfined(await confined(world.provider, ['bash', '-c', `echo payload > ${JSON.stringify(insideScope)}`], policy()), fixture.workspace)
    expect(writeScope.kind, `write into the scope root: ${writeScope.kind === 'denied' ? writeScope.detail : ''}`).toBe('ok')
    expect(existsSync(insideScope)).toBe(true)

    const writeOutside = runConfined(await confined(world.provider, ['bash', '-c', `echo payload > ${JSON.stringify(outside)}`], policy()), fixture.workspace)
    expect(writeOutside.kind, 'write outside both root sets must be denied').toBe('denied')
    expect(existsSync(outside)).toBe(false)
  })
})
