/**
 * The worktree feature's stable failure codes.
 *
 * Kept in its own module so the command/channel half can recognize a failure
 * without loading the discovery service (and so the code strings have exactly
 * one home).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/errors
 */

/** Stable feature error codes; the panel localizes by code. */
export class WorktreeError extends Error {
  /**
   * @param code - stable code (also the wire failure code).
   * @param message - English fallback text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}
