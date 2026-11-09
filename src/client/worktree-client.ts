/**
 * The worktree prompt client: the Connection RPC calls the overlay uses.
 *
 * Kept beside the panel client rather than merged into it: the worktree
 * endpoints have their own strict schemas and their own long-poll lifetime,
 * and the panel client's typed surface must keep promising only roots calls.
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
  worktreeWaitViewSchema,
  type WorktreeCleanupView,
  type WorktreePromptAnswerView,
  type WorktreePromptWaitView,
  type WorktreeResetAnswerView,
  type WorktreeResolveAnswerView,
} from '../contract.ts'
import { PanelError } from './panel-client.ts'

type ChannelResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

/** The callable face the prompt overlay receives. */
export interface WorktreeClient {
  wait(sessionId: string, seen: { seenPromptId?: string; seenViewRevision?: string }, signal?: AbortSignal): Promise<WorktreePromptWaitView>
  prompt(sessionId: string, signal?: AbortSignal): Promise<WorktreePromptAnswerView>
  resolve(sessionId: string, promptId: string, action: 'add' | 'dismiss', dontRemind?: boolean, signal?: AbortSignal): Promise<WorktreeResolveAnswerView>
  reset(sessionId: string, signal?: AbortSignal): Promise<WorktreeResetAnswerView>
  cleanup(sessionId: string, rootIds: readonly string[], signal?: AbortSignal): Promise<WorktreeCleanupView>
  /**
   * Wake a stopped overlay. Panel reads are explicit user actions that can
   * re-activate a lost workspace on the host, but they carry no prompt payload;
   * this signal is what makes the same session mount its wait again.
   */
  notify?(): void
  /** Subscribe to {@link notify}; returns the unsubscribe function. */
  subscribe?(listener: () => void): () => void
}

/**
 * Build the prompt client over a Connection handle.
 * @param connection - the client Connection service.
 * @returns the client, with transport failures normalized to PanelError.
 */
export function createWorktreeClient(connection: ConnectionHandle): WorktreeClient {
  const listeners = new Set<() => void>()
  return {
    notify() {
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async wait(sessionId, seen, signal) {
      return parse(worktreeWaitViewSchema, await call(connection, 'worktreePromptWait', { sessionId, ...seen }, signal), 'the worktree wait answer')
    },
    async prompt(sessionId, signal) {
      return parse(worktreePromptAnswerSchema, await call(connection, 'worktreePrompt', { sessionId }, signal), 'the worktree prompt answer')
    },
    async resolve(sessionId, promptId, action, dontRemind, signal) {
      return parse(worktreeResolveAnswerSchema, await call(connection, 'worktreePromptResolve', {
        sessionId, promptId, action, ...(dontRemind === undefined ? {} : { dontRemind }),
      }, signal), 'the worktree resolve answer')
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
