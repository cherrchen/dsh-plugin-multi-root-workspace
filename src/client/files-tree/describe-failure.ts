/**
 * One localization for a failed additional-root search, shared by every entry
 * that can start one (the Files page and the document preview navigator).
 *
 * The pane's failure view carries the tree's own vocabulary for upstream
 * `workspace-file/*` codes. Codes that belong to this plugin's panel dictionary
 * (`root-unavailable`, `session-not-live`, …) are localized here instead; a code
 * this build does not know returns `undefined` so the caller hands the failure
 * back to the tree's vocabulary rather than printing a generic line. Keeping the
 * mapping in one place is what stops the two owners from drifting apart.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/files-tree/describe-failure
 */
import { errorKeyOf } from '../panel-client.ts'
import type { Key } from '../locales.ts'
import type { SearchFailureInfo } from './search-state.ts'

/** Localize a failed search's fallback line, or `undefined` for the tree's own codes. */
export type SearchFailureDescriber = (failure: SearchFailureInfo) => string | undefined

/**
 * Build the describer over one locale binding.
 * @param t - the plugin namespace's translate function.
 * @returns the describer the pane's failure view consumes.
 */
export function createSearchFailureDescriber(t: (key: Key) => string): SearchFailureDescriber {
  return failure => {
    const key = errorKeyOf(failure.code)
    return key === 'error.fallback' ? undefined : t(key)
  }
}
