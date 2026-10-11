/**
 * kernel:probe — can this host run a real confined command?
 *
 * The parity matrix and the behavior smoke both contain assertions that NEED a
 * kernel runner (macOS Seatbelt, Linux bwrap or Landlock, Windows ACL). Where
 * the host cannot run one — a developer box whose outer sandbox refuses
 * nesting, a CI image without `bwrap` — those assertions skip, and a skip is
 * indistinguishable from a pass at the end of a log. This probe turns the
 * question into a decision the CI workflow can act on:
 *
 * - at least one mechanism actually executes a confined command here ⇒ print
 *   `DSH_REQUIRE_KERNEL_RUNNER=1` for the steps that follow, so a later skip
 *   becomes a failure instead of a silent pass;
 * - none does ⇒ print why, and leave the environment alone (the later steps skip
 *   loudly, which is the honest outcome on such a host).
 *
 * The probe drives the RAW mechanisms the plugin's dialects wrap — `sandbox-exec`
 * with an allow profile, `bwrap` with the same binding flags the provider emits,
 * Landlock's `--rw` launcher, and on Windows the REAL upstream
 * `@deepseek-ai/dsh-sandbox-windows-acl` runner in standalone mode — so it
 * depends on nothing this repository builds. That keeps it usable as a
 * workflow step even when the artifact does not compile, which is exactly when
 * a green kernel suite would be most misleading.
 *
 * @module scripts/check-kernel-runner
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Repository root (this file lives in `scripts/`). */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The dialects the plugin widens, in the order the probes report them. */
const DIALECTS = ['seatbelt', 'bwrap', 'landlock', ...(process.platform === 'win32' ? ['windows-acl'] : [])]

/** Where a Linux Landlock launcher is commonly installed. */
const LANDLOCK_CANDIDATES = ['landlock-exec', 'landlock-run']

/**
 * The Seatbelt profile the plugin's own probe uses: allow the reads a shell
 * needs to start, and nothing else. If `sandbox-exec` can apply this here, a
 * confined command can run here.
 */
const SEATBELT_PROFILE = '(version 1)(allow default)(deny file-write*)'

/**
 * Whether `root` already covers `path`. Lexical is enough here: both come from
 * real directories the probe itself allocated.
 */
function contains(root, path) {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

/**
 * A writable parent outside the automatic temporary write grants — the same
 * rule `tests/support/temp-workspace.ts` applies, so a workspace placed there
 * can actually demonstrate a denial.
 */
function probeParent() {
  const candidates = [join(REPO_ROOT, '.dsh-smoke'), dirname(realpathSync.native(tmpdir())), homedir()]
  const tempGrants = [realpathSync.native(tmpdir())]
  for (const candidate of candidates) {
    if (candidate === dirname(candidate)) continue
    try {
      mkdirSync(candidate, { recursive: true })
      const probe = join(candidate, `.kernel-probe-writable-${process.pid}`)
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
      if (tempGrants.some(root => contains(root, candidate))) continue
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('no writable probe parent outside the temporary write grants')
}

/**
 * One probe: the argv to try, or a reason the mechanism is absent.
 * The landlock addon is loaded lazily so a Windows or macOS host never pays
 * for a module that cannot exist there.
 */
async function probeFor(dialect) {
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
      // DSH ships this launcher through its public addon entry point. Looking
      // only on PATH misses the actual runner the provider uses on Linux.
      if (process.platform === 'linux') {
        const { launcherPath } = await import('@deepseek-ai/node-addon-system/landlock-run')
        return { program: launcherPath(), argv: ['--ro', '/', '--rw', '/tmp', '--', 'bash', '-c', 'true'] }
      }
      for (const candidate of LANDLOCK_CANDIDATES) {
        const found = spawnSync('sh', ['-c', `command -v ${candidate}`], { encoding: 'utf8' })
        const path = found.stdout?.trim() ?? ''
        if (found.status === 0 && path !== '') {
          return { program: path, argv: ['--ro', '/', '--rw', '/tmp', '--', 'bash', '-c', 'true'] }
        }
      }
      return { program: undefined, missing: `none of ${LANDLOCK_CANDIDATES.join(', ')} is installed` }
    }
    case 'windows-acl':
      // Answered by probeWindowsAcl(): the verdict needs TWO confined spawns —
      // a runner that allows everything would pass the write and prove nothing.
      return { program: undefined, custom: true }
    default:
      throw new Error(`unknown dialect ${dialect}`)
  }
}

/**
 * The Windows ACL probe: the REAL upstream runner in standalone
 * workspace-write mode (no `--write-sid`/`--temp-write-sid` pair, so the
 * runner grants and revokes the DACLs itself — the same mechanics the
 * plugin's runner widens). A confined `node -e` must be able to write inside
 * the workspace AND be denied in a sibling directory: a confinement that
 * cannot deny is not a sandbox.
 */
function probeWindowsAcl() {
  const runner = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  const base = mkdtempSync(join(probeParent(), 'kernel-probe-'))
  const workspace = join(base, 'ws')
  const sibling = join(base, 'sibling')
  try {
    for (const dir of [workspace, sibling]) mkdirSync(dir)
    const script = target =>
      `require('fs').writeFileSync(${JSON.stringify(join(target, 'probe.txt')).replace(/\\/g, '/')}, 'x')`
    const run = (target) => spawnSync(process.execPath, [
      runner, '--workspace', workspace, '--temp', tmpdir(), '--mode', 'workspace-write',
      '--', process.execPath, '-e', script(target),
    ], { encoding: 'utf8', timeout: 60_000 })
    const inside = run(workspace)
    if (inside.error !== undefined) return { dialect: 'windows-acl', kind: 'unavailable', detail: String(inside.error.message) }
    const insideText = `${inside.stderr ?? ''}${inside.stdout ?? ''}`.trim().replace(/\s+/g, ' ')
    if (inside.status !== 0 || !existsSync(join(workspace, 'probe.txt'))) {
      return { dialect: 'windows-acl', kind: 'runner-failed', detail: insideText === '' ? `allowed-write exit ${String(inside.status)}` : insideText }
    }
    const outside = run(sibling)
    const denied = outside.status !== 0 && !existsSync(join(sibling, 'probe.txt'))
    if (!denied) {
      return {
        dialect: 'windows-acl',
        kind: 'runner-failed',
        detail: `the sibling write was NOT denied (exit ${String(outside.status)}); the runner cannot prove confinement`,
      }
    }
    return { dialect: 'windows-acl', kind: 'ok', detail: 'a confined command wrote the workspace and was denied a sibling' }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/** Run one probe and classify it the way a developer would. */
async function run(dialect) {
  if (dialect === 'windows-acl') return probeWindowsAcl()
  const probe = await probeFor(dialect)
  if (probe.program === undefined) return { dialect, kind: 'unavailable', detail: probe.missing }
  const result = spawnSync(probe.program, probe.argv, { encoding: 'utf8', timeout: 20_000 })
  if (result.error !== undefined) {
    return { dialect, kind: 'unavailable', detail: String(result.error.message) }
  }
  if (result.status === 0) return { dialect, kind: 'ok', detail: 'a confined command executed' }
  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().replace(/\s+/g, ' ')
  return { dialect, kind: 'runner-failed', detail: detail === '' ? `exit ${String(result.status)}` : detail }
}

const results = []
for (const dialect of DIALECTS) results.push(await run(dialect))
const usable = results.filter(result => result.kind === 'ok')

console.log('[kernel:probe] confined-execution availability on this host:')
for (const result of results) {
  console.log(`  - ${result.dialect}: ${result.kind} — ${result.detail.slice(0, 200)}`)
}

if (usable.length === 0) {
  console.log('[kernel:probe] no confined execution is possible here; the kernel assertions will skip and say so.')
  process.exit(0)
}

const names = usable.map(result => result.dialect).join(',')
console.log(`[kernel:probe] usable: ${names}`
  + ' — the assertions for THESE dialects must run; the others are not required here.')
// Per dialect, never "something works": requiring bwrap on a macOS runner (or
// Seatbelt on a Linux one) would fail a run for a reason this plugin cannot fix.
if (process.env.GITHUB_ENV !== undefined && process.env.GITHUB_ENV !== '') {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_ENV, `DSH_PROBE_VERIFIED_DIALECTS=${names}\n`)
  console.log(`[kernel:probe] exported DSH_PROBE_VERIFIED_DIALECTS=${names} for the remaining steps.`)
}
