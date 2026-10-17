/**
 * Multi-root widening at the provider boundary.
 *
 * The empty-root contract (element-for-element passthrough) is pinned by
 * `tests/sandbox-passthrough.spec.ts`. This suite pins what M2 adds: with a
 * non-empty scope, the additional roots are grafted onto the profile the
 * UPSTREAM provider actually produced — for every dialect, in scope order, with
 * the upstream flags — while the enforcement facts the bash executor classifies
 * denials with stay untouched. The independent re-parse of the widened argv
 * lives in `tests/support/dialect-grants.ts`.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { confined } from './support/confine.ts'
import { parseConfined } from './support/dialect-grants.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('sandbox-multi')
  mkdirSync(`${fixture.base}/third`)
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  vi.restoreAllMocks()
  fixture.dispose()
})

const DIALECTS = ['seatbelt', 'bwrap', 'landlock'] as const
type Dialect = (typeof DIALECTS)[number]
const COMMAND = ['bash', '-c', 'echo hi']

function internalsFor(dialect: Dialect | 'windows-acl'): SandboxInternals {
  switch (dialect) {
    case 'seatbelt': return { chain: ['seatbelt'] }
    case 'bwrap': return { chain: ['bwrap'] }
    case 'landlock': return { chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run' }
    case 'windows-acl': return { chain: ['windows-acl'], windowsAclRunnerArgs: ['node', '/fake/runner.js'] }
  }
}

interface Mounted {
  ctx: Context
  provider: LocalSandboxProvider
}

/** Mount either provider over the same fixture, with a forced dialect. */
async function mount(plugin: unknown, mode: SandboxPolicy['mode'], internals: SandboxInternals): Promise<Mounted> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
  )
  if (plugin === MultiRootSandboxProvider) {
    fibers.push(await ctx.plugin(MultiRootScopeService))
    await mountCompat(ctx)
  }
  fibers.push(await ctx.plugin(plugin as never, {}))
  const provider = ctx.sandbox as LocalSandboxProvider
  provider.internals = { ...internals }
  return { ctx, provider }
}

/** Mount both providers, register the additional roots on ours, and confine once. */
async function confineBoth(
  dialect: Dialect | 'windows-acl',
  mode: SandboxPolicy['mode'],
  additionalRoots: readonly string[],
  access: 'inherit' | 'read-only' | 'read-write' = 'read-write',
): Promise<{ upstream: ConfinedArgv; ours: ConfinedArgv; ctx: Context }> {
  const upstream = await mount(LocalSandboxProvider, mode, internalsFor(dialect))
  const ours = await mount(MultiRootSandboxProvider, mode, internalsFor(dialect))
  ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, additionalRoots.map((path, index) => ({ id: `root-${index}`, path, recordedPath: canonicalPath(path), access })))
  const policy: SandboxPolicy = { mode, workspaceRoot: fixture.workspace }
  return {
    upstream: await confined(upstream.provider, COMMAND, policy),
    ours: await confined(ours.provider, COMMAND, policy),
    ctx: ours.ctx,
  }
}

/** The separator index `confine` produced for one wrapped argv. */
function separator(argv: readonly string[]): number {
  return argv.length - COMMAND.length - 1
}

/**
 * The dialect suites below drive the POSIX runner argv (Seatbelt / bwrap /
 * Landlock). Windows has no kernel rung for additional roots in this release, so
 * they skip there with this reason instead of failing for a platform the plugin
 * does not claim; the Windows ACL rung keeps its own upstream shape.
 */
const posixRunner = process.platform === 'darwin' || process.platform === 'linux'

describe.skipIf(!posixRunner)('additional-root grants per dialect (POSIX runner argv only)', () => {
  const extra = (): string[] => [fixture.outside, `${fixture.base}/third`]

  it('extends the Seatbelt allow form inside the profile the upstream provider built', async () => {
    const { upstream, ours } = await confineBoth('seatbelt', 'workspace-write', extra())
    const [exec, flag, profile] = upstream.argv as [string, string, string]
    expect(ours.argv).toEqual([
      exec,
      flag,
      `${profile.slice(0, -1)} (subpath ${JSON.stringify(fixture.outside)}) (subpath ${JSON.stringify(`${fixture.base}/third`)}))`,
      '--',
      ...COMMAND,
    ])
    expect(parseConfined(ours.argv, COMMAND).subpaths).toEqual(expect.arrayContaining(extra()))
  })

  it('binds each additional root after the upstream bind (bwrap)', async () => {
    const { upstream, ours } = await confineBoth('bwrap', 'workspace-write', extra())
    expect(ours.argv).toEqual([
      ...upstream.argv.slice(0, separator(upstream.argv)),
      '--bind', fixture.outside, fixture.outside,
      '--bind', `${fixture.base}/third`, `${fixture.base}/third`,
      '--', ...COMMAND,
    ])
    const grants = parseConfined(ours.argv, COMMAND)
    expect(grants.dialect).toBe('bwrap')
    expect(grants.subpaths).toEqual(expect.arrayContaining(extra()))
  })

  it('appends a read-write grant per additional root (Landlock)', async () => {
    const { upstream, ours } = await confineBoth('landlock', 'workspace-write', extra())
    expect(ours.argv).toEqual([
      ...upstream.argv.slice(0, separator(upstream.argv)),
      '--rw', fixture.outside,
      '--rw', `${fixture.base}/third`,
      '--', ...COMMAND,
    ])
    const grants = parseConfined(ours.argv, COMMAND)
    expect(grants.dialect).toBe('landlock')
    expect(grants.subpaths).toEqual(expect.arrayContaining(extra()))
  })

  it('keeps the scope order of the roots in every dialect', async () => {
    const roots = [fixture.outside, `${fixture.base}/third`]
    for (const dialect of DIALECTS) {
      const { ours } = await confineBoth(dialect, 'workspace-write', roots)
      const argv = ours.argv.join('\u0000')
      expect(argv.indexOf(fixture.outside), dialect).toBeLessThan(argv.indexOf(`${fixture.base}/third`))
    }
  })

  it('never recomputes the facts the denial and enforcement reporting derives from', async () => {
    for (const dialect of DIALECTS) {
      for (const mode of ['workspace-write', 'read-only'] as const) {
        const { upstream, ours } = await confineBoth(dialect, mode, extra())
        expect(ours.enforcement, `${dialect}/${mode}`).toBe(upstream.enforcement)
        expect(ours.denialSignatures, `${dialect}/${mode}`).toEqual(upstream.denialSignatures)
        expect(ours.runnerFailureRules, `${dialect}/${mode}`).toEqual(upstream.runnerFailureRules)
      }
    }
  })
})

describe.skipIf(!posixRunner)('mode and scope gating (POSIX runner argv only)', () => {
  it('grants nothing under read-only when the members inherit', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'read-only', [fixture.outside], 'inherit')
      expect(ours.argv, dialect).toEqual(upstream.argv)
      expect(parseConfined(ours.argv, COMMAND).subpaths, dialect).not.toContain(fixture.outside)
    }
  })

  it('grants a fixed read-write member back onto a read-only profile (B9)', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'read-only', [fixture.outside], 'read-write')
      expect(ours.argv, dialect).not.toEqual(upstream.argv)
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.subpaths, dialect).toContain(canonicalPath(fixture.outside))
    }
  })

  it('grants nothing under read-only when the only member is explicit read-only', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'read-only', [fixture.outside], 'read-only')
      expect(ours.argv, dialect).toEqual(upstream.argv)
    }
  })

  it('returns the upstream wrap untouched when the scope is empty', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'workspace-write', [])
      expect(ours.argv, dialect).toEqual(upstream.argv)
    }
  })
})

describe('the Windows ACL rung', () => {
  it('selects the plugin runner and preserves enforcement and payload', async () => {
    const upstream = await mount(LocalSandboxProvider, 'workspace-write', internalsFor('windows-acl'))
    const ours = await mount(MultiRootSandboxProvider, 'workspace-write', internalsFor('windows-acl'))
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'root-0', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' }])
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
    const expected = await confined(upstream.provider, COMMAND, policy)
    const result = await confined(ours.provider, COMMAND, policy)
    expect(result.argv[1]).toMatch(/windows-runner\.js$/)
    expect(result.argv).toContain('--additional-root')
    expect(result.argv).toContain(canonicalPath(fixture.outside))
    expect(result.argv.slice(-COMMAND.length)).toEqual(COMMAND)
    expect({ ...result, argv: expected.argv }).toEqual(expected)
  })
})

describe.skipIf(!posixRunner)('read-only additional roots (POSIX runner argv only)', () => {
  /** Mount ours + upstream, with mixed-access members in the scope. */
  const confineAccess = async (
    dialect: Dialect,
    members: readonly { path: string; access: 'inherit' | 'read-only' | 'read-write' }[],
    mode: SandboxPolicy['mode'] = 'workspace-write',
  ): Promise<{ upstream: ConfinedArgv; ours: ConfinedArgv }> => {
    const upstream = await mount(LocalSandboxProvider, mode, internalsFor(dialect))
    const ours = await mount(MultiRootSandboxProvider, mode, internalsFor(dialect))
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, members.map((member, index) => ({
      id: `root-${index}`,
      path: member.path,
      recordedPath: canonicalPath(member.path),
      access: member.access,
    })))
    const policy: SandboxPolicy = { mode, workspaceRoot: fixture.workspace }
    return {
      upstream: await confined(upstream.provider, COMMAND, policy),
      ours: await confined(ours.provider, COMMAND, policy),
    }
  }

  it('widens only the writable members in every dialect', async () => {
    const third = `${fixture.base}/third`
    for (const dialect of DIALECTS) {
      const { ours } = await confineAccess(dialect, [
        { path: fixture.outside, access: 'read-write' },
        { path: third, access: 'read-only' },
      ])
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.subpaths, dialect).toContain(canonicalPath(fixture.outside))
      expect(grants.subpaths, dialect).not.toContain(canonicalPath(third))
    }
  })

  it('returns the upstream result element for element when no member is writable', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineAccess(dialect, [{ path: fixture.outside, access: 'read-only' }])
      expect(ours, dialect).toEqual(upstream)
    }
  })

  it('widens nothing under read-only mode for inherit and read-only members', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineAccess(dialect, [
        { path: fixture.outside, access: 'inherit' },
        { path: `${fixture.base}/third`, access: 'read-only' },
      ], 'read-only')
      expect(ours.argv, dialect).toEqual(upstream.argv)
    }
  })

  it('grafts only the fixed read-write members under read-only mode (B9)', async () => {
    const third = `${fixture.base}/third`
    for (const dialect of DIALECTS) {
      const { ours } = await confineAccess(dialect, [
        { path: fixture.outside, access: 'read-write' },
        { path: third, access: 'inherit' },
      ], 'read-only')
      const grants = parseConfined(ours.argv, COMMAND)
      expect(grants.subpaths, dialect).toContain(canonicalPath(fixture.outside))
      expect(grants.subpaths, dialect).not.toContain(canonicalPath(third))
    }
  })

  it('leaves danger-full-access untouched (the executor never calls confine, but the guard holds anyway)', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineAccess(dialect, [
        { path: fixture.outside, access: 'read-write' },
      ], 'danger-full-access')
      expect(ours.argv, dialect).toEqual(upstream.argv)
    }
  })
})

/**
 * The R2 regression, host-independent: under `read-only` the graft of a fixed
 * `read-write` parent used to be the LAST word — a denied child beneath it
 * inherited the writable grant. The deny set must apply after the graft, in
 * the dialect's own spelling. Upstream `confine` is mocked to emit each
 * dialect's skeleton, so the POSIX shapes are covered on Windows too — the
 * real runners never start.
 */
describe('a read-only profile keeps its deny boundaries after grafting', () => {
  /** Just enough of each dialect's upstream read-only skeleton to be recognized. */
  function readOnlyProfile(dialect: Dialect | 'windows-acl'): string[] {
    switch (dialect) {
      case 'seatbelt':
        return ['sandbox-exec', '-p', '(version 1) (deny default)']
      case 'bwrap':
        return ['bwrap', '--ro-bind', '/', '/']
      case 'landlock':
        // Upstream grants `--rw /dev/null` even in read-only: the `--rw` flag
        // is what `detectDialect` keys on.
        return ['/nonexistent/landlock-run', '--ro', '/', '--rw', '/dev/null']
      case 'windows-acl':
        return ['node', '/fake/runner.js',
          '--workspace', canonicalPath(fixture.workspace),
          '--temp', join(fixture.base, 'temp'), '--mode', 'read-only']
    }
  }

  /** Quote one path into the SBPL string literal the profile carries. */
  const sbpl = (path: string): string => `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`

  /**
   * Register the pair the R2 finding describes — a fixed `read-write` parent
   * plus a withheld `read-only` child beneath it — mock upstream `confine`
   * into the dialect skeleton, and run ours under `read-only`.
   */
  async function confinePair(
    dialect: Dialect | 'windows-acl',
    shape: 'sync' | 'promise',
  ): Promise<{ attempt: Promise<ConfinedArgv>; parent: string; child: string }> {
    const ours = await mount(MultiRootSandboxProvider, 'read-only', internalsFor(dialect))
    const parent = canonicalPath(fixture.outside)
    const child = join(parent, 'denied')
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { id: 'parent', path: parent, recordedPath: parent, access: 'read-write' },
      { id: 'child', path: child, recordedPath: child, access: 'read-only', withheld: true },
    ])
    const upstream: ConfinedArgv = {
      argv: [...readOnlyProfile(dialect), '--', ...COMMAND],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
    const impl = (shape === 'promise' ? async () => upstream : () => upstream)
    vi.spyOn(LocalSandboxProvider.prototype, 'confine')
      .mockImplementation(impl as unknown as typeof LocalSandboxProvider.prototype.confine)
    return {
      attempt: confined(ours.provider, COMMAND, { mode: 'read-only', workspaceRoot: fixture.workspace }),
      parent,
      child,
    }
  }

  for (const shape of ['sync', 'promise'] as const) {
    it(`seatbelt appends the deny AFTER the grafted allow (${shape} upstream)`, async () => {
      const { attempt, parent, child } = await confinePair('seatbelt', shape)
      const { argv } = await attempt
      const profile = argv[2]!
      const allowAt = profile.indexOf('(allow file-write*')
      const denyAt = profile.indexOf('(deny file-write*')
      expect(allowAt).toBeGreaterThanOrEqual(0)
      expect(denyAt).toBeGreaterThan(allowAt)
      expect(profile).toContain(`(subpath ${sbpl(parent)})`)
      expect(profile.slice(denyAt)).toContain(`(subpath ${sbpl(child)})`)
    })

    it(`bwrap re-binds the denied child read-only AFTER the writable bind (${shape} upstream)`, async () => {
      const { attempt, parent, child } = await confinePair('bwrap', shape)
      const { argv } = await attempt
      const bindAt = argv.findIndex((arg, index) => arg === '--bind' && argv[index + 1] === parent && argv[index + 2] === parent)
      const denyAt = argv.findIndex((arg, index) => arg === '--ro-bind' && argv[index + 1] === child)
      expect(bindAt).toBeGreaterThanOrEqual(0)
      expect(denyAt).toBeGreaterThan(bindAt)
      expect(argv[denyAt + 2]).toBe(child)
      // The deny mount is mandatory: a missing source must fail setup, never
      // let the command recreate the path under the writable bind.
      expect(argv).not.toContain('--ro-bind-try')
    })

    it(`landlock refuses the unrepresentable subtraction (${shape} upstream)`, async () => {
      const { attempt } = await confinePair('landlock', shape)
      await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError)
      await expect(attempt).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    })

    it(`windows-acl stays fail-closed on the same overlap (${shape} upstream)`, async () => {
      const { attempt } = await confinePair('windows-acl', shape)
      await expect(attempt).rejects.toBeInstanceOf(SandboxUnavailableError)
      await expect(attempt).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    })
  }

  it('still returns the upstream argv untouched when nothing was grafted', async () => {
    // A denied child with no writable member to hide under is already denied
    // by the read-only baseline: the result stays element-for-element.
    const ours = await mount(MultiRootSandboxProvider, 'read-only', internalsFor('seatbelt'))
    const child = join(canonicalPath(fixture.outside), 'denied')
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { id: 'child', path: child, recordedPath: child, access: 'read-only', withheld: true },
    ])
    const upstream: ConfinedArgv = {
      argv: [...readOnlyProfile('seatbelt'), '--', ...COMMAND],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
    vi.spyOn(LocalSandboxProvider.prototype, 'confine')
      .mockImplementation((() => upstream) as unknown as typeof LocalSandboxProvider.prototype.confine)
    const result = await confined(ours.provider, COMMAND, { mode: 'read-only', workspaceRoot: fixture.workspace })
    expect(result.argv).toEqual(upstream.argv)
  })
})
