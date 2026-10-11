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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  // The harness home is `$HOME/.dsh` — on Windows the home variable is
  // `USERPROFILE`, so both spellings are refused for the operator's real home.
  const userHome = process.env.HOME ?? process.env.USERPROFILE
  const realHome = userHome === undefined ? undefined : join(userHome, '.dsh')
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

/**
 * pnpm's supply-chain recovery, confined to the scratch home.
 *
 * pnpm ≥10 refuses a dependency's build scripts unless the profile's
 * `pnpm-workspace.yaml` rules on them, so a first `dsh plugin add` of a source
 * carrying `koffi` can fail with `ERR_PNPM_IGNORED_BUILDS` and leave
 * `koffi: set this to true or false` pending there. The documented recovery —
 * ruling the pending entries `true` and re-running the same add — is applied
 * ONLY here, inside a verified scratch home; nothing in the repository or the
 * operator's real home is touched. The first add's verbatim output is logged so
 * the docs can quote the exact prompt.
 * @returns the recovered outcome, or the original failure untouched.
 */
async function recoverBuildApproval(first, args, profile, home) {
  const output = `${first.stdout}\n${first.stderr}`
  const pendingFile = join(home, 'profiles', profile, 'pnpm-workspace.yaml')
  const ignored = [...output.matchAll(/Ignored build scripts: ([^\n]+)/g)]
    .flatMap(match => match[1].split(',').map(entry => entry.trim()))
  const hasPendingMarker = existsSync(pendingFile) && readFileSync(pendingFile, 'utf8').includes('set this to true or false')
  if (ignored.length === 0 && !hasPendingMarker) return first
  console.log(`[dsh-runtime] first \`dsh plugin add\` stopped at build approval (exit ${first.code}); verbatim output:`)
  process.stdout.write(first.stdout)
  process.stderr.write(first.stderr)
  // Approve ONLY `koffi` — the dependency the troubleshooting doc names. Any
  // other ignored build script is a new finding, not something to approve.
  const unapproved = ignored.filter(entry => !/^koffi@/.test(entry))
  if (unapproved.length > 0) {
    console.log('[dsh-runtime] koffi approved; OTHER ignored build scripts were NOT approved:')
    for (const entry of unapproved) console.log(`  ${entry}`)
  }
  let yaml = existsSync(pendingFile) ? readFileSync(pendingFile, 'utf8') : 'packages:\n  - .\n'
  if (/^(\s*['"]?koffi['"]?\s*:\s*)set this to true or false\s*$/m.test(yaml)) {
    yaml = yaml.replace(/^(\s*['"]?koffi['"]?\s*:\s*)set this to true or false\s*$/m, '$1true')
  } else if (/^\s*allowBuilds:\s*$/m.test(yaml)) {
    yaml = yaml.replace(/^(\s*)allowBuilds:\s*$/m, '$1allowBuilds:\n$1  koffi: true')
  } else {
    yaml = `${yaml.trimEnd()}\n\nallowBuilds:\n  koffi: true\n`
  }
  writeFileSync(pendingFile, yaml)
  const stillPending = yaml.match(/^\s*['"]?(\S+?)['"]?\s*:\s*set this to true or false\s*$/gm)
  if (stillPending !== null) {
    console.log('[dsh-runtime] other pending allowBuilds entries were NOT approved:')
    for (const line of stillPending) console.log(`  ${line.trim()}`)
  }
  console.log('[dsh-runtime] applied the documented recovery: `koffi` allowBuild set to `true` in the scratch profile; re-running the same add')
  const second = await captureDsh(args, { DSH_HOME: home })
  if (second.code === 0) {
    console.log('[dsh-runtime] install succeeded after the allowBuilds recovery')
    return second
  }
  console.log(`[dsh-runtime] the add still failed after allowBuilds recovery (exit ${second.code}); verbatim output:`)
  process.stdout.write(second.stdout)
  process.stderr.write(second.stderr)
  return second
}

/**
 * Verify the package actually became a profile bundle, and force the
 * reconciler to look at it when a build-approval-interrupted first add left
 * the dependency half-registered.
 *
 * The plugin manager's reconcile pass only evaluates dependencies that are
 * NEW since before the run. A first `pnpm add` that fails at the
 * build-approval stage has still written the dependency and installed it, so
 * the recovered second add sees it as already present and skips activation —
 * the package sits in `dependencies` while `dsh.profile.bundles` keeps only
 * the template bundles. The supported way to make reconcile evaluate it is a
 * real `remove` + `add` cycle through the same `dsh plugin` command, still
 * inside the scratch home.
 * @param profile - the profile that was just installed into.
 * @param home - the isolated `$DSH_HOME`.
 * @param source - the original add source (reused verbatim).
 * @param args - the original CLI arguments (reused verbatim).
 * @returns 0 when the plugin is an active bundle, 1 otherwise.
 */
async function ensureBundleActivated(profile, home, source, args) {
  const manifestPath = join(home, 'profiles', profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = require('@dsh-electron/dsh-plugin-multi-root-workspace/package.json').name
  if ((manifest.dsh?.profile?.bundles ?? []).includes(name)) return 0
  console.log(`[dsh-runtime] ${name} was installed as a dependency but NOT activated in dsh.profile.bundles — ` +
    'the build-approval-interrupted first add left it already present, so the recovered add\'s reconcile skipped it; ' +
    're-registering through a real `remove` + `add` cycle')
  const removed = await runDsh(['plugin', '--profile', profile, 'remove', name], { DSH_HOME: home })
  if (removed !== 0) {
    console.error(`[dsh-runtime] \`dsh plugin remove ${name}\` failed (exit ${removed}) — cannot force bundle activation`)
    return removed
  }
  const readded = await runDsh(args, { DSH_HOME: home })
  if (readded !== 0) return readded
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if ((after.dsh?.profile?.bundles ?? []).includes(name)) {
    console.log('[dsh-runtime] bundle activation confirmed after remove + add')
    return 0
  }
  console.error(`[dsh-runtime] ${name} is STILL absent from dsh.profile.bundles after remove + add — ` +
    'the plugin manager did not recognize the package as a bundle')
  return 1
}

/**
 * Candidate-only exact installation exemption, confined to a disposable smoke home.
 * @param profile - the profile to install into.
 * @param home - the isolated `$DSH_HOME`.
 * @param source - what `dsh plugin add` installs: this package's directory, or a
 *   packed tarball path (`smoke:packed` proves the shipped artifact, not the
 *   checkout).
 */
export async function installPluginProfile(profile, home, source = pluginPackageDir()) {
  assertIsolatedHome(home)
  const args = ['plugin', '--profile', profile, 'add', source]
  let first = await captureDsh(args, { DSH_HOME: home })
  if (first.code === 0) {
    // What the docs need to know: whether the first add even ASKED for build
    // approval (koffi's install script, the pending allowBuilds prompt).
    console.log(`[dsh-runtime] first \`dsh plugin add ${source.endsWith('.tgz') ? '<tgz>' : source}\` exited 0 — no build-approval stop`)
    return 0
  }
  first = await recoverBuildApproval(first, args, profile, home)
  if (first.code === 0) return await ensureBundleActivated(profile, home, source, args)
  if (process.env.DSH_MULTI_ROOT_COMPAT !== 'warn' || !first.stderr.includes('allow-version')) {
    process.stderr.write(first.stderr)
    return first.code
  }
  const plugin = require('@dsh-electron/dsh-plugin-multi-root-workspace/package.json')
  const runtime = runtimeRequire()('@deepseek-ai/dsh/package.json').version
  const allowed = await runDsh(['plugin', '--profile', profile, 'allow-version', `${plugin.name}@${plugin.version}`,
    '--dsh-version', runtime, '--accept-risk'], { DSH_HOME: home })
  if (allowed !== 0) return allowed
  const readded = await runDsh(args, { DSH_HOME: home })
  if (readded !== 0) return readded
  return await ensureBundleActivated(profile, home, source, args)
}
