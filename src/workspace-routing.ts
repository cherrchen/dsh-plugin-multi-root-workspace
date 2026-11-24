/** Shared, canonical root selection for read-only workspace consumers. */
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from './scope.ts'

export interface WorkspaceRoute {
  primaryRoot: string
  workspaceRoot: string
  target: FsTarget
  absolutePath: string
}

/**
 * One resolved selection: the canonical target of the requested path and, when
 * a live grant accepts it, the route that grant authorizes.
 *
 * The target is preserved even when no root accepts it. Directory consumers
 * still need it: upstream confines a listing or a directory watch to the wire
 * root's canonical target, so an alias inside that root can land in a
 * registered-but-withheld root while the requested spelling shows nothing.
 */
export interface WorkspacePathResolution {
  /** The grant the target routes to; absent when no root contains it. */
  readonly route?: WorkspaceRoute
  /** The resolved target of the requested path. */
  readonly target: FsTarget
  /** The canonical spelling of that target. */
  readonly absolutePath: string
}

/** Resolve relative paths against the primary cwd; never search other roots by basename. */
export async function resolveWorkspacePath(
  ctx: Context, primaryRoot: string, path: string, signal?: AbortSignal, cwd = primaryRoot,
): Promise<WorkspacePathResolution> {
  signal?.throwIfAborted()
  // `primary` is geometry (contains checks); the Registry/scope key is the
  // upstream spelling `primaryRoot` itself — never re-resolved (MRW-01).
  const primary = canonicalPath(primaryRoot)
  const roots = [primary, ...ctx.multiRootScope.scopeOf(primaryRoot)]
  const target = await ctx.fs.resolve(path, { cwd, ...(signal === undefined ? {} : { signal }) })
  const absolutePath = ctx.fs.processPath(target)
  for (const root of roots) {
    const rootTarget = await ctx.fs.resolve(root, signal === undefined ? {} : { signal })
    if (!ctx.fs.contains(rootTarget, target)) continue
    // The filesystem awaits may span a scope change or a root replacement.
    if (root !== primary && !ctx.multiRootScope.scopeOf(primaryRoot).includes(root)) return { target, absolutePath }
    signal?.throwIfAborted()
    // The returned `primaryRoot` is the upstream identity (callers feed it
    // back into scope/registry lookups); `workspaceRoot` is what the call is
    // routed under — the spelling it came in as for the primary itself.
    return {
      route: { primaryRoot, workspaceRoot: root === primary ? primaryRoot : root, target, absolutePath },
      target,
      absolutePath,
    }
  }
  return { target, absolutePath }
}

/** Resolve relative paths against the primary cwd and report the live grant, if any. */
export async function routeWorkspacePath(
  ctx: Context, primaryRoot: string, path: string, signal?: AbortSignal, cwd = primaryRoot,
): Promise<WorkspaceRoute | undefined> {
  return (await resolveWorkspacePath(ctx, primaryRoot, path, signal, cwd)).route
}
