/**
 * The provider-conflict gate for unit stacks.
 *
 * `multiRootProviders` is a hard precondition of the registry and of every
 * authority-widening row: cordis holds a fiber whose injected service is
 * missing inactive, so a spec that mounts the registry without this gate would
 * silently never start the service under test — the same failure mode the
 * compat gate had before `mountCompat`.
 *
 * A spec's stack mounts this gate the way a real profile does: whatever `fs` /
 * `sandbox` is already mounted carries this bundle's brand (the real
 * `MultiRootFileSystem` / `MultiRootSandboxProvider` brand themselves; a spec
 * that mounts the upstream provider directly gets the same brand because the
 * spec's provider plays the replacement role), and a missing one gets a
 * branded stub. The conflict behavior itself — foreign provider before or
 * after ours — is exercised end-to-end in `provider-conflict.spec.ts`, never
 * through this helper.
 *
 * @module tests/support/providers
 */

import type { Context } from '@deepseek-ai/cordis'
import { MultiRootProviders, brandMultiRootProvider, type ProviderKind } from '../../src/providers.ts'

/**
 * Brand whatever `fs`/`sandbox` the stack already mounts, stub the missing
 * ones, and mount the provider-conflict gate.
 * @param ctx - the stack's root context; call after its providers are mounted.
 */
export async function mountProviderGate(ctx: Context): Promise<void> {
  for (const name of ['fs', 'sandbox'] as const satisfies readonly ProviderKind[]) {
    const existing = ctx.get(name, false)
    if (existing !== undefined) {
      // The spec's provider plays the replacement role this bundle's row would
      // mount in a real composition, so it carries the same brand.
      brandMultiRootProvider(existing, name)
    } else {
      ctx.provide(name, brandMultiRootProvider({}, name))
    }
  }
  await ctx.plugin(MultiRootProviders)
}
