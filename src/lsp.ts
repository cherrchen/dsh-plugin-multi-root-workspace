/** Add root routing at the public LSP query seam; upstream owns servers and disposal. */
import type { Context } from '@deepseek-ai/cordis'
import type { LspService } from '@deepseek-ai/dsh-lsp'
import type { Session } from '@deepseek-ai/dsh-session'
import { AsyncLocalStorage } from 'node:async_hooks'
import { aroundTool } from './compat/tool-context.ts'
import type {} from './compat.ts'
import { routeWorkspacePath } from './workspace-routing.ts'
import { wrapMethod } from './method-wrapper.ts'

export const inject = ['multiRootCompat', 'multiRootScope']

export function apply(ctx: Context): void {
  // The new native LSP tool supplies effective cwd, with no session field on
  // query. Carry identity across dispatch, never infer it by searching cwd maps.
  const callers = new AsyncLocalStorage<Session>()
  aroundTool(ctx, (exec, next) => exec.agent === undefined
    ? next() : callers.run(exec.agent.session, next))
  ctx.inject(['lsp', 'fs'], scope => {
    const service = scope.get('lsp') as LspService
    scope.effect(() => wrapMethod(service, 'query', original => async function(this: LspService, request, signal) {
        const session = callers.getStore()
        const primary = session?.header.cwd ?? request.workspaceRoot
        if (scope.multiRootScope.scopeOf(primary).length === 0 && session === undefined) {
          return original.call(this, request, signal)
        }
        const route = await routeWorkspacePath(scope, primary, request.filePath, signal, request.workspaceRoot)
        // An effective cwd outside the authorized set must not become a new
        // LSP project. Upstream validates containment against the origin here.
        if (route === undefined) {
          const target = await scope.fs.resolve(request.filePath, { cwd: request.workspaceRoot, ...(signal === undefined ? {} : { signal }) })
          return original.call(this, { ...request, workspaceRoot: primary, filePath: scope.fs.processPath(target) }, signal)
        }
        if (session === undefined && route.workspaceRoot === route.primaryRoot) return original.call(this, request, signal)
        return original.call(this, { ...request, workspaceRoot: route.workspaceRoot, filePath: route.absolutePath }, signal)
      }), 'multi-root:lsp routing')
  })
}
