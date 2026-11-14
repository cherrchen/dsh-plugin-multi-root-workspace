/**
 * The worktree prompt client: the Connection RPC calls the overlay uses.
 *
 * Kept beside the panel client rather than merged into it: the worktree
 * endpoints have their own strict schemas and their own long-poll lifetime,
 * and the panel client's typed surface must keep promising only roots calls.
 *
 * The second revision of the trigger model (ADR-0039 第二十次修订) gives this
 * client exactly three automatic roles, and no way to auto-open the Dialog:
 *
 * - `prompt(..., { fresh: true })` — the one read-only check a session
 *   activation performs;
 * - `seen(...)` — claim the candidates the notice listed;
 * - `snooze(...)` — record a reminder delay (the Dialog's permanent option
 *   uses `resolve(..., 'dismiss', { dontRemind: true })` instead).
 *
 * The Dialog's long poll starts only after the operator pressed "View".
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/worktree-client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  PANEL_CHANNEL,
  parseErrorView,
  parseWorktreeCleanupView,
  worktreePromptAnswerSchema,
  worktreeResetAnswerSchema,
  worktreeResolveAnswerSchema,
  worktreeSeenAnswerSchema,
  worktreeWaitViewSchema,
  type WorktreeCleanupView,
  type WorktreePromptAnswerView,
  type WorktreePromptWaitView,
  type WorktreeResetAnswerView,
  type WorktreeResolveAnswerView,
  type WorktreeSeenAnswerView,
  type WorktreeSnoozeChoice,
} from '../contract.ts'
import { PanelError } from './panel-client.ts'

type ChannelResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

/** The one automatic check's query knob; `false`/omitted is the Dialog list. */
export interface WorktreePromptQuery {
  /** Ask only for candidates not yet offered and not snoozed (no side effects). */
  readonly fresh?: boolean
}

/** The non-add outcomes a confirmation may carry. */
export interface WorktreeResolveOptions {
  /** `dismiss` only: persist the workspace-wide "do not suggest" decision. */
  readonly dontRemind?: boolean
  /** `snooze` only: the reminder delay the operator picked. */
  readonly snooze?: WorktreeSnoozeChoice
}

/** The callable face the prompt overlay receives. */
export interface WorktreeClient {
  /** One read-only view: `fresh` for the automatic check, otherwise the full list. */
  prompt(sessionId: string, query?: WorktreePromptQuery, signal?: AbortSignal): Promise<WorktreePromptAnswerView>
  /** Claim the candidates the notice showed (Host memory; idempotent). */
  seen(sessionId: string, promptIds: readonly string[], signal?: AbortSignal): Promise<WorktreeSeenAnswerView>
  /** Long-poll the Dialog's visible list. */
  wait(sessionId: string, seen: { seenViewRevision?: string }, signal?: AbortSignal): Promise<WorktreePromptWaitView>
  /** Confirm (`add`), ignore (`dismiss`) or delay (`snooze`) the selected ids. */
  resolve(sessionId: string, promptIds: readonly string[], action: 'add' | 'dismiss' | 'snooze', options?: WorktreeResolveOptions, signal?: AbortSignal): Promise<WorktreeResolveAnswerView>
  /** Record a reminder delay; the host derives the discovery keys. */
  snooze(sessionId: string, promptIds: readonly string[], choice: WorktreeSnoozeChoice, signal?: AbortSignal): Promise<WorktreeResolveAnswerView>
  /** Clear every prompt decision of the workspace (explicit operator action). */
  reset(sessionId: string, signal?: AbortSignal): Promise<WorktreeResetAnswerView>
  /** Clean up tracked B roots whose directories are confirmed missing. */
  cleanup(sessionId: string, rootIds: readonly string[], signal?: AbortSignal): Promise<WorktreeCleanupView>
}

/**
 * Build the prompt client over a Connection handle.
 * @param connection - the client Connection service.
 * @returns the client, with transport failures normalized to PanelError.
 */
export function createWorktreeClient(connection: ConnectionHandle): WorktreeClient {
  return {
    async wait(sessionId, seen, signal) {
      return parse(worktreeWaitViewSchema, await call(connection, 'worktreePromptWait', { sessionId, ...seen }, signal), 'the worktree wait answer')
    },
    async prompt(sessionId, query, signal) {
      return parse(worktreePromptAnswerSchema, await call(connection, 'worktreePrompt', {
        sessionId,
        ...(query?.fresh === true ? { fresh: true } : {}),
      }, signal), 'the worktree prompt answer')
    },
    async seen(sessionId, promptIds, signal) {
      return parse(worktreeSeenAnswerSchema, await call(connection, 'worktreePromptSeen', {
        sessionId, promptIds,
      }, signal), 'the worktree seen answer')
    },
    async resolve(sessionId, promptIds, action, options, signal) {
      return parse(worktreeResolveAnswerSchema, await call(connection, 'worktreePromptResolve', {
        sessionId,
        promptIds,
        action,
        ...(options?.dontRemind === undefined ? {} : { dontRemind: options.dontRemind }),
        ...(options?.snooze === undefined ? {} : { snooze: options.snooze }),
      }, signal), 'the worktree resolve answer')
    },
    async snooze(sessionId, promptIds, choice, signal) {
      return parse(worktreeResolveAnswerSchema, await call(connection, 'worktreePromptResolve', {
        sessionId, promptIds, action: 'snooze', snooze: choice,
      }, signal), 'the worktree snooze answer')
    },
    async reset(sessionId, signal) {
      return parse(worktreeResetAnswerSchema, await call(connection, 'worktreePromptReset', { sessionId }, signal), 'the worktree reset answer')
    },
    async cleanup(sessionId, rootIds, signal) {
      const parsed = parseWorktreeCleanupView(await call(connection, 'worktreeRootsCleanup', { sessionId, rootIds }, signal))
      if (!parsed.ok) throw new PanelError('panel/bad-response', parsed.message)
      return parsed.value
    },
  }
}

async function call(connection: ConnectionHandle, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  let result: ChannelResult
  try {
    result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as ChannelResult
  } catch (error: unknown) {
    throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) {
    const failure = parseErrorView(result.error)
    throw failure === undefined
      ? new PanelError('unavailable', 'the host answered with an unreadable failure')
      : new PanelError(failure.code, failure.message)
  }
  return result.value
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new PanelError('panel/bad-response', label + ' does not match the contract')
  return parsed.data
}
