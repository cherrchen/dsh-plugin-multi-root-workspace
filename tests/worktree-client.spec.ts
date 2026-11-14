/** The worktree Connection client: request ids travel in contract-sized batches. */
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createWorktreeClient } from '../src/client/worktree-client.ts'

interface RecordedCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: {
    readonly promptIds: readonly string[]
    readonly action?: string
    readonly snooze?: { readonly mode: string }
  }
}

/** A Connection that records payloads and answers the two batched endpoints. */
function fakeConnection(): { readonly connection: ConnectionHandle; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const connection = {
    rpc: {
      async call(channel: string, endpoint: string, payload: RecordedCall['payload']) {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'worktreePromptSeen') {
          return { ok: true, value: { seen: payload.promptIds.length } }
        }
        if (endpoint === 'worktreePromptResolve') {
          return {
            ok: true,
            value: {
              viewRevision: 'v2',
              prompts: [],
              resolved: payload.promptIds.map(id => ({ id, key: id, path: '/' + id })),
              skipped: [],
            },
          }
        }
        throw new Error('unexpected endpoint ' + endpoint)
      },
    },
  } as unknown as ConnectionHandle
  return { connection, calls }
}

const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `p${index}`)

describe('worktree client request batching', () => {
  it('claims every id in request-sized batches and sums the answer', async () => {
    const { connection, calls } = fakeConnection()
    const client = createWorktreeClient(connection)
    const answer = await client.seen('s1', ids(130))
    expect(answer).toEqual({ seen: 130 })
    expect(calls).toHaveLength(3)
    expect(calls.map(call => call.payload.promptIds.length)).toEqual([64, 64, 2])
    expect(calls[0]!.payload.promptIds[0]).toBe('p0')
    expect(calls[2]!.payload.promptIds.at(-1)).toBe('p129')
  })

  it('confirms in batches and merges the per-row answers', async () => {
    const { connection, calls } = fakeConnection()
    const client = createWorktreeClient(connection)
    const answer = await client.resolve('s1', ids(65), 'add')
    expect(calls.map(call => call.payload.promptIds.length)).toEqual([64, 1])
    expect(calls.every(call => call.endpoint === 'worktreePromptResolve' && call.payload.action === 'add')).toBe(true)
    expect(answer.viewRevision).toBe('v2')
    expect(answer.prompts).toEqual([])
    expect(answer.resolved).toHaveLength(65)
  })

  it('snoozes in batches with the chosen mode on every request', async () => {
    const { connection, calls } = fakeConnection()
    const client = createWorktreeClient(connection)
    await client.snooze('s1', ids(100), { mode: '7d' })
    expect(calls.map(call => call.payload.promptIds.length)).toEqual([64, 36])
    expect(calls.every(call => call.payload.action === 'snooze' && call.payload.snooze?.mode === '7d')).toBe(true)
  })

  it('keeps a single batch in one request', async () => {
    const { connection, calls } = fakeConnection()
    const client = createWorktreeClient(connection)
    await client.seen('s1', ['p0'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload.promptIds).toEqual(['p0'])
  })
})
