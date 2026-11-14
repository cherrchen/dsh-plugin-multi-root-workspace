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
 * The upstream options container is `flex: none`, so this entry cannot shrink
 * the way its neighbors do; it measures the room the row leaves for it and
 * clamps itself into it instead (see `hero-entry-room.ts`). Below
 * `HERO_ENTRY_LABEL_MIN_PX` the label gives way to the icon alone.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/HeroWorkspaceEntry
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { IconWorkspaceTree } from '../compat/client-icons.ts'
import { heroEntryForm, heroRowOf, heroRowWidthTargets, measureHeroEntryRoom } from './hero-entry-room.ts'
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
 * The measured room as the stylesheet's width cap. React's property type has
 * no index signature for custom properties, hence the cast of this literal.
 */
function roomStyle(room: number | null): CSSProperties | undefined {
  if (room === null) return undefined
  return { '--mrfw-hero-entry-room': `${room}px` } as CSSProperties
}

/**
 * The hero-row trigger plus the shared Workspace Folders dialog.
 * @param props - the panel face, the composed session reader, and the translator.
 * @returns the trigger and, while open, the dialog.
 */
export function HeroWorkspaceEntry(props: HeroWorkspaceEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [room, setRoom] = useState<number | null>(null)
  const seat = useRef<HTMLSpanElement | null>(null)

  // Probe after every commit: a workspace title or locale change moves the
  // room without resizing the row, so width observation alone would go stale.
  // `measureHeroEntryRoom` pins and restores the seat synchronously, before
  // the browser paints, so the probe never shows the floor form.
  useLayoutEffect(() => {
    const element = seat.current
    if (element === null) return
    setRoom(measureHeroEntryRoom(element))
  })

  // Row-width observation for the changes the probe cannot be told about.
  useLayoutEffect(() => {
    const element = seat.current
    if (element === null) return undefined
    const row = heroRowOf(element)
    if (row === null) return undefined
    const observer = new ResizeObserver(() => { setRoom(measureHeroEntryRoom(element)) })
    for (const target of heroRowWidthTargets(row, element)) observer.observe(target)
    return () => { observer.disconnect() }
  }, [])

  const form = heroEntryForm(room)
  return (
    <>
      <span className="mrfw-heroEntrySeat" ref={seat} data-size={form} style={roomStyle(room)}>
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
      </span>
      {open ? <WorkspaceFoldersDialog {...props} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}
