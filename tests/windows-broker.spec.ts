import { describe, expect, it } from 'vitest'
import { brokerPipeName, requestDenyAttribute } from '../src/windows-broker.ts'
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
      await expect(requestDenyAttribute(user, handle, values)).rejects.toThrow('invalid token-attribute broker request')
    }
  })
})
