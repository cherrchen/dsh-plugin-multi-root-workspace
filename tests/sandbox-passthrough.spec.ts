/**
 * Passthrough parity for the kernel-sandbox provider.
 *
 * M1's contract is that `MultiRootSandboxProvider.confine` returns the upstream
 * result ELEMENT FOR ELEMENT while the scope carries no additional roots: same
 * argv, same `enforcement`, same denial dialect, same runner-failure rules. The
 * bash executor derives its denial and enforcement reporting from exactly those
 * facts, so a divergence here would silently change what the model is told.
 *
 * Each dialect is forced through the provider's public `internals` hook, which
 * selects a sole candidate and therefore skips probing — the assertions are
 * about the profile each dialect builds, not about running a sandbox.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MultiRootSandboxProvider } from '../src/sandbox.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

beforeEach(() => {
  fixture = createFixtureWorkspace('sandbox')
})

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()?.dispose()
  fixture.dispose()
})

const DIALECTS = ['seatbelt', 'bwrap', 'landlock'] as const
type Dialect = (typeof DIALECTS)[number]

function internalsFor(dialect: Dialect): SandboxInternals {
  switch (dialect) {
    case 'seatbelt': return { chain: ['seatbelt'] }
    case 'bwrap': return { chain: ['bwrap'] }
    case 'landlock': return { chain: ['landlock'], landlockLauncher: '/nonexistent/landlock-run' }
  }
}

async function mountProvider(plugin: unknown, mode: SandboxPolicy['mode']): Promise<LocalSandboxProvider> {
  const ctx = new Context()
  fibers.push(
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: fixture.workspace }),
  )
  if (plugin === MultiRootSandboxProvider) {
    fibers.push(await ctx.plugin(MultiRootScopeService))
  }
  fibers.push(await ctx.plugin(plugin as never, {}))
  return ctx.sandbox as LocalSandboxProvider
}

function policy(mode: SandboxPolicy['mode']): SandboxPolicy {
  return { mode, workspaceRoot: fixture.workspace }
}

describe('empty-root passthrough', () => {
  for (const dialect of DIALECTS) {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      it(`returns the upstream confinement element for element (${dialect}, ${mode})`, async () => {
        const upstream = await mountProvider(LocalSandboxProvider, mode)
        const ours = await mountProvider(MultiRootSandboxProvider, mode)
        const internals = internalsFor(dialect)
        upstream.internals = { ...internals }
        ours.internals = { ...internals }

        const argv = ['bash', '-c', 'echo hello']
        const upstreamConfined = upstream.confine(argv, policy(mode))
        const ourConfined = ours.confine(argv, policy(mode))

        expect(ourConfined.argv).toEqual(upstreamConfined.argv)
        expect(ourConfined.enforcement).toBe(upstreamConfined.enforcement)
        expect(ourConfined.denialSignatures).toEqual(upstreamConfined.denialSignatures)
        expect(ourConfined.runnerFailureRules).toEqual(upstreamConfined.runnerFailureRules)
      })
    }
  }

  it('confines the PTY shape (program plus arguments, no -c) identically', async () => {
    const upstream = await mountProvider(LocalSandboxProvider, 'workspace-write')
    const ours = await mountProvider(MultiRootSandboxProvider, 'workspace-write')
    upstream.internals = { chain: ['bwrap'] }
    ours.internals = { chain: ['bwrap'] }

    const argv = ['/bin/bash', '-i']
    expect(ours.confine(argv, policy('workspace-write'))).toEqual(upstream.confine(argv, policy('workspace-write')))
  })

  it('honours the operator runnerCommand configuration like upstream', async () => {
    const ctx = new Context()
    fibers.push(
      await ctx.plugin(SessionProjectionRegistry),
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await ctx.plugin(MultiRootScopeService),
      await ctx.plugin(MultiRootSandboxProvider, {
        runnerCommand: ['my-runner'],
        runnerFailureSignatures: ['my-runner: fatal'],
      }),
    )
    const confined = ctx.sandbox.confine(['bash', '-c', 'true'], policy('workspace-write'))
    expect(confined.argv[0]).toBe('my-runner')
    const separator = confined.argv.indexOf('--')
    expect(separator).toBeGreaterThan(0)
    expect(confined.argv.slice(separator + 1)).toEqual(['bash', '-c', 'true'])
  })
})

describe('M1 scope boundary', () => {
  it('fails loudly instead of silently confining to the primary root alone', async () => {
    const ours = await mountProvider(MultiRootSandboxProvider, 'workspace-write')
    ours.internals = { chain: ['bwrap'] }
    ours.ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside }])

    expect(() => ours.confine(['bash', '-c', 'true'], policy('workspace-write')))
      .toThrow(SandboxUnavailableError)
    expect(() => ours.confine(['bash', '-c', 'true'], policy('workspace-write')))
      .toThrow(/not implemented yet \(M1\)/)
  })
})
