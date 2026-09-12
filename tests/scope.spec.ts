/**
 * Unit tests for the plugin's single permission-source: the multi-root scope
 * service. These pin the resolution contract the providers depend on —
 * canonical keys, deduplication, primary-root exclusion, and the empty answer
 * for anything unregistered — plus the model-facing topology contribution, which
 * must be silent exactly when there is nothing to say (no additional root, a
 * non-writable mode, or no agent at all).
 */

import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { MULTI_ROOT_CONTEXT_NAME, MultiRootScopeService, sanitizeAdditionalRoots } from '../src/scope.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import type { FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  fixture = createFixtureWorkspace('scope')
  // A real nested directory, so `sub/..` is a spelling `realpath` can collapse;
  // for a path that does not exist, `canonicalPath` keeps the spelling as-is.
  mkdirSync(join(fixture.workspace, 'sub'))
  ctx = new Context()
  fiber = await ctx.plugin(MultiRootScopeService)
})

afterEach(async () => {
  await fiber?.dispose()
  fixture.dispose()
})

function policy(workspaceRoot: string, mode: SandboxExecutionPolicy['mode'] = 'workspace-write'): SandboxExecutionPolicy {
  return { mode, workspaceRoot }
}

/** Register one additional root the way the registry does: canonical, with its granted directory. */
function root(id: string, path: string): { id: string; path: string; recordedPath: string } {
  return { id, path, recordedPath: canonicalPath(path) }
}

describe('scope resolution', () => {
  it('reports the policy root as primary and no additional roots when none are registered', () => {
    const scope = ctx.multiRootScope.resolve(policy(fixture.workspace))
    expect(scope.primaryRoot).toBe(fixture.workspace)
    expect(scope.additionalRoots).toEqual([])
  })

  it('resolves the primary root canonically, not as spelled', () => {
    const scope = ctx.multiRootScope.resolve(policy(`${fixture.workspace}/sub/..`))
    expect(scope.primaryRoot).toBe(fixture.workspace)
  })

  it('keeps the spelling of a root that does not exist (upstream conservative rule)', () => {
    // `canonicalPath` mirrors the upstream helper: an unresolvable path is
    // returned unchanged, which makes it match nothing until it exists.
    const missing = `${fixture.base}/not-there`
    expect(ctx.multiRootScope.resolve(policy(missing)).primaryRoot).toBe(missing)
  })

  it('returns registered roots in registry order', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('b', fixture.outside),
      root('a', `${fixture.base}/third`),
    ])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots)
      .toEqual([fixture.outside, `${fixture.base}/third`])
  })

  it('drops duplicates, the primary root itself, and non-canonical spellings of the same directory', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('dup', fixture.outside),
      root('dup-alias', `${fixture.outside}/.`),
      root('primary', fixture.workspace),
      { id: 'primary-alias', path: `${fixture.workspace}/sub/..` },
    ])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([fixture.outside])
  })

  it('answers empty for a primary root that has no registration', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    expect(ctx.multiRootScope.scopeOf(fixture.base)).toEqual([])
  })

  it('clears the registration when an empty list is set', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
  })

  it('indexes by canonical key, so an aliased primary root still finds its roots', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    expect(ctx.multiRootScope.scopeOf(`${fixture.workspace}/sub/..`)).toEqual([fixture.outside])
  })
})

describe('root sanitization', () => {
  it('is pure and never mutates its input', () => {
    const roots = [root('x', fixture.outside)]
    const before = structuredClone(roots)
    expect(sanitizeAdditionalRoots(fixture.workspace, roots)).toEqual([fixture.outside])
    expect(roots).toEqual(before)
  })

  it('withholds a registration whose path was replaced after it was granted', () => {
    // The audited hole: `canonicalPath` is `realpath`, so a registered directory
    // swapped for a symlink resolves to whatever that symlink points at. The
    // grant is keyed to the directory that was granted, so the replacement must
    // grant NOTHING — not the new target, and not the old path either.
    const granted = join(fixture.base, 'granted')
    const elsewhere = join(fixture.base, 'elsewhere')
    mkdirSync(granted)
    mkdirSync(elsewhere)
    const registration = root('x', granted)
    expect(sanitizeAdditionalRoots(fixture.workspace, [registration])).toEqual([canonicalPath(granted)])

    rmSync(granted, { recursive: true, force: true })
    symlinkSync(elsewhere, granted)

    expect(sanitizeAdditionalRoots(fixture.workspace, [registration])).toEqual([])
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [registration])
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([])
  })

  it('withholds a registration that does not say which directory it was granted for', () => {
    const incomplete = { id: 'x', path: fixture.outside, recordedPath: '' }
    expect(sanitizeAdditionalRoots(fixture.workspace, [incomplete])).toEqual([])
  })
})

describe('workspace topology context', () => {
  let promptCtx: Context
  let promptFibers: Array<Awaited<ReturnType<Context['plugin']>>>
  let session: Session

  beforeEach(async () => {
    promptCtx = new Context()
    promptFibers = [
      await promptCtx.plugin(SystemPrompt),
      await promptCtx.plugin(SessionProjectionRegistry),
      await promptCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace }),
      await promptCtx.plugin(MultiRootScopeService),
    ]
    const sessionId = SessionId('sess-topology')
    session = Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 0,
      isSeeded: false,
      cwd: fixture.workspace,
    })
  })

  afterEach(async () => {
    while (promptFibers.length > 0) await promptFibers.pop()?.dispose()
  })

  const agent = (): Agent => ({ session }) as unknown as Agent

  async function topology(): Promise<string | undefined> {
    const assembly = await promptCtx.systemPrompt.assemble({ agent: agent() })
    return assembly.contexts.find(context => context.name === MULTI_ROOT_CONTEXT_NAME)?.text
  }

  it('states the additional roots next to the sandbox policy sentence', async () => {
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    expect(await topology()).toBe(
      `Current DSH workspace roots: ${JSON.stringify([fixture.outside])} are additional roots of this session's workspace. `
      + `Under workspace-write they may be modified like the session workspace; the session cwd remains the primary root `
      + `(${JSON.stringify(fixture.workspace)}).`,
    )
    const snapshot = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    expect(snapshot.indexOf('Current DSH file policy')).toBeLessThan(snapshot.indexOf('Current DSH workspace roots'))
  })

  it('contributes nothing while the scope holds no additional root', async () => {
    expect(await topology()).toBe('')
    const snapshot = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    expect(snapshot).not.toContain('workspace roots')
  })

  it('contributes nothing without an agent (diagnostics assemblies)', async () => {
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    const assembly = await promptCtx.systemPrompt.assemble()
    expect(assembly.contexts.find(context => context.name === MULTI_ROOT_CONTEXT_NAME)?.text).toBe('')
  })

  it('contributes nothing while the policy is read-only, even with additional roots', async () => {
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    const readOnly = new Context()
    const fibers = [
      await readOnly.plugin(SystemPrompt),
      await readOnly.plugin(SessionProjectionRegistry),
      await readOnly.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: fixture.workspace }),
      await readOnly.plugin(MultiRootScopeService),
    ]
    try {
      readOnly.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
      const assembly = await readOnly.systemPrompt.assemble({ agent: agent() })
      expect(assembly.contexts.find(context => context.name === MULTI_ROOT_CONTEXT_NAME)?.text).toBe('')
      expect(renderContextSnapshot(assembly)).not.toContain('workspace roots')
    } finally {
      while (fibers.length > 0) await fibers.pop()?.dispose()
    }
  })

  it('is byte-stable across assemblies and lists roots in scope order', async () => {
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('a', fixture.outside),
      root('b', `${fixture.base}/third`),
    ])
    const first = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    const second = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    expect(second).toBe(first)
    expect(first).toContain(JSON.stringify([fixture.outside, `${fixture.base}/third`]))
  })

  it('mounts without a system-prompt seam at all (soft dependency)', async () => {
    const bare = new Context()
    const fiber = await bare.plugin(MultiRootScopeService)
    expect(bare.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([])
    await fiber.dispose()
  })
})
