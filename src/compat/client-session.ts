/**
 * Compatibility adapter for "which session is the client looking at".
 *
 * The browser panel has to name that session before it may call the host
 * (ADR-0008). Upstream moved the fact between two releases this plugin
 * supports, without renaming the `sessions` service:
 *
 * ```text
 * 0.1.5-rc.2, 0.1.6-alpha.1
 *   sessions.list.getSnapshot().current          SessionId | undefined
 * 0.1.6-alpha.2, 0.1.7-alpha.1, 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2
 *   the catalog has no `current`. The main view retains its session with
 *   source `mainView`, and that count is projected onto the list row:
 *   sessions.list.getSnapshot().byId[id].retainedBy.mainView > 0
 * ```
 *
 * Reading only `current` makes 0.1.6-alpha.2 report "no active session"
 * while a conversation is on screen. Reading the first catalog id would
 * name a session the operator is not looking at. This probe prefers the
 * explicit selection when that field is a non-empty string, and otherwise
 * the first row the main view actually retains — the same predicate
 * `ui-session` uses to publish the main binding.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/client-session
 */

/** The list snapshot, when the service actually exposes one. */
interface ListSnapshot {
  readonly current?: unknown
  readonly byId?: unknown
}

/**
 * The session the composed client is showing, when it can name one.
 * @param sessions - the client `sessions` service, or whatever this
 *   composition provided under that name. Absence is a supported state.
 * @returns the session id, or `undefined` when no main view holds one.
 */
export function currentSessionIdOf(sessions: unknown): string | undefined {
  const snapshot = listSnapshotOf(sessions)
  if (snapshot === undefined) return undefined
  const current = snapshot.current
  if (typeof current === 'string' && current !== '') return current
  return mainViewSessionId(snapshot.byId)
}

/**
 * Whether one session is retained by the client's main view, read from the
 * per-session retention snapshot when the service exposes one.
 *
 * `sessions.retainInfo(sessionId)` changes synchronously inside `retain()`,
 * which is what the workspace navigation calls before it selects a session.
 * The catalog row for a session the navigation just created can arrive later,
 * so reading only the catalog would make a caller believe the navigation never
 * selected its target. `undefined` means this surface has no readable probe;
 * callers must then fall back to {@link currentSessionIdOf}.
 * @param sessions - the client `sessions` service, or whatever this
 *   composition provided under that name.
 * @param sessionId - the session to inspect.
 * @returns whether the main view currently retains it, or `undefined` when
 *   this surface cannot answer that question.
 */
export function mainViewRetentionOf(sessions: unknown, sessionId: string): boolean | undefined {
  if (sessions === null || typeof sessions !== 'object') return undefined
  const retainInfo = (sessions as { retainInfo?: unknown }).retainInfo
  if (typeof retainInfo !== 'function') return undefined
  let info: unknown
  try {
    info = (retainInfo as (id: string) => unknown).call(sessions, sessionId)
  } catch {
    return undefined
  }
  if (info === null || typeof info !== 'object') return undefined
  const getSnapshot = (info as { getSnapshot?: unknown }).getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  let snapshot: unknown
  try {
    snapshot = (getSnapshot as () => unknown).call(info)
  } catch {
    return undefined
  }
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const retainedBy = (snapshot as { retainedBy?: unknown }).retainedBy
  if (retainedBy === null || typeof retainedBy !== 'object') return undefined
  const count = (retainedBy as { mainView?: unknown }).mainView
  // A readable retention snapshot with no `mainView` entry means the main
  // view does not retain this session; only an unreadable shape is unknown.
  return typeof count === 'number' ? count > 0 : false
}

/** Observe native catalog changes when this surface provides a subscribable store. */
export function subscribeSessions(sessions: unknown, listener: () => void): () => void {
  if (sessions === null || typeof sessions !== 'object') return () => {}
  const list = (sessions as { list?: { subscribe?: (listener: () => void) => () => void } }).list
  return typeof list?.subscribe === 'function' ? list.subscribe(listener) : () => {}
}

/** Selection changes only: activity/title updates must not close a Skill preview. */
export function subscribeCurrentSession(sessions: unknown, listener: () => void): () => void {
  let previous = currentSessionIdOf(sessions)
  return subscribeSessions(sessions, () => {
    const current = currentSessionIdOf(sessions)
    if (current !== previous) { previous = current; listener() }
  })
}

/**
 * The list snapshot, when the service actually exposes one.
 *
 * `getSnapshot` is invoked as a method so a real store can read `this`.
 * Extracting the function and calling it unbound drops that binding and
 * yields `undefined` even when a session is selected.
 */
function listSnapshotOf(sessions: unknown): ListSnapshot | undefined {
  if (sessions === null || typeof sessions !== 'object') return undefined
  const list = (sessions as { list?: unknown }).list
  if (list === null || typeof list !== 'object') return undefined
  const holder = list as { getSnapshot?: unknown }
  if (typeof holder.getSnapshot !== 'function') return undefined
  let snapshot: unknown
  try {
    snapshot = holder.getSnapshot()
  } catch {
    return undefined
  }
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  return snapshot as ListSnapshot
}

/**
 * The first catalog row retained by the main view.
 *
 * Enumeration order is the catalog's insertion order, which is the order
 * upstream's own main-binding projection scans. A row counts only while
 * `retainedBy.mainView` is a positive number: zero, a missing source, and a
 * non-numeric value are not a selection.
 * @param byId - the catalog map, or anything else the snapshot happened to carry.
 * @returns that row's session id.
 */
function mainViewSessionId(byId: unknown): string | undefined {
  if (byId === null || typeof byId !== 'object') return undefined
  for (const [key, row] of Object.entries(byId)) {
    if (!isMainViewRow(row)) continue
    const id = (row as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
    if (key !== '') return key
  }
  return undefined
}

/** Whether one catalog value is a row the main view currently retains. */
function isMainViewRow(row: unknown): boolean {
  if (row === null || typeof row !== 'object') return false
  const retainedBy = (row as { retainedBy?: unknown }).retainedBy
  if (retainedBy === null || typeof retainedBy !== 'object') return false
  const count = (retainedBy as { mainView?: unknown }).mainView
  return typeof count === 'number' && count > 0
}
