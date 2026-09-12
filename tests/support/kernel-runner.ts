/**
 * The one place that decides what a kernel assertion does when the host cannot
 * run a confined command.
 *
 * Both the parity matrix (vitest) and `smoke:behavior` (plain Node) contain
 * assertions that NEED a real kernel runner. Skipping is right on a developer box
 * whose outer sandbox refuses nesting — and wrong in CI, where the whole point of
 * the matrix is that a real confined execution happened. A skip that nobody reads
 * is how "the plugin's kernel path regressed" stays invisible for a release.
 *
 * So the rule is one line of configuration: with `DSH_REQUIRE_KERNEL_RUNNER=1`
 * (exported by `scripts/check-kernel-runner.mjs` when it actually ran a confined
 * command) an unusable runner FAILS the assertion; without it, the reason is
 * reported and the assertion is skipped.
 *
 * @module tests/support/kernel-runner
 */

/** Whether this run demands a real confined execution. */
export function kernelRunnerRequired() {
  const value = process.env.DSH_REQUIRE_KERNEL_RUNNER
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * The message to report when a runner is unusable.
 * @param detail - why the runner could not run.
 * @returns one sentence naming the runner failure and the requirement.
 */
export function unusableRunnerMessage(detail) {
  return `no usable kernel runner on this host: ${String(detail).slice(0, 200)}`
}

/**
 * Fail loudly when this run required a real confined execution.
 *
 * Call this INSTEAD of skipping. With the requirement set it throws, so the
 * assertion cannot be recorded as a pass; without it, the caller skips with the
 * message returned by {@link unusableRunnerMessage}.
 * @param detail - why the runner could not run.
 * @returns the message to skip with (when skipping is allowed).
 * @throws {Error} when `DSH_REQUIRE_KERNEL_RUNNER` is set.
 */
export function requireKernelRunner(detail) {
  const message = unusableRunnerMessage(detail)
  if (kernelRunnerRequired()) {
    throw new Error(`${message} — and DSH_REQUIRE_KERNEL_RUNNER is set, so this run must not skip it`)
  }
  return message
}
