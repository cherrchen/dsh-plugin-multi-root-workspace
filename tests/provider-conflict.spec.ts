/**
 * Provider-replacement conflict: a second plugin owning `ctx.fs` or
 * `ctx.sandbox` must lose the multi-root rows loudly, never silently win a
 * widened grant.
 *
 * The composition this spec reproduces is exactly what two patches produce at
 * boot: each side mounts rows in patch order, and a patch that takes over a
 * service key first disables the row that owns it (the same mechanism this
 * bundle uses on upstream `fs-sandbox`/`sandbox`). Cordis refuses a second
 * `provide` of a registered key, so:
 *
 * - foreign row BEFORE ours — our provider's `provide` throws, the foreign
 *   service stays active, and `multi-root-providers`' `[Service.init]` sees an
 *   unbranded `ctx.fs`/`ctx.sandbox`, logs the foreign service, and throws;
 * - foreign row AFTER ours — the foreign patch disables our row (emulated by
 *   disposing its fiber), the replacement provokes a dependent-fiber reload,
 *   the re-run check sees the foreign service, and the gate dies again.
 *
 * Either way `multiRootProviders` never activates, so the registry — and the
 * instruction/LSP/workspace-files rows that inject it — never starts, the
 * scope stays empty, and a write to a would-be additional root through the
 * surviving foreign `ctx.fs` is denied by ITS OWN fence, not widened by ours.
 *
 * @module tests/provider-conflict
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { afterEach, describe, expect, it } from 'vitest'
import MultiRootFileSystem from '../src/fs.ts'
import MultiRootSandboxProvider from '../src/sandbox.ts'
import MultiRootProviders, { isMultiRootProvider } from '../src/providers.ts'
import MultiRootRegistry, { DOMAIN_NAME } from '../src/registry.ts'
import MultiRootScopeService from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

type ConflictKind = 'fs' | 'sandbox'
type ConflictOrder = 'before' | 'after'

interface World {
  ctx: Context
  fixture: FixtureWorkspace
  /** Error-type entries the built-in logger buffer captured. */
  errors: () => readonly { args: readonly unknown[] }[]
  dispose: () => Promise<void>
}

const worlds: World[] = []
afterEach(async () => { while (worlds.length > 0) await worlds.pop()!.dispose() })

/**
 * A foreign provider for `fs`: unbranded, with its own primary-root fence — a
 * stand-in for any plugin's fs (the upstream fs-sandbox row included) that took
 * the key instead of this bundle's provider. Writes outside its workspace are
 * denied by ITS fence; whatever grant applies, it is never ours.
 */
function foreignFsPlugin(fixture: FixtureWorkspace) {
  return {
    name: 'conflict-fs',
    apply(ctx: Context) {
      ctx.provide('fs' as never, {
        resolve: async (path: string) => path,
        writeText: async (target: string) => {
          if (target.startsWith(`${fixture.workspace}/`) || target === fixture.workspace) return { operation: 'create' }
          throw Object.assign(new Error(`write outside the foreign provider's workspace: ${target}`), { code: 'FS_SANDBOX_DENIED' })
        },
      } as never)
    },
  }
}

/**
 * A foreign provider for `sandbox`: a plain object whose only job is to NOT
 * carry this bundle's brand and to hand argv back untouched, so the test can
 * see our dialect widening never ran on it.
 */
function foreignSandboxPlugin() {
  return {
    name: 'conflict-sandbox',
    apply(ctx: Context) {
      ctx.provide('sandbox' as never, { confine: async (argv: readonly string[]) => [...argv] } as never)
    },
  }
}

/** Wait out cordis's asynchronous dependent-fiber refresh after a swap. */
async function settle(ctx: Context, gone: string): Promise<void> {
  for (let i = 0; i < 50 && ctx.get(gone) !== undefined; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setImmediate(resolve))
}

/**
 * Mount the real composition rows in patch order, with the conflicting
 * provider owned by a foreign plugin mounted `before` or `after` ours.
 */
async function mountWorld(foreign: Partial<Record<ConflictKind, ConflictOrder>>): Promise<World> {
  const fixture = createFixtureWorkspace('provider-conflict')
  const storeRoot = join(fixture.base, 'store')
  mkdirSync(storeRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storeRoot })
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
  await ctx.plugin(MultiRootScopeService)
  await mountCompat(ctx)

  // The conflict plugin's own rows: unbranded foreign providers — the
  // realistic survivors of a provider replacement this bundle did not perform.
  const mountForeignFs = () => ctx.plugin(foreignFsPlugin(fixture))
  const mountForeignSandbox = () => ctx.plugin(foreignSandboxPlugin())
  if (foreign.fs === 'before') await mountForeignFs()
  if (foreign.sandbox === 'before') await mountForeignSandbox()

  // Our patch's rows, in cordis.patch.yml order. When a foreign provider won
  // the key first, our provider's `provide` throws inside its fiber and the
  // plugin mount resolves with the row dead — that IS the composition.
  const fsFiber = foreign.fs === 'before'
    ? await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace }).then(fiber => fiber, () => undefined)
    : await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
  const sandboxFiber = foreign.sandbox === 'before'
    ? await ctx.plugin(MultiRootSandboxProvider).then(fiber => fiber, () => undefined)
    : await ctx.plugin(MultiRootSandboxProvider)
  // When a foreign provider is mounted the gate's init throws; cordis both
  // logs it and rethrows it to the mounting await — the row stays dead either
  // way, which is the state under test.
  await ctx.plugin(MultiRootProviders).then(fiber => fiber, () => undefined)
  await ctx.plugin(MultiRootRegistry, { leasePath: `${storeRoot}/${DOMAIN_NAME}.lock` })

  // A foreign patch applied after ours first disables our row (here: dispose
  // the provider fiber), then mounts its replacement — the late-replacement
  // path the gate must re-check.
  if (foreign.fs === 'after') {
    expect(ctx.get('multiRootRegistry'), 'registry must start before the takeover').toBeDefined()
    await fsFiber?.dispose()
    await mountForeignFs()
  }
  if (foreign.sandbox === 'after') {
    expect(ctx.get('multiRootRegistry'), 'registry must start before the takeover').toBeDefined()
    await sandboxFiber?.dispose()
    await mountForeignSandbox()
  }
  if (foreign.fs === 'after' || foreign.sandbox === 'after') await settle(ctx, 'multiRootProviders')

  const world: World = {
    ctx,
    fixture,
    errors: () => ctx.logger.buffer.filter((entry: { type?: string }) => entry.type === 'error') as { args: readonly unknown[] }[],
    dispose: async () => { await ctx.fiber.dispose(); fixture.dispose() },
  }
  worlds.push(world)
  return world
}

/** Every conflict must fail closed the same way, whatever the order was. */
function expectFailClosed(world: World, kind: ConflictKind): void {
  const { ctx, fixture } = world
  expect(ctx.get('multiRootProviders'), 'the provider gate must never activate').toBeUndefined()
  expect(ctx.get('multiRootRegistry'), 'the registry must never start on a foreign provider').toBeUndefined()
  expect(ctx.multiRootScope.scopeOf(fixture.workspace), 'the scope must keep granting nothing').toEqual([])
  const active = kind === 'fs' ? ctx.fs : ctx.sandbox
  expect(isMultiRootProvider(active, kind), `ctx.${kind} stayed foreign`).toBe(false)
  const names = world.errors().flatMap(entry => entry.args.map(String)).join('\n')
  expect(names, 'an error must name the foreign service').toContain(`ctx.${kind}`)
}

for (const kind of ['fs', 'sandbox'] as const) {
  describe(`foreign ${kind} provider`, () => {
    it('applied before this bundle leaves every widened-authority row unmounted', async () => {
      const world = await mountWorld({ [kind]: 'before' })
      expectFailClosed(world, kind)
      if (kind === 'fs') {
        // A write to the would-be additional root goes through the foreign
        // fs's OWN primary-root fence: our widening never ran, so it is denied.
        const target = join(world.fixture.outside, 'foreign.txt')
        await expect(world.ctx.fs.writeText(target, 'payload')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
        expect(existsSync(target)).toBe(false)
      } else {
        // The foreign sandbox returns argv untouched: no additional-root
        // argument from our dialect widening can appear on it.
        const argv = await (world.ctx.sandbox as { confine(a: readonly string[]): Promise<readonly string[]> }).confine(['echo', 'hi'])
        expect(argv).toEqual(['echo', 'hi'])
      }
    })

    it('applied after this bundle re-runs the check and unmounts the gated rows', async () => {
      const world = await mountWorld({ [kind]: 'after' })
      expectFailClosed(world, kind)
    })
  })
}

describe('an unconflicted composition', () => {
  it('still boots with the provider gate, the registry, and an empty scope', async () => {
    const world = await mountWorld({})
    const { ctx, fixture } = world
    expect(isMultiRootProvider(ctx.fs, 'fs')).toBe(true)
    expect(isMultiRootProvider(ctx.sandbox, 'sandbox')).toBe(true)
    expect(ctx.get('multiRootProviders')).toBeDefined()
    expect(ctx.get('multiRootRegistry')).toBeDefined()
    expect(ctx.multiRootScope.scopeOf(fixture.workspace)).toEqual([])
    // Pass-through unchanged: the foreign-free fence still confines to the
    // primary root alone.
    writeFileSync(join(fixture.workspace, 'inside.txt'), 'payload')
    await expect(ctx.fs.writeText(await ctx.fs.resolve(join(fixture.outside, 'denied.txt')), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
