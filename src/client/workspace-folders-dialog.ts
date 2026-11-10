/**
 * The seam that lets a global surface open the Workspace Folders dialog the
 * sidebar footer owns.
 *
 * The dialog itself stays where it has always been — `WorkspaceFoldersAction`
 * owns its open/close state — because moving it into a global host would
 * rewrite the Files-tab switcher's local lifetime as well (see ADR-0038).
 * What the menu needs is narrower than that: a stable "the footer is mounted,
 * here is how to open it" fact, plus a way to pin the session the dialog
 * should manage.
 *
 * The controller is created once per `apply()` — not at module scope — so a
 * hot-reloaded client never inherits a previous client's owner or
 * availability.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/workspace-folders-dialog
 */

import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Opens the footer-owned dialog for one session, or for the current one. */
export type WorkspaceFoldersDialogOpen = (sessionId?: string) => void

/**
 * Client-scoped capability over the footer's dialog instance.
 *
 * `available` is an observable snapshot rather than a boolean so a menu
 * resolution can ask the live question ("is the host dialog mounted right
 * now?") without subscribing to the whole client graph.
 */
export interface WorkspaceFoldersDialogController {
  /**
   * Register the footer action as the dialog owner.
   * @param open - opens the dialog, optionally pinned to one session.
   * @returns a deregistration function; a stale deregistration from an owner
   *   that has already been replaced is a no-op.
   */
  registerOwner(open: WorkspaceFoldersDialogOpen): () => void

  /**
   * Ask the owner to open its dialog.
   * @param sessionId - the session the dialog must manage.
   * @returns whether an owner accepted the request. `false` means the caller
   *   must not assume a dialog is on screen; an owner that throws is treated
   *   the same way and stays registered for a later attempt.
   */
  open(sessionId: string): boolean

  /** Whether a footer owner is currently mounted. */
  readonly available: ObservableSnapshot<boolean>
}

/**
 * Create the controller for one client lifetime.
 * @returns the controller, initially unavailable until the footer registers.
 */
export function createWorkspaceFoldersDialogController(): WorkspaceFoldersDialogController {
  const available = createSnapshotStore<boolean>(false)
  let owner: WorkspaceFoldersDialogOpen | undefined
  return {
    available,
    registerOwner(open) {
      // Last-wins: a second footer (for example a stale StrictMode replay
      // before its cleanup) replaces the first, and the first's cleanup must
      // not clear the second's availability.
      owner = open
      available.set(true)
      return () => {
        if (owner !== open) return
        owner = undefined
        available.set(false)
      }
    },
    open(sessionId) {
      if (owner === undefined) return false
      try {
        owner(sessionId)
        return true
      } catch {
        // A React state setter rejecting is not actionable here; report "not
        // opened" to the caller and leave the owner registered so the next
        // click can retry instead of silently disabling the entry forever.
        return false
      }
    },
  }
}
