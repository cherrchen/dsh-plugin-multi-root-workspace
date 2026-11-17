/**
 * The additional-root search call the pane makes, and its answer.
 *
 * The Host's own wire search carries no root, so the plugin's channel endpoint
 * takes a registry root id instead; the answer names the canonical root the
 * Host actually searched. Everything here is plugin-owned and independent of
 * the upstream `search-workspace.ts` copy: the previous pane state, the
 * preference book, and this call are what the results view needs.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/search-client
 */
import type { SearchMatch } from './search-tree.ts'

/** What one search asks the Host for. */
export interface WorkspaceSearchRequest {
  /** The query without surrounding whitespace; never empty. */
  readonly query: string
  /** The enabled exclusion rules' paths, in list order. */
  readonly excludedPaths: readonly string[]
  /** Whether hidden entries may match. */
  readonly includeHidden: boolean
  /** Whether entries the root's ignore files exclude are left out. */
  readonly respectGitignore: boolean
}

/** One settled search. */
export interface WorkspaceSearchAnswer {
  /** Canonical absolute path of the additional root the Host searched. */
  readonly root: string
  /** The matches, relative to `root`, in the Host's order. */
  readonly matches: readonly SearchMatch[]
  /** The Host returned only its first matches because more matched. */
  readonly truncated: boolean
  /** Part of the root was not searched. */
  readonly incomplete: boolean
}

/**
 * Run one additional-root search.
 *
 * Aborting `signal` cancels the request (and the Host's search process); a
 * failure rejects with the Host's localized failure envelope.
 * @param rootId - the registry id of the root to search.
 * @param request - the query and the preferences it follows.
 * @param signal - the search's lifetime.
 * @returns the matches, named relative to the canonical searched root.
 */
export type FilesSearchRun = (
  rootId: string,
  request: WorkspaceSearchRequest,
  signal: AbortSignal,
) => Promise<WorkspaceSearchAnswer>
