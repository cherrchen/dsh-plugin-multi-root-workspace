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
 * The rule is per DIALECT, because "this host can confine" does not mean every
 * dialect can run here:
 *
 * - a dialect the host DEMONSTRABLY ran is REQUIRED, so its assertion cannot skip
 *   and a real regression on that dialect fails the run. The probe
 *   (`scripts/check-kernel-runner.mjs`, run as `pnpm kernel:probe`) establishes
 *   that per host and exports `DSH_PROBE_VERIFIED_DIALECTS=seatbelt,…`;
 * - a dialect the host cannot run is never required. Requiring bwrap on a macOS
 *   runner — or Seatbelt on a Linux one — would fail a run for a reason that has
 *   nothing to do with this plugin;
 * - without the probe's verdict nothing is required: a developer box whose outer
 *   sandbox refuses nesting reports what it could not run, and CI is where the
 *   probe (and therefore the requirement) exists;
 * - `DSH_REQUIRE_KERNEL_RUNNER=1` overrides everything and forces REQUIRE for
 *   every dialect — the switch for checking that the skips themselves are honest.
 *
 * @module tests/support/kernel-runner
 */

/** What the probe recorded, when it ran. */
function verifiedDialects(): readonly string[] | undefined {
  const value = process.env.DSH_PROBE_VERIFIED_DIALECTS
  if (value === undefined || value.trim() === '') return undefined
  return value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/**
 * Whether this run demands a real confined execution for one dialect.
 * @param dialect - the dialect the assertion needs.
 * @returns whether an unusable runner must fail the assertion.
 */
export function kernelRunnerRequired(dialect: string): boolean {
  const forced = process.env.DSH_REQUIRE_KERNEL_RUNNER
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return true
  const verified = verifiedDialects()
  return verified === undefined ? false : verified.includes(dialect)
}

/**
 * The message to report when a runner is unusable.
 * @param detail - why the runner could not run.
 * @returns one sentence naming the runner failure and the requirement.
 */
export function unusableRunnerMessage(detail: string): string {
  return `no usable kernel runner on this host: ${String(detail).slice(0, 200)}`
}

/**
 * Fail loudly when this run required a real confined execution.
 *
 * Call this INSTEAD of skipping. With the dialect required it throws, so the
 * assertion cannot be recorded as a pass; otherwise the caller skips with the
 * returned message.
 * @param dialect - the dialect the assertion needs.
 * @param detail - why the runner could not run.
 * @returns the message to skip with (when skipping is allowed).
 * @throws {Error} when this dialect is required for this run.
 */
export function requireKernelRunner(dialect: string, detail: string): string {
  const message = unusableRunnerMessage(detail)
  if (kernelRunnerRequired(dialect)) {
    throw new Error(`${dialect}: ${message} — and this run requires it, so the assertion must not be skipped`)
  }
  return `${dialect}: ${message}`
}
