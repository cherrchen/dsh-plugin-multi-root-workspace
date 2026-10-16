/**
 * smoke:packed — does the SHIPPED tarball behave like the checkout?
 *
 * `smoke:behavior` proves the repository's working tree; this smoke proves the
 * artifact a user actually installs. It packs the repository, then runs the
 * ENTIRE behavior battery in a child process with two switches:
 *
 * - `DSH_SMOKE_PLUGIN_SOURCE` — `dsh plugin add` installs the tarball, so the
 *   composition exercises the packed files (including `lib/windows-runner.js`,
 *   which is what confines the multi-root pwsh write on Windows);
 * - `DSH_SMOKE_HOME` — a scratch home OUTSIDE the repository, so the battery's
 *   "resolved plugin lives outside the checkout" assertion is meaningful.
 *
 * The first `dsh plugin add <tgz>` may stop at pnpm's build-approval prompt for
 * `koffi`; the shared installer then applies the documented recovery (pending
 * `allowBuilds` set inside the SCRATCH profile only — never a repo file) and
 * prints the verbatim exchange, so the troubleshooting doc can quote it.
 *
 * @module scripts/smoke-packed
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packTarball } from './check-pack.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const keep = process.env.DSH_SMOKE_KEEP === '1'

if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) {
  console.error('[smoke:packed] lib/ is missing — run `pnpm build` before the smoke')
  process.exit(1)
}

const { dir: packDir, tarball } = packTarball()
console.log(`[smoke:packed] packed artifact: ${tarball}`)

// The scratch home MUST live outside the repository: the battery asserts the
// installed plugin resolves to a path outside this checkout.
const smokeHome = join(tmpdir(), `dsh-packed-${process.pid}`)
console.log(`[smoke:packed] scratch home root: ${smokeHome}`)

const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'smoke-behavior.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_SMOKE_PLUGIN_SOURCE: tarball,
    DSH_SMOKE_HOME: smokeHome,
  },
})
const code = await new Promise((settle, fail) => {
  child.on('error', fail)
  child.on('close', value => settle(value ?? 1))
})

if (keep) {
  console.log(`[smoke:packed] kept scratch home root at ${smokeHome}`)
} else {
  rmSync(smokeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
rmSync(packDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })

if (code !== 0) {
  console.error(`[smoke:packed] the packed artifact failed the behavior battery (exit ${code})`)
  process.exit(code)
}
console.log('[smoke:packed] the packed artifact passed the behavior battery')
