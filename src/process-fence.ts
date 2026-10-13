/**
 * `multi-root-process-fence`: the B9 seam for the one cell `ctx.sandbox.confine`
 * never sees — `danger-full-access` with explicit `read-only` additional roots.
 *
 * Upstream, every confined consumer routes through `ctx.sandbox.confine`, which
 * this bundle's provider already widens (grants, the read-only fixed-write
 * graft, and the workspace-write deny edge). But the shell executor, the PTC
 * runtime and the PTY backend all short-circuit that mode: `policy.mode ===
 * 'danger-full-access'` returns the bare argv, so an explicit `read-only` root
 * would silently stay writable. This row closes the gap without touching any
 * upstream executor:
 *
 * - `ctx.subprocess.spawn` is wrapped to prepend a precomputed restricted
 *   profile whenever the AsyncLocalStorage below carries one. `spawn` is
 *   synchronous, so the profile — which never depends on the callee's argv —
 *   is built by the wrapping consumer, not here.
 * - `ctx.shell.execute` (bash and pwsh alike, and `start` where an older
 *   release still exposes it) resolves the per-call policy exactly the way the
 *   executor itself does, and — under Full-access with deny roots — asks the
 *   sandbox provider for the restricted prefix and runs the call inside the
 *   store, so every subprocess the executor launches is confined.
 * - `ctx.ptcRuntime.run` does the same for `run_code`.
 * - `ctx.subprocess.spawnTerminal` resolves the caller from the
 *   `DSH_SESSION_ID` environment marker the terminal backend always stamps —
 *   `Agent.enter` forces that id to equal the session id — and rewrites the
 *   already-built argv in place. A spawn carrying the marker whose session
 *   cannot be resolved fails closed whenever ANY registered primary holds an
 *   explicit `read-only` root: a terminal we cannot attribute must not inherit
 *   a deny set we cannot compute.
 *
 * Windows uses the standalone ambient deny-token runner. Landlock cannot subtract a subtree, so that combination selects bubblewrap.
 * An unusable mount runner fails without starting an unconfined process.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/process-fence
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './scope.ts'
import { wrapMethod } from './method-wrapper.ts'
import type { MultiRootSandboxProvider } from './sandbox.ts'
import { decorateProcessOutcome } from './compat/process-result.ts'

// `multiRootProviders` is the provider-conflict gate: the restricted profile is
// only meaningful when `ctx.sandbox` is THIS bundle's provider — a foreign one
// has no `restrictedArgvPrefix`, and wrapping a spawn on top of it would pass
// an explicit `read-only` root through unconfined.
export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootScope', 'sandbox', 'sandboxPolicy']

/**
 * The deny context a wrapping consumer hands to the synchronous `spawn` seam:
 * the restricted profile prefix, already ending at the `--` separator.
 */
interface PreparedDeny {
  readonly argvPrefix: readonly string[]
}

const processDenyStore = new AsyncLocalStorage<PreparedDeny>()

/** Whether a value is a thenable, i.e. whether the installed `confine` is async. */
function isThenable(value: unknown): value is Promise<ConfinedArgv> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/** `spec.sandboxPolicy`, the optional field every process spec may carry. */
interface PolicyCarryingSpec {
  readonly sandboxPolicy?: SandboxExecutionPolicy | undefined
  readonly signal?: AbortSignal | undefined
}

/** A service whose execute-style entries take a policy-carrying spec. */
interface PolicyEntrypoint {
  execute(spec: PolicyCarryingSpec, ...rest: unknown[]): unknown
  start(spec: PolicyCarryingSpec, ...rest: unknown[]): unknown
  run(spec: PolicyCarryingSpec, ...rest: unknown[]): unknown
}

export function apply(ctx: Context): void {
  // Resolve the policy the same way the upstream consumer does: the spec's own
  // resolved policy wins, the deployment/session resolution is the fallback.
  const policyOf = (spec: PolicyCarryingSpec | undefined): SandboxExecutionPolicy =>
    spec?.sandboxPolicy ?? ctx.sandboxPolicy.resolve()

  /**
   * The restricted prefix for one Full-access call, or `undefined` when the
   * call needs no confinement (not full-access, or nothing to deny). May throw
   * synchronously — `SandboxUnavailableError` from a dialect that cannot
   * express the deny, which must propagate to the caller, never be swallowed.
   */
  const prepare = (policy: SandboxExecutionPolicy, signal?: AbortSignal): ConfinedArgv | Promise<ConfinedArgv> | undefined => {
    if (policy.mode !== 'danger-full-access') return undefined
    const denied = ctx.multiRootScope.resolve(policy).deniedRoots
    if (denied.length === 0) return undefined
    return (ctx.sandbox as MultiRootSandboxProvider).restrictedExecution(policy, denied, signal)
  }

  /**
   * Run `body` under the restricted deny context when `prepared` is a prefix —
   * preserving the sync/async shape of the prepared value itself.
   */
  const runDenied = (prepared: ConfinedArgv | Promise<ConfinedArgv>, policy: SandboxExecutionPolicy, body: () => unknown): unknown =>
    isThenable(prepared)
      ? prepared.then(facts => processDenyStore.run({ argvPrefix: facts.argv }, () => decorateProcessOutcome(body(), facts, policy)))
      : processDenyStore.run({ argvPrefix: prepared.argv }, () => decorateProcessOutcome(body(), prepared, policy))

  // The synchronous seam every confined-capable spawn crosses. The store is
  // set ONLY around a consumer call that already paid for the restricted
  // profile, so other spawns stay untouched — a nesting consumer can only ever
  // narrow, matching the tool-cap rule.
  ctx.inject(['subprocess'], (scope: Context) => {
    scope.effect(() => wrapMethod(scope.subprocess, 'spawn', original => function (
      this: unknown,
      spec: SubprocessSpawnSpec,
    ) {
      const store = processDenyStore.getStore()
      if (store === undefined) return original.call(this, spec)
      return original.call(this, { ...spec, argv: [...store.argvPrefix, ...spec.argv] })
    }))

    scope.effect(() => wrapMethod(scope.subprocess, 'spawnTerminal', original => async function (
      this: unknown,
      spec: SubprocessTerminalSpawnSpec,
    ) {
      const sessionId = spec.env?.DSH_SESSION_ID
      if (sessionId === undefined || sessionId === '') return await original.call(this, spec)
      const session = ctx.get('sessions')?.get(sessionId as SessionId)
      if (session === undefined) {
        // A PTY spawn whose owner session is gone is already an anomaly. With
        // no explicit read-only roots anywhere there is nothing to deny and
        // the spawn stays upstream-exact; otherwise refuse it — an
        // unattributable terminal must not inherit an uncomputed deny set.
        if (!ctx.multiRootScope.hasActiveDenyRoots()) return await original.call(this, spec)
        throw new Error(
          'multi-root workspace: terminal spawn carries a session marker that does not resolve '
          + `to a live session (${JSON.stringify(sessionId)}), and explicit read-only roots are `
          + 'registered — refusing to spawn an unconfined terminal',
        )
      }
      const policy = ctx.sandboxPolicy.resolve({ session })
      const prepared = prepare(policy, spec.signal)
      if (prepared === undefined) return await original.call(this, spec)
      const argvPrefix = (await prepared).argv
      return await original.call(this, { ...spec, argv: [...argvPrefix, ...spec.argv] })
    }))
  })

  /**
   * The wrapper every execute-style consumer entry shares: resolve the policy
   * the way the upstream consumer does, and when the call runs ambient under
   * Full-access with roots to deny, execute it inside the restricted store so
   * every subprocess it launches is confined.
   */
  const deniedEntry = (scope: Context, target: PolicyEntrypoint, key: 'execute' | 'start' | 'run'): void => {
    if (typeof target[key] !== 'function') return
    scope.effect(() => wrapMethod(target, key, original => function (
      this: unknown,
      spec: PolicyCarryingSpec | undefined,
      ...rest: unknown[]
    ) {
      const policy = policyOf(spec)
      const prepared = prepare(policy, spec?.signal)
      if (prepared === undefined) return original.call(this, spec as PolicyCarryingSpec, ...rest)
      return runDenied(prepared, policy, () => original.call(this, spec as PolicyCarryingSpec, ...rest))
    }))
  }

  // The bash / pwsh tool executors. `execute` is the only entry on every
  // supported release; `start` existed through 0.1.6 and is wrapped when the
  // mounted executor still exposes it — structure, not a version check.
  ctx.inject(['shell'], (scope: Context) => {
    const shell = scope.get('shell') as PolicyEntrypoint | undefined
    if (shell === undefined) return
    deniedEntry(scope, shell, 'execute')
    deniedEntry(scope, shell, 'run')
    deniedEntry(scope, shell, 'start')
  })

  // `run_code` — the PTC runtime spawns its Node worker through the same
  // subprocess seam and carries the resolved policy on the spec.
  ctx.inject(['ptcRuntime'], (scope: Context) => {
    const runtime = scope.get('ptcRuntime') as PolicyEntrypoint | undefined
    if (runtime === undefined) return
    // `run` is public. The concrete runtime's `execute` helper is private and
    // is deliberately not used as a cross-package compatibility seam.
    deniedEntry(scope, runtime, 'run')
  })
}
