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
 * - `ctx.subprocess.spawnTerminal` keys on the `DSH_PTY_SESSION_ID` marker:
 *   every supported `dsh-terminal-bash` backend stamps it (alongside
 *   `DSH_SESSION_ID`) when it launches an agent's PTY, and no other caller —
 *   above all the panel's terminal controller — ever sets it. A spec without
 *   the marker is a USER terminal, passed through untouched in every mode:
 *   the sandbox protects agent behavior, and upstream never confines the
 *   user's own terminal. `ctx.terminals` itself is deliberately NOT wrapped:
 *   upstream mounts it inside `optional-persistent-terminals` with
 *   `isolate: { terminals: true }`, so the registry entry is unreachable from
 *   this row — the shared `spawnTerminal` seam plus the env discriminator
 *   covers both the un-isolated SDK mount and the isolated web mount.
 *
 * The same seam carries the unknown-authority downgrade: while the scope
 * reports `authority: 'unavailable'` — a contended, storage-failed or
 * config-invalid registry publishes an empty deny set that is NOT evidence —
 * `danger-full-access` executions run inside the upstream `workspace-write`
 * profile (with the deny set applied) instead of ambient.
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
 * the restricted profile prefix, already ending at the `--` separator, plus the
 * non-consuming stderr tail reader of the confined spawn the consumer launched
 * — the settle-time evidence a live process handle cannot carry itself.
 */
interface PreparedDeny {
  readonly argvPrefix: readonly string[]
  stderr?: (() => string | undefined) | undefined
}

const processDenyStore = new AsyncLocalStorage<PreparedDeny>()

/** Whether a value is a thenable, i.e. whether the installed `confine` is async. */
function isThenable(value: unknown): value is Promise<ConfinedArgv> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

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
   * The confined facts for one Full-access call, or `undefined` when the call
   * needs no confinement (not full-access, and nothing to deny while the
   * registry is the store's authority). An `unavailable` scope authority
   * clamps the call to the upstream `workspace-write` profile: the empty deny
   * set a contended or failed registry publishes is not evidence that nothing
   * is restricted. May throw synchronously — `SandboxUnavailableError` from a
   * dialect that cannot express the confinement, which must propagate to the
   * caller, never be swallowed.
   */
  const prepare = (policy: SandboxExecutionPolicy, signal?: AbortSignal): ConfinedArgv | Promise<ConfinedArgv> | undefined => {
    if (policy.mode !== 'danger-full-access') return undefined
    const scope = ctx.multiRootScope.resolve(policy)
    if (scope.authority === 'unavailable') {
      return (ctx.sandbox as MultiRootSandboxProvider).clampedExecution(policy, scope.deniedRoots, signal)
    }
    if (scope.deniedRoots.length === 0) return undefined
    return (ctx.sandbox as MultiRootSandboxProvider).restrictedExecution(policy, scope.deniedRoots, signal)
  }

  /**
   * Run `body` under the restricted deny context when `prepared` is a prefix —
   * preserving the sync/async shape of the prepared value itself.
   */
  const runDenied = (prepared: ConfinedArgv | Promise<ConfinedArgv>, policy: SandboxExecutionPolicy, body: () => unknown): unknown => {
    const run = (facts: ConfinedArgv): unknown => {
      const store: PreparedDeny = { argvPrefix: facts.argv }
      return processDenyStore.run(store, () =>
        decorateProcessOutcome(body(), facts, policy, { stderr: () => store.stderr?.() }))
    }
    return isThenable(prepared) ? prepared.then(run) : run(prepared)
  }

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
      const handle = original.call(this, { ...spec, argv: [...store.argvPrefix, ...spec.argv] })
      // `collected.stderr.readFrom(0)` is cursor-free — a live shell handle's
      // only settle-time window into the denial text the executor's own
      // `onProcessDone` would see. The last confined spawn wins; execute-style
      // entries launch exactly one.
      const stderr = object(handle) && object(handle.collected) && object(handle.collected.stderr)
        && typeof handle.collected.stderr.readFrom === 'function'
        ? handle.collected.stderr as { readFrom(fromByte: number): { text: string } }
        : undefined
      if (stderr !== undefined) store.stderr = () => {
        try { return stderr.readFrom(0).text } catch { return undefined }
      }
      return handle
    }))

    scope.effect(() => wrapMethod(scope.subprocess, 'spawnTerminal', original => async function (
      this: unknown,
      spec: SubprocessTerminalSpawnSpec,
    ) {
      // `DSH_PTY_SESSION_ID` is stamped by every supported dsh-terminal-bash
      // backend when it launches an agent's PTY — and never by any other
      // caller. A spec without it is a USER terminal (the panel's controller
      // calls `spawnTerminal` directly): the sandbox guards agent behavior,
      // so user terminals pass through untouched in every mode.
      const ptySessionId = spec.env?.DSH_PTY_SESSION_ID
      if (ptySessionId === undefined || ptySessionId === '') return await original.call(this, spec)
      const sessionId = spec.env?.DSH_SESSION_ID
      const session = sessionId === undefined || sessionId === ''
        ? undefined
        : ctx.get('sessions')?.get(sessionId as SessionId)
      if (session === undefined) {
        // An agent PTY whose owner session is gone is already an anomaly.
        // With no explicit read-only roots anywhere there is nothing to deny
        // and the spawn stays upstream-exact; otherwise refuse it — an
        // unattributable agent terminal must not inherit an uncomputed deny
        // set.
        if (!ctx.multiRootScope.hasActiveDenyRoots()) return await original.call(this, spec)
        throw new Error(
          'multi-root workspace: agent terminal spawn carries a session marker that does not resolve '
          + `to a live session (${JSON.stringify(sessionId ?? ptySessionId)}), and explicit read-only roots are `
          + 'or may be registered — refusing to spawn an unconfined terminal',
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
