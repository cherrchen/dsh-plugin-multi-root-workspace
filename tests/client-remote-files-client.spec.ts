/** Browser-side remoteFiles.list scheduling: the Host cap is a refusal, so overflow waits locally and remains cancellable. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteFilesClient } from '../src/client/remote-files-client.ts'
import { REMOTE_FILES_LIMITS, type RemoteFilesListRequest } from '../src/remote/files-contract.ts'

afterEach(() => { vi.useRealTimers() })

const REQUEST: RemoteFilesListRequest = {
  sessionId: 'session-1',
  environmentId: 'device',
  rootId: 'out',
  relativePath: '',
  authorization: 'a'.repeat(64),
}

function harness() {
  const release: (() => void)[] = []
  const calls: string[] = []
  let active = 0
  let maxActive = 0
  const connection = {
    rpc: {
      call: vi.fn(async (_channel: string, _endpoint: string, payload: { relativePath: string }) => {
        calls.push(payload.relativePath)
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>(resolve => { release.push(resolve) })
        active--
        return { ok: true, value: { entries: [], truncated: false } }
      }),
    },
  }
  return { client: createRemoteFilesClient(connection), release, calls, activeCount: () => active, maxActive: () => maxActive }
}

describe('the remoteFiles client listing scheduler', () => {
  it('admits at most the host concurrency cap and starts a queued listing only after a slot frees', async () => {
    const { client, release, calls, maxActive } = harness()
    const pending = Array.from({ length: REMOTE_FILES_LIMITS.concurrent + 1 }, (_, index) =>
      client.list({ ...REQUEST, relativePath: `dir-${index}` }, new AbortController().signal))

    await vi.waitFor(() => { expect(calls).toHaveLength(REMOTE_FILES_LIMITS.concurrent) })
    expect(maxActive()).toBe(REMOTE_FILES_LIMITS.concurrent)
    expect(calls).not.toContain('dir-4')

    release.shift()?.()
    await vi.waitFor(() => { expect(calls).toContain('dir-4') })
    expect(maxActive()).toBe(REMOTE_FILES_LIMITS.concurrent)
    for (const finish of release.splice(0)) finish()
    await expect(Promise.all(pending)).resolves.toHaveLength(REMOTE_FILES_LIMITS.concurrent + 1)
  })

  it('cancelling a queued listing settles it promptly and it never reaches the wire', async () => {
    const { client, release, calls } = harness()
    const occupants = Array.from({ length: REMOTE_FILES_LIMITS.concurrent }, (_, index) =>
      client.list({ ...REQUEST, relativePath: `busy-${index}` }, new AbortController().signal))
    await vi.waitFor(() => { expect(calls).toHaveLength(REMOTE_FILES_LIMITS.concurrent) })

    const controller = new AbortController()
    const queued = client.list({ ...REQUEST, relativePath: 'queued' }, controller.signal)
    const checked = expect(queued).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await checked
    for (const finish of release.splice(0)) finish()
    await expect(Promise.all(occupants)).resolves.toHaveLength(REMOTE_FILES_LIMITS.concurrent)
    expect(calls).not.toContain('queued')
  })

  it('retries a transient host resource-budget left by a cancelled in-flight listing', async () => {
    vi.useFakeTimers()
    type Slot = { done: boolean; finish: () => void; janitor: () => void }
    const slots: Slot[] = []
    const calls: string[] = []
    let hostActive = 0
    const connection = {
      rpc: {
        call: vi.fn(async (_channel: string, _endpoint: string, payload: { relativePath: string }, signal: AbortSignal) => {
          calls.push(payload.relativePath)
          if (hostActive >= REMOTE_FILES_LIMITS.concurrent) return { ok: false, error: { code: 'resource-budget' } }
          hostActive++
          const slot = {} as Slot
          slots.push(slot)
          return await new Promise((resolve, reject) => {
            const retire = (): boolean => {
              if (slot.done) return false
              slot.done = true
              hostActive--
              return true
            }
            slot.finish = () => {
              if (retire()) resolve({ ok: true, value: { entries: [], truncated: false } })
            }
            slot.janitor = retire
            signal.addEventListener('abort', () => { reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }, { once: true })
          })
        }),
      },
    }
    const client = createRemoteFilesClient(connection)
    const controllers = Array.from({ length: REMOTE_FILES_LIMITS.concurrent }, () => new AbortController())
    const occupants = controllers.map((controller, index) =>
      client.list({ ...REQUEST, relativePath: `busy-${index}` }, controller.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(REMOTE_FILES_LIMITS.concurrent)

    const queued = client.list({ ...REQUEST, relativePath: 'queued' }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(REMOTE_FILES_LIMITS.concurrent)

    controllers[0].abort()
    await expect(occupants[0]).rejects.toMatchObject({ code: 'cancelled' })
    // The wire call answered immediately, but the Host-side slot is still
    // active until the janitor runs: the first queued attempt is refused.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(path => path === 'queued')).toHaveLength(1)
    slots[0].janitor()
    await vi.advanceTimersByTimeAsync(25)
    expect(calls.filter(path => path === 'queued')).toHaveLength(2)
    slots.at(-1)?.finish()
    await expect(queued).resolves.toMatchObject({ entries: [] })
    for (const slot of slots) slot.finish()
    await expect(Promise.allSettled(occupants.slice(1))).resolves.toHaveLength(REMOTE_FILES_LIMITS.concurrent - 1)
  })

  it('expires a retry waiting for a local slot without sending it', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const accepted = { ok: true, value: { entries: [], truncated: false } }
    const blockers = new Map<string, PromiseWithResolvers<void>>()
    const calls: string[] = []
    const client = createRemoteFilesClient({
      rpc: {
        call: async (_channel, _endpoint, payload) => {
          const { relativePath } = payload as RemoteFilesListRequest
          calls.push(relativePath)
          if (relativePath === 'retry') return { ok: false, error: { code: 'resource-budget' } }
          const blocker = Promise.withResolvers<void>()
          blockers.set(relativePath, blocker)
          await blocker.promise
          return accepted
        },
      },
    })
    const signal = new AbortController().signal
    const occupants = Array.from({ length: REMOTE_FILES_LIMITS.concurrent - 1 }, (_, index) =>
      client.list({ ...REQUEST, relativePath: `busy-${index}` }, signal))
    const settled = vi.fn()
    const retry = client.list({ ...REQUEST, relativePath: 'retry' }, signal).then(settled, settled)
    const ahead = client.list({ ...REQUEST, relativePath: 'ahead' }, signal)

    await vi.advanceTimersByTimeAsync(25)
    expect(blockers.has('ahead')).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.deadlineMs - 25)
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: 'resource-budget' }))
    expect(calls.filter(path => path === 'retry')).toHaveLength(1)

    for (const blocker of blockers.values()) blocker.resolve()
    await Promise.all([...occupants, ahead, retry])
    expect(calls.filter(path => path === 'retry')).toHaveLength(1)
  })

  it('reports caller cancellation during backoff', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async () => ({ ok: false, error: { code: 'resource-budget' } }))
    const client = createRemoteFilesClient({ rpc: { call } })
    const controller = new AbortController()
    const checked = expect(client.list(REQUEST, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })

    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(1)
    controller.abort()
    await checked
    await vi.advanceTimersByTimeAsync(REMOTE_FILES_LIMITS.deadlineMs)
    expect(call).toHaveBeenCalledTimes(1)
  })
})

/** remoteFiles.read: strict request/response schemas and carrier folding — fixed vocabulary only. */
describe('the remoteFiles client preview read', () => {
  const READ_REQUEST = {
    sessionId: 'session-1', environmentId: 'device', rootId: 'out',
    relativePath: 'a.txt', authorization: 'a'.repeat(64),
  }
  const content = { kind: 'file', size: 3, complete: true, bytes: new Uint8Array([65, 66, 67]) }

  it('returns the decoded content envelope on a well-formed answer', async () => {
    const call = vi.fn(async () => ({ ok: true, value: content }))
    const client = createRemoteFilesClient({ rpc: { call } })
    const result = await client.read(READ_REQUEST, new AbortController().signal)
    expect(result).toEqual(content)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('an invalid request never reaches the wire', async () => {
    const call = vi.fn(async () => ({ ok: true, value: content }))
    const client = createRemoteFilesClient({ rpc: { call } })
    for (const bad of [{ ...READ_REQUEST, relativePath: '' }, { ...READ_REQUEST, relativePath: '../x' }, { ...READ_REQUEST, absolutePath: '/x' }]) {
      await expect(client.read(bad as never, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-request' })
    }
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-object envelope', 'junk'],
    ['a null envelope', null],
    ['a non-boolean ok', { ok: 'yes', value: content }],
    ['an unknown host code', { ok: false, error: { code: 'brand-new-code' } }],
    ['a prototype-polluting code', { ok: false, error: { code: 'toString' } }],
  ])('folds %s to provider-unavailable', async (_name, answer) => {
    const client = createRemoteFilesClient({ rpc: { call: async () => answer } })
    await expect(client.read(READ_REQUEST, new AbortController().signal)).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    ['missing bytes', { kind: 'file', size: 3, complete: true }],
    ['a length mismatch', { kind: 'file', size: 4, complete: true, bytes: new Uint8Array([1]) }],
    ['non-Uint8Array bytes', { kind: 'file', size: 3, complete: true, bytes: 'abc' }],
    ['an extra property', { ...content, absolutePath: '/x' }],
  ])('rejects a payload with %s as invalid-content', async (_name, value) => {
    const client = createRemoteFilesClient({ rpc: { call: async () => ({ ok: true, value }) } })
    await expect(client.read(READ_REQUEST, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-content' })
  })

  it('a pre-aborted signal is cancelled with zero wire calls; a known code keeps its entry', async () => {
    const call = vi.fn(async () => ({ ok: false, error: { code: 'file-too-large' } }))
    const client = createRemoteFilesClient({ rpc: { call } })
    const controller = new AbortController()
    controller.abort()
    await expect(client.read(READ_REQUEST, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(call).not.toHaveBeenCalled()
    await expect(client.read(READ_REQUEST, new AbortController().signal)).rejects.toMatchObject({ code: 'file-too-large' })
  })
})
