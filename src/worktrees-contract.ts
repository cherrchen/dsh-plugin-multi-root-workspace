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
 * `lost` mean stop, `timeout` means mount again.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees-contract
 */

import { z } from 'zod'

/** The endpoint names, relative to the panel channel. */
export type WorktreeEndpoint
  = | 'worktreePrompt'
    | 'worktreePromptWait'
    | 'worktreePromptResolve'
    | 'worktreePromptReset'
    | 'worktreeRootsCleanup'

/** Every worktree endpoint, for exhaustive dispatch. */
export const WORKTREE_ENDPOINTS: readonly WorktreeEndpoint[] = [
  'worktreePrompt',
  'worktreePromptWait',
  'worktreePromptResolve',
  'worktreePromptReset',
  'worktreeRootsCleanup',
]

/** The kind of grant a prompt offers. */
export type WorktreePromptKind = 'worktree' | 'git-common'
/** The effective authority the panel shows for one prompt. */
export type WorktreeEffectiveAccess = 'read-only' | 'read-write' | 'full-access' | 'unavailable'

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

/** The long-poll result: a strict discriminated union with NO retry field. */
export type WorktreePromptWaitView
  = | { readonly status: 'prompt'; readonly prompt: WorktreePromptView; readonly viewRevision: string }
    | { readonly status: 'timeout'; readonly viewRevision: string }
    | { readonly status: 'unactivated'; readonly viewRevision: string }
    | { readonly status: 'lost'; readonly viewRevision: string }
    | { readonly status: 'stale'; readonly viewRevision: string; readonly reason: string }

/** `worktreePrompt` answers this. */
export interface WorktreePromptAnswerView {
  readonly prompt?: WorktreePromptView | undefined
  readonly viewRevision: string
}

/** `worktreePromptResolve` answers this. */
export interface WorktreeResolveAnswerView {
  readonly viewRevision: string
  readonly prompt?: WorktreePromptView | undefined
}

/** `worktreePromptReset` answers this. */
export interface WorktreeResetAnswerView {
  readonly cleared: boolean
}

/** What a client may send: never a path, only ids and the flags the ADR names. */
export interface WorktreeRequest {
  readonly sessionId: string
  readonly promptId?: string
  readonly action?: 'add' | 'dismiss'
  readonly dontRemind?: boolean
  readonly rootIds?: readonly string[]
  readonly seenPromptId?: string
  readonly seenViewRevision?: string
}

/** One validated call. */
export interface WorktreeCall extends WorktreeRequest {
  readonly endpoint: WorktreeEndpoint
}

/** A parse verdict, matching the root contract's shape. */
export type ParsedWorktree<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** The one request body schema; unknown keys are refused. */
export const worktreeRequestSchema = z.object({
  sessionId: z.string().min(1),
  promptId: z.string().min(1).optional(),
  action: z.enum(['add', 'dismiss']).optional(),
  dontRemind: z.boolean().optional(),
  rootIds: z.array(z.string().min(1)).max(256).optional(),
  seenPromptId: z.string().min(1).optional(),
  seenViewRevision: z.string().min(1).optional(),
}).strict()

/** One prompt on the wire. */
const promptSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  kind: z.enum(['worktree', 'git-common']),
  path: z.string(),
  primaryRoot: z.string(),
  access: z.literal('inherit'),
  effectiveAccess: z.enum(['read-only', 'read-write', 'full-access', 'unavailable']),
  remaining: z.number().int().nonnegative(),
  viewRevision: z.string().min(1),
}).strict()

/** The long-poll answer schema: every branch strict, no retry hint anywhere. */
export const worktreeWaitViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('prompt'), prompt: promptSchema, viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('timeout'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('unactivated'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('lost'), viewRevision: z.string().min(1) }).strict(),
  z.object({ status: z.literal('stale'), viewRevision: z.string().min(1), reason: z.string().min(1) }).strict(),
])

/** `worktreePrompt` answer schema. */
export const worktreePromptAnswerSchema = z.object({
  prompt: promptSchema.optional(),
  viewRevision: z.string().min(1),
}).strict()

/** `worktreePromptResolve` answer schema. */
export const worktreeResolveAnswerSchema = z.object({
  viewRevision: z.string().min(1),
  prompt: promptSchema.optional(),
}).strict()

/** `worktreePromptReset` answer schema. */
export const worktreeResetAnswerSchema = z.object({ cleared: z.boolean() }).strict()

/**
 * Validate the payload of one worktree endpoint, including the fields that
 * endpoint requires (so a resolve without `promptId` never reaches the host's
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
  if (value.promptId === undefined && (endpoint === 'worktreePromptResolve')) {
    return { ok: false, message: 'promptId is required' }
  }
  if (value.action === undefined && endpoint === 'worktreePromptResolve') {
    return { ok: false, message: 'action is required' }
  }
  if (value.rootIds === undefined && endpoint === 'worktreeRootsCleanup') {
    return { ok: false, message: 'rootIds is required' }
  }
  return {
    ok: true,
    value: {
      endpoint: endpoint as WorktreeEndpoint,
      sessionId: value.sessionId,
      ...(value.promptId === undefined ? {} : { promptId: value.promptId }),
      ...(value.action === undefined ? {} : { action: value.action }),
      ...(value.dontRemind === undefined ? {} : { dontRemind: value.dontRemind }),
      ...(value.rootIds === undefined ? {} : { rootIds: value.rootIds }),
      ...(value.seenPromptId === undefined ? {} : { seenPromptId: value.seenPromptId }),
      ...(value.seenViewRevision === undefined ? {} : { seenViewRevision: value.seenViewRevision }),
    },
  }
}
