/**
 * Compatibility adapter for where a tool result records failure.
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   content[0].isError on the tool-result block
 * 0.1.7-alpha.1 through 0.1.7-rc.2   message.isError on the tool-role message
 * ```
 *
 * A failed `read` / `write` / `edit` must not make a directory worth examining
 * (ADR-0010). The two releases store that bit in different places, and a
 * session log can carry either spelling, so both are read. Neither access is
 * written against the installed `ContentBlock` or `ToolResultMessage` type:
 * one of the two properties is absent from each release's declaration.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/tool-result
 */

/** The fields either release uses to say a tool invocation failed. */
export interface ToolResultFailureShape {
  /** `0.1.7-alpha.1` through `0.1.7-rc.2` record the outcome on the message. */
  readonly isError?: boolean
  /** `0.1.5-rc.2` and `0.1.6` record it on the first content block. */
  readonly content?: readonly object[]
}

/**
 * Whether a tool-result message reports failure, on every supported release.
 * @param message - the `tool/result` message from the session log.
 * @returns `true` when either spelling says the call failed.
 */
export function toolResultFailed(message: ToolResultFailureShape): boolean {
  if (message.isError === true) return true
  const block = message.content?.[0]
  if (typeof block !== 'object' || block === null || !('isError' in block)) return false
  return block.isError === true
}
