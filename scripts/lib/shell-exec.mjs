/**
 * Run one foreground shell spec against whichever executor shape is installed.
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   shell.run(spec) → ShellRunResult
 * 0.1.7-alpha.1        shell.execute(spec) → handle, handle.result() → ShellRunResult
 * ```
 *
 * The settled object is what the behavior smoke reads (`exitCode`,
 * `stdout.text`, `stderr.text`, `sandbox`). The probe is the method name, not
 * the release string.
 *
 * @module scripts/lib/shell-exec
 */

/**
 * Settle one foreground command.
 * @param shell - `ctx.shell`.
 * @param spec - the executor's resolved spec.
 * @returns the settled run result.
 */
export async function runForeground(shell, spec) {
  if (typeof shell.run === 'function') return await shell.run(spec)
  if (typeof shell.execute !== 'function') {
    throw new TypeError('ctx.shell has neither run nor execute')
  }
  const execution = await shell.execute(spec)
  if (typeof execution?.result === 'function') return await execution.result()
  return execution
}
