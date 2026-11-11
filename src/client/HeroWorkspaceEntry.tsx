/**
 * The New Session hero row's Workspace Folders entry.
 *
 * One compact trigger staged at the row's right edge through
 * `conversation.hero.options` (`0.2.1-alpha.3+`). It shares the adjacent
 * workspace and agent-preset selectors' geometry — 28px height, one 8px
 * inset, 13px/20px/500 — but it opens the dialog rather than a menu, so it
 * deliberately carries no chevron. The sidebar footer action keeps its own
 * trigger; both open the same `WorkspaceFoldersDialog` over the same channel.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/HeroWorkspaceEntry
 */

import { useState, type ReactNode } from 'react'
import { IconWorkspaceTree } from '../compat/client-icons.ts'
import type { PanelClient } from './panel-client.ts'
import type { WorktreeClient } from './worktree-client.ts'
import { WorkspaceFoldersDialog, type Translate } from './WorkspaceFoldersAction.tsx'

/** What the hero seat passes to its trigger. */
export interface HeroWorkspaceEntryProps {
  /** The channel client; absent when this composition has no host Connection. */
  readonly panel: PanelClient | undefined
  /** Opens the composed directory picker, when one is composed. */
  readonly pickDirectory: (() => Promise<string | null>) | undefined
  /**
   * The session id the cluster was composed for. A stable callback rather than
   * a value: the dialog's list effect keys on its identity, and a function
   * re-created per render would re-issue `list` on every upstream store write.
   */
  readonly sessionId: () => string | undefined
  /** Bound translator for this plugin's namespace. */
  readonly t: Translate
  /** The worktree channel client, when the composition mounts it. */
  readonly worktrees?: WorktreeClient | undefined
}

/**
 * The hero-row trigger plus the shared Workspace Folders dialog.
 * @param props - the panel face, the composed session reader, and the translator.
 * @returns the trigger and, while open, the dialog.
 */
export function HeroWorkspaceEntry(props: HeroWorkspaceEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="mrfw-heroEntry"
        title={props.t('action.title')}
        aria-label={props.t('action.label')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="mrfw-heroEntryLabel">{props.t('action.label')}</span>
        <span className="mrfw-heroEntryIcon" aria-hidden="true"><IconWorkspaceTree size={16} /></span>
      </button>
      {open ? <WorkspaceFoldersDialog {...props} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}
