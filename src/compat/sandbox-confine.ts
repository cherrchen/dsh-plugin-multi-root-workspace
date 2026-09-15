/**
 * Compatibility adapter for the one upstream signature that changed shape
 * between two releases this plugin supports.
 *
 * ```text
 * 0.1.5-rc.2     confine(argv, policy): ConfinedArgv
 * 0.1.6-alpha.1  confine(argv, policy, signal?): Promise<ConfinedArgv>
 * ```
 *
 * The widening itself (`src/dialects.ts`) is pure string work on the argv the
 * upstream provider produced, so nothing about it needs to be async. The only
 * problem is the SHAPE of the call: an override must accept what the installed
 * base class declares and return what its caller expects. This module is where
 * that is solved, once:
 *
 * - the return type is expressed as {@link UpstreamConfined}, derived from the
 *   installed base class, so it resolves to `ConfinedArgv` on one release and
 *   `Promise<ConfinedArgv>` on the other without two hand-written signatures;
 * - {@link widenConfined} preserves the shape it was handed — a synchronous
 *   base result stays synchronous, a promise stays a promise. It never wraps a
 *   sync result in a promise, because on `0.1.5-rc.2` that would change
 *   `ctx.sandbox.confine()` from a value into a thenable for every caller in
 *   the composition, including the bash executor and the PTY backend.
 *
 * The single unavoidable cast lives here too, and nowhere else: `super.confine`
 * has a different arity per release, so calling it uniformly needs one
 * assertion to {@link ConfineCall}.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/sandbox-confine
 */

import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/**
 * Whatever the INSTALLED upstream provider's `confine` returns. Resolves to
 * `ConfinedArgv` on a release with a synchronous `confine`, and to
 * `Promise<ConfinedArgv>` on a release with an asynchronous one.
 */
export type UpstreamConfined = ReturnType<LocalSandboxProvider['confine']>

/**
 * A call into the upstream `confine`, tolerant of both arities. The trailing
 * `signal` is ignored by a release that does not declare it, which is safe:
 * extra arguments to a JavaScript function are discarded, and a release without
 * cancellation support simply never observes it.
 */
export type ConfineCall = (
  argv: readonly string[],
  policy: SandboxPolicy,
  signal?: AbortSignal,
) => ConfinedArgv | Promise<ConfinedArgv>

/** Whether a value is a thenable, i.e. whether the installed `confine` is async. */
function isThenable(value: unknown): value is Promise<ConfinedArgv> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/**
 * Call the upstream `confine` and widen its result, preserving sync/async shape.
 *
 * @param base - the upstream `confine`, already bound to its provider.
 * @param widen - the pure transformation to apply to the upstream result. It
 *   runs exactly once per call, on whichever release; it may throw, and the
 *   throw surfaces synchronously or as a rejection to match the base shape.
 * @param argv - the caller's argv, forwarded verbatim.
 * @param policy - the per-call policy, forwarded verbatim.
 * @param signal - forwarded when the installed release accepts it.
 * @returns the widened result, in the shape the installed release uses.
 */
export function widenConfined(
  base: ConfineCall,
  widen: (confined: ConfinedArgv) => ConfinedArgv,
  argv: readonly string[],
  policy: SandboxPolicy,
  signal?: AbortSignal,
): UpstreamConfined {
  const confined = base(argv, policy, signal)
  const result = isThenable(confined) ? confined.then(widen) : widen(confined)
  // The one cast: `UpstreamConfined` is whichever branch the installed release
  // declares, and the branch taken above is exactly that one — but only the
  // runtime probe knows which, so the compiler has to be told.
  return result as UpstreamConfined
}
