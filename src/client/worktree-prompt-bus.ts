/**
 * The panel-to-overlay signal for opening the worktree suggestion Dialog.
 *
 * The Workspace Folders panel and the shell-overlay prompt are separate slot
 * registrations with no shared React tree. The overlay stays the only owner of
 * the Dialog's long poll and lifecycle. The panel names its own session, and
 * the listener acknowledges the event only if that session can open the Dialog.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/worktree-prompt-bus
 */

/** The one event name both halves spell. */
const WORKTREE_PROMPT_EVENT = 'dsh-multi-root-workspace:open-worktree-prompt'

/**
 * Ask the shell overlay to open its worktree suggestion Dialog.
 * @param sessionId - the session whose folders the manager is showing.
 * @returns whether the overlay accepted the request.
 */
export function requestWorktreePrompt(sessionId: string): boolean {
  if (typeof window === 'undefined') return false
  const event = new CustomEvent<string>(WORKTREE_PROMPT_EVENT, { detail: sessionId, cancelable: true })
  return !window.dispatchEvent(event)
}

/**
 * Listen for a panel request to open the suggestion Dialog.
 * @param listener - the overlay's open action, returning true on acceptance.
 * @returns the disposer that removes the listener.
 */
export function onWorktreePromptRequest(listener: (sessionId: string) => boolean): () => void {
  if (typeof window === 'undefined') return () => {}
  const receive = (event: Event): void => {
    const sessionId: unknown = (event as CustomEvent<unknown>).detail
    if (!event.defaultPrevented && event.cancelable && typeof sessionId === 'string' && sessionId !== '' && listener(sessionId)) {
      // Cancellation acknowledges the handoff to the manager synchronously.
      event.preventDefault()
    }
  }
  window.addEventListener(WORKTREE_PROMPT_EVENT, receive)
  return () => { window.removeEventListener(WORKTREE_PROMPT_EVENT, receive) }
}
