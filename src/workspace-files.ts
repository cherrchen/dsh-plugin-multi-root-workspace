/** Extend the existing workspaceFiles namespace without replacing its codecs or read caps. */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceFiles, WorkspaceFileRange, WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { resolve as resolveLexically } from 'node:path'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type { MultiRootRegistry } from './registry.ts'
import { adaptPathWatch, resolveRelatedWorkspacePath } from './compat/workspace-files.ts'
import { canonicalRoot, isCanonicallyUnder } from './roots.ts'
import { routeWorkspacePath } from './workspace-routing.ts'
import { withRegistryRead } from './registry-operation.ts'
import { wrapMethod } from './method-wrapper.ts'

// `multiRootProviders` is the provider-conflict gate: a foreign `ctx.fs` must
// not serve additional-root entries this row listed.
export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootScope']

export function apply(ctx: Context): void {
  ctx.inject(['workspaceFiles', 'fs'], scope => {
    const service = scope.get('workspaceFiles') as WorkspaceFiles
    scope.effect(() => {
      const rowLifetime = new AbortController()
      const restoreList = wrapMethod(service, 'list', original => async function(this: WorkspaceFiles, request, path, signal) {
        // A granted root or a registered-but-withheld set must still resolve
        // the selected path: the listing may target another granted root even
        // while the primary itself resolves inside a withheld boundary.
        if (scope.multiRootScope.scopeOf(request.workspaceRoot).length === 0 && registeredRoots(scope, request.workspaceRoot).length === 0) {
          return original.call(this, request, path, signal)
        }
        const route = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
        // The withheld check belongs to the directory the requested path
        // selects, not to the session root.
        if (route !== undefined && underWithheldRoot(scope, route.primaryRoot, route.absolutePath)) throw await outside(path)
        if (route === undefined || route.workspaceRoot === route.primaryRoot) return original.call(this, request, path, signal)
        const result = await original.call(this, { ...request, workspaceRoot: route.workspaceRoot }, route.absolutePath, signal)
        if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) throw await outside(path)
        return result
      })
      // `stat`, `read` and `readBytes` — plus `readAll`/`readRelated` on the
      // releases that still carry them — carry NO upstream workspace
      // confinement (file opens are user authority by upstream design), so
      // this plugin's grant boundary has to be applied here: a live
      // additional root routes exactly like `list`, and a path still sitting
      // under a registered but withheld root is refused instead of reading
      // through the dead grant (a cached tree row stays clickable after a
      // revoke/redirect, and upstream would happily resolve the replaced
      // directory's symlink).
      const restoreStat = wrapMethod(service, 'stat', original => async function(this: WorkspaceFiles, request: WorkspaceFileScope, path: string, signal: AbortSignal) {
        const routed = await routeRead(scope, request, path, signal)
        if (routed === 'deny') throw await outside(path)
        return original.call(this, routed.request, routed.path, signal)
      })
      const restoreRead = wrapMethod(service, 'read', original => async function(this: WorkspaceFiles, request: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal) {
        const routed = await routeRead(scope, request, path, signal)
        if (routed === 'deny') throw await outside(path)
        return original.call(this, routed.request, routed.path, range, signal)
      })
      const restoreReadBytes = wrapMethod(service, 'readBytes', original => {
        // The third parameter is version-shaped — a plain `WorkspaceByteRange`
        // on older releases, a `WorkspaceByteReadOptions` carrying `baseFile`
        // later — so the wrapper preserves every option and only rewrites
        // `baseFile` when routing changes its spelling. With `baseFile`, `path`
        // resolves from the base file's directory upstream, so the base
        // carries the routing identity and the joined tail is checked for a
        // withheld-root landing.
        const call = original as unknown as (
          this: WorkspaceFiles, request: WorkspaceFileScope, path: string, options: unknown, signal: AbortSignal,
        ) => Promise<unknown>
        return (async function(this: WorkspaceFiles, request: WorkspaceFileScope, path: string, options: unknown, signal: AbortSignal): Promise<unknown> {
          const baseFile = (options as { readonly baseFile?: string } | undefined)?.baseFile
          if (baseFile !== undefined) {
            const routed = await routeRead(scope, request, baseFile, signal)
            if (routed === 'deny') throw await outside(baseFile)
            const escaped = await relatedTailWithheld(scope, request.workspaceRoot, routed, path, signal)
            if (escaped !== undefined) throw await outside(escaped)
            const routedOptions = baseFile === routed.path ? options : { ...options as Record<string, unknown>, baseFile: routed.path }
            return call.call(this, routed.request, path, routedOptions, signal)
          }
          const routed = await routeRead(scope, request, path, signal)
          if (routed === 'deny') throw await outside(path)
          return call.call(this, routed.request, routed.path, options, signal)
        }) as unknown as typeof original
      })
      // `readAll`/`readRelated` only exist on pre-0.2 releases; probe the
      // instance instead of the version — a release that dropped them simply
      // has nothing to wrap.
      const legacy = service as WorkspaceFiles & Partial<LegacyReads>
      const restoreReadAll = typeof legacy.readAll === 'function'
        ? wrapMethod(legacy as WorkspaceFiles & LegacyReads, 'readAll', original => (async function(this: WorkspaceFiles, request: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<unknown> {
            const routed = await routeRead(scope, request, path, signal)
            if (routed === 'deny') throw await outside(path)
            return original.call(this, routed.request, routed.path, signal)
          }) as unknown as typeof original)
        : undefined
      const restoreReadRelated = typeof legacy.readRelated === 'function'
        ? wrapMethod(legacy as WorkspaceFiles & LegacyReads, 'readRelated', original => (async function(this: WorkspaceFiles, request: WorkspaceFileScope, path: string, relativePath: string, signal: AbortSignal): Promise<unknown> {
            const routed = await routeRead(scope, request, path, signal)
            if (routed === 'deny') throw await outside(path)
            const escaped = await relatedTailWithheld(scope, request.workspaceRoot, routed, relativePath, signal)
            if (escaped !== undefined) throw await outside(escaped)
            return original.call(this, routed.request, routed.path, relativePath, signal)
          }) as unknown as typeof original)
        : undefined
      const restoreWatch = adaptPathWatch(service, originalChanges => async function*(this: WorkspaceFiles, request, path, signal) {
        const check = async () => {
          await withRegistryRead(scope, request.workspaceRoot, 'files', async () => {
            // The watch may target another granted root; check the directory
            // the path actually selects, not the session root.
            const current = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
            if (current !== undefined && underWithheldRoot(scope, current.primaryRoot, current.absolutePath)) throw await outside(path)
            const routed = await routeRead(scope, request, path, signal)
            if (routed === 'deny') throw await outside(path)
          })
        }
        if (scope.get('multiRootRegistry')?.shared) await check()

        if (scope.multiRootScope.snapshot({ workspaceRoot: request.workspaceRoot, mode: 'read-only' }).additionalRoots.length === 0 && registeredRoots(scope, request.workspaceRoot).length === 0) {
          for await (const frame of originalChanges.call(this, request, path, signal)) {
            if (scope.get('multiRootRegistry')?.shared) await check()
            yield frame
          }
          return
        }
        const route = await withRegistryRead(scope, request.workspaceRoot, 'files', async () => {
          const resolved = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
          if (resolved !== undefined && underWithheldRoot(scope, resolved.primaryRoot, resolved.absolutePath)) throw await outside(path)
          return resolved
        })
        if (route === undefined || route.workspaceRoot === route.primaryRoot) {
          // Directory targets are confined by the host's own check either
          // way; file watches are uncontained upstream, so a stale row
          // under a withheld root has to be refused here.
          if (underWithheldRoot(scope, request.workspaceRoot, path)) throw await outside(path)
          for await (const frame of originalChanges.call(this, request, path, signal)) {
            if (scope.get('multiRootRegistry')?.shared) await check()
            yield frame
          }
          return
        }
        const lifetime = new AbortController()
        const unsubscribe = scope.multiRootScope.subscribe(() => {
          if (!scope.multiRootScope.snapshot({ workspaceRoot: route.primaryRoot, mode: 'read-only' }).additionalRoots.includes(route.workspaceRoot)) lifetime.abort(new Error('the additional root was revoked'))
        })
        try {
          for await (const frame of originalChanges.call(this, { ...request, workspaceRoot: route.workspaceRoot }, route.absolutePath, AbortSignal.any([signal, lifetime.signal, rowLifetime.signal]))) {
            await withRegistryRead(scope, route.primaryRoot, 'files', async () => {
              if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) throw await outside(path)
            })
            yield frame
          }
        } finally { unsubscribe() }
      })
      const admissionRestores: Array<() => void> = []
      {
        const methods = service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        // 'search' arrived at 0.2.2-rc.2. It is admitted like every other
        // read so a shared-authority Host orders it at the owner. It is not
        // routed (the upstream search is rooted at the Session's cwd and the
        // plugin offers no additional-root search UI), but its session root
        // is bounded: a root inside a withheld registration is refused before
        // ripgrep starts (see the takeover rules in client/styles.ts for the
        // hidden native bar). `list` and `changes` bound the directory their
        // path selects in their own wrappers instead.
        const rootGuarded = new Set(['search'])
        for (const key of ['list', 'stat', 'read', 'readBytes', 'readAll', 'readRelated', 'search']) {
          if (typeof methods[key] !== 'function') continue
          admissionRestores.push(wrapMethod(methods, key, original => async function(this: unknown, ...args: unknown[]) {
            const request = args[0] as WorkspaceFileScope
            return withRegistryRead(scope, request.workspaceRoot, 'files', async () => {
              // `search` has no path to select a target: its root IS the
              // tree. Refuse before upstream launches ripgrep, inside the
              // same admission as the operation itself.
              if (rootGuarded.has(key) && rootWithheld(scope, request.workspaceRoot)) {
                throw await outside(request.workspaceRoot)
              }
              return original.apply(this, args)
            })
          }))
        }
      }
      return () => {
        for (const restore of admissionRestores.reverse()) restore()
        rowLifetime.abort(new Error('multi-root workspace-files routing unloaded'))
        restoreList()
        restoreStat()
        restoreRead()
        restoreReadBytes()
        restoreReadAll?.()
        restoreReadRelated?.()
        restoreWatch()
      }
    }, 'multi-root:workspace-files routing')
  })
}

/** The settled outcome of routing one read-style call: the call arguments, or a refusal. */
type RoutedRead = { readonly request: WorkspaceFileScope; readonly path: string } | 'deny'

/** The read surface pre-0.2 releases carried and the current one dropped. */
type LegacyReads = {
  readAll: (request: WorkspaceFileScope, path: string, signal: AbortSignal) => Promise<unknown>
  readRelated: (request: WorkspaceFileScope, path: string, relativePath: string, signal: AbortSignal) => Promise<unknown>
}

/**
 * Route one read-style `workspaceFiles` call (`stat`/`read`/`readBytes`,
 * plus the legacy `readAll`/`readRelated` pair where a release has them).
 *
 * Upstream deliberately gives reads no workspace confinement, so the
 * multi-root boundary lives here: a path canonically inside a *live*
 * additional root is answered under that root's scope; a path lexically
 * inside a *registered but withheld* root is denied, because re-resolving it
 * would follow whatever replaced the registered directory — the grant must
 * never travel to a directory nobody registered. Anything else (primary
 * root, genuinely unrelated paths) keeps upstream's default read access.
 */
async function routeRead(scope: Context, request: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<RoutedRead> {
  const registry = scope.get('multiRootRegistry')
  if (registry?.shared && scope.multiRootScope.resolve({ workspaceRoot: request.workspaceRoot, mode: 'read-only' }).authority === 'unavailable') {
    const route = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
    return route !== undefined && route.workspaceRoot === route.primaryRoot ? { request, path: route.absolutePath } : 'deny'
  }
  if (scope.multiRootScope.scopeOf(request.workspaceRoot).length === 0 && registeredRoots(scope, request.workspaceRoot).length === 0) {
    return { request, path }
  }
  const route = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
  if (route !== undefined && route.workspaceRoot !== route.primaryRoot) {
    if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) return 'deny'
    return { request: { ...request, workspaceRoot: route.workspaceRoot }, path: route.absolutePath }
  }
  return underWithheldRoot(scope, request.workspaceRoot, path) ? 'deny' : { request, path }
}

/**
 * Every registration of one primary root, in any state — the scope only
 * publishes the effective grant, so the withheld set has to come from the
 * registry. Absent the registry service (degraded compositions, bare test
 * contexts) there is no withheld set to enforce.
 */
function registeredRoots(scope: Context, primaryRoot: string): ReturnType<MultiRootRegistry['list']> {
  const registry = scope.get('multiRootRegistry') as MultiRootRegistry | undefined
  return registry?.list(primaryRoot) ?? []
}

/**
 * Whether `path` lexically sits under a registered root that is not granted
 * right now. The comparison is lexical on purpose: the canonical resolution
 * of a withheld root escapes by definition (that is what `redirected` means),
 * so only the recorded spelling recognizes the stale row. `scopeOf` is the
 * grant authority — it re-validates `canonicalPath` on every call, so a
 * redirected root drops out even before the next registry `refresh()` run.
 */
function underWithheldRoot(scope: Context, primaryRoot: string, path: string): boolean {
  const statuses = registeredRoots(scope, primaryRoot)
  if (statuses.length === 0) return false
  const lexical = resolveLexically(primaryRoot, path)
  const candidates = statuses.filter(status => isCanonicallyUnder(lexical, status.path))
  if (candidates.length === 0) return false
  const granted = new Set(scope.multiRootScope.scopeOf(primaryRoot))
  return candidates.some(status => !granted.has(status.path))
}

/**
 * Whether the session-root operation starts inside a registered but withheld
 * root.
 *
 * `search` has no path argument that selects another directory: its root is
 * the tree. The comparison therefore uses the canonical root — the directory
 * the backend actually walks — because a primary spelling that was replaced
 * by a symlink into a withheld root still passes a lexical test on itself.
 * `list` and `changes` apply the same comparison to the directory their
 * requested path selects, so another granted root stays usable. A withheld
 * root's current target is deliberately not followed: re-resolving a
 * registration does not re-authorize it, and an attacker-replaced directory
 * must not turn the primary's own tree into a refusal.
 * @param scope - the context carrying the scope and the registry.
 * @param primaryRoot - the workspace root the operation starts from.
 * @returns whether the operation's canonical root is inside a withheld registration.
 */
function rootWithheld(scope: Context, primaryRoot: string): boolean {
  const statuses = registeredRoots(scope, primaryRoot)
  if (statuses.length === 0) return false
  // A healthy grant set has nothing to resolve for: skip the canonical
  // lookup on every directory listing and search in the common case.
  const granted = new Set(scope.multiRootScope.scopeOf(primaryRoot))
  if (statuses.every(status => granted.has(status.path))) return false
  return underWithheldRoot(scope, primaryRoot, canonicalRoot(primaryRoot))
}

/**
 * Resolve `tail` from the canonical base file's directory and report the joined path
 * when it lands under a withheld root. `readRelated`'s tail and `readBytes`'s
 * `baseFile`-relative target both read a file located relative to another
 * file, so the granted base must not reach back into a dead grant.
 */
async function relatedTailWithheld(scope: Context, primaryRoot: string, base: Exclude<RoutedRead, 'deny'>, tail: string, signal: AbortSignal): Promise<string | undefined> {
  const unknown = scope.get('multiRootRegistry')?.shared
    && scope.multiRootScope.resolve({ workspaceRoot: primaryRoot, mode: 'read-only' }).authority === 'unavailable'
  if (registeredRoots(scope, primaryRoot).length === 0 && !unknown) return undefined
  // Upstream locates the canonical base before joining the normalized tail;
  // an intermediate directory alias must not change the path being checked.
  const targetBase = await scope.fs.resolve(base.path, { cwd: base.request.workspaceRoot, signal })
  const target = resolveRelatedWorkspacePath(scope.fs.processPath(targetBase), tail)
  if (unknown && await routeRead(scope, { ...base.request, workspaceRoot: primaryRoot }, target, signal) === 'deny') return target
  return underWithheldRoot(scope, primaryRoot, target) ? target : undefined
}

async function outside(path: string): Promise<RemoteError<'workspace-file/outside-workspace'>> {
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol')
  return new RemoteError('workspace-file/outside-workspace', `"${path}" is no longer in this workspace`, { path })
}
