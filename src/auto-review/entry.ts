/** Optional Loader face. Its one switch owns context, reviewer and takeover. */
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { AUTO_REVIEW_IMPLEMENTATIONS, requireAutoReviewBaseline, requireAutoReviewRelease, type AutoReviewBaseline } from '../compat/auto-review-contract.ts'
import { assertForkPackages } from '../compat/auto-review-packages.ts'
import { AutoReviewTakeover } from '../compat/auto-review-loader.ts'
import MultiRootReviewContext from '../review-context.ts'

export const name = 'multi-root-auto-review'
export const inject = ['loader', 'multiRootCompat', 'multiRootProviders', 'multiRootScope', 'multiRootRegistry', 'multiRootInstructions', 'sandboxPolicy', 'workingDirectory', 'fs', 'approval', 'llm', 'permissionPresets', 'sessions', 'tools']

/** The bundled implementation must expose the Loader's plugin face. */
function assertImplementation(value: unknown): asserts value is Plugin.Object {
  if (typeof value !== 'object' || value === null || !('apply' in value) || typeof value.apply !== 'function') {
    throw new Error('multi-root Auto Review: the bundled implementation is incomplete')
  }
  // Missing `inject` is not a load error: the plugin would start and then fail
  // on its first host-service read. Validate the declaration here instead.
  if (!('inject' in value) || !Array.isArray(value.inject)) {
    throw new Error('multi-root Auto Review: the bundled implementation declares no injected services')
  }
}

/**
 * Load the fork implementation of one baseline. The implementations are
 * separate bundle entries and the path is computed: importing both statically
 * would pull the other generation's imports into this host's module graph.
 * @param baseline - the baseline selected from the installed release.
 * @returns the implementation's plugin face.
 */
async function loadImplementation(baseline: AutoReviewBaseline): Promise<Plugin.Object> {
  const loaded: unknown = await import(new URL(AUTO_REVIEW_IMPLEMENTATIONS[baseline], import.meta.url).href)
  assertImplementation(loaded)
  return loaded
}

export async function apply(ctx: Context): Promise<void> {
  const release = requireAutoReviewRelease(ctx.multiRootCompat.release)
  const baseline = requireAutoReviewBaseline(release)
  assertForkPackages(release)
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
      const fork = await loadImplementation(baseline)
      ctx.fiber.assertActive()
      const mountedReviewer = ctx.plugin(fork)
      reviewer = mountedReviewer.ctx.fiber
      await mountedReviewer
      if (reviewer.state !== 2) throw new Error('multi-root Auto Review owner did not activate')
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
