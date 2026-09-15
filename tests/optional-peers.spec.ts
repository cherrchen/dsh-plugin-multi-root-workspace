/**
 * The two optional upstream peers this bundle loads at runtime.
 *
 * Both properties here are about the LOAD MOMENT, which is what makes them
 * testable at all: the barrel (`src/index.ts`) is the module the carrier loader
 * row mounts, so what it resolves at load time decides whether a minimal
 * composition can load this plugin at all.
 */

import { describe, expect, it, vi } from 'vitest'

let llmLoaded = false

vi.mock('@deepseek-ai/dsh-llm', () => {
  llmLoaded = true
  return { createUserMessage: (input: unknown) => ({ ...(input as object), role: 'user', id: 'stub-message' }) }
})

vi.mock('@deepseek-ai/dsh-agent-instructions', () => {
  // "Installed, but its evaluation fails" — the review's exact scenario (a
  // transitive dependency is missing). The package's own entry resolves, so
  // `isPackageInstalled` says `true` and the failure must surface instead of
  // being reported as absence.
  throw new Error('evaluation failed: a transitive dependency is missing')
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

describe('the optional instruction package', () => {
  it('is distinguished from an installed package that fails to load', async () => {
    // Dynamic import on purpose: the mocks above apply to `import()` and the
    // adapter is the thing that decides what to do with their failure.
    const { instructionsApi, isPackageInstalled, resetInstructionsApi } = await import('../src/compat/agent-instructions.ts')
    expect(isPackageInstalled('@deepseek-ai/dsh-definitely-not-installed')).toBe(false)
    expect(isPackageInstalled('@deepseek-ai/dsh-agent-instructions')).toBe(true)

    resetInstructionsApi()
    // Absence is `undefined`; a failure to evaluate is NOT.
    let failure: unknown
    try {
      await instructionsApi()
    } catch (error: unknown) {
      failure = error
    }
    // The mocker wraps a throwing factory in its own error, so the injected
    // reason is looked for in the cause as well as the message.
    const described = failure instanceof Error
      ? `${failure.message} :: ${String(failure.cause)}`
      : String(failure)
    expect(described).toContain('evaluation failed')
  })
})
