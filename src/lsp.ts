/** Add root routing at the public LSP query seam; upstream owns servers and disposal. */
import type { Context } from '@deepseek-ai/cordis'
import type { LspService } from '@deepseek-ai/dsh-lsp'
import type {} from './compat.ts'
import { routeWorkspacePath } from './workspace-routing.ts'
import { wrapMethod } from './method-wrapper.ts'

export const inject = ['multiRootCompat', 'multiRootScope']

export function apply(ctx: Context): void {
  ctx.inject(['lsp', 'fs'], scope => {
    const service = scope.get('lsp') as LspService
    scope.effect(() => wrapMethod(service, 'query', original => async function(this: LspService, request, signal) {
        if (scope.multiRootScope.scopeOf(request.workspaceRoot).length === 0) {
          return original.call(this, request, signal)
        }
        const route = await routeWorkspacePath(scope, request.workspaceRoot, request.filePath, signal)
        if (route === undefined || route.workspaceRoot === route.primaryRoot) return original.call(this, request, signal)
        return original.call(this, { ...request, workspaceRoot: route.workspaceRoot, filePath: route.absolutePath }, signal)
      }), 'multi-root:lsp routing')
  })
}
