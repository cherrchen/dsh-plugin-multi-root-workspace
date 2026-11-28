/**
 * The profile-side SSH dependency installer shared by the published command
 * and any launcher that delegates to it.
 *
 * The installer is deliberately a separate process from the running Host: the
 * four packages are ordinary profile dependencies, and the profile writer
 * lock and package-manager configuration belong to the DSH CLI. This module
 * validates the target before writing, then runs exactly one
 * `dsh plugin --profile <name> add --save-exact <four packages>@<release>`
 * operation with a structured argv. It never accepts package names or a
 * version from the caller beyond the four fixed peers and the Host release.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote/install-ssh-deps
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { SSH_PEER_PACKAGES, SUPPORTED_SSH_RELEASES } from '../compat/dsh-version.ts'

/** Everything the installer needs; all paths are absolute. */
export interface SshDependencyInstallRequest {
  /** Profile name under `$DSH_HOME/profiles`. */
  readonly profile: string
  /** The DSH home that owns the profile. */
  readonly home: string
  /** Exact Host release the four packages must match. */
  readonly release: string
  /** Trusted DSH CLI executable. */
  readonly dsh: string
  /** Working directory for the CLI; defaults to the home directory. */
  readonly cwd?: string
}

/** The four packages after a successful operation. */
export interface SshDependencyPackage {
  readonly name: string
  readonly version: string
}

/** A completed install or an already-aligned profile. */
export interface SshDependencyInstallResult {
  /** `ready` means no write was needed; `installed` ran the CLI operation. */
  readonly status: 'ready' | 'installed'
  readonly profile: string
  readonly release: string
  readonly packages: readonly SshDependencyPackage[]
}

/** Why the installer refused or failed. */
export class SshDependencyInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SshDependencyInstallError'
  }
}

/** A user-facing result or refusal from the installer command. */
export interface SshDependencyInstallOutcome {
  readonly code: 0 | 1
  readonly message: string
}

/** Same profile-name rules as the command generator: a path component, not an escape. */
function validProfileName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && name !== 'node_modules'
    && !/[/\\\0\r\n]/.test(name)
}

function fail(code: string, message: string): never {
  throw new SshDependencyInstallError(code, message)
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function readVersion(path: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch { return undefined }
}

/**
 * Resolve the profile directory and prove it belongs to the supplied home.
 * @param home - trusted DSH home.
 * @param profile - validated profile name.
 * @returns the real profile directory, or throws when it escapes the home.
 */
export function resolveInstallProfileDir(home: string, profile: string): string {
  if (!isAbsolute(home) || /[\0\r\n]/.test(home)) fail('invalid-home', 'the DSH home must be an absolute path without control characters')
  if (!existsSync(home)) fail('invalid-home', `the DSH home does not exist: ${home}`)
  const homeReal = realpathSync(home)
  const candidate = join(homeReal, 'profiles', profile)
  if (!inside(homeReal, candidate)) fail('invalid-profile', 'the profile path escapes the DSH home')
  if (!existsSync(candidate)) {
    if (profile === 'desktop') {
      fail('profile-missing', 'the Desktop profile is not initialized; open DeepSeek Harness Desktop once, then fully quit it')
    }
    return candidate
  }
  if (profile === 'desktop' && !existsSync(join(candidate, 'package.json'))) {
    fail('profile-missing', 'the Desktop profile is not initialized; open DeepSeek Harness Desktop once, then fully quit it')
  }
  const profileReal = realpathSync(candidate)
  if (!inside(homeReal, profileReal)) fail('invalid-profile', 'the profile directory resolves outside the DSH home')
  return profileReal
}

/**
 * Parse the published installer command line.
 * @param argv - arguments after the script name.
 * @returns the validated request.
 */
export function parseSshDependencyInstallArgs(argv: readonly string[]): SshDependencyInstallRequest {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith('--')) fail('invalid-arguments', `unexpected argument ${JSON.stringify(argument)}`)
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
    if (!['profile', 'home', 'release', 'dsh'].includes(name)) fail('invalid-arguments', `unknown option --${name}`)
    if (values.has(name)) fail('invalid-arguments', `duplicate option --${name}`)
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1)
    if (value === undefined || value === '') fail('invalid-arguments', `option --${name} requires a value`)
    values.set(name, value)
  }
  const profile = values.get('profile')
  const home = values.get('home')
  const release = values.get('release')
  const dsh = values.get('dsh')
  if (profile === undefined || home === undefined || release === undefined || dsh === undefined) {
    fail('invalid-arguments', 'usage: install-ssh-deps.mjs --profile <name> --home <path> --release <version> --dsh <path>')
  }
  if (!validProfileName(profile)) {
    fail('invalid-profile', `invalid profile name: ${JSON.stringify(profile)}`)
  }
  if (!(SUPPORTED_SSH_RELEASES as readonly string[]).includes(release)) {
    fail('unsupported-release', `DSH ${release} is not in the SSH support matrix (${SUPPORTED_SSH_RELEASES.join(', ')})`)
  }
  if (!isAbsolute(dsh) || !existsSync(dsh)) fail('dsh-missing', `the DSH CLI does not exist: ${dsh}`)
  return { profile, home, release, dsh }
}

/** Captured output per stream. The installer only classifies success; it never needs an unbounded package-manager log in memory. */
const OUTPUT_CAPTURE_LIMIT = 8192

/** Upper bound for the version preflight or the fixed profile write. A hung package manager must not pin the Host repair queue forever. */
export const SSH_DEPENDENCY_INSTALL_TIMEOUT_MS = 5 * 60_000

function boundedAppend(current: string, chunk: string): string {
  if (current.length >= OUTPUT_CAPTURE_LIMIT) return current
  return current + chunk.slice(0, OUTPUT_CAPTURE_LIMIT - current.length)
}

/**
 * Signal every member of the child's process tree.
 *
 * The child is spawned detached on POSIX, so it leads a process group that
 * the package manager it launches shares. A negative pid signals the whole
 * group, including a descendant that keeps the inherited output pipes open
 * after the direct child is already gone; killing only the direct child
 * would leave that descendant running and the pipes open. Windows has no
 * process groups: SSH repair is never offered there, so a best-effort
 * taskkill tree termination is enough.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch { /* the group is empty or already reaped; fall through to the direct child */ }
  }
  try { child.kill(signal) } catch { /* the close event decides the result */ }
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      taskkill.once('error', () => {})
      taskkill.unref()
    } catch { /* best effort only: the SSH repair flow is not offered on Windows */ }
  }
}

function runDsh(file: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const useHostRuntime = /\.[cm]?js$/i.test(file) && isAbsolute(process.execPath) && existsSync(process.execPath)
    const executable = useHostRuntime ? process.execPath : file
    const executableArgs = useHostRuntime ? [file, ...args] : [...args]
    const env = useHostRuntime ? { ...options.env, ELECTRON_RUN_AS_NODE: '1' } : options.env
    const child = spawn(executable, executableArgs, {
      cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    // A detached child leaves the terminal's foreground process group, so an
    // interactive Ctrl+C would otherwise orphan the package manager while it
    // still holds the profile writer lock — and Node processes survive the
    // resulting EPIPE, so the orphan would not notice. Interruptions are
    // forwarded into the tree instead. When the embedding process has other
    // listeners for the signal (the Host, or a test runner), they own the
    // shutdown and the signal is not re-raised; when this forwarder is the
    // only listener, the default termination would have applied without it,
    // so the signal is re-raised after forwarding.
    const forwarders: Array<readonly ['SIGINT' | 'SIGTERM', () => void]> = []
    const removeForwarders = (): void => {
      for (const [signal, listener] of forwarders) process.removeListener(signal, listener)
      forwarders.length = 0
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = (): void => {
        killTree(child, signal)
        if (process.listenerCount(signal) === 1) {
          removeForwarders()
          process.kill(process.pid, signal)
        }
      }
      forwarders.push([signal, listener] as const)
      process.on(signal, listener)
    }

    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      removeForwarders()
      resolvePromise(result)
    }

    const timeout = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      // Closing the pipes from this side unblocks settlement even when a
      // descendant keeps its inherited copies open: 'close' can fire as soon
      // as the direct child is reaped, and the descendant's next write fails.
      child.stdout?.destroy()
      child.stderr?.destroy()
      // The escalation chain deliberately completes even when the operation
      // settles earlier: a package manager that ignored SIGTERM still has to
      // die, or it keeps the profile writer lock and defeats the retry.
      const forceKill = setTimeout(() => {
        killTree(child, 'SIGKILL')
        const backstop = setTimeout(() => {
          // SIGKILL is unconditional on POSIX, so reaching this line means the
          // platform never reported the exit. Settle anyway: a hung pipe must
          // not pin the profile-write queue open forever.
          finish({ code: null, stdout, stderr, timedOut })
        }, 2_000)
        backstop.unref()
      }, 2_000)
      forceKill.unref()
    }, options.timeoutMs)
    timeout.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout = boundedAppend(stdout, chunk) })
    child.stderr?.on('data', (chunk: string) => { stderr = boundedAppend(stderr, chunk) })
    child.once('error', error => {
      clearTimeout(timeout)
      removeForwarders()
      reject(error)
    })
    child.once('close', code => {
      finish({ code, stdout, stderr, timedOut })
    })
  })
}

/** Whether the profile already declares and resolves all four packages at the release. */
function alignedProfile(dir: string, release: string): readonly SshDependencyPackage[] | undefined {
  let dependencies: Record<string, unknown>
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
    dependencies = manifest.dependencies ?? {}
  } catch { return undefined }
  const packages: SshDependencyPackage[] = []
  const require = createRequire(join(dir, 'package.json'))
  for (const name of SSH_PEER_PACKAGES) {
    if (dependencies[name] !== release) return undefined
    const manifestPath = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    const installed = readVersion(manifestPath)
    if (installed !== release) return undefined
    let entry: string
    try { entry = require.resolve(name) } catch { return undefined }
    const root = dirname(manifestPath)
    if (entry !== root && !entry.startsWith(root + sep)) return undefined
    packages.push({ name, version: installed })
  }
  return packages
}

/**
 * Install the four SSH peers into one profile through the DSH CLI.
 *
 * The CLI is asked to verify its own version before the profile is touched;
 * a CLI at another release, an unsupported release, or a profile outside the
 * supplied home refuses without writing. An already-aligned profile returns
 * `ready` without invoking the package manager.
 * @param request - the validated install target.
 * @param options - optional output sink for the CLI; production inherits stdio.
 * @returns the completed state and the four package versions.
 */
export async function runSshDependencyInstall(
  request: SshDependencyInstallRequest,
  options: { readonly output?: (text: string, stream: 'stdout' | 'stderr') => void; readonly timeoutMs?: number } = {},
): Promise<SshDependencyInstallResult> {
  const dir = resolveInstallProfileDir(request.home, request.profile)
  const env = { ...process.env, DSH_HOME: request.home }
  const cwd = request.cwd ?? request.home
  const timeoutMs = options.timeoutMs ?? SSH_DEPENDENCY_INSTALL_TIMEOUT_MS
  const version = await runDsh(request.dsh, ['--version'], { cwd, env, timeoutMs }).catch((error: unknown) => {
    fail('dsh-unavailable', `cannot run the DSH CLI: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (version.timedOut) fail('dsh-unavailable', `the DSH CLI ${request.dsh} --version timed out`)
  if (version.code !== 0) fail('dsh-unavailable', `the DSH CLI ${request.dsh} --version failed`)
  if (version.stdout.trim() !== request.release) {
    fail('release-mismatch', `the DSH CLI reports ${JSON.stringify(version.stdout.trim())}, expected ${request.release}`)
  }
  const already = alignedProfile(dir, request.release)
  if (already !== undefined) return { status: 'ready', profile: request.profile, release: request.release, packages: already }
  const args = ['plugin', '--profile', request.profile, 'add', '--save-exact',
    ...SSH_PEER_PACKAGES.map(name => `${name}@${request.release}`)]
  const result = await runDsh(request.dsh, args, { cwd, env, timeoutMs }).catch((error: unknown) => {
    fail('install-failed', `cannot run the DSH CLI: ${error instanceof Error ? error.message : String(error)}`)
  })
  const output = `${result.stdout}${result.stderr}`
  for (const line of output.split('\n')) {
    if (line !== '') options.output?.(line, result.stderr.includes(line) ? 'stderr' : 'stdout')
  }
  if (result.timedOut) {
    fail('install-timeout', `dsh plugin add did not finish within ${timeoutMs}ms; the package-manager process was stopped`)
  }
  if (result.code !== 0) {
    fail('install-failed', `dsh plugin add failed with exit code ${String(result.code)}; diagnostics: ${output.trim().slice(-400)}`)
  }
  const installed = alignedProfile(dir, request.release)
  if (installed === undefined) {
    fail('install-incomplete', 'the CLI completed but this profile still does not resolve all four SSH packages at the Host release')
  }
  return { status: 'installed', profile: request.profile, release: request.release, packages: installed }
}

/**
 * Run the command line entry and render a short, copy-independent result.
 * @param argv - arguments after the script name.
 * @returns exit code zero on ready/installed, one on diagnostic failure.
 */
export async function main(argv: readonly string[]): Promise<SshDependencyInstallOutcome> {
  try {
    const request = parseSshDependencyInstallArgs(argv)
    const result = await runSshDependencyInstall(request, {
      output: (text, stream) => { (stream === 'stdout' ? process.stdout : process.stderr).write(text + '\n') },
    })
    const message = result.status === 'ready'
      ? `SSH dependencies are already installed and resolvable for profile "${result.profile}" at DSH ${result.release}. No write was needed; restart the DSH Host only if it started before these packages were installed.`
      : `SSH dependencies were installed for profile "${result.profile}" at DSH ${result.release}. Restart the DSH Host with this profile so it loads the four packages.`
    return { code: 0, message }
  } catch (error) {
    if (error instanceof SshDependencyInstallError) return { code: 1, message: `install-ssh-deps: ${error.message}` }
    return { code: 1, message: `install-ssh-deps: ${error instanceof Error ? error.message : String(error)}` }
  }
}
