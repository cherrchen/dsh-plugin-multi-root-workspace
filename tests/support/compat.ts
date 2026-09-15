/**
 * Satisfy the `multiRootCompat` gate for specs that mount a gated provider.
 *
 * It mounts the REAL row — verdict, gate policy and all — rather than a
 * permissive stub. That matters: every spec that mounts a provider therefore
 * also asserts that this suite is allowed to run against the installed release
 * at all. On an unlisted release the gate refuses here, and the suite fails
 * loudly instead of quietly producing evidence about a harness nobody verified.
 *
 * The one way past it is `DSH_MULTI_ROOT_COMPAT=warn`, which is how the upgrade
 * lane runs the behavior matrix against a candidate release before that release
 * is on the allowlist (ADR-0009).
 *
 * @module tests/support/compat
 */

import type { Context } from '@deepseek-ai/cordis'
import * as Compat from '../../src/compat.ts'

/**
 * Mount `ctx.multiRootCompat` for the installation under test.
 * @param ctx - the context to provide the service on.
 * @throws {DshCompatUnsupportedError} under `enforce` on an unlisted release.
 */
export async function mountCompat(ctx: Context): Promise<void> {
  await ctx.plugin(Compat)
}
