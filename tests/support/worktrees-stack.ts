/**
 * A production Registry + worktree service stack for the write-path specs.
 * Only the live session / sandbox-policy lookups are stubs.
 *
 * @module tests/support/worktrees-stack
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { mountRegistryStack, type RegistryStack } from './registry-stack.ts'
import MultiRootWorktrees, { type Config } from '../../src/worktrees.ts'

export interface WorktreeStackOptions {
  readonly config?: Config
  readonly mode?: () => 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly sessionId?: string
  readonly cwd?: string
  readonly settings?: boolean
}

export interface WorktreeStack {
  readonly stack: RegistryStack
  readonly ctx: Context
  readonly worktrees: MultiRootWorktrees
  readonly storeFile: string
  readonly sidecarRoot: string
  readonly sessionId: string
  readonly cwd: string
  hooks(): { setSource(source: () => unknown): void; onChange(): void; validate(value: unknown): void } | undefined
}

export async function mountWorktreeStack(storeRoot: string, options: WorktreeStackOptions = {}): Promise<WorktreeStack> {
  const stack = await mountRegistryStack(storeRoot)
  const ctx = stack.ctx
  const sessionId = options.sessionId ?? 'session-1'
  const cwd = options.cwd ?? '/'
  const mode = options.mode ?? (() => 'workspace-write')
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: mode(), workspaceRoot: cwd }) } as never)
  ctx.provide('sessions', { get: (id: string) => id === sessionId ? { header: { cwd } } : undefined } as never)
  let hooks: { setSource(source: () => unknown): void; onChange(): void; validate(value: unknown): void } | undefined
  if (options.settings === true) {
    ctx.provide('settings', {
      installSection: (_owner: Context, _ns: string, _schema: unknown, _value: unknown, value: typeof hooks) => { hooks = value },
    } as never)
  }
  await ctx.plugin(MultiRootWorktrees, options.config ?? {})
  return {
    stack,
    ctx,
    worktrees: ctx.multiRootWorktrees,
    storeFile: stack.storeFile,
    sidecarRoot: join(storeRoot, 'worktree-prompts'),
    sessionId,
    cwd,
    hooks: () => hooks,
  }
}

/** The sidecar file of one primary root, or undefined when it does not exist yet. */
export function readSidecarFile(sidecarRoot: string, primaryKey: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(sidecarRoot, createHash('sha256').update(primaryKey).digest('hex') + '.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}
