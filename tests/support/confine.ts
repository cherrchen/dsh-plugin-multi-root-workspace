/**
 * Read one `confine` result regardless of which supported release is installed.
 *
 * `confine` is synchronous on `0.1.5-rc.2` and asynchronous on `0.1.6-alpha.1`
 * (see `src/compat/sandbox-confine.ts`). The specs care about the confined argv
 * and the backend facts, never about the call shape, so they go through this
 * helper and stay identical across both releases — which is what makes one
 * suite valid evidence for the whole allowlist.
 *
 * @module tests/support/confine
 */

import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/**
 * Confine one argv and await the result if the installed release returns a promise.
 * @param provider - the provider to ask.
 * @param argv - the argv to confine.
 * @param policy - the per-call policy.
 * @returns the confined argv and the selected backend's facts.
 */
export async function confined(
  provider: Pick<LocalSandboxProvider, 'confine'>,
  argv: readonly string[],
  policy: SandboxPolicy,
): Promise<ConfinedArgv> {
  return await (provider.confine(argv, policy) as ConfinedArgv | Promise<ConfinedArgv>)
}
