/** The worktree wire contract: strict unions, no retry hints, explicit required fields. */
import { describe, expect, it } from 'vitest'
import {
  parseRootsView,
  parseWorktreeCall,
  worktreePromptAnswerSchema,
  worktreeResolveAnswerSchema,
  worktreeWaitViewSchema,
} from '../src/contract.ts'

const prompt = {
  id: 'p1',
  key: 'worktree\u0000/wt',
  kind: 'worktree' as const,
  path: '/wt',
  primaryRoot: '/main',
  access: 'inherit' as const,
  effectiveAccess: 'read-write' as const,
  remaining: 1,
  viewRevision: 'v1',
}

describe('worktree wait union', () => {
  it('accepts every documented branch', () => {
    for (const value of [
      { status: 'prompt', prompt, viewRevision: 'v1' },
      { status: 'prompts', prompts: [prompt, { ...prompt, id: 'p2', key: 'worktree\u0000/wt2', path: '/wt2' }], viewRevision: 'v1' },
      { status: 'timeout', viewRevision: 'v1' },
      { status: 'unactivated', viewRevision: 'v1' },
      { status: 'lost', viewRevision: 'v1' },
      { status: 'stale', viewRevision: 'v1', reason: 'prompt-gone' },
    ]) expect(worktreeWaitViewSchema.safeParse(value).success, JSON.stringify(value)).toBe(true)
  })

  it('keeps the single and list shapes apart', () => {
    // One candidate is always the single shape; the list branch starts at two.
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompts', prompts: [prompt], viewRevision: 'v1' }).success).toBe(false)
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompt', prompts: [prompt], viewRevision: 'v1' }).success).toBe(false)
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompt', prompt, prompts: [prompt], viewRevision: 'v1' }).success).toBe(false)
  })

  it('refuses a retry hint on every branch', () => {
    for (const status of ['prompt', 'prompts', 'timeout', 'unactivated', 'lost', 'stale']) {
      const value = status === 'prompt' ? { status, prompt, viewRevision: 'v1', retryAfterMs: 1000 }
        : status === 'prompts' ? { status, prompts: [prompt, { ...prompt, id: 'p2' }], viewRevision: 'v1', retryAfterMs: 1000 }
          : status === 'stale' ? { status, viewRevision: 'v1', reason: 'x', retryAfterMs: 1000 }
            : { status, viewRevision: 'v1', retryAfterMs: 1000 }
      expect(worktreeWaitViewSchema.safeParse(value).success, status).toBe(false)
    }
  })

  it('refuses an unknown status or a malformed prompt', () => {
    expect(worktreeWaitViewSchema.safeParse({ status: 'waiting', viewRevision: 'v1' }).success).toBe(false)
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompt', prompt: { ...prompt, kind: 'other' }, viewRevision: 'v1' }).success).toBe(false)
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompt', prompt: { ...prompt, access: 'read-only' }, viewRevision: 'v1' }).success).toBe(false)
    expect(worktreeWaitViewSchema.safeParse({ status: 'prompt', viewRevision: 'v1' }).success).toBe(false)
  })
})

describe('worktree responses', () => {
  it('carries the full visible list beyond the 64-id request cap', () => {
    const prompts = Array.from({ length: 65 }, (_, index) => ({
      ...prompt,
      id: `p${index}`,
      key: `worktree\u0000/wt${index}`,
      path: `/wt${index}`,
    }))
    // Discovery is not capped, so the response must not silently reject a
    // repository with more than 64 worktrees; only request batches are capped.
    expect(worktreePromptAnswerSchema.safeParse({ prompts, viewRevision: 'v1' }).success).toBe(true)
    expect(worktreeResolveAnswerSchema.safeParse({
      viewRevision: 'v1', prompts, resolved: [], skipped: [],
    }).success).toBe(true)
    expect(parseWorktreeCall('worktreePromptSeen', {
      sessionId: 's', promptIds: prompts.map(item => item.id),
    })).toMatchObject({ ok: false })
  })
})

describe('worktree requests', () => {
  it('requires sessionId and rejects unknown fields', () => {
    expect(parseWorktreeCall('worktreePrompt', {})).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePrompt', { sessionId: 's', path: '/wt' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePrompt', { sessionId: 's' })).toMatchObject({ ok: true, value: { sessionId: 's' } })
  })

  it('requires the fields each endpoint acts on', () => {
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', action: 'add' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: ['p'] })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: ['p'], action: 'add' })).toMatchObject({ ok: true })
    // The pre-list single-id field is gone: the client always sends an array.
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptId: 'p', action: 'add' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreeRootsCleanup', { sessionId: 's' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreeRootsCleanup', { sessionId: 's', rootIds: ['r1'] })).toMatchObject({ ok: true })
  })

  it('refuses duplicate or oversized prompt ids', () => {
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: ['p', 'p'], action: 'add' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: [], action: 'add' })).toMatchObject({ ok: false })
    const tooMany = Array.from({ length: 65 }, (_, index) => `p${index}`)
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: tooMany, action: 'add' })).toMatchObject({ ok: false })
  })

  it('carries the seen cursor and refuses an unknown endpoint', () => {
    expect(parseWorktreeCall('worktreePromptWait', { sessionId: 's', seenViewRevision: 'v' })).toMatchObject({
      ok: true, value: { seenViewRevision: 'v' },
    })
    expect(parseWorktreeCall('worktreePromptWait', { sessionId: 's', seenPromptId: 'p' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreeNope', { sessionId: 's' })).toMatchObject({ ok: false })
  })

  it('accepts the optional fresh flag only on worktreePrompt', () => {
    // The ONE automatic check is a pure query: a boolean, default false.
    expect(parseWorktreeCall('worktreePrompt', { sessionId: 's', fresh: true })).toMatchObject({
      ok: true, value: { fresh: true },
    })
    expect(parseWorktreeCall('worktreePrompt', { sessionId: 's' })).toMatchObject({
      ok: true, value: { sessionId: 's' },
    })
    // Not a truthy string, and not another endpoint's field.
    expect(parseWorktreeCall('worktreePrompt', { sessionId: 's', fresh: 'yes' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptWait', { sessionId: 's', fresh: true })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's', promptIds: ['p'], fresh: true })).toMatchObject({ ok: false })
  })

  it('requires promptIds on the seen claim and keeps it strict', () => {
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's', promptIds: [] })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's', promptIds: ['p', 'p'] })).toMatchObject({ ok: false })
    const tooMany = Array.from({ length: 65 }, (_, index) => `p${index}`)
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's', promptIds: tooMany })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptSeen', { sessionId: 's', promptIds: ['p'] })).toMatchObject({
      ok: true, value: { promptIds: ['p'] },
    })
  })

  it('keeps the snooze mode and its action mutually required', () => {
    // A snooze without its mode cannot be stored, and a mode without the snooze
    // action is a client that disagrees with the contract.
    expect(parseWorktreeCall('worktreePromptResolve', { sessionId: 's', promptIds: ['p'], action: 'snooze' })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'add', snooze: { mode: '7d' },
    })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'dismiss', dontRemind: true, snooze: { mode: '7d' },
    })).toMatchObject({ ok: false })
    for (const mode of ['until-new-worktree', '7d', '30d'] as const) {
      expect(parseWorktreeCall('worktreePromptResolve', {
        sessionId: 's', promptIds: ['p'], action: 'snooze', snooze: { mode },
      })).toMatchObject({ ok: true, value: { action: 'snooze', snooze: { mode } } })
    }
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'snooze', snooze: { mode: '5m' },
    })).toMatchObject({ ok: false })
    // No extra field rides along inside the mode object.
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'snooze', snooze: { mode: '7d', until: '2030-01-01' },
    })).toMatchObject({ ok: false })
    // `dontRemind` is the permanent option and only exists on dismiss.
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'add', dontRemind: true,
    })).toMatchObject({ ok: false })
    expect(parseWorktreeCall('worktreePromptResolve', {
      sessionId: 's', promptIds: ['p'], action: 'dismiss', dontRemind: true,
    })).toMatchObject({ ok: true, value: { dontRemind: true } })
  })
})

describe('roots view worktree fields', () => {
  it('preserves the worktree badge, primary state and cleanup count', () => {
    const view = {
      primaryRoot: '/main',
      roots: [{
        ordinal: 1, id: 'r1', path: '/wt', addedAt: '2026-11-09', state: 'missing', access: 'inherit',
        worktree: { adminId: 'id', path: '/wt', state: 'directory-missing', cleanupEligible: true },
      }],
      limit: 16, count: 1, primaryState: 'present', worktreeCleanupCount: 1,
    }
    const parsed = parseRootsView(view)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.primaryState).toBe('present')
    expect(parsed.value.worktreeCleanupCount).toBe(1)
    expect(parsed.value.roots[0]?.worktree).toMatchObject({ state: 'directory-missing', cleanupEligible: true })
  })

  it('rejects a malformed worktree badge without breaking the root view', () => {
    const root = { ordinal: 1, id: 'r1', path: '/wt', addedAt: '2026-11-09', state: 'missing', worktree: { adminId: 'id', path: '/wt', state: 'gone', cleanupEligible: true } }
    expect(parseRootsView({ primaryRoot: '/main', roots: [root] })).toMatchObject({ ok: false })
  })
})
