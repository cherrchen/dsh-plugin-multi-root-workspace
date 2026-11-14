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
 *   {@link RevealedView}; root-management endpoints answer with
 *   {@link RootsView}.
 *   The host builds those answers in `command.ts` and the
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
import type { SkillsResponseMap } from './skills-contract.ts'
import type { WorktreePromptAnswerView, WorktreePromptWaitView, WorktreeResetAnswerView, WorktreeResolveAnswerView, WorktreeSeenAnswerView } from './worktrees-contract.ts'
export { SKILLS_ENDPOINTS, skillsRequestSchema, skillsCatalogSchema, skillsPreviewSchema, skillsStatusSchema } from './skills-contract.ts'
export type { SkillsEndpoint, SkillsStatusView, SkillsCatalogView, SkillsPreviewView } from './skills-contract.ts'
export {
  WORKTREE_ENDPOINTS,
  worktreeRequestSchema,
  worktreeWaitViewSchema,
  worktreePromptAnswerSchema,
  worktreeResolveAnswerSchema,
  worktreeResetAnswerSchema,
  worktreeSeenAnswerSchema,
  worktreeSnoozeChoiceSchema,
  parseWorktreeCall,
} from './worktrees-contract.ts'
export type {
  WorktreeEndpoint,
  WorktreeCall,
  WorktreePromptView,
  WorktreePromptWaitView,
  WorktreePromptAnswerView,
  WorktreeResolveAnswerView,
  WorktreeResolvedView,
  WorktreeResetAnswerView,
  WorktreeRequest,
  WorktreeEffectiveAccess,
  WorktreePromptKind,
  WorktreeSeenAnswerView,
  WorktreeSkippedView,
  WorktreeSnoozeChoice,
  WorktreeSnoozeMode,
} from './worktrees-contract.ts'

/** One worktree deletion badge on a registered root (ADR-0039 §6.1). */
export interface WorktreeRootView {
  readonly adminId: string
  readonly path: string
  readonly state: 'active' | 'directory-missing' | 'unregistered' | 'moved' | 'changed'
  readonly cleanupEligible: boolean
}

/** `worktreeRootsCleanup` answers this after the explicit per-id cleanup. */
export interface WorktreeCleanupView {
  readonly removed: readonly string[]
  readonly skipped: readonly { readonly id: string; readonly code: string }[]
  readonly roots: RootsView
}

/** The worktree endpoints' response types, merged into the workspace map. */
export interface WorktreeResponseMap {
  readonly worktreePrompt: WorktreePromptAnswerView
  readonly worktreePromptSeen: WorktreeSeenAnswerView
  readonly worktreePromptWait: WorktreePromptWaitView
  readonly worktreePromptResolve: WorktreeResolveAnswerView
  readonly worktreePromptReset: WorktreeResetAnswerView
  readonly worktreeRootsCleanup: WorktreeCleanupView
}

export interface WorkspaceResponseMap extends PanelResponseMap, SkillsResponseMap, WorktreeResponseMap {}

/** The absolute logical channel both halves speak over. */
export const PANEL_CHANNEL = '/multi-root-workspace'

/** Endpoint names, relative to {@link PANEL_CHANNEL}. */
export type PanelEndpoint = 'list' | 'add' | 'remove' | 'alias' | 'move' | 'setAccess' | 'setSkillsEnabled' | 'setAliasId' | 'reveal' | 'search'

/** Every endpoint name, for exhaustive iteration in tests and callers. */
export const PANEL_ENDPOINTS: readonly PanelEndpoint[] = ['list', 'add', 'remove', 'alias', 'move', 'setAccess', 'setSkillsEnabled', 'setAliasId', 'reveal', 'search']

/**
 * How one registered root currently stands, as the panel renders it. Kept in
 * step with the root vocabulary in `src/roots.ts` deliberately: this module is
 * inlined into the browser bundle and must not pull in `node:*`, so the one
 * value the two sides share is spelled out rather than imported.
 */
export type RootState = 'available' | 'missing' | 'redirected' | 'invalid'

/**
 * The write authority one registration carries (B9 three-state), spelled out
 * rather than imported: this module is inlined into the browser bundle and
 * must not pull in `node:*`, so the one value the two sides share is
 * duplicated here.
 */
export type RootAccess = 'inherit' | 'read-write' | 'read-only'
export type WorkspaceMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type EffectiveRootAccess = 'read-only' | 'read-write' | 'full-access' | 'unavailable'

/** The shared nine-cell rule; tool dispatch may subsequently narrow writes. */
export function effectiveRootAccess(access: RootAccess, mode: WorkspaceMode): EffectiveRootAccess {
  if (access !== 'inherit') return access
  return mode === 'danger-full-access' ? 'full-access' : mode === 'workspace-write' ? 'read-write' : 'read-only'
}

/** One root as the panel renders it. */
export interface RootView {
  /** 1-based position in the returned snapshot. */
  readonly ordinal: number
  /** Stable identity, used by every mutating endpoint. */
  readonly id: string
  /** Canonical absolute directory. */
  readonly path: string
  /** Display alias as stored; absent when cleared. */
  readonly aliasId?: string
  readonly skillsEnabled?: boolean
  readonly alias?: string
  /** ISO-8601 registration instant. */
  readonly addedAt: string
  /** Whether the directory is writable right now, withheld, or unusable. */
  readonly state: RootState
  /** The write authority the registration carries. */
  readonly access: RootAccess
  /** Host-derived session permission, before any per-tool cap. */
  readonly effectiveAccess?: EffectiveRootAccess
  /** Why the root is not `available`; a code the panel localizes. */
  readonly detail?: string
  /** Worktree lifecycle facts for a root this feature tracks (ADR-0039 §6). */
  readonly worktree?: WorktreeRootView
}

/** Exact identity of one row in a returned list snapshot. */
export interface RootEntryView {
  readonly ordinal: number
  readonly id: string
  readonly path: string
  readonly addedAt: string
}

/** The panel's whole view, returned by root-management endpoints. */
export interface RootsView {
  /** The canonical workspace root these registrations belong to. */
  readonly primaryRoot: string
  /**
   * Display name of the primary root: the workspace's upstream title when the
   * host could resolve one; absent means the panel falls back to the path's
   * basename.
   */
  readonly primaryName?: string
  /** Execution directory only; never a registry key or an authorization grant. */
  readonly effectiveCwd?: string
  readonly mode?: WorkspaceMode
  readonly cappedTools?: readonly string[]
  readonly toolAccessInvalid?: boolean
  /** The additional roots, in registry order. */
  readonly roots: readonly RootView[]
  /** The host cap; MAX_SAFE_INTEGER means a legacy host reported no limit. */
  readonly limit: number
  /**
   * How many records are stored, in every state. `count > limit` is a
   * historical over-limit store: everything stays granted, only adds refuse.
   */
  readonly count: number
  /** Set when the store itself could not be read; the panel shows this verbatim. */
  readonly unavailable?: string
  /** Host-derived state of the primary directory itself (ADR-0039 §6.7). */
  readonly primaryState?: 'present' | 'missing' | 'inaccessible'
  /** How many tracked worktree roots are cleanup-eligible right now. */
  readonly worktreeCleanupCount?: number
}

/** What `reveal` answers with: the directory the host asked the file manager to show. */
export interface RevealedView {
  /** Canonical path of the revealed root. */
  readonly revealed: string
}

/** One entry a workspace search returned, `/`-joined relative to {@link SearchView.root}. */
export interface SearchMatchView {
  readonly path: string
  /** What the entry resolves to, in the same vocabulary the Host's listings use. */
  readonly type: 'file' | 'directory' | 'other'
}

/**
 * What `search` answers with.
 *
 * The Host searched one additional root of the Session's workspace, not the
 * Session cwd: `root` is that root's canonical path, and `matches` are relative
 * to it — exactly the vocabulary the Host's own workspace search answers in.
 * The Client joins the two to key its tree; the whole authorization decision
 * (which root, whether it is still granted) happened on the Host.
 */
export interface SearchView {
  /** Canonical absolute path of the searched additional root. */
  readonly root: string
  /** Matching files and their inferred ancestor directories, relative to `root`. */
  readonly matches: readonly SearchMatchView[]
  /** The Host returned only its first matches because more matched. */
  readonly truncated: boolean
  /** Part of the root was not searched (the Host's file cap or an unreadable directory). */
  readonly incomplete: boolean
}

/** The response type of every endpoint — the mapping the panel is typed against. */
export interface PanelResponseMap {
  readonly list: RootsView
  readonly add: RootsView
  readonly remove: RootsView
  readonly alias: RootsView
  readonly move: RootsView
  readonly setSkillsEnabled: RootsView
  readonly setAliasId: RootsView
  readonly setAccess: RootsView
  readonly reveal: RevealedView
  readonly search: SearchView
}

/**
 * The fields a request may carry. `sessionId` is required on every endpoint:
 * the host derives the primary root from that session's immutable cwd and
 * never accepts a client-named path. The remaining fields are used per
 * endpoint and the host asserts which ones that endpoint requires.
 */
export interface PanelRequest {
  /** The live host session whose cwd is the primary root this call acts on. */
  readonly sessionId: string
  /** Exact target row from the most recent list snapshot. */
  readonly entry?: RootEntryView
  /** Compatibility reference; accepted only when the id is unique. */
  readonly id?: string
  /** Candidate directory (add). */
  readonly path?: string
  /** Display alias (add/alias); empty clears it. */
  readonly aliasId?: string
  readonly skillsEnabled?: boolean
  readonly alias?: string
  /** Write authority (add — defaults to `inherit` — and setAccess). */
  readonly access?: RootAccess
  /** Exact anchor row (move): the target is placed in front of it; absent moves it last. */
  readonly beforeEntry?: RootEntryView
  /** Compatibility anchor; accepted only when the id is unique. */
  readonly beforeId?: string
  /**
   * The additional root to search (search): the stable `RootView.id`, never a
   * path. The Host re-resolves it against a refreshed registry, so a root that
   * moved, was removed, or is no longer granted is refused instead of searched
   * through a stale client copy.
   */
  readonly rootId?: string
  /** Search text without surrounding whitespace (search); the Host refuses a blank one. */
  readonly query?: string
  /** Literal exclusion names, or root-relative paths containing `/` (search). */
  readonly excludedPaths?: readonly string[]
  /** Whether hidden entries may match (search). */
  readonly includeHidden?: boolean
  /** Whether the search honors the root's ignore files (search). */
  readonly respectGitignore?: boolean
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
  sessionId: z.string().min(1),
  entry: z.object({
    ordinal: z.number().int().positive(),
    id: z.string(),
    path: z.string(),
    addedAt: z.string(),
  }).strict().optional(),
  id: z.string().optional(),
  path: z.string().optional(),
  aliasId: z.string().optional(),
  skillsEnabled: z.boolean().optional(),
  alias: z.string().optional(),
  access: z.enum(['inherit', 'read-write', 'read-only']).optional(),
  beforeEntry: z.object({
    ordinal: z.number().int().positive(),
    id: z.string(),
    path: z.string(),
    addedAt: z.string(),
  }).strict().optional(),
  beforeId: z.string().optional(),
  rootId: z.string().min(1).optional(),
  query: z.string().optional(),
  excludedPaths: z.array(z.string()).optional(),
  includeHidden: z.boolean().optional(),
  respectGitignore: z.boolean().optional(),
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
  aliasId: z.string().optional(),
  skillsEnabled: z.boolean().optional(),
  alias: z.string().optional(),
  addedAt: z.string(),
  state: z.enum(['available', 'missing', 'redirected', 'invalid']),
  // Optional on the wire so an older host (which always meant session-following
  // read-write — `inherit` under B9) still parses; narrowed to the legacy
  // default in `narrowRootView`.
  access: z.enum(['inherit', 'read-write', 'read-only']).optional(),
  detail: z.string().optional(),
  effectiveAccess: z.enum(['read-only', 'read-write', 'full-access', 'unavailable']).optional(),
  worktree: z.object({
    adminId: z.string(),
    path: z.string(),
    state: z.enum(['active', 'directory-missing', 'unregistered', 'moved', 'changed']),
    cleanupEligible: z.boolean(),
  }).optional(),
})

const rootsViewSchema = z.object({
  primaryRoot: z.string(),
  primaryName: z.string().optional(),
  effectiveCwd: z.string().optional(),
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  cappedTools: z.array(z.string()).optional(),
  toolAccessInvalid: z.boolean().optional(),
  roots: z.array(rootViewSchema),
  // Pre-limit hosts omitted both fields. Absence is compatible; malformed
  // supplied values still fail validation.
  limit: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative().optional(),
  unavailable: z.string().optional(),
  primaryState: z.enum(['present', 'missing', 'inaccessible']).optional(),
  worktreeCleanupCount: z.number().int().nonnegative().optional(),
})

const revealedViewSchema = z.object({ revealed: z.string() })

/**
 * One search answer. Deliberately NOT strict, like the roots view: a newer Host
 * that adds a field must not brick an older panel, and the fields that matter
 * are the matches and their two completeness flags.
 */
const searchViewSchema = z.object({
  root: z.string(),
  matches: z.array(z.object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'other']),
  })),
  truncated: z.boolean(),
  incomplete: z.boolean(),
})

/** The cleanup answer; `roots` is re-validated by {@link parseRootsView}. */
const worktreeCleanupSchema = z.object({
  removed: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), code: z.string() }).strict()),
  roots: z.unknown(),
}).strict()

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
      ...(view.effectiveCwd === undefined ? {} : { effectiveCwd: view.effectiveCwd }),
      ...(view.mode === undefined ? {} : { mode: view.mode }),
      ...(view.cappedTools === undefined ? {} : { cappedTools: view.cappedTools }),
      ...(view.toolAccessInvalid === undefined ? {} : { toolAccessInvalid: view.toolAccessInvalid }),
      roots: view.roots.map(narrowRootView),
      // Legacy hosts had no cap. Do not invent a client-side limit that
      // disables their Add controls; all stored states count equally.
      limit: view.limit ?? Number.MAX_SAFE_INTEGER,
      count: view.count ?? view.roots.length,
      ...(view.unavailable === undefined ? {} : { unavailable: view.unavailable }),
      ...(view.primaryState === undefined ? {} : { primaryState: view.primaryState }),
      ...(view.worktreeCleanupCount === undefined ? {} : { worktreeCleanupCount: view.worktreeCleanupCount }),
    },
  }
}

/**
 * Validate a `WorktreeCleanupView` when it arrives. The nested roots view is
 * parsed by the same function the list endpoint uses, so a cleanup answer can
 * never introduce a shape the list would have refused.
 * @param value - the raw endpoint value.
 * @returns the view, or the reason it is not one.
 */
export function parseWorktreeCleanupView(value: unknown): Parsed<WorktreeCleanupView> {
  const parsed = worktreeCleanupSchema.safeParse(value)
  if (!parsed.success) return { ok: false, message: `the answer is not a worktree cleanup view: ${firstIssue(parsed.error)}` }
  const roots = parseRootsView(parsed.data.roots)
  if (!roots.ok) return { ok: false, message: `the cleanup roots view is invalid: ${roots.message}` }
  return {
    ok: true,
    value: { removed: parsed.data.removed, skipped: parsed.data.skipped, roots: roots.value },
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
 * Validate a `SearchView` when it arrives.
 * @param value - the raw endpoint value.
 * @returns the view, or the reason it is not one.
 */
export function parseSearchView(value: unknown): Parsed<SearchView> {
  const parsed = searchViewSchema.safeParse(value)
  if (!parsed.success) return { ok: false, message: `the answer is not a search view: ${firstIssue(parsed.error)}` }
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
    sessionId: value.sessionId,
    ...(value.entry === undefined ? {} : { entry: value.entry }),
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.aliasId === undefined ? {} : { aliasId: value.aliasId }),
    ...(value.skillsEnabled === undefined ? {} : { skillsEnabled: value.skillsEnabled }),
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.access === undefined ? {} : { access: value.access }),
    ...(value.beforeEntry === undefined ? {} : { beforeEntry: value.beforeEntry }),
    ...(value.beforeId === undefined ? {} : { beforeId: value.beforeId }),
    ...(value.rootId === undefined ? {} : { rootId: value.rootId }),
    ...(value.query === undefined ? {} : { query: value.query }),
    ...(value.excludedPaths === undefined ? {} : { excludedPaths: value.excludedPaths }),
    ...(value.includeHidden === undefined ? {} : { includeHidden: value.includeHidden }),
    ...(value.respectGitignore === undefined ? {} : { respectGitignore: value.respectGitignore }),
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
    // A host that predates the field only ever granted session-following
    // read-write — `inherit` under B9.
    access: value.access ?? 'inherit',
    ...(value.effectiveAccess === undefined ? {} : { effectiveAccess: value.effectiveAccess }),
    ...(value.aliasId === undefined ? {} : { aliasId: value.aliasId }),
    ...(value.skillsEnabled === undefined ? {} : { skillsEnabled: value.skillsEnabled }),
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.worktree === undefined ? {} : { worktree: value.worktree }),
  }
}

/** Render the first zod issue as one short sentence. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid'
  const path = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${path}${issue.message}`
}
