/**
 * Remote command preview budgets shared by the tool layer and the unpublished
 * broker adapter's fallback.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-output-budget
 */

/**
 * Default bytes of stdout and of stderr a `remote_bash` result previews.
 * The connection's deployment limit also bounds an explicit `maxOutputBytes`.
 */
export const DEFAULT_OUTPUT_PREVIEW_BYTES = 64 * 1024

/**
 * The effective preview cap for one stream: the requested cap, clamped to the
 * deployment's declared limit. A missing or non-positive request uses the
 * default, so an old 1 MiB deployment still answers with the bounded preview.
 * @param requested - the call's optional `maxOutputBytes`.
 * @param deploymentLimit - the environment's declared limit for this stream.
 * @returns the byte cap applied to one stream.
 */
export function effectivePreviewLimit(requested: number | undefined, deploymentLimit: number): number {
  const wanted = requested !== undefined && Number.isInteger(requested) && requested >= 1
    ? requested
    : DEFAULT_OUTPUT_PREVIEW_BYTES
  return Math.min(wanted, deploymentLimit)
}
