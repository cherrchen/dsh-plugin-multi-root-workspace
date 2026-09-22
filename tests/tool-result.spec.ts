/**
 * The tool-result failure bit lives on the content block through `0.1.6` and
 * on the message itself from `0.1.7-alpha.1`. A touch must ignore either
 * spelling, including a log that carries only one of them.
 */

import { describe, expect, it } from 'vitest'
import { toolResultFailed } from '../src/compat/tool-result.ts'

describe('toolResultFailed', () => {
  it('reads the message-level bit 0.1.7 records', () => {
    expect(toolResultFailed({ isError: true, content: [{ type: 'tool-result' }] })).toBe(true)
    expect(toolResultFailed({ isError: false, content: [{ type: 'tool-result' }] })).toBe(false)
  })

  it('reads the block-level bit 0.1.5 and 0.1.6 record', () => {
    expect(toolResultFailed({ content: [{ type: 'tool-result', isError: true }] })).toBe(true)
    expect(toolResultFailed({ content: [{ type: 'tool-result', isError: false }] })).toBe(false)
  })

  it('treats a result with neither bit as success', () => {
    expect(toolResultFailed({ content: [] })).toBe(false)
    expect(toolResultFailed({})).toBe(false)
  })
})
