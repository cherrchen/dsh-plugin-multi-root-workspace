/** Optional Loader face. Its one switch owns context, reviewer and takeover. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { assertAutoReviewRelease } from '../compat/auto-review-contract.ts'
import { assertForkPackages } from '../compat/auto-review-packages.ts'
import { AutoReviewTakeover } from '../compat/auto-review-loader.ts'
import MultiRootReviewContext from '../review-context.ts'

export const name = 'multi-root-auto-review'
export const inject = ['loader', 'multiRootCompat', 'multiRootProviders', 'multiRootScope', 'multiRootRegistry', 'multiRootInstructions', 'sandboxPolicy', 'workingDirectory', 'fs', 'approval', 'llm', 'permissionPresets', 'sessions', 'tools']

export async function apply(ctx: Context): Promise<void> {
  assertAutoReviewRelease(ctx.multiRootCompat.release)
  assertForkPackages()
  await ctx.effect(async function* () {
    const takeover = new AutoReviewTakeover(ctx)
    // Collect these in ONE effect. Cordis unloads separate effects in
    // parallel; yielding moves them into this effect's ordered cleanup.
    yield takeover.stopHook
    yield () => takeover.close()
    let context: Fiber | undefined
    let reviewer: Fiber | undefined
    const setup = (async () => {
      await takeover.suspendOfficial()
      ctx.fiber.assertActive()
      const mountedContext = ctx.plugin(MultiRootReviewContext)
      context = mountedContext.ctx.fiber
      await mountedContext
      // FiberState.ACTIVE is 2; cordis publishes the state as a const enum
      // (type only), so the literal stays annotated instead of imported.
      if (context.state !== 2 /* FiberState.ACTIVE */) throw new Error('multi-root Auto Review context did not activate')
      const fork = await import('./fork.ts')
      ctx.fiber.assertActive()
      const mountedReviewer = ctx.plugin(fork)
      reviewer = mountedReviewer.ctx.fiber
      await mountedReviewer
      if (reviewer.state !== 2 /* FiberState.ACTIVE */) throw new Error('multi-root Auto Review owner did not activate')
    })()
    takeover.setOwnerDisposer(async () => {
      await setup.catch(() => {})
      await reviewer?.dispose()
      await reviewer?.await()
      await context?.dispose()
      await context?.await()
    })
    await setup
    if (context !== undefined) yield context.dispose
    if (reviewer !== undefined) yield reviewer.dispose
  }, 'optional Auto Review integration')
}
