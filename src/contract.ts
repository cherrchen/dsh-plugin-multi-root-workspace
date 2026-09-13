/**
 * The wire contract between the browser panel and this plugin's host half.
 *
 * It is deliberately transport-agnostic plain data: the host registers one
 * Connection RPC channel (see `command.ts`) and the client bundle inlines this
 * module, so both sides agree on endpoint names and payload shapes without
 * sharing any runtime identity. Error codes are the stable half of the
 * contract; `message` is only a fallback the panel does not have to show.
 *
 * Two properties this module owns:
 *
 * - **One shape per endpoint.** {@link PanelResponseMap} is the single mapping
 *   from endpoint to response type, so the panel cannot silently decode one
 *   endpoint's answer as another's. `reveal` answers with
 *   {@link RevealedView}; every other endpoint answers with a whole
 *   {@link RootsView}. The host builds those answers in `command.ts` and the
 *   panel parses them here — one definition, two consumers.
 * - **Runtime validation at the boundary.** The payload arrives from a browser
 *   and the answer arrives from the host; neither is trusted to match the
 *   TypeScript types. {@link parsePanelCall} and the `parse*View` functions
 *   check the shapes and report structural failures as a message, so a
 *   mismatch becomes a visible, localized error instead of a crash or a
 *   silently wrong render.
 *
 * Nothing here may import `node:*` or `@deepseek-ai/*`: this module is inlined
 * into the browser bundle.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/contract
 */

import { z } from 'zod'

/** The absolute logical channel both halves speak over. */
export const PANEL_CHANNEL = '/multi-root-workspace'

/** Endpoint names, relative to {@link PANEL_CHANNEL}. */
export type PanelEndpoint = 'list' | 'add' | 'remove' | 'alias' | 'move' | 'reveal'

/** Every endpoint name, for exhaustive iteration in tests and callers. */
export const PANEL_ENDPOINTS: readonly PanelEndpoint[] = ['list', 'add', 'remove', 'alias', 'move', 'reveal']

/**
 * How one registered root currently stands, as the panel renders it. Kept in
 * step with the root vocabulary in `src/roots.ts` deliberately: this module is
 * inlined into the browser bundle and must not pull in `node:*`, so the one
 * value the two sides share is spelled out rather than imported.
 */
export type RootState = 'available' | 'missing' | 'redirected' | 'invalid'

/** One root as the panel renders it. */
export interface RootView {
  /** 1-based position in the returned snapshot. */
  readonly ordinal: number
  /** Stable identity, used by every mutating endpoint. */
  readonly id: string
  /** Canonical absolute directory. */
  readonly path: string
  /** Display alias as stored; absent when cleared. */
  readonly alias?: string
  /** ISO-8601 registration instant. */
  readonly addedAt: string
  /** Whether the directory is writable right now, withheld, or unusable. */
  readonly state: RootState
  /** Why the root is not `available`; a code the panel localizes. */
  readonly detail?: string
}

/** Exact identity of one row in a returned list snapshot. */
export interface RootEntryView {
  readonly ordinal: number
  readonly id: string
  readonly path: string
  readonly addedAt: string
}

/** The panel's whole view of one workspace root; every endpoint but `reveal` answers with this. */
export interface RootsView {
  /** The canonical workspace root these registrations belong to. */
  readonly primaryRoot: string
  /**
   * Display name of the primary root: the workspace's upstream title when the
   * host could resolve one; absent means the panel falls back to the path's
   * basename.
   */
  readonly primaryName?: string
  /** The additional roots, in registry order. */
  readonly roots: readonly RootView[]
  /** Set when the store itself could not be read; the panel shows this verbatim. */
  readonly unavailable?: string
}

/** What `reveal` answers with: the directory the host asked the file manager to show. */
export interface RevealedView {
  /** Canonical path of the revealed root. */
  readonly revealed: string
}

/** The response type of every endpoint — the mapping the panel is typed against. */
export interface PanelResponseMap {
  readonly list: RootsView
  readonly add: RootsView
  readonly remove: RootsView
  readonly alias: RootsView
  readonly move: RootsView
  readonly reveal: RevealedView
}

/**
 * The fields a request may carry. `primaryRoot` and `sessionId` are shared by
 * every endpoint (a client may name the workspace root directly or let the host
 * resolve it from the session); the remaining fields are used per endpoint and
 * the host asserts which ones that endpoint requires.
 */
export interface PanelRequest {
  /** The workspace root to act on; the host validates that it is an existing directory. */
  readonly primaryRoot?: string
  /** The session whose workspace root should be used when `primaryRoot` is absent. */
  readonly sessionId?: string
  /** Exact target row from the most recent list snapshot. */
  readonly entry?: RootEntryView
  /** Compatibility reference; accepted only when the id is unique. */
  readonly id?: string
  /** Candidate directory (add). */
  readonly path?: string
  /** Display alias (add/alias); empty clears it. */
  readonly alias?: string
  /** Exact anchor row (move): the target is placed in front of it; absent moves it last. */
  readonly beforeEntry?: RootEntryView
  /** Compatibility anchor; accepted only when the id is unique. */
  readonly beforeId?: string
}

/** One validated call: the endpoint plus the request fields it may use. */
export interface PanelCall extends PanelRequest {
  /** The endpoint to call. */
  readonly endpoint: PanelEndpoint
}

/** A failure the panel renders by `code`. */
export interface PanelFailure {
  /** Stable code from the root vocabulary, or `panel/bad-request`. */
  readonly code: string
  /** Human-readable fallback text. */
  readonly message: string
}

/** One parse result: the value, or one sentence naming what was wrong. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * The request body on the wire. The endpoint travels as the RPC method, not as
 * a field, so this schema covers the fields only; the host pairs it with the
 * method the channel dispatched (and rejects the pair if the body contradicts
 * it). Unknown keys are rejected rather than ignored: a client sending a field
 * this host does not understand is out of contract, and silently dropping it
 * would hide the drift.
 */
const panelRequestSchema = z.object({
  primaryRoot: z.string().optional(),
  sessionId: z.string().optional(),
  entry: z.object({
    ordinal: z.number().int().positive(),
    id: z.string(),
    path: z.string(),
    addedAt: z.string(),
  }).strict().optional(),
  id: z.string().optional(),
  path: z.string().optional(),
  alias: z.string().optional(),
  beforeEntry: z.object({
    ordinal: z.number().int().positive(),
    id: z.string(),
    path: z.string(),
    addedAt: z.string(),
  }).strict().optional(),
  beforeId: z.string().optional(),
}).strict()

/**
 * One root as it travels over the channel. Deliberately NOT strict, in both
 * directions: a newer host that adds a field must not brick an older panel, and
 * the field that matters is the state it reports.
 */
const rootViewSchema = z.object({
  ordinal: z.number().int().positive(),
  id: z.string(),
  path: z.string(),
  alias: z.string().optional(),
  addedAt: z.string(),
  state: z.enum(['available', 'missing', 'redirected', 'invalid']),
  detail: z.string().optional(),
})

const rootsViewSchema = z.object({
  primaryRoot: z.string(),
  primaryName: z.string().optional(),
  roots: z.array(rootViewSchema),
  unavailable: z.string().optional(),
})

const revealedViewSchema = z.object({ revealed: z.string() })

const errorViewSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

/**
 * Validate the payload the host received for one endpoint.
 * @param endpoint - the endpoint the channel dispatched (the RPC method).
 * @param payload - the raw channel payload (the request body).
 * @returns the call the host may act on, or the reason it is not one.
 */
export function parsePanelCall(endpoint: string, payload: unknown): Parsed<PanelCall> {
  const known = (PANEL_ENDPOINTS as readonly string[]).includes(endpoint)
  if (!known) return { ok: false, message: `unknown endpoint "${endpoint}"` }
  const parsed = panelRequestSchema.safeParse(payload ?? {})
  if (!parsed.success) return { ok: false, message: `the request body is invalid: ${firstIssue(parsed.error)}` }
  return { ok: true, value: narrowCall(endpoint as PanelEndpoint, parsed.data) }
}

/**
 * Validate a `RootsView` when it arrives.
 * @param value - the raw endpoint value.
 * @returns the view, or the reason it is not one.
 */
export function parseRootsView(value: unknown): Parsed<RootsView> {
  const parsed = rootsViewSchema.safeParse(value)
  if (!parsed.success) return { ok: false, message: `the answer is not a roots view: ${firstIssue(parsed.error)}` }
  const view = parsed.data
  return {
    ok: true,
    value: {
      primaryRoot: view.primaryRoot,
      ...(view.primaryName === undefined ? {} : { primaryName: view.primaryName }),
      roots: view.roots.map(narrowRootView),
      ...(view.unavailable === undefined ? {} : { unavailable: view.unavailable }),
    },
  }
}

/**
 * Validate a `RevealedView` when it arrives.
 * @param value - the raw endpoint value.
 * @returns the view, or the reason it is not one.
 */
export function parseRevealedView(value: unknown): Parsed<RevealedView> {
  const parsed = revealedViewSchema.safeParse(value)
  if (!parsed.success) return { ok: false, message: `the answer is not a reveal result: ${firstIssue(parsed.error)}` }
  return { ok: true, value: parsed.data }
}

/**
 * Validate the `{ code, message }` envelope of a failed call.
 * @param value - the raw error value.
 * @returns the failure, or `undefined` when the value is not one.
 */
export function parseErrorView(value: unknown): PanelFailure | undefined {
  const parsed = errorViewSchema.safeParse(value)
  if (!parsed.success) return undefined
  return { code: parsed.data.code, message: parsed.data.message }
}

/**
 * Rebuild a parsed call as the declared type, keeping absent optional fields
 * ABSENT (`exactOptionalPropertyTypes` distinguishes "absent" from "undefined",
 * and the host's own code reads the two the same way the panel sent them).
 */
function narrowCall(endpoint: PanelEndpoint, value: z.infer<typeof panelRequestSchema>): PanelCall {
  return {
    endpoint,
    ...(value.primaryRoot === undefined ? {} : { primaryRoot: value.primaryRoot }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.entry === undefined ? {} : { entry: value.entry }),
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.beforeEntry === undefined ? {} : { beforeEntry: value.beforeEntry }),
    ...(value.beforeId === undefined ? {} : { beforeId: value.beforeId }),
  }
}

/** Rebuild one parsed root as the declared `RootView`. */
function narrowRootView(value: z.infer<typeof rootViewSchema>): RootView {
  return {
    ordinal: value.ordinal,
    id: value.id,
    path: value.path,
    addedAt: value.addedAt,
    state: value.state,
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  }
}

/** Render the first zod issue as one short sentence. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid'
  const path = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${path}${issue.message}`
}
