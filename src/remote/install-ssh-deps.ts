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

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
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

const profilePattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/

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
  if (!profilePattern.test(profile) || profile === '.' || profile === '..') {
    fail('invalid-profile', `invalid profile name: ${JSON.stringify(profile)}`)
  }
  if (!(SUPPORTED_SSH_RELEASES as readonly string[]).includes(release)) {
    fail('unsupported-release', `DSH ${release} is not in the SSH support matrix (${SUPPORTED_SSH_RELEASES.join(', ')})`)
  }
  if (!isAbsolute(dsh) || !existsSync(dsh)) fail('dsh-missing', `the DSH CLI does not exist: ${dsh}`)
  return { profile, home, release, dsh }
}

function runDsh(file: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { resolvePromise({ code, stdout, stderr }) })
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
  for (const name of SSH_PEER_PACKAGES) {
    if (dependencies[name] !== release) return undefined
    const installed = readVersion(join(dir, 'node_modules', ...name.split('/'), 'package.json'))
    if (installed !== release) return undefined
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
  options: { readonly output?: (text: string, stream: 'stdout' | 'stderr') => void } = {},
): Promise<SshDependencyInstallResult> {
  const dir = resolveInstallProfileDir(request.home, request.profile)
  const env = { ...process.env, DSH_HOME: request.home }
  const cwd = request.cwd ?? request.home
  const version = await runDsh(request.dsh, ['--version'], { cwd, env }).catch((error: unknown) => {
    fail('dsh-unavailable', `cannot run the DSH CLI: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (version.code !== 0) fail('dsh-unavailable', `the DSH CLI ${request.dsh} --version failed`)
  if (version.stdout.trim() !== request.release) {
    fail('release-mismatch', `the DSH CLI reports ${JSON.stringify(version.stdout.trim())}, expected ${request.release}`)
  }
  const already = alignedProfile(dir, request.release)
  if (already !== undefined) return { status: 'ready', profile: request.profile, release: request.release, packages: already }
  const args = ['plugin', '--profile', request.profile, 'add', '--save-exact',
    ...SSH_PEER_PACKAGES.map(name => `${name}@${request.release}`)]
  const result = await runDsh(request.dsh, args, { cwd, env }).catch((error: unknown) => {
    fail('install-failed', `cannot run the DSH CLI: ${error instanceof Error ? error.message : String(error)}`)
  })
  const output = `${result.stdout}${result.stderr}`
  for (const line of output.split('\n')) {
    if (line !== '') options.output?.(line, result.stderr.includes(line) ? 'stderr' : 'stdout')
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
    const verb = result.status === 'ready' ? 'already installed' : 'installed'
    return { code: 0, message: `SSH dependencies are ${verb} for profile "${result.profile}" at DSH ${result.release}. Restart the DSH Host with this profile so it loads the four packages.` }
  } catch (error) {
    if (error instanceof SshDependencyInstallError) return { code: 1, message: `install-ssh-deps: ${error.message}` }
    return { code: 1, message: `install-ssh-deps: ${error instanceof Error ? error.message : String(error)}` }
  }
}
