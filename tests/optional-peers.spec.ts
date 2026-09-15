/**
 * The optional LLM peer this bundle loads at runtime.
 *
 * The property here is about the LOAD MOMENT, which is what makes it testable
 * at all: the barrel (`src/index.ts`) is the module the carrier loader row
 * mounts, so what it resolves at load time decides whether a minimal
 * composition can load this plugin at all.
 */

import { describe, expect, it, vi } from 'vitest'

let llmLoaded = false

vi.mock('@deepseek-ai/dsh-llm', () => {
  llmLoaded = true
  return { createUserMessage: (input: unknown) => ({ ...(input as object), role: 'user', id: 'stub-message' }) }
})

describe('the optional LLM peer', () => {
  it('is not resolved while the barrel or the instruction row loads', async () => {
    // Dynamic imports on purpose: static ones would resolve these modules
    // before the flag below could observe the load moment, which IS the
    // property under test.
    await expect(import('../src/index.ts')).resolves.toBeDefined()
    await expect(import('../src/instructions.ts')).resolves.toBeDefined()
    expect(llmLoaded).toBe(false)
  })
})
