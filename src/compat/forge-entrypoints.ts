/**
 * Compatibility adapter: which foreign-service entries the process fence can
 * admit.
 *
 * The upstream experimental forge bundle composes `ctx.sandbox.confine` +
 * `ctx.subprocess.spawn` on its own code paths — the panel's Git reads and the
 * worktree service's creation/restore commands — bypassing every wrapped
 * executor seam the admission already reaches. The fence therefore wraps each
 * reachable async public entry with an ordered admission of its own. Which
 * services and keys exist is a per-release shape: the verified baseline here
 * is `@deepseek-ai/dsh-experimental-forge-bundle@0.2.2-rc.1` (which pins
 * `dsh-experimental-worktree` and `dsh-experimental-client-ui-forge` at the
 * same version), and the `follow`/`changeRequestStates` async generators are
 * deliberately absent — a generator cannot hold a synchronous admission, so
 * its detached work falls back to the minted-profile ledger.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/forge-entrypoints
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One foreign service whose public entries spawn confined processes. */
export interface ForeignProcessService {
  readonly service: string
  readonly keys: readonly string[]
}

/**
 * The forge-bundle service entries an admission can wrap, in this order.
 * `worktrees.create`/`restore` take an `Agent` (the session rides on
 * `agent.session`); every listed `forgePanel` entry takes the `Session` as
 * its first argument. Entries not listed — background inspections, the
 * isolated `forge-worktree` instance inside the panel's mount group — stay
 * ledger-covered.
 */
export const FORGE_PROCESS_SERVICES: readonly ForeignProcessService[] = [
  { service: 'worktrees', keys: ['create', 'restore'] },
  {
    service: 'forgePanel',
    keys: [
      'branches', 'track', 'dismiss', 'refresh', 'localDiff', 'localText',
      'changeRequestChecks', 'changeRequestDiff', 'changeRequestText', 'submitReview', 'markReady', 'merge',
      'requestWorktree', 'cancelWorktree', 'stopCreation', 'retryWorktree', 'restoreWorktree', 'continueInProject',
    ],
  },
]

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Read the session a foreign-service entry resolves its policy from — the
 * first argument alone: a `Session`, or an `Agent`-shaped value carrying one.
 * The probe is deliberately structural and narrow (`id` + `header`): it is a
 * trust boundary over the upstream type, not a full validation — anything
 * else runs unadmitted rather than let `sandboxPolicy.resolve` read fields a
 * foreign argument lacks.
 * @param first - the wrapped call's first argument.
 * @returns the session, or `undefined` for a call that does not carry one.
 */
export function sessionOf(first: unknown): Session | undefined {
  const candidate = object(first) && object(first.session) ? first.session : first
  const isSession = (value: unknown): value is Session =>
    object(value) && typeof value.id === 'string' && object(value.header)
  return isSession(candidate) ? candidate : undefined
}
