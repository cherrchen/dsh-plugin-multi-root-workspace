/**
 * kernel:probe — can this host run a real confined command?
 *
 * The parity matrix and the behavior smoke both contain assertions that NEED a
 * kernel runner (macOS Seatbelt, Linux bwrap or Landlock). Where the host cannot
 * run one — a developer box whose outer sandbox refuses nesting, a CI image
 * without `bwrap` — those assertions skip, and a skip is indistinguishable from
 * a pass at the end of a log. This probe turns the question into a decision the
 * CI workflow can act on:
 *
 * - at least one mechanism actually executes a confined command here ⇒ print
 *   `DSH_REQUIRE_KERNEL_RUNNER=1` for the steps that follow, so a later skip
 *   becomes a failure instead of a silent pass;
 * - none does ⇒ print why, and leave the environment alone (the later steps skip
 *   loudly, which is the honest outcome on such a host).
 *
 * The probe drives the RAW mechanisms the plugin's dialects wrap — `sandbox-exec`
 * with an allow profile, `bwrap` with the same binding flags the provider emits,
 * and Landlock's `--rw` launcher — so it depends on nothing this repository
 * builds. That keeps it usable as a workflow step even when the artifact does
 * not compile, which is exactly when a green kernel suite would be most
 * misleading.
 *
 * @module scripts/check-kernel-runner
 */

import { spawnSync } from 'node:child_process'

/** The dialects the plugin widens, in the order the probes report them. */
const DIALECTS = ['seatbelt', 'bwrap', 'landlock']

/** Where a Linux Landlock launcher is commonly installed. */
const LANDLOCK_CANDIDATES = ['landlock-exec', 'landlock-run']

/**
 * The Seatbelt profile the plugin's own probe uses: allow the reads a shell
 * needs to start, and nothing else. If `sandbox-exec` can apply this here, a
 * confined command can run here.
 */
const SEATBELT_PROFILE = '(version 1)(allow default)(deny file-write*)'

/** One probe: the argv to try, or a reason the mechanism is absent. */
function probeFor(dialect) {
  switch (dialect) {
    case 'seatbelt':
      return { program: 'sandbox-exec', argv: ['-p', SEATBELT_PROFILE, '--', 'bash', '-c', 'true'] }
    case 'bwrap':
      return {
        program: 'bwrap',
        // The same flag families the provider emits for a workspace-write profile.
        argv: ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--', 'bash', '-c', 'true'],
      }
    case 'landlock': {
      for (const candidate of LANDLOCK_CANDIDATES) {
        const found = spawnSync('sh', ['-c', `command -v ${candidate}`], { encoding: 'utf8' })
        const path = found.stdout?.trim() ?? ''
        if (found.status === 0 && path !== '') {
          return { program: path, argv: ['--ro', '/', '--rw', '/tmp', '--', 'bash', '-c', 'true'] }
        }
      }
      return { program: undefined, missing: `none of ${LANDLOCK_CANDIDATES.join(', ')} is installed` }
    }
    default:
      throw new Error(`unknown dialect ${dialect}`)
  }
}

/** Run one probe and classify it the way a developer would. */
function run(dialect) {
  const probe = probeFor(dialect)
  if (probe.program === undefined) return { dialect, kind: 'unavailable', detail: probe.missing }
  const result = spawnSync(probe.program, probe.argv, { encoding: 'utf8', timeout: 20_000 })
  if (result.error !== undefined) {
    return { dialect, kind: 'unavailable', detail: String(result.error.message) }
  }
  if (result.status === 0) return { dialect, kind: 'ok', detail: 'a confined command executed' }
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().replace(/\s+/g, ' ')
  return { dialect, kind: 'runner-failed', detail: detail === '' ? `exit ${String(result.status)}` : detail }
}

const results = DIALECTS.map(run)
const usable = results.filter(result => result.kind === 'ok')

console.log('[kernel:probe] confined-execution availability on this host:')
for (const result of results) {
  console.log(`  - ${result.dialect}: ${result.kind} — ${result.detail.slice(0, 200)}`)
}

if (usable.length === 0) {
  console.log('[kernel:probe] no confined execution is possible here; the kernel assertions will skip and say so.')
  process.exit(0)
}

console.log(`[kernel:probe] usable: ${usable.map(result => result.dialect).join(', ')}`
  + ' — the kernel assertions must RUN, not skip.')
if (process.env.GITHUB_ENV !== undefined && process.env.GITHUB_ENV !== '') {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_ENV, 'DSH_REQUIRE_KERNEL_RUNNER=1\n')
  console.log('[kernel:probe] exported DSH_REQUIRE_KERNEL_RUNNER=1 for the remaining steps.')
}
