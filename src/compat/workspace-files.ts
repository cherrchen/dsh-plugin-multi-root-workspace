/** Old releases watch a session; newer ones watch a path. Probe arity, never version. */
import type { WorkspaceFileScope, WorkspaceFileWatchFrame, WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { posix, win32 } from 'node:path'
import { wrapMethod } from '../method-wrapper.ts'

type PathWatch = (this: WorkspaceFiles, scope: WorkspaceFileScope, path: string, signal: AbortSignal) => AsyncIterable<WorkspaceFileWatchFrame>

export function adaptPathWatch(service: WorkspaceFiles, wrap: (original: PathWatch) => PathWatch): () => void {
  return wrapMethod(service, 'changes', original => original.length < 3 ? original : wrap(original as unknown as PathWatch) as unknown as typeof original)
}

/** Match both legacy `readRelated` and modern `readBytes({ baseFile })` tail resolution. */
export function resolveRelatedWorkspacePath(absoluteBase: string, tail: string): string {
  const paths = absoluteBase.startsWith('/') ? posix : win32
  return paths.resolve(paths.dirname(absoluteBase), tail.replace(/\\/g, '/'))
}

/**
 * Upstream's search request, declared here rather than imported: the type
 * arrives with the method in `0.2.2-rc.2`, and a named import would fail the
 * type check of every earlier supported pin even though this module only ever
 * reaches the call behind a structural probe.
 */
export interface WorkspaceFileSearchRequest {
  readonly query: string
  readonly excludedPaths: readonly string[]
  readonly includeHidden: boolean
  readonly respectGitignore: boolean
}

/** One entry a workspace search found, relative to the searched root. */
export interface WorkspaceFileSearchMatch {
  readonly path: string
  readonly type: 'file' | 'directory' | 'other'
}

/** The outcome of one workspace search (same reason for the local declaration). */
export interface WorkspaceFileSearchResult {
  readonly matches: readonly WorkspaceFileSearchMatch[]
  readonly truncated: boolean
  readonly incomplete: boolean
}

/**
 * The workspace search one Host exposes, or `undefined` on a release that
 * predates it (`0.2.2-rc.2`).
 *
 * Structural by design (ADR-0009): the method's presence, never a version
 * string. The Host calls it with a scope object it builds itself, which is how
 * the additional-root search reaches a root other than the Session cwd — the
 * wire call the browser can make always derives its root from the Session
 * header.
 */
export type WorkspaceSearch = (
  this: WorkspaceFiles,
  scope: WorkspaceFileScope,
  request: WorkspaceFileSearchRequest,
  signal: AbortSignal,
) => Promise<WorkspaceFileSearchResult>

/**
 * The scope shape a routed search hands the wrapped service.
 *
 * `primaryRoot` is host-internal only — the wire never carries it. The wrapper
 * in `src/workspace-files.ts` takes its Registry admission key from it, because
 * the operation itself names the additional root as `workspaceRoot`.
 */
export interface RoutedSearchScope extends WorkspaceFileScope {
  readonly primaryRoot: string
}

/**
 * Read the search method off a `workspaceFiles` face.
 * @param face - the `workspaceFiles` service or Remote face.
 * @returns the search method when this release has one.
 */
export function workspaceSearchOf(face: unknown): WorkspaceSearch | undefined {
  const search = (face as { readonly search?: unknown } | null | undefined)?.search
  return typeof search === 'function' ? search as WorkspaceSearch : undefined
}
