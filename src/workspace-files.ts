/** Extend the existing workspaceFiles namespace without replacing its codecs or read caps. */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import type { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './compat.ts'
import { adaptPathWatch } from './compat/workspace-files.ts'
import { routeWorkspacePath } from './workspace-routing.ts'
import { wrapMethod } from './method-wrapper.ts'

export const inject = ['multiRootCompat', 'multiRootScope']

export function apply(ctx: Context): void {
  ctx.inject(['workspaceFiles', 'fs'], scope => {
    const service = scope.get('workspaceFiles') as WorkspaceFiles
    scope.effect(() => {
      const rowLifetime = new AbortController()
      const restoreList = wrapMethod(service, 'list', original => async function(this: WorkspaceFiles, request, path, signal) {
        if (scope.multiRootScope.scopeOf(request.workspaceRoot).length === 0) return original.call(this, request, path, signal)
        const route = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
        if (route === undefined || route.workspaceRoot === route.primaryRoot) return original.call(this, request, path, signal)
        const result = await original.call(this, { ...request, workspaceRoot: route.workspaceRoot }, route.absolutePath, signal)
        if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) throw await outside(path)
        return result
      })
      const restoreWatch = adaptPathWatch(service, originalChanges => async function*(this: WorkspaceFiles, request, path, signal) {
        if (scope.multiRootScope.scopeOf(request.workspaceRoot).length === 0) {
          yield* originalChanges.call(this, request, path, signal)
          return
        }
        const route = await routeWorkspacePath(scope, request.workspaceRoot, path, signal)
        if (route === undefined || route.workspaceRoot === route.primaryRoot) {
          yield* originalChanges.call(this, request, path, signal)
          return
        }
        const lifetime = new AbortController()
        const unsubscribe = scope.multiRootScope.subscribe(() => {
          if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) lifetime.abort(new Error('the additional root was revoked'))
        })
        try {
          for await (const frame of originalChanges.call(this, { ...request, workspaceRoot: route.workspaceRoot }, route.absolutePath, AbortSignal.any([signal, lifetime.signal, rowLifetime.signal]))) {
            if (!scope.multiRootScope.scopeOf(route.primaryRoot).includes(route.workspaceRoot)) throw await outside(path)
            yield frame
          }
        } finally { unsubscribe() }
      })
      return () => {
        rowLifetime.abort(new Error('multi-root workspace-files routing unloaded'))
        restoreList()
        restoreWatch()
      }
    }, 'multi-root:workspace-files routing')
  })
}

async function outside(path: string): Promise<RemoteError<'workspace-file/outside-workspace'>> {
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol')
  return new RemoteError('workspace-file/outside-workspace', `"${path}" is no longer in this workspace`, { path })
}
