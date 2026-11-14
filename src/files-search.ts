/**
 * Additional-root workspace search: the one file operation the browser cannot
 * ask the upstream Remote for.
 *
 * `workspaceFiles.search` derives its root from the Session header on the
 * Host; its wire request carries no root field (upstream
 * `api/workspace-files` types), so no browser call can name an additional
 * root. This module is the endpoint behind the plugin's own channel: it
 * resolves the root from the Registry, authorizes it against the published
 * scope, and then calls the same upstream implementation in-process with a
 * scope object naming that root — the identical search, same limits, same
 * `workspace-file/*` failures.
 *
 * Authorization is repeated where it is enforced: `src/workspace-files.ts`
 * refuses and admits routed search calls, so this module's checks are the
 * early, more specific refusal that lets the panel show the right code.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/files-search
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelCall, SearchView } from './contract.ts'
import { workspaceSearchOf, type RoutedSearchScope, type WorkspaceFileSearchRequest } from './compat/workspace-files.ts'
import { RootValidationError, canonicalRoot } from './roots.ts'
import type {} from './registry.ts'
import type {} from './scope.ts'

/**
 * Run one additional-root search.
 *
 * The root is resolved from a registry snapshot refreshed for this request, so
 * a removed root, a replaced directory, a non-granted registration, or an
 * authority that no longer grants anything is refused here rather than searched
 * through a stale client copy.
 * @param ctx - host context carrying the registry, scope, and workspace files.
 * @param primaryRoot - the Session-derived primary root (ADR-0008).
 * @param call - the validated search request.
 * @param signal - caller cancellation, forwarded to the search process.
 * @returns the matches, relative to the canonical searched root.
 * @throws {RootValidationError} with the stable code the panel localizes.
 */
export async function searchAdditionalRoot(
  ctx: Context,
  primaryRoot: string,
  call: PanelCall,
  signal?: AbortSignal,
): Promise<SearchView> {
  const rootId = call.rootId ?? ''
  const query = (call.query ?? '').trim()
  if (rootId === '') throw new RootValidationError('invalid-ref', 'rootId is required')
  if (query === '') throw new RootValidationError('invalid-ref', 'query is required')
  const service = ctx.get('workspaceFiles')
  if (service === undefined) throw new RootValidationError('search-unavailable', 'this composition has no workspace files service')
  const search = workspaceSearchOf(service)
  if (search === undefined) {
    throw new RootValidationError('search-unavailable', 'this host release has no workspace file search')
  }
  const statuses = await ctx.multiRootRegistry.refresh(primaryRoot)
  const status = statuses.find(row => row.id === rootId)
  if (status === undefined) throw new RootValidationError('not-found', 'no additional root has that id')
  if (status.state !== 'available') throw new RootValidationError('root-unavailable', `"${status.path}" is not available`)
  const root = status.path
  // The grant itself is checked inside the wrapper's admission frame: in a
  // shared-authority Host `multiRootScope.scopeOf()` answers from the CURRENT
  // operation and is empty outside one, so a pre-admission check here would
  // refuse every search. The refreshed registry status is the pre-check.
  const request: WorkspaceFileSearchRequest = {
    query,
    excludedPaths: [...(call.excludedPaths ?? [])],
    includeHidden: call.includeHidden === true,
    respectGitignore: call.respectGitignore !== false,
  }
  const scope: RoutedSearchScope = { sessionId: call.sessionId as SessionId, workspaceRoot: root, primaryRoot }
  const answer = await search.call(service, scope, request, signal ?? new AbortController().signal)
  return {
    root: canonicalRoot(root),
    matches: answer.matches.map(match => ({ path: match.path, type: match.type })),
    truncated: answer.truncated,
    incomplete: answer.incomplete,
  }
}
