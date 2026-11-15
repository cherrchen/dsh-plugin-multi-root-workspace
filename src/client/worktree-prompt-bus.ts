/**
 * The panel-to-overlay signal for opening the worktree suggestion Dialog.
 *
 * The Workspace Folders panel and the shell-overlay prompt are separate slot
 * registrations with no shared React tree. The overlay stays the only owner of
 * the Dialog's long poll and lifecycle; the panel only asks it to open for the
 * current session. A namespaced DOM event keeps them independent without a
 * module-level state object (there is no state to own: the listener decides
 * from its live session and settings snapshots).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/worktree-prompt-bus
 */

/** The one event name both halves spell. */
const WORKTREE_PROMPT_EVENT = 'dsh-multi-root-workspace:open-worktree-prompt'

/**
 * Ask the shell overlay to open its worktree suggestion Dialog.
 * @returns nothing; a composition without the overlay simply ignores the event.
 */
export function requestWorktreePrompt(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WORKTREE_PROMPT_EVENT))
}

/**
 * Listen for a panel request to open the suggestion Dialog.
 * @param listener - the overlay's open action.
 * @returns the disposer that removes the listener.
 */
export function onWorktreePromptRequest(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(WORKTREE_PROMPT_EVENT, listener)
  return () => { window.removeEventListener(WORKTREE_PROMPT_EVENT, listener) }
}
