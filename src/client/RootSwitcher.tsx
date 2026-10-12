/**
 * The Files-tab root switcher — the entry that took over the header position
 * the P1 gear launcher first claimed. It poses as the pane's path label: a
 * trigger that opens a menu of this session's roots (primary first, the
 * registered additional roots next, and the Workspace Folders manager last),
 * and while an additional root is selected it lends the pane's body area to
 * this plugin's own lazy tree.
 *
 * Two upstream DOM hooks make the takeover work, and both degrade silently:
 *
 * - The stylesheet rules: while `.mrfw-rootSwitcher` exists inside a
 *   `[data-files-root]` pane the upstream `data-files-path` is hidden and the
 *   switcher takes its flex position; while the switcher carries
 *   `data-root-kind="additional"` the native `data-files-body` and
 *   `data-files-reload` hide too (the reload refreshes the very tree that is
 *   no longer visible). Upstream changing that DOM shape simply stops the
 *   selectors from matching — the native header keeps working and the
 *   switcher is just another actions occupant.
 * - `closest('[data-files-root]')` from the switcher's own element locates
 *   the pane the self-drawn tree is portaled into, as a sibling of
 *   `data-files-body`. No match → no portal: the component keeps working as
 *   a menu and the native tree keeps its area.
 *
 * The selected root is component state on purpose: every tab render
 * occurrence gets its own, and reopening the pane resets to the primary
 * root. There is no cross-tab or persisted selection.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/RootSwitcher
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown, IconFolderClose, IconFolderOpen, IconSettings } from '../compat/client-icons.ts'
import type { RootsView, RootView } from '../contract.ts'
import { RootFileTree } from './RootFileTree.tsx'
import {
  basename,
  displayNameOf,
  entryOf,
  stateKey,
  WorkspaceFoldersDialog,
  type WorkspaceFoldersActionProps,
} from './WorkspaceFoldersAction.tsx'

/** What the registered Files-actions occupant needs beyond the slot owner. */
export interface RootSwitcherProps extends Omit<WorkspaceFoldersActionProps, 'compact' | 'wide'> {
  /** This pane's workspace root, carried by the slot owner's `absolutePath`. */
  readonly primaryPath: string
}

/** `sessionId` fallback for compositions that carry no session service. */
const NO_SESSION = (): undefined => undefined

/** The Files-header switcher: root menu, dialog entry, and the portal tree. */
export function RootSwitcher(props: RootSwitcherProps): ReactNode {
  const { panel, t, primaryPath } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [view, setView] = useState<RootsView | undefined>(undefined)
  const [selected, setSelected] = useState<RootView | 'primary'>('primary')
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)

  useEffect(() => () => {
    mounted.current = false
    requestEpoch.current += 1
  }, [])

  // Locate the pane once, after mount. Finding no `[data-files-root]`
  // ancestor is the supported degradation: nothing is portaled, and the
  // stylesheet rules that would hide the native body match nothing either.
  useEffect(() => {
    setPane(wrapperRef.current?.closest<HTMLElement>('[data-files-root]') ?? null)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (panel === undefined) { setView(undefined); return }
    const session = props.sessionId?.()
    if (session === undefined || session === '') { setView(undefined); return }
    const epoch = ++requestEpoch.current
    try {
      const next = await panel.call('list', { sessionId: session })
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== session) return
      setView(next)
    } catch {
      // A failed list degrades to "primary only": the menu keeps working and
      // the trigger still mirrors the pane path. The dialog reports channel
      // failures itself, so the switcher stays silent here on purpose.
      if (!mounted.current || epoch !== requestEpoch.current || props.sessionId?.() !== session) return
      setView(undefined)
    }
  }, [panel, props.sessionId])

  useEffect(() => { void refresh() }, [refresh])

  // A session change makes the whole view — and any selected root — stale:
  // the registry is keyed by the session's primary root, so the selection
  // falls back to primary and the list reloads.
  useEffect(() => {
    let previous = props.sessionId?.()
    return props.subscribeSession?.(() => {
      const current = props.sessionId?.()
      if (current === previous) return
      previous = current
      requestEpoch.current += 1
      setSelected('primary')
      setView(undefined)
      void refresh()
    })
  }, [props.subscribeSession, props.sessionId, refresh])

  // A refresh that reports the selected root gone or withheld sends the
  // selection back to the primary root instead of browsing a stale grant.
  useEffect(() => {
    if (selected === 'primary' || view === undefined) return
    const current = view.roots.find(root => root.id === selected.id)
    if (current === undefined || current.state !== 'available') setSelected('primary')
  }, [view, selected])

  const roots = useMemo(() => view?.roots ?? [], [view])
  const primaryLabel = view?.primaryName ?? basename(view?.primaryRoot ?? primaryPath)
  const triggerLabel = selected === 'primary' ? primaryLabel : displayNameOf(selected)
  const triggerPath = selected === 'primary' ? (view?.primaryRoot ?? primaryPath) : selected.path

  const items = useMemo((): MenuEntry[] => [
    { id: 'primary', label: `${primaryLabel} · ${t('panel.primary')}`, icon: <IconFolderOpen /> },
    ...roots.map((root): MenuEntry => ({
      id: `root:${root.id}`,
      label: root.state === 'available' ? displayNameOf(root) : `${displayNameOf(root)} · ${t(stateKey(root.state))}`,
      icon: <IconFolderClose />,
      disabled: root.state !== 'available',
    })),
  ], [roots, primaryLabel, t])

  const onSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'manage') { setDialogOpen(true); return }
    if (id === 'primary') { setSelected('primary'); return }
    const root = roots.find(candidate => `root:${candidate.id}` === id)
    if (root !== undefined) setSelected(root)
  }

  return (
    <>
      <span
        ref={wrapperRef}
        className="mrfw-rootSwitcher"
        data-root-kind={selected === 'primary' ? 'primary' : 'additional'}
      >
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={items}
          // The manager entry pins below the scrolling roots list — it is
          // chrome, not a root, and a long registry must not scroll it away.
          footer={[{ id: 'manage', label: t('switcher.manage'), icon: <IconSettings /> }]}
          selectedId={selected === 'primary' ? 'primary' : `root:${selected.id}`}
          onSelect={onSelect}
          portal
          align="start"
          anchor={(
            <button
              type="button"
              className="mrfw-rootSwitchBtn"
              title={triggerPath}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                const opening = !menuOpen
                setMenuOpen(opening)
                // States change between opens; the menu always lists a fresh
                // view rather than the snapshot from the previous visit.
                if (opening) void refresh()
              }}
            >
              <span className="mrfw-triggerIcon" aria-hidden="true"><IconFolderClose size={16} /></span>
              <span className="mrfw-rootSwitchLabel">{triggerLabel}</span>
              <span className="mrfw-triggerIcon mrfw-rootSwitchChevron" aria-hidden="true"><IconChevronDown size={14} /></span>
            </button>
          )}
        />
      </span>
      {selected !== 'primary' && panel !== undefined && pane !== null
        ? createPortal(
            <div className="mrfw-switcherTree">
              <RootFileTree panel={panel} entry={entryOf(selected)} sessionId={props.sessionId ?? NO_SESSION} t={t} />
            </div>,
            pane,
          )
        : null}
      {dialogOpen ? (
        <WorkspaceFoldersDialog
          panel={props.panel}
          pickDirectory={props.pickDirectory}
          {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
          {...(props.subscribeSession === undefined ? {} : { subscribeSession: props.subscribeSession })}
          t={t}
          onClose={() => { setDialogOpen(false) }}
        />
      ) : null}
    </>
  )
}
