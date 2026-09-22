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
 * This plugin's own producer kind.
 *
 * Session format 4 rejects the shared `kind: 'plugin'` (`format v4 message
 * requires a producer-owned source kind`). The kind is ours, not
 * `agent-instructions`: upstream treats that kind's `changes` array as its
 * own reconciliation authority.
 */
export const PRODUCER_SOURCE_KIND = 'multi-root-workspace'

/**
 * The first session format whose encoder refuses `kind: 'plugin'`.
 * Earlier formats declare that kind on `MessageSourceMap` and require it.
 */
const PRODUCER_OWNED_FORMAT = 4

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'multi-root-workspace': {
      kind: 'multi-root-workspace'
      plugin: string
      form: 'instructions'
    }
  }
}

/** Either spelling of an instruction message's source. */
type InstructionSource =
  | { readonly kind: 'plugin'; readonly plugin: string; readonly form: 'instructions' }
  | { readonly kind: 'multi-root-workspace'; readonly plugin: string; readonly form: 'instructions' }

/**
 * Which source kind the installed session format will persist.
 * @param formatVersion - `SESSION_FORMAT_VERSION`, when the session package is installed.
 * @returns `plugin` through format 3, and this plugin's own kind from format 4 on.
 */
export function instructionSourceKind(formatVersion: number | undefined): InstructionSource['kind'] {
  return formatVersion !== undefined && formatVersion >= PRODUCER_OWNED_FORMAT ? PRODUCER_SOURCE_KIND : 'plugin'
}

/**
 * `createUserMessage` as this plugin calls it.
 *
 * The installed helper's `source` parameter is the release's `MessageSource`
 * union, which names `plugin` on one release and not the other. The call is
 * typed against {@link InstructionSource}; the assertion is the one place
 * that difference is allowed to show.
 */
type CreateInstructionMessage = (input: {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly source: InstructionSource
}) => UserMessage

/**
 * The installed session format, when that package is present.
 *
 * A composition that never persists a session can omit the package; format 3
 * is then the spelling that still declares `kind: 'plugin'`. Any other failure
 * is a broken install and must surface.
 * @returns the format version, or `undefined` when the package is not installed.
 */
async function installedFormatVersion(): Promise<number | undefined> {
  try {
    const session = await import('@deepseek-ai/dsh-session') as { readonly SESSION_FORMAT_VERSION?: number }
    return typeof session.SESSION_FORMAT_VERSION === 'number' ? session.SESSION_FORMAT_VERSION : undefined
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Build one user-role instruction message.
 *
 * Format 3 and earlier: `{ kind: 'plugin', plugin, form: 'instructions' }`.
 * Format 4 and later: `{ kind: 'multi-root-workspace', plugin, form: 'instructions' }`.
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
  const create = module.createUserMessage as CreateInstructionMessage
  return create({
    content: [{ type: 'text', text: input.text }],
    source: instructionSource(input.plugin, await installedFormatVersion()),
  })
}

/** The source object the installed format will persist. */
function instructionSource(plugin: string, formatVersion: number | undefined): InstructionSource {
  const kind = instructionSourceKind(formatVersion)
  if (kind === 'plugin') return { kind, plugin, form: 'instructions' }
  return { kind, plugin, form: 'instructions' }
}
