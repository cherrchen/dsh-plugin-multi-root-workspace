/** F11: the endpoint verifier always terminates its probe and never leaks timers or listeners. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshEndpointVerifier } from '../src/remote/ssh-verifier.ts'

afterEach(() => { vi.useRealTimers() })

const ENVIRONMENT = { environmentId: 'build', transport: 'helper', platform: 'linux' } as never
const BINDING = { path: '/srv/root' } as never

function world(spawn: (handle: FakeHandle) => unknown = handle => handle) {
  const handle = new FakeHandle()
  const calls: string[] = []
  const env = {
    hello: { executable: '/bin/true', platform: 'linux' },
    sandbox: { confine: async (argv: readonly string[]) => { calls.push('confine'); return { argv, enforcement: 'full' as const } } },
    subprocess: { spawn: () => { calls.push('spawn'); return spawn(handle) } },
  }
  const manager = { open: async () => { calls.push('open'); return env }, openSftp: async () => { throw new Error('unused') } }
  return { verifier: new SshEndpointVerifier(manager as never), handle, calls }
}

class FakeHandle {
  readonly completion = Promise.withResolvers<{ exitCode: number; signal: string | null }>()
  readonly done = this.completion.promise
  readonly collected = { stdout: { readFrom: () => ({ text: JSON.stringify({ real: '/srv/root', dev: '1', ino: '2', isDirectory: true }) }) } }
  terminateCalls = 0
  waitCalls = 0
  terminate() { this.terminateCalls++ }
  async waitForExit() { this.waitCalls++; return true }
}

describe('the endpoint verifier probe lifecycle', () => {
  it('refuses an already-aborted signal before opening the environment', async () => {
    const { verifier, calls } = world()
    const controller = new AbortController()
    controller.abort()
    await expect(verifier.verify(ENVIRONMENT, BINDING, controller.signal)).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    expect(calls).toEqual([])
  })

  it('terminates and bounds the wait when the caller aborts mid-probe', async () => {
    const { verifier, handle } = world()
    const controller = new AbortController()
    const pending = verifier.verify(ENVIRONMENT, BINDING, controller.signal)
    for (let i = 0; i < 100 && handle.terminateCalls === 0 && handle.waitCalls === 0; i++) {
      if (i === 10) controller.abort()
      await Promise.resolve()
    }
    await expect(pending).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    expect(handle.terminateCalls).toBe(1)
    expect(handle.waitCalls).toBeGreaterThan(0)
  })

  it('terminates and bounds the wait when the probe hangs past the timeout', async () => {
    const { verifier, handle } = world()
    vi.useFakeTimers()
    const pending = verifier.verify(ENVIRONMENT, BINDING, new AbortController().signal)
    const checked = expect(pending).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    await vi.advanceTimersByTimeAsync(30_100)
    await checked
    await vi.advanceTimersByTimeAsync(600)
    expect(handle.terminateCalls).toBe(1)
    expect(handle.waitCalls).toBeGreaterThan(0)
  })

  it('still terminates after a successful probe and returns the durable identity', async () => {
    const { verifier, handle } = world()
    const pending = verifier.verify(ENVIRONMENT, BINDING, new AbortController().signal)
    await Promise.resolve()
    handle.completion.resolve({ exitCode: 0, signal: null })
    await expect(pending).resolves.toMatchObject({ platform: 'linux', target: { kind: 'object', value: '1:2' } })
    expect(handle.terminateCalls).toBe(1)
    expect(handle.waitCalls).toBeGreaterThan(0)
  })

  it('reports a non-zero probe exit and a spawn failure without leaking', async () => {
    const failed = world()
    const pending = failed.verifier.verify(ENVIRONMENT, BINDING, new AbortController().signal)
    await Promise.resolve()
    failed.handle.completion.resolve({ exitCode: 3, signal: null })
    await expect(pending).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    expect(failed.handle.terminateCalls).toBe(1)
    const broken = world(() => { throw new Error('no spawn') })
    await expect(broken.verifier.verify(ENVIRONMENT, BINDING, new AbortController().signal)).rejects.toThrowError('no spawn')
  })
})
