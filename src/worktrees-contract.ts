/**
 * The worktree suggestion wire contract.
 *
 * Kept apart from `contract.ts` for the same reason `skills-contract.ts` is:
 * the endpoint set is additive, the host dispatches it before the root panel
 * schema, and the browser bundle inlines exactly this module. Nothing here may
 * import `node:*`, `@deepseek-ai/*`, or this package's host-only modules.
 *
 * The one shape with a security role is {@link WorktreePromptWaitView}: it is a
 * STRICT discriminated union. Every branch is validated on both halves, and no
 * branch may carry a retry hint (ADR-0039 §4.3 / §9): `unactivated` and
 * `lost` mean stop, `timeout` means mount again. A single visible candidate is
 * delivered as `prompt`; two or more are delivered as `prompts` and rendered
 * as a checkbox list.
 *
 * The second revision of the trigger model (ADR-0039 §二十次修订) splits the
 * request into three roles that must not be confused:
 *
 * - `worktreePrompt` with `fresh: true` is the ONE read-only automatic check
 *   (a notice-worthy candidate set, no side effects);
 * - `worktreePromptSeen` records that the operator was already shown those
 *   candidates (Host memory only — never authorization);
 * - `worktreePromptResolve` with `action: 'snooze'` records a reminder delay
 *   in the sidecar. Only ids and a mode travel; keys stay on the host.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees-contract
 */

import { z } from 'zod'

/** The endpoint names, relative to the panel channel. */
export type WorktreeEndpoint
  = | 'worktreePrompt'
    | 'worktreePromptSeen'
    | 'worktreePromptWait'
    | 'worktreePromptResolve'
    | 'worktreePromptReset'
    | 'worktreeRootsCleanup'

/** Every worktree endpoint, for exhaustive dispatch. */
export const WORKTREE_ENDPOINTS: readonly WorktreeEndpoint[] = [
  'worktreePrompt',
  'worktreePromptSeen',
  'worktreePromptWait',
  'worktreePromptResolve',
  'worktreePromptReset',
  'worktreeRootsCleanup',
]

/** The kind of grant a prompt offers. */
export type WorktreePromptKind = 'worktree' | 'main-checkout'
/** The effective authority the panel shows for one prompt. */
export type WorktreeEffectiveAccess = 'read-only' | 'read-write' | 'full-access' | 'unavailable'

/**
 * The three reminder delays the UI offers. The host converts `7d`/`30d` into
 * an absolute instant with ITS clock; the browser never sends a timestamp.
 */
export type WorktreeSnoozeMode = 'until-new-worktree' | '7d' | '30d'

/** The snooze choice a confirmation may carry. */
export interface WorktreeSnoozeChoice {
  readonly mode: WorktreeSnoozeMode
}

/** One prompt as the panel renders it. */
export interface WorktreePromptView {
  readonly id: string
  readonly key: string
  readonly kind: WorktreePromptKind
  readonly path: string
  readonly primaryRoot: string
  readonly access: 'inherit'
  readonly effectiveAccess: WorktreeEffectiveAccess
  readonly remaining: number
  readonly viewRevision: string
}

/**
 * The long-poll result: a strict discriminated union with NO retry field.
 *
 * `prompt` is the single-candidate shape (the plain confirmation dialog);
 * `prompts` is the multi-candidate shape (the checkbox list). They are
 * mutually exclusive by construction.
 */
export type WorktreePromptWaitView
  = | { readonly status: 'prompt'; readonly prompt: WorktreePromptView; readonly viewRevision: string }
    | { readonly status: 'prompts'; readonly prompts: readonly WorktreePromptView[]; readonly viewRevision: string }
    | { readonly status: 'timeout'; readonly viewRevision: string }
    | { readonly status: 'unactivated'; readonly viewRevision: string }
    | { readonly status: 'lost'; readonly viewRevision: string }
    | { readonly status: 'stale'; readonly viewRevision: string; readonly reason: string }

/** `worktreePrompt` answers this (always a visible list). */
export interface WorktreePromptAnswerView {
  readonly prompts: readonly WorktreePromptView[]
  readonly viewRevision: string
}

/** `worktreePromptSeen` answers how many ids it could claim. */
export interface WorktreeSeenAnswerView {
  readonly seen: number
}

/** One id the batch handled. */
export interface WorktreeResolvedView {
  readonly id: string
  readonly key: string
  readonly path: string
  /** The new Registry record, present for an `add`. */
  readonly rootId?: string | undefined
}

/** One id the batch refused, with the stable refusal code. */
export interface WorktreeSkippedView {
  readonly id: string
  readonly key?: string | undefined
  readonly path?: string | undefined
  readonly code: string
}

/** `worktreePromptResolve` answers this. */
export interface WorktreeResolveAnswerView {
  readonly viewRevision: string
  /** The still-visible candidates after the batch (may be empty). */
  readonly prompts: readonly WorktreePromptView[]
  readonly resolved: readonly WorktreeResolvedView[]
  readonly skipped: readonly WorktreeSkippedView[]
}

/** `worktreePromptReset` answers this. */
export interface WorktreeResetAnswerView {
  readonly cleared: boolean
}

/** What a client may send: never a path, only ids, a mode and the flags the ADR names. */
export interface WorktreeRequest {
  readonly sessionId: string
  readonly fresh?: boolean
  readonly promptIds?: readonly string[]
  readonly action?: 'add' | 'dismiss' | 'snooze'
  readonly dontRemind?: boolean
  readonly snooze?: WorktreeSnoozeChoice
  readonly rootIds?: readonly string[]
  readonly seenViewRevision?: string
}

/** One validated call. */
export interface WorktreeCall extends WorktreeRequest {
  readonly endpoint: WorktreeEndpoint
}

/** A parse verdict, matching the root contract's shape. */
export type ParsedWorktree<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** The snooze choice schema; the mode enum is the whole vocabulary. */
export const worktreeSnoozeChoiceSchema = z.object({
  mode: z.enum(['until-new-worktree', '7d', '30d']),
}).strict()

/** The one request body schema; unknown keys are refused. */
export const worktreeRequestSchema = z.object({
  sessionId: z.string().min(1),
  fresh: z.boolean().optional(),
  promptIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  action: z.enum(['add', 'dismiss', 'snooze']).optional(),
  dontRemind: z.boolean().optional(),
  snooze: worktreeSnoozeChoiceSchema.optional(),
  rootIds: z.array(z.string().min(1)).max(256).optional(),
  seenViewRevision: z.string().min(1).optional(),
}).strict()

/**
 * The fields each endpoint acts on. A body that carries another endpoint's
 * field is refused instead of silently ignored: a `snooze` on `worktreePrompt`
 * or a `fresh` on `worktreePromptResolve` is a client that disagrees with the
 * contract, not a harmless extra.
 */
const ENDPOINT_FIELDS: Record<WorktreeEndpoint, readonly string[]> = {
  worktreePrompt: ['sessionId', 'fresh'],
  worktreePromptSeen: ['sessionId', 'promptIds'],
  worktreePromptWait: ['sessionId', 'seenViewRevision'],
  worktreePromptResolve: ['sessionId', 'promptIds', 'action', 'dontRemind', 'snooze'],
  worktreePromptReset: ['sessionId'],
  worktreeRootsCleanup: ['sessionId', 'rootIds'],
}

/** One prompt on the wire. */
const promptSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  kind: z.enum(['worktree', 'main-checkout']),
  path: z.string(),
  primaryRoot: z.string(),
  access: z.literal('inherit'),
  effectiveAccess: z.enum(['read-only', 'read-write', 'full-access', 'unavailable']),
  remaining: z.number().int().nonnegative(),
  viewRevision: z.string().min(1),
}).strict()

const promptListSchema = z.array(promptSchema).max(64)

/** One batch outcome. */
const resolvedSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  path: z.string(),
  rootId: z.string().min(1).optional(),
}).strict()

const skippedSchema = z.object({
  id: z.string().min(1),
  key: z.string().optional(),
  path: z.string().optional(),
  code: z.string().min(1),
}).strict()

/** The long-poll answer schema: every branch strict, no retry hint anywhere. */
export const worktreeWaitViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('prompt'), prompt: promptSchema, viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('prompts'), prompts: promptListSchema.min(2), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('timeout'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('unactivated'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('lost'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('stale'), viewRevision: z.string().min(1), reason: z.string().min(1) }).strict(),
])

/** `worktreePrompt` answer schema. */
export const worktreePromptAnswerSchema = z.object({
  prompts: promptListSchema,
  viewRevision: z.string().min(1),
}).strict()

/** `worktreePromptSeen` answer schema. */
export const worktreeSeenAnswerSchema = z.object({ seen: z.number().int().nonnegative() }).strict()

/** `worktreePromptResolve` answer schema. */
export const worktreeResolveAnswerSchema = z.object({
  viewRevision: z.string().min(1),
  prompts: promptListSchema,
  resolved: z.array(resolvedSchema),
  skipped: z.array(skippedSchema),
}).strict()

/** `worktreePromptReset` answer schema. */
export const worktreeResetAnswerSchema = z.object({ cleared: z.boolean() }).strict()

/**
 * Validate the payload of one worktree endpoint, including the fields that
 * endpoint requires (so a resolve without `promptIds` never reaches the host's
 * switch).
 * @param endpoint - the channel method.
 * @param payload - the raw payload.
 * @returns the call, or one sentence naming the problem.
 */
export function parseWorktreeCall(endpoint: string, payload: unknown): ParsedWorktree<WorktreeCall> {
  if (!(WORKTREE_ENDPOINTS as readonly string[]).includes(endpoint)) return { ok: false, message: `unknown worktree endpoint "${endpoint}"` }
  const parsed = worktreeRequestSchema.safeParse(payload ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
    return { ok: false, message: `the request body is invalid: ${path}${issue?.message ?? 'invalid'}` }
  }
  const value = parsed.data
  const allowed = ENDPOINT_FIELDS[endpoint as WorktreeEndpoint]
  const present = Object.entries(value).filter(([, field]) => field !== undefined).map(([name]) => name)
  const extra = present.find(name => !allowed.includes(name))
  if (extra !== undefined) return { ok: false, message: `"${extra}" does not belong to ${endpoint}` }
  if (value.promptIds !== undefined && new Set(value.promptIds).size !== value.promptIds.length) {
    return { ok: false, message: 'promptIds must be unique' }
  }
  switch (endpoint as WorktreeEndpoint) {
    case 'worktreePromptSeen':
    case 'worktreePromptResolve':
      if (value.promptIds === undefined) return { ok: false, message: 'promptIds is required' }
      break
    case 'worktreeRootsCleanup':
      if (value.rootIds === undefined) return { ok: false, message: 'rootIds is required' }
      break
    default:
      break
  }
  if (endpoint === 'worktreePromptResolve') {
    if (value.action === undefined) return { ok: false, message: 'action is required' }
    // The three flags are not interchangeable: a snooze without its mode cannot
    // be stored, a mode without the snooze action is a client bug, and a
    // permanent ignore only exists on `dismiss` (ADR-0039 §6.3).
    if (value.action === 'snooze' && value.snooze === undefined) {
      return { ok: false, message: 'a snooze action requires the snooze mode' }
    }
    if (value.action !== 'snooze' && value.snooze !== undefined) {
      return { ok: false, message: 'the snooze mode only belongs to the snooze action' }
    }
    if (value.dontRemind !== undefined && value.action !== 'dismiss') {
      return { ok: false, message: 'dontRemind only belongs to the dismiss action' }
    }
  }
  return {
    ok: true,
    value: {
      endpoint: endpoint as WorktreeEndpoint,
      sessionId: value.sessionId,
      ...(value.fresh === undefined ? {} : { fresh: value.fresh }),
      ...(value.promptIds === undefined ? {} : { promptIds: value.promptIds }),
      ...(value.action === undefined ? {} : { action: value.action }),
      ...(value.dontRemind === undefined ? {} : { dontRemind: value.dontRemind }),
      ...(value.snooze === undefined ? {} : { snooze: { mode: value.snooze.mode } }),
      ...(value.rootIds === undefined ? {} : { rootIds: value.rootIds }),
      ...(value.seenViewRevision === undefined ? {} : { seenViewRevision: value.seenViewRevision }),
    },
  }
}
