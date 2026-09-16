/**
 * Compatibility adapter for the one LLM helper this bundle needs.
 *
 * `@deepseek-ai/dsh-llm` is an OPTIONAL peer (see `peerDependenciesMeta`): a
 * minimal composition legitimately has neither it nor an agent, and the
 * instruction row then contributes nothing. That makes the load MOMENT part of
 * the contract — this bundle's business layer is re-exported by the barrel
 * (`src/index.ts`), which is the module the carrier loader row mounts, so a
 * static value import of the package would make that row fail to load in a
 * composition that was never going to build a message at all.
 *
 * `createUserMessage` is therefore reached through this module, at the moment a
 * message actually has to be built. Nothing else in the bundle imports the
 * package for a value.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/llm-message
 */

import type { createUserMessage, UserMessage } from '@deepseek-ai/dsh-llm'

/** The upstream message constructor, named rather than spelled inline. */
type CreateUserMessage = typeof createUserMessage

/** The subset of the optional peer this module uses. */
interface LlmModule {
  readonly createUserMessage: CreateUserMessage
}

/** One plugin-attributed instruction message to build. */
export interface InstructionMessageInput {
  /** The message body. */
  readonly text: string
  /** The plugin credited with the message. */
  readonly plugin: string
}

/**
 * Build one `{ kind: 'plugin', form: 'instructions' }` user-role message.
 * @param input - the body and the plugin attribution.
 * @returns the frozen message upstream's helper produced.
 * @throws {Error} when the optional peer is absent: a step that has instruction
 *   text to deliver cannot be served without it, and staying silent would drop
 *   user-visible context instead of reporting a misconfigured composition.
 */
export async function createInstructionMessage(input: InstructionMessageInput): Promise<UserMessage> {
  let module: LlmModule
  try {
    // A literal specifier on purpose, and dynamic on purpose: this is an
    // OPTIONAL peer, so resolving it while the module graph loads would break a
    // composition that legitimately omits it (see the module comment). The
    // bundler keeps it external, exactly like `agent-instructions.ts` does for
    // its own optional peer.
    module = await import('@deepseek-ai/dsh-llm')
  } catch (error: unknown) {
    throw new Error(
      'multi-root workspace: @deepseek-ai/dsh-llm is not installed, so additional roots\' instruction files '
      + `cannot be delivered as messages (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  return module.createUserMessage({
    content: [{ type: 'text', text: input.text }],
    source: { kind: 'plugin', plugin: input.plugin, form: 'instructions' },
  })
}
