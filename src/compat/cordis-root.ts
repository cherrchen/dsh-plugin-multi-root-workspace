/**
 * The shared application root context across cordis generations.
 *
 * Cordis 4.1 exposes the root as the `ctx.root` property; 4.2 moved the same
 * shared context to the published `Context.root` symbol
 * (`Symbol.for('cordis.root')`). The optional Auto Review disposer asks whether
 * the ROOT is still active, so it must reach the root on every supported
 * release; this structural probe keeps both generations working without
 * comparing version strings (ADR-0009).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/cordis-root
 */

import type { Context } from '@deepseek-ai/cordis'

/** The published cordis symbol for the root context (4.2 and later). */
const ROOT = Symbol.for('cordis.root')

/**
 * Resolve the application's shared root context from any context.
 *
 * Tries the published symbol first and the pre-4.2 `root` property second.
 * Neither present means the installed cordis is a shape this plugin has never
 * been verified against; the caller must fail loudly rather than silently
 * skip the root-state check it needs.
 * @param ctx - any context whose shared root is requested.
 * @returns the shared root context.
 * @throws when the installed cordis exposes neither published root form.
 */
export function rootContext(ctx: Context): Context {
  const symbolic: Context | undefined = Reflect.get(ctx, ROOT)
  if (symbolic !== undefined) return symbolic
  const legacy = (ctx as Context & { root?: Context }).root
  if (legacy !== undefined) return legacy
  throw new Error('multi-root workspace: the installed cordis exposes no root context')
}
