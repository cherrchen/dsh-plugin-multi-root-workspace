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
  ctx: Context, primaryRoot: string, path: string, signal?: AbortSignal,
): Promise<WorkspaceRoute | undefined> {
  signal?.throwIfAborted()
  const primary = canonicalPath(primaryRoot)
  const roots = [primary, ...ctx.multiRootScope.scopeOf(primary)]
  const target = await ctx.fs.resolve(path, { cwd: primary, ...(signal === undefined ? {} : { signal }) })
  for (const root of roots) {
    const rootTarget = await ctx.fs.resolve(root, signal === undefined ? {} : { signal })
    if (!ctx.fs.contains(rootTarget, target)) continue
    // The filesystem awaits may span a scope change or a root replacement.
    if (root !== primary && !ctx.multiRootScope.scopeOf(primary).includes(root)) return undefined
    signal?.throwIfAborted()
    return { primaryRoot: primary, workspaceRoot: root, target, absolutePath: ctx.fs.processPath(target) }
  }
  return undefined
}
