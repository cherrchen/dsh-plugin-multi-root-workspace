/** Browser-side remoteFiles.list scheduling: the Host cap is a refusal, so overflow waits locally and remains cancellable. */
import { describe, expect, it, vi } from 'vitest'
import { createRemoteFilesClient } from '../src/client/remote-files-client.ts'
import { REMOTE_FILES_LIMITS, type RemoteFilesListRequest } from '../src/remote/files-contract.ts'

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
})
