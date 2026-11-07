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
 *   release still exposes it — `compat/process-entrypoints.ts` owns which
 *   entries a mounted executor actually carries) resolves the per-call policy
 *   exactly the way the executor itself does, and — under Full-access with
 *   deny roots — asks the sandbox provider for the restricted prefix and runs
 *   the call inside the store, so every subprocess the executor launches is
 *   confined.
 * - `ctx.ptcRuntime.run` does the same for `run_code`.
 * - `ctx.subprocess.spawnTerminal` keys on the `DSH_PTY_SESSION_ID` marker:
 *   every supported `dsh-terminal-bash` backend stamps it (alongside
 *   `DSH_SESSION_ID`) when it launches an agent's PTY, and no other caller —
 *   above all the panel's terminal controller — ever sets it. A spec without
 *   the marker is a USER terminal, passed through untouched in every mode:
 *   the sandbox protects agent behavior, and upstream never confines the
 *   user's own terminal. Because that marker is the ONLY discriminator, the
 *   `multi-root-compat` gate asserts it at boot (`compat/pty-marker.ts`):
 *   an installed backend whose emitted code no longer stamps it fails the
 *   plugin load rather than silently reclassifying agent PTYs as the user's.
 *   `ctx.terminals` itself is deliberately NOT wrapped:
 *   upstream mounts it inside `optional-persistent-terminals` with
 *   `isolate: { terminals: true }`, so the registry entry is unreachable from
 *   this row — the shared `spawnTerminal` seam plus the env discriminator
 *   covers both the un-isolated SDK mount and the isolated web mount.
 *
 * The same seam carries the unknown-authority downgrade: while the scope
 * reports `authority: 'unavailable'` — a contended, storage-failed or
 * config-invalid registry publishes an empty deny set that is NOT evidence —
 * `danger-full-access` executions run inside a primary-root-only
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
import { withRegistryAdmission } from './registry-operation.ts'
import { confineInstalled } from './compat/sandbox-confine.ts'
import { hasConfinedProfile, originalProcessArgv } from './compat/process-profile.ts'
import { aroundTool } from './compat/tool-context.ts'
import { opsCompatibilityToken } from './compat/ops-settings.ts'
import type { ToolCaller } from './compat/tool-context.ts'
import {
  assertOpsPosixCacheAdmission, assertOpsProtectionOwner, claimOpsProtection,
  classifyOpsTool, drainOpsProtection, enterOpsProtection, leaveOpsProtection,
  revokeOpsProtection, withOpsSpawnPermit,
} from './compat/ops-tools.ts'
import { wrapMethod } from './method-wrapper.ts'
import type { MultiRootSandboxProvider } from './sandbox.ts'
import { decorateProcessOutcome } from './compat/process-result.ts'
import { isAsyncProcessEntry, ptcEntrypoints, shellEntrypoints } from './compat/process-entrypoints.ts'
import type { ProcessEntrypoint } from './compat/process-entrypoints.ts'
import { FORGE_PROCESS_SERVICES, sessionOf } from './compat/forge-entrypoints.ts'

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
  readonly ops?: boolean
  readonly opsState?: import('./compat/ops-tools.ts').OpsProtectionState
  active?: boolean
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
  const opsScope = ctx.get('multiRootScope')!
  const opsSandbox = ctx.sandbox as MultiRootSandboxProvider
  const runOpsDispatch = async (exec: ToolCaller, policy: SandboxExecutionPolicy, next: () => Promise<unknown>): Promise<unknown> => {
    const modeToken = opsCompatibilityToken(ctx)
    const scope = opsScope
    const opsState = scope.opsProtection
    const token = enterOpsProtection(opsState)
    try {
      const dispatch = async () => {
        const resolved = scope.resolve(policy)
        if (resolved.authority === 'unavailable') {
          throw new Error('multi-root workspace: the registry authority is unavailable; refusing the OPS execution')
        }
        if (resolved.deniedRoots.length > 0) {
          if (policy.mode !== 'danger-full-access') {
            throw new Error(`multi-root workspace: the OPS execution is refused in ${policy.mode}: private preparation and worker write boundaries cannot be proven without OPS integration`)
          }
          if (classifyOpsTool(exec.name) === 'unknown') {
            throw new Error(`multi-root workspace: the unrecognized OPS capability ${JSON.stringify(exec.name)} is refused while write boundaries apply`)
          }
          if (exec.name === 'ops_bash' && typeof exec.arguments === 'object' && exec.arguments !== null
            && (exec.arguments as { run_in_background?: unknown }).run_in_background === true) {
            throw new Error('multi-root workspace: run_in_background is refused while danger-full-access write boundaries apply')
          }
        }
        let facts: ConfinedArgv | undefined
        if (resolved.deniedRoots.length > 0) {
          if (process.platform === 'win32') {
            throw new Error('multi-root workspace: OPS worker preparation is not verified on this platform; refusing the call while write boundaries apply')
          }
          assertOpsPosixCacheAdmission(resolved.deniedRoots)
          facts = await opsSandbox
            .restrictedExecution(policy, resolved.deniedRoots, exec.signal, resolved.protectedHome)
          if (facts === undefined || facts.argv.length === 0) {
            throw new Error('multi-root workspace: the restricted runner could not be prepared; refusing the OPS execution')
          }
        }
        assertOpsProtectionOwner(opsState, token)
        if (opsCompatibilityToken(ctx) !== modeToken) {
          throw new Error('multi-root workspace: the OPS compatibility mode changed during dispatch; refusing the execution')
        }
        const store: PreparedDeny = { argvPrefix: facts?.argv ?? [], ops: true, opsState, active: true }
        try {
          return await processDenyStore.run(store, () =>
            facts === undefined
              ? next()
              : decorateProcessOutcome(next(), facts, policy, { stderr: () => store.stderr?.() }))
        } finally {
          store.active = false
        }
      }
      if (ctx.get('multiRootRegistry')?.shared) return await withRegistryAdmission(ctx, policy, 'process', dispatch)
      return await dispatch()
    } finally {
      leaveOpsProtection(opsState)
    }
  }

  aroundTool(ctx, async (exec, next) => {
    const kind = classifyOpsTool(exec.name)
    if (kind === 'other' || kind === 'publish' || opsCompatibilityToken(ctx) === undefined) {
      if (!ctx.get('multiRootRegistry')?.shared || exec.agent === undefined) return next()
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
      return opsScope.withToolCap(exec.name, () => withRegistryAdmission(ctx, policy, 'process', next))
    }
    if (exec.agent === undefined) {
      throw new Error(`multi-root workspace: the OPS call ${JSON.stringify(exec.name)} cannot be confirmed against a trusted session`)
    }
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    return opsScope.withToolCap(exec.name, () => runOpsDispatch(exec, policy, next))
  })
  // Resolve the policy the same way the upstream consumer does: the spec's own
  // resolved policy wins, the deployment/session resolution is the fallback.
  const policyOf = (spec: PolicyCarryingSpec | undefined): SandboxExecutionPolicy =>
    spec?.sandboxPolicy ?? ctx.sandboxPolicy.resolve()

  /**
   * The confined facts for one Full-access call, or `undefined` when the call
   * needs no confinement (not full-access, and nothing to deny while the
   * registry is the store's authority). An `unavailable` scope authority
   * clamps the call to a primary-root-only profile: the empty deny
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
    return (ctx.sandbox as MultiRootSandboxProvider).restrictedExecution(policy, scope.deniedRoots, signal, scope.protectedHome)
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
    const opsState = opsScope.opsProtection
    scope.effect(() => {
      const restore = wrapMethod(scope.get('subprocess') as typeof scope.subprocess, 'spawn', original => function (
      this: unknown,
      spec: SubprocessSpawnSpec,
    ) {
      const store = processDenyStore.getStore()
      if (store?.ops === true && (store.active === false || store.opsState !== opsState)) {
        throw new Error('multi-root workspace: the OPS execution domain has expired')
      }
      const admissionScope = store?.ops === true ? opsScope : scope.multiRootScope
      if (admissionScope.admissionRequired && admissionScope.hasAdmission() && !admissionScope.admissionPathsValid()) {
        throw new Error('multi-root workspace: an admitted root was redirected before process launch')
      }
      let argv = spec.argv
      if (store?.ops === true) {
        const prefix = store.argvPrefix
        if (hasConfinedProfile(spec.argv)) {
          const matches = spec.argv.length > prefix.length && prefix.every((segment, index) => spec.argv[index] === segment)
          if (!matches) {
            throw new Error("multi-root workspace: a confined spawn inside an OPS execution domain must carry this domain's own profile")
          }
        } else {
          argv = [...prefix, ...spec.argv]
        }
        if (opsScope.admissionRequired && (hasConfinedProfile(spec.argv) || prefix.length > 0)
          && !opsScope.permitsOperationProfile(argv)) {
          throw new Error('multi-root workspace: a confined spawn requires a profile from this live admission')
        }
      } else {
        argv = store === undefined ? spec.argv : [...store.argvPrefix, ...spec.argv]
        if (scope.multiRootScope.admissionRequired && (store !== undefined || hasConfinedProfile(argv))
          && !scope.multiRootScope.permitsProfile(argv)) {
          throw new Error('multi-root workspace: a confined spawn requires a profile from this live admission')
        }
      }
      const launch = () => original.call(this, argv === spec.argv ? spec : { ...spec, argv })
      // Only the prepared domain or a profile minted inside a live admission
      // earns the OPS protection window's launch permit; a ledger mint still
      // launches unadmitted — just unattributed, so the scope guard refuses
      // it while OPS roots are denied.
      const handle = store !== undefined || admissionScope.admissionRequired && admissionScope.permitsOperationProfile(argv)
        ? withOpsSpawnPermit(opsState, launch) : launch()
      if (store === undefined) return handle
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
    })
      return async () => {
        await drainOpsProtection(opsState)
        restore()
      }
    })

    scope.effect(() => wrapMethod(scope.get('subprocess') as typeof scope.subprocess, 'spawnTerminal', original => async function (
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
      return withRegistryAdmission(ctx, policy, 'pty', async () => {
        if (ctx.get('multiRootRegistry')?.shared) {
          const command = originalProcessArgv(spec.argv)
          const prefix = prepare(policy, spec.signal)
          const argv = policy.mode === 'danger-full-access'
            ? prefix === undefined ? command : [...(await prefix).argv, ...command]
            : (await confineInstalled(ctx.sandbox, command, { ...policy, mode: policy.mode }, spec.signal)).argv
          if (!ctx.multiRootScope.admissionPathsValid()) throw new Error('an admitted terminal root was redirected')
          return await original.call(this, { ...spec, argv })
        }
        const prepared = prepare(policy, spec.signal)
        if (prepared === undefined) return await original.call(this, spec)
        const argvPrefix = (await prepared).argv
        return await original.call(this, { ...spec, argv: [...argvPrefix, ...spec.argv] })
      })
    }))

    const token = claimOpsProtection(opsState)
    scope.effect(() => async () => {
      revokeOpsProtection(opsState, token)
      await drainOpsProtection(opsState)
    })
  })

  /**
   * The wrapper every execute-style consumer entry shares: resolve the policy
   * the way the upstream consumer does, and when the call runs ambient under
   * Full-access with roots to deny, execute it inside the restricted store so
   * every subprocess it launches is confined.
   */
  const deniedEntry = (scope: Context, target: PolicyEntrypoint, key: ProcessEntrypoint): void => {
    scope.effect(() => wrapMethod(target, key, original => function (
      this: unknown,
      spec: PolicyCarryingSpec | undefined,
      ...rest: unknown[]
    ) {
      const policy = policyOf(spec)
      const run = () => {
        const prepared = prepare(policy, spec?.signal)
        if (prepared === undefined) return original.call(this, spec as PolicyCarryingSpec, ...rest)
        return runDenied(prepared, policy, () => original.call(this, spec as PolicyCarryingSpec, ...rest))
      }
      if (ctx.get('multiRootRegistry')?.shared) {
        // AsyncFunction is a structural probe; synchronous legacy entries keep
        // their return shape and receive no additional grant without admission.
        if (isAsyncProcessEntry(original)) return withRegistryAdmission(ctx, policy, 'process', run)
        if (!ctx.multiRootScope.hasAdmission()) return ctx.get('multiRootRegistry')!.withPrimaryOperation(policy, run)
      }
      return run()
    }))
  }

  // The bash / pwsh tool executors. Which execute-style entries the mounted
  // service actually carries is a per-release shape — `compat/process-entrypoints`
  // answers it structurally (a version string is never probed).
  ctx.inject(['shell'], (scope: Context) => {
    const shell = scope.get('shell') as PolicyEntrypoint | undefined
    if (shell === undefined) return
    for (const key of shellEntrypoints(shell)) deniedEntry(scope, shell, key)
  })

  // `run_code` — the PTC runtime spawns its Node worker through the same
  // subprocess seam and carries the resolved policy on the spec.
  ctx.inject(['ptcRuntime'], (scope: Context) => {
    const runtime = scope.get('ptcRuntime') as PolicyEntrypoint | undefined
    if (runtime === undefined) return
    for (const key of ptcEntrypoints(runtime)) deniedEntry(scope, runtime, key)
  })

  // Foreign services that compose `ctx.sandbox.confine` + `ctx.subprocess.spawn`
  // on their own code paths — the upstream experimental forge bundle's panel
  // and worktree service (`compat/forge-entrypoints.ts` owns the per-release
  // service/key inventory and the session probe). Their async public entries
  // get the same ordered admission the wrapped executors receive; entries
  // unreachable from here (background inspections, async generators, isolated
  // mounts) stay covered by the minted-profile ledger instead. `ctx.inject`
  // never fires for a service nobody mounted, so these hooks cost nothing
  // without the bundle. A key the mounted service exposes but cannot take a
  // wrapper — a getter-only property rather than a plain method — is skipped
  // with a warning rather than failing the whole hook.
  const admitCalls = (service: string, keys: readonly string[]): void => {
    ctx.inject([service], (scope: Context) => {
      const target = scope.get(service) as Record<string, unknown> | undefined
      if (target === undefined) return
      for (const key of keys) {
        try {
          if (!isAsyncProcessEntry(target[key])) {
            if (key in target) ctx.logger.warn(`multi-root workspace: foreign process entry ${service}.${key} exists but is not an async method; it keeps ledger coverage only`)
            continue
          }
          scope.effect(() => wrapMethod(
            target as Record<string, (this: unknown, first: unknown, ...rest: unknown[]) => unknown>,
            key,
            original => async function (this: unknown, first: unknown, ...rest: unknown[]) {
              const session = sessionOf(first)
              if (session === undefined) return original.call(this, first, ...rest)
              const policy = ctx.sandboxPolicy.resolve({ session })
              // An admission that cannot be acquired (registry unreachable or
              // disposed) must not fail a call that may not spawn at all: run
              // it unadmitted, where any confined mint falls back to the
              // clamped-ledger degrade. Errors thrown BY the call propagate.
              let ran = false
              try {
                return await withRegistryAdmission(ctx, policy, 'process', () => {
                  ran = true
                  return original.call(this, first, ...rest)
                })
              } catch (error: unknown) {
                if (ran) throw error
                return original.call(this, first, ...rest)
              }
            },
          ))
        } catch (error: unknown) {
          ctx.logger.warn(`multi-root workspace: foreign process entry ${service}.${key} is not wrappable: `
            + `${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  }
  for (const { service, keys } of FORGE_PROCESS_SERVICES) admitCalls(service, keys)
}
