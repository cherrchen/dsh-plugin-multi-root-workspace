/**
 * Host-side fixed SSH dependency install/upgrade operation.
 *
 * The operation is intentionally narrower than the copyable installer script:
 * callers cannot choose packages, versions, argv, cwd, a shell command, or even
 * a profile. Those facts are re-derived from the trusted Host profile context
 * for every invocation. Concurrent callers either share the in-flight repair
 * for the same target or queue behind the single profile-write chain.
 */
import type { Context } from '@deepseek-ai/cordis'
import { inspectSshProfile, sshDependencyInstallTarget, type TrustedSshDependencyTarget } from '../compat/ssh-profile.ts'
import { RemoteAdmissionError } from './contract.ts'
import { runSshDependencyInstall, SshDependencyInstallError, type SshDependencyInstallRequest, type SshDependencyInstallResult } from './install-ssh-deps.ts'
import type { SshDependencyView } from './ssh-diagnostics.ts'

export interface SshDependencyOperationResult {
  readonly status: 'ready' | 'restart-required'
  readonly dependencies: SshDependencyView
}

type Installer = (request: SshDependencyInstallRequest) => Promise<SshDependencyInstallResult>

export interface SshDependencyOperationDeps {
  readonly install?: Installer
}

let writeChain: Promise<unknown> = Promise.resolve()
const active = new Map<string, Promise<SshDependencyOperationResult>>()

function keyOf(target: TrustedSshDependencyTarget): string {
  return [target.home, target.profile, target.release].join('\0')
}

function unavailable(): RemoteAdmissionError {
  return new RemoteAdmissionError(
    'ssh-deps-install-unavailable',
    'this Host cannot derive its exact profile CLI; use the displayed command manually',
  )
}

function publicFailure(error: unknown, ctx: Context): RemoteAdmissionError {
  if (error instanceof SshDependencyInstallError) {
    // The installer message may quote package-manager output. It is bounded in
    // memory, but it is not a panel-safe vocabulary item: keep the raw text in
    // Host logs and expose only a stable, retryable summary over the wire.
    ctx.logger.warn(`multi-root remote: SSH dependency repair failed (${error.code}): ${error.message}`)
  }
  return new RemoteAdmissionError(
    'ssh-deps-install-failed',
    'the fixed SSH dependency install or upgrade did not complete; retry or use the displayed command manually',
  )
}

const repairable = new Set(['ssh-deps-missing', 'ssh-deps-partial', 'ssh-deps-version', 'ssh-deps-restart'])

async function runRepair(ctx: Context, target: TrustedSshDependencyTarget, install: Installer): Promise<SshDependencyOperationResult> {
  const before = inspectSshProfile(ctx).view
  if (!repairable.has(before.code) && before.code !== 'ready') throw unavailable()
  let installed: SshDependencyInstallResult
  try {
    installed = await install(target)
  } catch (error: unknown) {
    throw publicFailure(error, ctx)
  }
  const dependencies = inspectSshProfile(ctx).view
  // `ready` from the installer means "the disk is already aligned", not that
  // the currently running Host has loaded that disk state. A write is always
  // restart-required; a no-op is ready only when the live inspection is ready.
  return {
    status: installed.status === 'ready' && dependencies.code === 'ready' ? 'ready' : 'restart-required',
    dependencies,
  }
}

/**
 * Run or join the fixed repair for this Host profile. Different targets are
 * serialized because all supported targets share the same profile write lock
 * in practice; identical concurrent targets are merged into one execution.
 */
export async function installOrUpgradeSshDependencies(
  ctx: Context,
  deps: SshDependencyOperationDeps = {},
): Promise<SshDependencyOperationResult> {
  const target = sshDependencyInstallTarget(ctx)
  if (target === undefined) throw unavailable()
  const key = keyOf(target)
  const existing = active.get(key)
  if (existing !== undefined) return existing
  const install = deps.install ?? runSshDependencyInstall
  const queued = writeChain.catch(() => undefined).then(() => runRepair(ctx, target, install))
  active.set(key, queued)
  writeChain = queued.catch(() => undefined)
  try {
    return await queued
  } finally {
    active.delete(key)
  }
}
