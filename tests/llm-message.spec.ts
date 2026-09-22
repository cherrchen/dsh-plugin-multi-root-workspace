/**
 * Session format 3 persists the shared `plugin` source kind. Format 4 rejects
 * that kind and requires a producer-owned one. The chooser is pure so both
 * spellings can be pinned without installing both releases at once.
 */

import { describe, expect, it } from 'vitest'
import { instructionSourceKind } from '../src/compat/llm-message.ts'

describe('instructionSourceKind', () => {
  it('keeps the shared plugin kind through session format 3', () => {
    expect(instructionSourceKind(3)).toBe('plugin')
    expect(instructionSourceKind(undefined)).toBe('plugin')
  })

  it('uses this plugin\'s own kind once format 4 rejects kind plugin', () => {
    expect(instructionSourceKind(4)).toBe('multi-root-workspace')
    expect(instructionSourceKind(5)).toBe('multi-root-workspace')
  })
})
