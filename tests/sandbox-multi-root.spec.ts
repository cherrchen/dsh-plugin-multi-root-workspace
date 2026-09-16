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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
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
): Promise<{ upstream: ConfinedArgv; ours: ConfinedArgv; ctx: Context }> {
  const upstream = await mount(LocalSandboxProvider, mode, internalsFor(dialect))
  const ours = await mount(MultiRootSandboxProvider, mode, internalsFor(dialect))
  ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, additionalRoots.map((path, index) => ({ id: `root-${index}`, path, recordedPath: canonicalPath(path) })))
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
  it('grants nothing under read-only, even with a populated scope', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'read-only', [fixture.outside])
      expect(ours.argv, dialect).toEqual(upstream.argv)
      expect(parseConfined(ours.argv, COMMAND).subpaths, dialect).not.toContain(fixture.outside)
    }
  })

  it('returns the upstream wrap untouched when the scope is empty', async () => {
    for (const dialect of DIALECTS) {
      const { upstream, ours } = await confineBoth(dialect, 'workspace-write', [])
      expect(ours.argv, dialect).toEqual(upstream.argv)
    }
  })
})

describe('the Windows ACL rung keeps the upstream wrap and warns once', () => {
  it('warns a single time for a populated scope and never touches the argv', async () => {
    const upstream = await mount(LocalSandboxProvider, 'workspace-write', internalsFor('windows-acl'))
    const ours = await mount(MultiRootSandboxProvider, 'workspace-write', internalsFor('windows-acl'))
    const warn = vi.spyOn(ours.ctx.logger, 'warn').mockImplementation(() => {})
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'root-0', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])

    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
    const expected = await confined(upstream.provider, COMMAND, policy)
    expect((await confined(ours.provider, COMMAND, policy)).argv).toEqual(expected.argv)
    expect((await confined(ours.provider, COMMAND, policy)).argv).toEqual(expected.argv)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('Windows ACL runner')
  })

  it('stays silent when the scope is empty', async () => {
    const ours = await mount(MultiRootSandboxProvider, 'workspace-write', internalsFor('windows-acl'))
    const warn = vi.spyOn(ours.ctx.logger, 'warn').mockImplementation(() => {})
    await confined(ours.provider, COMMAND, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    expect(warn).not.toHaveBeenCalled()
  })
})
