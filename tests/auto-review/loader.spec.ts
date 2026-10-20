import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoReviewTakeover, OFFICIAL_AUTO_REVIEW, LEGACY_AUTO_REVIEW } from '../../src/compat/auto-review-loader.ts'

const require = createRequire(import.meta.url)
const loaderRequire = createRequire(require.resolve('@deepseek-ai/cordis/package.json'))
const { default: Loader } = await import(loaderRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
const MODULE = '@dsh-electron/dsh-plugin-multi-root-workspace/auto-review'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function fixture(delay = 0) {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  cleanup.push(() => ctx.fiber.dispose())
  const write = vi.spyOn(ctx.loader, 'write')
  const errors = vi.spyOn(ctx.logger, 'error')
  let owner: string | undefined
  const events: string[] = []
  const claim = (c: Context, who: string) => c.effect(() => {
    events.push(`claim:${who}`)
    if (owner !== undefined) throw new Error(`duplicate owner: ${owner} / ${who}`)
    owner = who
    return async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      events.push(`release:${who}`)
      owner = undefined
    }
  })
  const official = { name: 'official', apply(c: Context) { claim(c, 'official') } }
  const own = { name: 'fork', async apply(c: Context) {
    await c.effect(async function* () {
      const takeover = new AutoReviewTakeover(c)
      yield takeover.stopHook
      yield () => takeover.close()
      let child: ReturnType<Context['plugin']> | undefined
      const setup = (async () => {
        await takeover.suspendOfficial()
        c.fiber.assertActive()
        child = c.plugin({ name: 'fork-owner', apply(ownerCtx: Context) { claim(ownerCtx, 'fork') } })
        await child
      })()
      takeover.setOwnerDisposer(async () => { await setup.catch(() => {}); await child?.dispose(); await child?.await() })
      await setup
      if (child !== undefined) yield child.dispose
    })
  } }
  const imports: string[] = []
  ctx.loader.import = async (name: string) => {
    imports.push(name)
    if (name === OFFICIAL_AUTO_REVIEW && delay) await new Promise(resolve => setTimeout(resolve, delay))
    return name === OFFICIAL_AUTO_REVIEW ? official : own
  }
  const rows = (enabled: boolean, officialDisabled = false, first = true) => {
    const a = { id: 'auto-review', name: OFFICIAL_AUTO_REVIEW, disabled: officialDisabled }
    const b = { id: 'multi-root-auto-review', name: MODULE, disabled: !enabled }
    return first ? [a, b] : [b, a]
  }
  const update = async (config: ReturnType<typeof rows>) => {
    await ctx.loader.root.update(config)
    await ctx.loader.await()
  }
  return {ctx, write, errors, events, imports, rows, update, owner: () => owner}
}

describe('Auto Review Loader takeover', () => {
  for (const first of [true, false]) for (const delay of [0, 20]) {
    it(`prevents duplicate owners across cold start and reload (official first=${first}, import delay=${delay})`, async () => {
      const f = await fixture(delay)
      await f.update(f.rows(true, false, first))
      expect(f.owner()).toBe('fork')
      for (let i = 0; i < 3; i++) await f.update(f.rows(true, false, first))
      expect(f.owner()).toBe('fork')
      expect([...f.ctx.loader.entries()].some(e => e.options.name === OFFICIAL_AUTO_REVIEW)).toBe(false)
      expect(f.errors).not.toHaveBeenCalled()
      expect(f.write).not.toHaveBeenCalled()
    })
  }

  it('leaves the default-disabled entry inert and drains each owner before handing over', async () => {
    const f = await fixture()
    const descriptor = Object.getOwnPropertyDescriptor(f.ctx.loader.root, 'update')
    await f.update(f.rows(false))
    expect(f.imports).toEqual([OFFICIAL_AUTO_REVIEW])
    expect(f.owner()).toBe('official')
    await f.update(f.rows(true))
    expect(f.owner()).toBe('fork')
    await f.update(f.rows(false))
    expect(f.owner()).toBe('official')
    expect(Object.getOwnPropertyDescriptor(f.ctx.loader.root, 'update')).toEqual(descriptor)
    expect(f.events).toEqual(['claim:official', 'release:official', 'claim:fork', 'release:fork', 'claim:official'])
    expect(f.write).not.toHaveBeenCalled()
    expect(f.errors).not.toHaveBeenCalled()
  })

  it('preserves the official disabled preference on close and repeated re-enable', async () => {
    const f = await fixture(20)
    await f.update(f.rows(true, true))
    await f.update(f.rows(false, true))
    expect(f.owner()).toBeUndefined()
    await f.update(f.rows(true, true))
    expect(f.owner()).toBe('fork')
    await f.update(f.rows(false, true))
    expect(f.events).toEqual(['claim:fork', 'release:fork', 'claim:fork', 'release:fork'])
    expect(f.errors).not.toHaveBeenCalled()
  })

  it('handles official add/remove while enabled without restoring an unselected bundle', async () => {
    const f = await fixture()
    await f.update(f.rows(true).filter(row => row.name !== OFFICIAL_AUTO_REVIEW))
    await f.update(f.rows(true))
    expect(f.owner()).toBe('fork')
    await f.update(f.rows(true).filter(row => row.name !== OFFICIAL_AUTO_REVIEW))
    await f.update(f.rows(false).filter(row => row.name !== OFFICIAL_AUTO_REVIEW))
    expect(f.owner()).toBeUndefined()
    expect(f.imports).not.toContain(OFFICIAL_AUTO_REVIEW)
    expect(f.errors).not.toHaveBeenCalled()
  })

  it('rejects legacy companion coexistence with an actionable diagnostic', async () => {
    const f = await fixture()
    await f.update([...f.rows(true), {id:'legacy', name: LEGACY_AUTO_REVIEW, disabled:true}])
    expect(f.owner()).not.toBe('fork')
    expect(f.errors.mock.calls.flat().map(String).join('\n')).toContain('Remove the legacy')
  })
})
