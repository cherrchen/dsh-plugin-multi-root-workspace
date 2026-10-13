import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:net', () => ({ createConnection: vi.fn() }))
import { brokerPipeName, requestDenyToken } from '../src/windows-broker.ts'
import { rootDenySid } from '../src/windows-runner-contract.ts'

describe('Windows broker request boundary', () => {
  const user = 'S-1-5-21-100-200-300-1001'
  it('isolates installation identities and refuses pipe-name injection', () => {
    expect(brokerPipeName(user)).toMatch(/^DshMultiRootBroker-[a-f0-9]{16}$/)
    expect(brokerPipeName(user)).not.toBe(brokerPipeName(user + '0'))
    expect(() => brokerPipeName('..\\another-pipe')).toThrow('invalid')
  })
  it('accepts no arbitrary attribute value, command or unbounded set', async () => {
    const deny = rootDenySid('C:\\readonly')
    for (const [handle, values] of [[0n, [deny]], [1n, []], [1n, ['administrator']],
      [1n, [deny + '|run command']], [1n, Array(65).fill(deny)]] as const) {
      await expect(requestDenyToken(user, handle, values)).rejects.toThrow('invalid deny-token broker request')
    }
  })
})


describe('Windows broker response boundary', () => {
  const user = 'S-1-5-21-100-200-300-1001'
  const deny = rootDenySid('C:\\readonly')
  const connect = () => {
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() })
    vi.mocked(createConnection).mockReturnValue(socket as unknown as Socket)
    const response = requestDenyToken(user, 512n, [deny])
    socket.emit('connect')
    return { socket, response }
  }
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('receives a fragmented 64-bit handle without losing precision', async () => {
    const { socket, response } = connect()
    expect(socket.write).toHaveBeenCalledWith(`2|512|${deny}\n`)
    socket.emit('data', Buffer.from('OK|9007199254'))
    socket.emit('data', Buffer.from('740993\n'))
    await expect(response).resolves.toBe(9007199254740993n)
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it.each(['OK\n', 'OK|0\n', 'OK|-1\n', 'OK|18446744073709551616\n', 'ERROR:unauthorized\n'])(
    'refuses an ACK without a valid kernel handle: %j', async reply => {
      const { socket, response } = connect()
      socket.emit('data', Buffer.from(reply))
      await expect(response).rejects.toThrow('broker refused')
      expect(socket.destroy).toHaveBeenCalledOnce()
    },
  )

  it('rejects an incomplete reply and a stalled connection', async () => {
    vi.useFakeTimers()
    const first = connect()
    first.socket.emit('data', Buffer.from('OK|42'))
    first.socket.emit('end')
    await expect(first.response).rejects.toThrow('disconnected')
    const second = connect()
    const check = expect(second.response).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await check
    expect(second.socket.destroy).toHaveBeenCalledOnce()
  })
})
