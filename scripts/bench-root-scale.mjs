/**
 * bench:roots — the scale evidence behind `maxAdditionalRoots`.
 *
 * For each candidate count N it measures, on THIS host:
 *
 * - (a) `classifyStoredRoots` wall time over N real temporary directories;
 * - (b) the widened argv byte size the kernel dialects would carry: seatbelt,
 *   bwrap and landlock profiles are built synthetically (the same shapes
 *   `tests/dialects.spec.ts` pins) and then run through `widenProfileArgs`;
 * - (c) on win32 only, `workspaceScopeSid` time plus the runner argv length.
 *
 * The output is one JSON document on stdout; per-platform captures are kept
 * under `docs/reference/bench-root-scale-*.json`. Not a CI gate.
 *
 * @module scripts/bench-root-scale
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyStoredRoots } from '../src/roots.ts'
import { widenProfileArgs } from '../src/dialects.ts'
import { workspaceScopeSid } from '../src/windows-runner-contract.ts'

const SIZES = [0, 1, 4, 16, 32, 64]
const CLASSIFY_RUNS = 200

/** Median wall time of `runs` calls to `fn`, in milliseconds. */
function timeOf(fn, runs) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]
}

/** Synthetic per-dialect profile args, the shapes tests/dialects.spec.ts pins. */
function profiles(workspace) {
  const seatbelt = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) '
    + `(allow file-write* (subpath ${JSON.stringify(workspace)}) (subpath "/private/tmp") (subpath "/private/var/folders/T"))`
  return {
    seatbelt: ['sandbox-exec', '-p', seatbelt],
    bwrap: ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', workspace, workspace],
    landlock: ['/usr/local/bin/landlock-run', '--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', workspace],
  }
}

const base = mkdtempSync(join(tmpdir(), 'dsh-mr-bench-'))
const workspace = join(base, 'ws')
mkdirSync(workspace)
const pools = new Map()

try {
  for (const size of SIZES) {
    const roots = Array.from({ length: size }, (_unused, index) => {
      const dir = join(base, `r${index}`)
      mkdirSync(dir, { recursive: true })
      return { id: `root-${index}`, path: dir, recordedPath: dir, access: 'read-write', addedAt: '2026-01-01T00:00:00.000Z' }
    })
    pools.set(size, roots)
  }

  const rows = []
  for (const size of SIZES) {
    const roots = pools.get(size)
    const paths = roots.map(root => root.path)
    const classifyMs = timeOf(() => { classifyStoredRoots(workspace, roots) }, CLASSIFY_RUNS)

    const policy = { mode: 'workspace-write', workspaceRoot: workspace }
    const argv = {}
    for (const [dialect, profileArgs] of Object.entries(profiles(workspace))) {
      const widened = widenProfileArgs(dialect, profileArgs, policy, paths)
      argv[dialect] = {
        args: widened.length,
        // The size a spawn call actually carries: every byte of the profile.
        bytes: widened.reduce((total, argument) => total + argument.length + 1, 0),
      }
    }

    const windows = process.platform === 'win32'
      ? {
          scopeSidMs: timeOf(() => { workspaceScopeSid(paths) }, CLASSIFY_RUNS),
          runnerArgvLength: 1 + paths.length,
        }
      : null

    rows.push({ roots: size, classifyMs: Number(classifyMs.toFixed(4)), argv, windows })
  }

  const output = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sizes: SIZES,
    classifyRuns: CLASSIFY_RUNS,
    rows,
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
