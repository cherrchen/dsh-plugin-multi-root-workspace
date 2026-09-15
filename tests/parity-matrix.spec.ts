/**
 * The M2 core asset: the cross-provider allow matrix.
 *
 * Requirement §4 / acceptance 4 say there must be no combination in which one
 * tool can write an additional root while another cannot. Upstream guarantees
 * that with a shared `writableRoots()` derivation plus its own parity test; after
 * this plugin replaces both providers, the guarantee is ours to maintain. So for
 * one scope — primary root, one additional root, a third tree outside every root,
 * and a sibling that shares the primary root's lexical prefix — this suite
 * compares, path class by path class and mode by mode:
 *
 * - what the in-process filesystem fence ACTUALLY does (a real write attempt), and
 * - what the kernel dialect profile ACTUALLY grants (parsed out of the wrapped
 *   argv by `tests/support/dialect-grants.ts`, an implementation independent of
 *   the production widening code).
 *
 * Every dialect is exercised from any host by forcing the runner chain through
 * the provider's public `internals` hook, so the matrix is complete even where a
 * backend cannot execute (macOS has no bwrap, a confined process cannot nest
 * `sandbox-exec`). The real-execution cases at the bottom then spawn the wrapped
 * argv itself wherever the host CAN run it — Linux CI for bwrap/Landlock, macOS
 * for Seatbelt — and skip explicitly, with the reason, where it cannot. A dialect
 * the PLATFORM provides is required, so its skip becomes a failure: macOS must run
 * the Seatbelt case, Linux must run bwrap or Landlock, and neither is asked for
 * the runner it does not have (see `tests/support/kernel-runner.ts`). Windows has
 * no kernel rung here at all, so the suite skips there with that reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { confined } from './support/confine.ts'
import { allowsWrite, parseConfined, runConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import { symlinkUnsupportedReason } from './support/temp-workspace.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

const DIALECTS = ['seatbelt', 'bwrap', 'landlock'] as const
type Dialect = (typeof DIALECTS)[number]
const COMMAND = ['bash', '-c', 'true']
const TEMP_FILE = join(tmpdir(), `dsh-mr-matrix-${process.pid}.txt`)

const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
let fixture: FixtureWorkspace
let siblings = { third: '', shared: '' }
/** Why the symlink rows cannot run here, when the host refuses directory links. */
let symlinkReason: string | undefined

beforeEach(async () => {
  fixture = createFixtureWorkspace('matrix')
  siblings = { third: join(fixture.base, 'third'), shared: join(fixture.base, 'ws-child') }
  await mkdir(siblings.third, { recursive: true })
  await mkdir(siblings.shared, { recursive: true })
  await mkdir(join(fixture.workspace, 'nested'), { recursive: true })
  await mkdir(join(fixture.outside, 'nested'), { recursive: true })
  // A host that refuses directory symlinks (Windows without Developer Mode) still
  // gets the whole matrix minus the one row that needs the escape to exist.
  symlinkReason = symlinkUnsupportedReason()
  if (symlinkReason === undefined) {
    await mkdir(join(fixture.outside, 'link'), { recursive: true })
    await symlink(siblings.third, join(fixture.outside, 'link', 'escape'), 'dir')
  }
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  await rm(TEMP_FILE, { force: true })
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
 * Mount the real multi-root composition: the plugin's fs fence, the plugin's
 * kernel provider with one dialect forced, and the scope carrying exactly one
 * additional root (the fixture's `out` tree).
 */
async function mountWorld(dialect: Dialect): Promise<World> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
    await ctx.plugin(MultiRootScopeService),
  )
  await mountCompat(ctx)
  fibers.push(await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }))
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{
    id: 'extra',
    path: fixture.outside,
    recordedPath: canonicalPath(fixture.outside),
  }])
  fibers.push(await ctx.plugin(MultiRootSandboxProvider, {}))
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { ...internalsFor(dialect) }
  return { ctx, provider }
}

/** What the in-process fence does with one real write attempt. */
async function fenceVerdict(world: World, policy: SandboxPolicy, target: FsTarget): Promise<'allow' | 'deny'> {
  try {
    await world.ctx.fs.writeText(target, 'payload', undefined, undefined, policy)
    return 'allow'
  } catch (error: unknown) {
    if (error instanceof FsError && (error as FsError & { code?: string }).code === 'FS_SANDBOX_DENIED') return 'deny'
    throw error
  }
}

/** What the kernel dialect profile grants for the same canonical path. */
async function dialectVerdict(world: World, policy: SandboxPolicy, canonical: string): Promise<'allow' | 'deny'> {
  const wrapped = await confined(world.provider, COMMAND, policy)
  return allowsWrite(parseConfined(wrapped.argv, COMMAND), canonical) ? 'allow' : 'deny'
}

interface MatrixCase {
  name: string
  path: string
  expected: 'allow' | 'deny'
  /**
   * Set for rows whose answer depends on the dialect's OWN platform spelling of
   * the temp area: bwrap mounts a literal `/tmp` and Landlock grants a literal
   * `/tmp` (upstream's documented per-runner difference — see
   * `dsh-sandbox/src/roots.ts`), while on darwin the canonical temp area is
   * `/private/tmp`. Those rows are therefore only comparable for a dialect this
   * host would actually select; on Linux, where both spellings coincide, they
   * run for every dialect.
   */
  nativeOnly?: boolean
  /** Set for rows that need a directory symlink the host may refuse to create. */
  needsSymlink?: boolean
}

/** Whether the product runtime on THIS host can select this dialect at all. */
function isNativeDialect(dialect: Dialect): boolean {
  const chain = process.platform === 'darwin' ? ['seatbelt'] : process.platform === 'linux' ? ['bwrap', 'landlock'] : []
  return chain.includes(dialect)
}

function matrix(): MatrixCase[] {
  return [
    { name: 'a file in the primary root', path: join(fixture.workspace, 'matrix-primary.txt'), expected: 'allow' },
    { name: 'a file nested in the primary root', path: join(fixture.workspace, 'nested', 'deep.txt'), expected: 'allow' },
    { name: 'a file in an additional root', path: join(fixture.outside, 'matrix-extra.txt'), expected: 'allow' },
    { name: 'a file nested in an additional root', path: join(fixture.outside, 'nested', 'deep.txt'), expected: 'allow' },
    { name: 'a file outside every root', path: join(siblings.third, 'matrix-outside.txt'), expected: 'deny' },
    { name: 'a sibling sharing the primary root prefix', path: join(siblings.shared, 'matrix-prefix.txt'), expected: 'deny' },
    { name: 'a file through a symlink escaping an additional root', path: join(fixture.outside, 'link', 'escape', 'matrix-symlink.txt'), expected: 'deny', needsSymlink: true },
    { name: 'a file in the platform temp area', path: TEMP_FILE, expected: 'allow', nativeOnly: true },
  ]
}

describe('the fs fence and every kernel dialect agree on one scope', () => {
  for (const dialect of DIALECTS) {
    it(`allows exactly the same writes with the grant widened for ${dialect}`, async () => {
      const world = await mountWorld(dialect)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
      for (const entry of matrix()) {
        if (entry.nativeOnly === true && !isNativeDialect(dialect)) continue
        if (entry.needsSymlink === true && symlinkReason !== undefined) continue
        const target = await world.ctx.fs.resolve(entry.path)
        const fence = await fenceVerdict(world, policy, target)
        const dialectAnswer = await dialectVerdict(world, policy, String(target.targetKey))
        expect(fence, `${entry.name}: fs fence`).toBe(entry.expected)
        expect(dialectAnswer, `${entry.name}: ${dialect} grant`).toBe(entry.expected)
        expect(dialectAnswer, `${entry.name}: fs fence vs ${dialect}`).toBe(fence)
      }
    })

    it(`denies every write under read-only for both worlds (${dialect})`, async () => {
      const world = await mountWorld(dialect)
      const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: fixture.workspace }
      for (const entry of matrix()) {
        const target = await world.ctx.fs.resolve(entry.path)
        // A file must already exist for `resolve` to have a leaf, but read-only
        // must deny the mutation regardless.
        if (!existsSync(entry.path)) await writeFile(entry.path, 'existing')
        const fence = await fenceVerdict(world, policy, target)
        const dialectAnswer = await dialectVerdict(world, policy, String(target.targetKey))
        expect(fence, `${entry.name}: fs fence`).toBe('deny')
        expect(dialectAnswer, `${entry.name}: ${dialect} grant`).toBe('deny')
      }
    })
  }

  it('never grants a root the scope does not carry, in any dialect', async () => {
    for (const dialect of DIALECTS) {
      const world = await mountWorld(dialect)
      const wrapped = await confined(world.provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      const grants = parseConfined(wrapped.argv, COMMAND)
      expect(grants.subpaths, dialect).toContain(fixture.outside)
      expect(grants.subpaths, dialect).not.toContain(siblings.third)
      expect(grants.subpaths, dialect).not.toContain(siblings.shared)
    }
  })
})

describe('real confined execution of the widened profile', () => {
  for (const dialect of DIALECTS) {
    it(`lets a confined command write an additional root and refuses the outside (${dialect})`, async (context) => {
      const world = await mountWorld(dialect)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
      const inside = join(fixture.outside, 'confined-inside.txt')
      const outside = join(siblings.third, 'confined-outside.txt')

      const writeInside = runConfined(await confined(world.provider, ['bash', '-c', `echo payload > ${JSON.stringify(inside)}`], policy), fixture.workspace)
      if (writeInside.kind === 'unavailable' || writeInside.kind === 'runner-failed') {
        // Skipping is only allowed when this DIALECT is not required for this
        // run (see tests/support/kernel-runner.ts): a host that can confine with
        // Seatbelt cannot necessarily run bwrap, and vice versa.
        context.skip(requireKernelRunner(dialect, writeInside.detail))
        return
      }
      expect(writeInside.kind, `write into the additional root: ${writeInside.kind === 'denied' ? writeInside.detail : ''}`).toBe('ok')
      expect(existsSync(inside)).toBe(true)

      const writeOutside = runConfined(await confined(world.provider, ['bash', '-c', `echo payload > ${JSON.stringify(outside)}`], policy), fixture.workspace)
      expect(writeOutside.kind, 'write outside every root must be denied').toBe('denied')
      expect(existsSync(outside)).toBe(false)
    })
  }
})
