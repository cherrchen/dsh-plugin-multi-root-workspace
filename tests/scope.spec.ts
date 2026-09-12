/**
 * Unit tests for the plugin's single permission-source: the multi-root scope
 * service. M1 has no additional-root data source yet, so these tests pin the
 * resolution contract the providers already depend on — canonical keys,
 * deduplication, primary-root exclusion, and the empty answer for anything
 * unregistered.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { MultiRootScopeService, sanitizeAdditionalRoots } from '../src/scope.ts'
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
      { id: 'b', path: fixture.outside },
      { id: 'a', path: `${fixture.base}/third` },
    ])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots)
      .toEqual([fixture.outside, `${fixture.base}/third`])
  })

  it('drops duplicates, the primary root itself, and non-canonical spellings of the same directory', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { id: 'dup', path: fixture.outside },
      { id: 'dup-alias', path: `${fixture.outside}/.` },
      { id: 'primary', path: fixture.workspace },
      { id: 'primary-alias', path: `${fixture.workspace}/sub/..` },
    ])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([fixture.outside])
  })

  it('answers empty for a primary root that has no registration', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'x', path: fixture.outside }])
    expect(ctx.multiRootScope.scopeOf(fixture.base)).toEqual([])
  })

  it('clears the registration when an empty list is set', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'x', path: fixture.outside }])
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
  })

  it('indexes by canonical key, so an aliased primary root still finds its roots', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'x', path: fixture.outside }])
    expect(ctx.multiRootScope.scopeOf(`${fixture.workspace}/sub/..`)).toEqual([fixture.outside])
  })
})

describe('root sanitization', () => {
  it('is pure and never mutates its input', () => {
    const roots = [{ id: 'x', path: fixture.outside }]
    const before = structuredClone(roots)
    expect(sanitizeAdditionalRoots(fixture.workspace, roots)).toEqual([fixture.outside])
    expect(roots).toEqual(before)
  })
})
