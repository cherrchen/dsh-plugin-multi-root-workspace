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
import type { Config as ScopeConfig } from '../src/scope.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason } from './support/temp-workspace.ts'
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
function root(id: string, path: string): { id: string; path: string; recordedPath: string; access: 'inherit' } {
  return { id, path, recordedPath: canonicalPath(path), access: 'inherit' }
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
    // Spelled with a forward slash on purpose: the scope hands back the path
    // `canonicalPath` produced, which uses the platform's separator, so the
    // expectation has to be canonical rather than spelled.
    const third = `${fixture.base}/third`
    mkdirSync(third)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('b', fixture.outside),
      root('a', third),
    ])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots)
      .toEqual([fixture.outside, canonicalPath(third)])
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

  it('reports the registry authority the registry last published, and fails closed while unavailable', () => {
    // A composition with no registry row defaults to `available`: nothing can
    // ever have been registered, so nothing is unknown.
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).authority).toBe('available')
    expect(ctx.multiRootScope.hasActiveDenyRoots()).toBe(false)
    let fired = 0
    const unsubscribe = ctx.multiRootScope.subscribe(() => { fired += 1 })
    ctx.multiRootScope.setRegistryAuthority(true)
    expect(fired).toBe(0)
    ctx.multiRootScope.setRegistryAuthority(false)
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).authority).toBe('unavailable')
    // The PTY seam's fail-closed flag answers on authority alone.
    expect(ctx.multiRootScope.hasActiveDenyRoots()).toBe(true)
    expect(fired).toBe(1)
    ctx.multiRootScope.setRegistryAuthority(false)
    ctx.multiRootScope.setRegistryAuthority(false)
    expect(fired).toBe(1)
    ctx.multiRootScope.setRegistryAuthority(true)
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).authority).toBe('available')
    expect(ctx.multiRootScope.hasActiveDenyRoots()).toBe(false)
    expect(fired).toBe(2)
    ctx.multiRootScope.setRegistryAuthority(true)
    expect(fired).toBe(2)
    unsubscribe()
  })
})

describe('root sanitization', () => {
  it('is pure and never mutates its input', () => {
    const roots = [root('x', fixture.outside)]
    const before = structuredClone(roots)
    expect(sanitizeAdditionalRoots(fixture.workspace, roots)).toEqual([fixture.outside])
    expect(roots).toEqual(before)
  })

  it('withholds a registration whose path was replaced after it was granted', (context) => {
    const noSymlinks = symlinkUnsupportedReason()
    if (noSymlinks !== undefined) context.skip(noSymlinks)
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

  it('withholds a registered directory immediately after it is deleted', () => {
    const granted = join(fixture.base, 'ephemeral')
    mkdirSync(granted)
    const registration = root('x', granted)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [registration])
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([canonicalPath(granted)])

    rmSync(granted, { recursive: true, force: true })

    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([])
  })

  it('withholds a registration that does not say which directory it was granted for', () => {
    const incomplete = { id: 'x', path: fixture.outside, recordedPath: '', access: 'read-write' }
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
    let expected = `Current DSH workspace roots: ${JSON.stringify([fixture.outside])} are writable additional roots of this session's workspace. `
      + `The session origin remains the primary root (${JSON.stringify(fixture.workspace)}); `
      + 'changing the working directory does not change these grants. '
      + 'Grant changes apply to later operations and newly started processes, not to processes already running.'
    if (process.platform === 'win32') {
      expected += ' Writable additional roots are enforced for shell processes by the upstream Windows ACL '
        + 'restricted-token sandbox, whose enforcement is reported as partial; reads are not confined by it.'
    }
    expect(await topology()).toBe(expected)
    const snapshot = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    expect(snapshot.indexOf('Current DSH file policy')).toBeLessThan(snapshot.indexOf('Current DSH workspace roots'))
  })

  it.each([null, [], { bash: 'read-write' }])('reflects invalid toolAccess %j in the assembled prompt', async (toolAccess) => {
    await promptFibers.pop()!.dispose()
    promptFibers.push(await promptCtx.plugin(MultiRootScopeService, { toolAccess: toolAccess as never }))
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [root('x', fixture.outside)])
    expect(promptCtx.multiRootScope.resolve(policy(fixture.workspace)).writableRoots).toEqual([])
    const text = await topology()
    expect(text).toContain(JSON.stringify([fixture.outside]))
    expect(text).toContain('all additional-root writes are refused because toolAccess is invalid')
    expect(text).not.toContain('are writable additional roots')
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

  it('states membership without a write promise while the policy is read-only', async () => {
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
      expect(assembly.contexts.find(context => context.name === MULTI_ROOT_CONTEXT_NAME)?.text).toBe(
        `Current DSH workspace roots: ${JSON.stringify([fixture.outside])} are additional roots of this session's `
        + 'workspace and are readable; nothing is writable in read-only mode.',
      )
      // The text names membership only: no root is called writable.
      expect(renderContextSnapshot(assembly)).toContain('nothing is writable in read-only mode')
    } finally {
      while (fibers.length > 0) await fibers.pop()?.dispose()
    }
  })

  it('is byte-stable across assemblies and lists roots in scope order', async () => {
    const third = `${fixture.base}/third`
    mkdirSync(third)
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('a', fixture.outside),
      root('b', third),
    ])
    const first = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    const second = renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))
    expect(second).toBe(first)
    expect(first).toContain(JSON.stringify([fixture.outside, canonicalPath(third)]))

    // An alias is display-only: it never reaches the model-facing text.
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { ...root('a', fixture.outside), alias: 'payments' },
      root('b', third),
    ])
    expect(renderContextSnapshot(await promptCtx.systemPrompt.assemble({ agent: agent() }))).toBe(first)
  })

  it('mounts without a system-prompt seam at all (soft dependency)', async () => {
    const bare = new Context()
    const fiber = await bare.plugin(MultiRootScopeService)
    expect(bare.multiRootScope.resolve(policy(fixture.workspace)).additionalRoots).toEqual([])
    await fiber.dispose()
  })
})

describe('per-root access', () => {
  /** A read-only member: still a workspace root, never a writable one. */
  const readOnlyRoot = (id: string, path: string) => ({ ...root(id, path), access: 'read-only' as const })

  it('retains withheld negative boundaries without granting membership or following redirection', () => {
    const recorded = canonicalPath(fixture.outside)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{
      ...readOnlyRoot('ro', fixture.outside), withheld: true,
    }])
    const resolved = ctx.multiRootScope.resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(resolved.additionalRoots).toEqual([])
    expect(resolved.writableRoots).toEqual([])
    expect(resolved.deniedRoots).toEqual([recorded])
    expect(ctx.multiRootScope.hasActiveDenyRoots()).toBe(true)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    expect(ctx.multiRootScope.resolve(policy(fixture.workspace, 'danger-full-access')).deniedRoots).toEqual([])
  })

  it('keeps a read-only root a member while excluding it from the writable set', () => {
    const third = `${fixture.base}/third`
    mkdirSync(third)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      root('a', fixture.outside),
      readOnlyRoot('b', third),
    ])
    const resolved = ctx.multiRootScope.resolve(policy(fixture.workspace))
    // Membership (instructions, LSP, routing, reads) covers BOTH levels.
    expect(resolved.additionalRoots).toEqual([fixture.outside, canonicalPath(third)])
    expect(resolved.writableRoots).toEqual([fixture.outside])
    expect(resolved.roots.map(member => member.access)).toEqual(['inherit', 'read-only'])
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([fixture.outside, canonicalPath(third)])
    expect(ctx.multiRootScope.writableOf(fixture.workspace)).toEqual([fixture.outside])
  })

  it('answers an empty writable set when every member is read-only', () => {
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [readOnlyRoot('x', fixture.outside)])
    const resolved = ctx.multiRootScope.resolve(policy(fixture.workspace))
    expect(resolved.additionalRoots).toEqual([fixture.outside])
    expect(resolved.writableRoots).toEqual([])
  })
})

describe('read-only topology text', () => {
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
    const sessionId = SessionId('sess-topology-ro')
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

  it('never calls a read-only root writable and names it separately', async () => {
    const third = `${fixture.base}/third`
    mkdirSync(third)
    promptCtx.multiRootScope.setAdditionalRoots(fixture.workspace, [
      { ...root('a', fixture.outside) },
      { ...root('b', third), access: 'read-only' },
    ])
    const assembly = await promptCtx.systemPrompt.assemble({ agent: agent() })
    const text = assembly.contexts.find(context => context.name === MULTI_ROOT_CONTEXT_NAME)?.text ?? ''
    // The writable sentence lists only the writable member; the read-only
    // member is named as read-only, with its write refusal stated.
    expect(text).toContain(JSON.stringify([fixture.outside]))
    expect(text).not.toContain(JSON.stringify([fixture.outside, canonicalPath(third)]))
    expect(text).toContain(`${JSON.stringify([canonicalPath(third)])} are read-only additional roots (writes are refused)`)
  })
})

describe('the DSH-home boundary', () => {
  let home: string
  let homeCtx: Context
  let homeFiber: Awaited<ReturnType<Context['plugin']>>

  /**
   * Mount the scope row with a `dshHome` config — the value the patch row
   * fills with `dshHomePath()` — under a fixture directory.
   */
  const mountWithHome = async (dshHome: unknown = home, toolAccess?: ScopeConfig['toolAccess']): Promise<void> => {
    homeCtx = new Context()
    homeFiber = await homeCtx.plugin(MultiRootScopeService, {
      ...(dshHome === undefined ? {} : { dshHome: dshHome as string }),
      ...(toolAccess === undefined ? {} : { toolAccess }),
    })
  }
  const homeScope = () => homeCtx.multiRootScope

  beforeEach(() => {
    home = join(fixture.base, 'dsh-home')
    mkdirSync(home)
  })
  afterEach(async () => {
    await homeFiber?.dispose()
  })

  it('appends the home to deniedRoots under Full-access once any deny exists', async () => {
    await mountWithHome()
    homeScope().setAdditionalRoots(fixture.workspace, [
      { ...root('ro', fixture.outside), access: 'read-only' },
    ])
    const scope = homeScope().resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(scope.deniedRoots).toEqual([canonicalPath(fixture.outside), canonicalPath(home)])
    expect(scope.protectedHome).toBe(canonicalPath(home))
  })

  it('denies the home under Full-access while the registry authority is unavailable', async () => {
    await mountWithHome()
    homeScope().setRegistryAuthority(false)
    const scope = homeScope().resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(scope.deniedRoots).toEqual([canonicalPath(home)])
    expect(scope.protectedHome).toBe(canonicalPath(home))
  })

  it('never appends the home to a zero-root Full-access scope with available authority', async () => {
    await mountWithHome()
    const scope = homeScope().resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(scope.deniedRoots).toEqual([])
    expect(scope.protectedHome).toBeUndefined()
  })

  it('never appends the home under the confined modes', async () => {
    await mountWithHome()
    homeScope().setAdditionalRoots(fixture.workspace, [
      { ...root('ro', fixture.outside), access: 'read-only' },
    ])
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const scope = homeScope().resolve(policy(fixture.workspace, mode))
      expect(scope.deniedRoots).toEqual([canonicalPath(fixture.outside)])
      expect(scope.protectedHome).toBeUndefined()
    }
  })

  it('appends the home for a tool-capped Full-access call with members', async () => {
    await mountWithHome(home, { bash: 'read-only' })
    homeScope().setAdditionalRoots(fixture.workspace, [root('a', fixture.outside)])
    // Outside any dispatch a non-empty toolAccess caps every call — the deny
    // set is non-empty, so the home boundary rides along.
    const scope = homeScope().resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(scope.deniedRoots).toEqual([canonicalPath(fixture.outside), canonicalPath(home)])
    expect(scope.protectedHome).toBe(canonicalPath(home))
  })

  it('denies the primary root itself when it sits inside the home', async () => {
    const nested = join(home, 'workspace')
    mkdirSync(nested)
    await mountWithHome()
    homeScope().setAdditionalRoots(nested, [
      { ...root('ro', fixture.outside), access: 'read-only' },
    ])
    const scope = homeScope().resolve(policy(nested, 'danger-full-access'))
    // Deny wins over containment: the workspace is unwritable under
    // Full-access rather than the boundary being silently dropped.
    expect(scope.deniedRoots).toContain(canonicalPath(home))
    expect(scope.protectedHome).toBe(canonicalPath(home))
  })

  it('ignores a missing or invalid dshHome — the boundary simply does not exist', async () => {
    await mountWithHome('relative/not-absolute')
    homeScope().setRegistryAuthority(false)
    const scope = homeScope().resolve(policy(fixture.workspace, 'danger-full-access'))
    expect(scope.deniedRoots).toEqual([])
    expect(scope.protectedHome).toBeUndefined()
  })
})
