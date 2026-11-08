// @vitest-environment jsdom
/**
 * The hero registration must probe the PUBLIC slot service, not the internal
 * SlotCore: `specDynamic` exists on the core only, while `ctx.slots` exposes
 * `spec`. A stub that supplies the wrong method would hide that difference, so
 * this test loads the real browser bundle through the module-loader protocol,
 * instantiates its SlotRegistry, declares `conversation.hero.options` under the
 * built-in root, applies this client entry, and asserts the hero cell lands.
 */

import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { readInstalledVersion, SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'
import * as client from '../src/client/index.ts'

const requireFromTest = createRequire(import.meta.url)

// `conversation.hero.options` does not exist before 0.2.1-alpha.3. The test
// manually declares it under the built-in root, so it is meaningful only on
// releases that actually carry the slot; older lanes skip it.
const installed = readInstalledVersion('@deepseek-ai/dsh')
const releases = SUPPORTED_DSH_RELEASES as readonly string[]
const slotRelease = releases.indexOf('0.2.1-alpha.3')
const installedRelease = installed === undefined ? -1 : releases.indexOf(installed)
const slotBearing = installedRelease >= slotRelease && installedRelease !== -1

interface RendererExports {
  SlotRegistry: new (ctx: Context) => {
    register(options: unknown, component: unknown): () => void
    entries(key: string): readonly { options: { id?: string } }[]
    spec(key: string): unknown
    specDynamic?: unknown
  }
}

/** Load the real ui-renderer client bundle through the browser module protocol. */
async function loadRenderer(): Promise<RendererExports> {
  let exported: RendererExports | undefined
  const target = globalThis as unknown as {
    window: { __ModuleLoader__?: { load(module: { factory: (request: (id: string) => unknown) => unknown }): void } }
  }
  target.window.__ModuleLoader__ = {
    load(module) {
      exported = module.factory(requireFromTest) as RendererExports
    },
  }
  await import('@deepseek-ai/dsh-client-ui-renderer/client')
  if (exported === undefined) throw new Error('ui-renderer client bundle did not register with the module loader')
  return exported
}

describe('the hero slot service probe', () => {
  it.skipIf(!slotBearing)('registers on the real SlotRegistry once the slot is declared', async () => {
    const { SlotRegistry } = await loadRenderer()
    const ctx = new Context()
    const slots = new SlotRegistry(ctx)
    // The real ui-conversation owner declares this child under the built-in
    // root; the parent component is never rendered here.
    const disposeParent = slots.register({
      name: 'root',
      children: { 'conversation.hero.options': { kind: 'list', scope: 'session' } },
    }, () => null)

    const stubCtx = {
      effect: (callback: () => unknown) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      // This probe covers the hero slot registration; the workspace menu's
      // optional context-menu injection is out of scope.
      inject: () => () => {},
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots,
      get: () => undefined,
    }

    try {
      expect(() => { client.apply(stubCtx as never) }).not.toThrow()
      expect(slots.entries('conversation.hero.options').some(entry => entry.options.id === client.HERO_SLOT_ID)).toBe(true)
      // The public service carries `spec`; `specDynamic` is core-only. A future
      // service reshaping this surface must update the probe and this test.
      expect(typeof slots.spec).toBe('function')
      expect(slots.specDynamic).toBeUndefined()
    } finally {
      disposeParent()
    }
  })
})
