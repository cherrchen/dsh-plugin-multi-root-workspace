/**
 * Runtime discovery shared by the smoke scripts.
 *
 * Everything here is path-agnostic on purpose: the repository must not hardcode
 * where a dsh installation lives, and the documentation rules forbid absolute
 * machine paths. The CLI, its install anchor, and the profile home are all
 * resolved at run time from the pinned devDependencies or from environment
 * overrides.
 *
 * @module scripts/lib/dsh-runtime
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Repository root (this file lives in `scripts/lib/`). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * Absolute path of the `dsh` CLI entry to drive.
 *
 * Order: `DSH_CLI` override, then the `dsh` binary on PATH, then the pinned
 * devDependency copy. The devDependency copy is last but normally used — it is
 * the only one guaranteed to be the same version the lockfile pins.
 * @returns the CLI entry path.
 */
export function resolveDshCliPath() {
  const override = process.env.DSH_CLI
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new Error(`DSH_CLI points at a missing file: ${override}`)
    return override
  }
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/**
 * A `require` rooted at the runtime the smoke is driving, so its own copies of
 * the dsh packages are the ones that resolve — not this repository's.
 * @returns the runtime-scoped require.
 */
export function runtimeRequire() {
  return createRequire(resolveDshCliPath())
}

/**
 * The dsh installation anchor: the path the runtime resolves bundles from.
 * @returns the anchor package.json path.
 */
export function resolveInstallAnchor() {
  return runtimeRequire().resolve('@deepseek-ai/dsh/package.json')
}

/**
 * The app-boot module of the runtime under test.
 *
 * Booting through the RUNTIME's own copy is what keeps an in-process smoke
 * faithful to the CLI it claims to exercise: a differently-versioned app-boot
 * from this repository could resolve or compose profiles differently.
 * @returns the app-boot module namespace.
 */
export async function loadAppBoot() {
  const entry = createRequire(resolveInstallAnchor()).resolve('@deepseek-ai/dsh-app-boot')
  return await import(pathToFileURL(entry).href)
}

/**
 * Import one module from the runtime under test.
 *
 * A smoke that drives an Agent uses the RUNTIME's own copies (message
 * constructors, event types) rather than this repository's: the objects it
 * builds must satisfy the very schemas the runtime validates them against.
 * @param name - the module specifier, resolved from the runtime installation.
 * @returns the module namespace.
 */
export async function loadRuntimeModule(name) {
  const entry = runtimeRequire().resolve(name)
  return await import(pathToFileURL(entry).href)
}

/**
 * The profile home a smoke run drives. Always isolated: a smoke must never touch
 * the operator's real `$DSH_HOME`.
 * @param label - short directory label for this smoke run.
 * @returns the scratch home directory (created by the caller via `dsh plugin add`).
 */
export function resolveScratchHome(label) {
  const root = process.env.DSH_SMOKE_HOME ?? join(tmpdir(), 'dsh-multi-root-smoke')
  return join(root, label)
}

/**
 * Refuse to run against a home that could be an operator's real harness home.
 * @param home - the home directory a smoke is about to use.
 */
export function assertIsolatedHome(home) {
  const overridden = process.env.DSH_SMOKE_HOME !== undefined || process.env.DSH_HOME !== undefined
  const realHome = process.env.HOME === undefined ? undefined : join(process.env.HOME, '.dsh')
  if (realHome !== undefined && resolve(home) === resolve(realHome) && !overridden) {
    throw new Error(`refusing to run a smoke against the real harness home (${home})`)
  }
}

/**
 * Run the `dsh` CLI with inherited stdio and a bounded timeout.
 * @param args - CLI arguments (for example `['plugin', '--profile', 'x', 'add', path]`).
 * @param env - extra environment for the child.
 * @returns the exit code.
 */
export async function runDsh(args, env = {}) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [resolveDshCliPath(), ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  return await new Promise((settle, fail) => {
    child.on('error', fail)
    child.on('close', code => settle(code ?? 1))
  })
}

/**
 * Capture the `dsh` CLI's stdout for one invocation.
 * @param args - CLI arguments.
 * @param env - extra environment for the child.
 * @returns the captured stdout and exit code.
 */
export async function captureDsh(args, env = {}) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [resolveDshCliPath(), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((settle, fail) => {
    child.on('error', fail)
    child.on('close', value => settle(value ?? 1))
  })
  return { stdout, stderr, code }
}

/** Directory the plugin is loaded from (the bundle package root). */
export function pluginPackageDir() {
  return dirname(require.resolve('@dsh-electron/dsh-plugin-multi-root-workspace/package.json'))
}
