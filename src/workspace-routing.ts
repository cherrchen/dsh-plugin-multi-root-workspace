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

/** Resolve relative paths against the primary cwd; never search other roots by basename. */
export async function routeWorkspacePath(
  ctx: Context, primaryRoot: string, path: string, signal?: AbortSignal, cwd = primaryRoot,
): Promise<WorkspaceRoute | undefined> {
  signal?.throwIfAborted()
  // `primary` is geometry (contains checks); the Registry/scope key is the
  // upstream spelling `primaryRoot` itself — never re-resolved (MRW-01).
  const primary = canonicalPath(primaryRoot)
  const roots = [primary, ...ctx.multiRootScope.scopeOf(primaryRoot)]
  const target = await ctx.fs.resolve(path, { cwd, ...(signal === undefined ? {} : { signal }) })
  for (const root of roots) {
    const rootTarget = await ctx.fs.resolve(root, signal === undefined ? {} : { signal })
    if (!ctx.fs.contains(rootTarget, target)) continue
    // The filesystem awaits may span a scope change or a root replacement.
    if (root !== primary && !ctx.multiRootScope.scopeOf(primaryRoot).includes(root)) return undefined
    signal?.throwIfAborted()
    // The returned `primaryRoot` is the upstream identity (callers feed it
    // back into scope/registry lookups); `workspaceRoot` is what the call is
    // routed under — the spelling it came in as for the primary itself.
    return { primaryRoot, workspaceRoot: root === primary ? primaryRoot : root, target, absolutePath: ctx.fs.processPath(target) }
  }
  return undefined
}
