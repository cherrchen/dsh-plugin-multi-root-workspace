/**
 * Compatibility adapter for "does this session exist in durable storage".
 *
 * The panel session anchor (ADR-0008) is a live Session in this process's
 * `SessionStore`. A persisted session owned by another Host — or one still
 * mid-resume — never enters that store, so `resolvePanelPrimaryRoot` and the
 * `rootsViewOf` re-check both answer `session-not-found`. That code is true
 * but diagnostically wrong when the session exists: the panel copy asked the
 * user to open a session already on screen.
 *
 * `sessionPersistence.stat(id)` is the cheapest probe of the durable fact:
 * it reads only the session header — never the event log, never the
 * cross-process write lease — and reports `undefined` for an absent id.
 * This module isolates the probe because the fact's meaning differs by
 * outcome:
 *
 * - snapshot returned → the session exists (writer-held elsewhere, still
 *   resuming, or needing a format migration — `stat` reports the header in
 *   every one of those states): reclassify as `session-not-live`;
 * - `undefined` → the session does not exist in this backend: keep
 *   `session-not-found`;
 * - service or `stat` absent (a composition without persistence, or a
 *   runtime whose backend does not name it) → `false`: the probe cannot
 *   prove existence, so the caller keeps the code it already had;
 * - `stat` throws → `false`, same conservatism. One imprecision survives:
 *   a session that exists but whose header cannot be read (corrupt durable
 *   state, a broken backend) is reported as not-found rather than not-live —
 *   identical to the pre-probe behavior, and preferable to claiming
 *   existence the probe failed to prove.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/session-existence
 */

import type { Context } from '@deepseek-ai/cordis'

/** The `sessionPersistence` surface this probe consumes, structurally. */
interface SessionPersistenceLike {
  readonly stat?: (id: string, options?: { readonly signal?: AbortSignal }) => Promise<unknown>
}

/**
 * Whether `sessionId` exists in the mounted persistence backend.
 * @param ctx - the plugin fiber context; optional services read via `ctx.get`.
 * @param sessionId - the panel request's session id.
 * @param signal - the request's cancellation, forwarded when the backend takes options.
 * @returns `true` only when a snapshot proves the session exists.
 */
export async function persistedSessionExists(
  ctx: Context,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const persistence = ctx.get('sessionPersistence' as never) as SessionPersistenceLike | undefined
    if (typeof persistence?.stat !== 'function') return false
    // `stat` is invoked as a method so a real backend can read `this`.
    return (await persistence.stat(sessionId, signal === undefined ? undefined : { signal })) !== undefined
  } catch {
    // A throwing service proxy counts as "cannot prove" too: the probe only
    // ever answers `true` or `false`, never rejects.
    return false
  }
}
