/**
 * The wire contract between the browser panel and this plugin's host half.
 *
 * It is deliberately transport-agnostic plain data: the host registers one
 * Connection RPC channel (see `command.ts`) and the client bundle inlines this
 * module, so both sides agree on endpoint names and payload shapes without
 * sharing any runtime identity. Error codes are the stable half of the
 * contract; `message` is only a fallback the panel does not have to show.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/contract
 */

/** The absolute logical channel both halves speak over. */
export const PANEL_CHANNEL = '/multi-root-workspace'

/** Endpoint names, relative to {@link PANEL_CHANNEL}. */
export type PanelEndpoint = 'list' | 'add' | 'remove' | 'alias' | 'move' | 'reveal'

/** One root as the panel renders it. */
export interface RootView {
  /** Stable identity, used by every mutating endpoint. */
  readonly id: string
  /** Canonical absolute directory. */
  readonly path: string
  /** Display alias as stored; absent when cleared. */
  readonly alias?: string
  /** ISO-8601 registration instant. */
  readonly addedAt: string
  /** Whether the directory is writable right now, withheld, or unusable. */
  readonly state: 'available' | 'missing' | 'invalid'
  /** Why the root is not `available`; a code the panel localizes. */
  readonly detail?: string
}

/** The panel's whole view of one workspace root. */
export interface RootsView {
  /** The canonical workspace root these registrations belong to. */
  readonly primaryRoot: string
  /** The additional roots, in registry order. */
  readonly roots: readonly RootView[]
  /** Set when the store itself could not be read; the panel shows this verbatim. */
  readonly unavailable?: string
}

/** Payload shared by every request; every field is optional per endpoint. */
export interface PanelRequest {
  /** The workspace root to act on; absent lets the host resolve it from `sessionId`. */
  readonly primaryRoot?: string
  /** The session whose workspace root should be used when `primaryRoot` is absent. */
  readonly sessionId?: string
  /** Target root identity (mutations). */
  readonly id?: string
  /** Candidate directory (add). */
  readonly path?: string
  /** Display alias (add/alias); empty clears it. */
  readonly alias?: string
  /** Anchor identity (move): the target is placed in front of it; absent moves it last. */
  readonly beforeId?: string
}

/** A failure the panel renders by `code`. */
export interface PanelFailure {
  /** Stable code from the root vocabulary, or `panel/bad-request`. */
  readonly code: string
  /** Human-readable fallback text. */
  readonly message: string
}
