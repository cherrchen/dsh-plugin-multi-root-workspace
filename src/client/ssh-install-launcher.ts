/**
 * The optional Desktop launcher seam for SSH dependency repair.
 *
 * Protocol v2 splits the two capabilities that the v1 sketch coupled together:
 * fixed install/upgrade and Host restart. Either capability may be present
 * without the other. Package names and argv still never cross the window
 * boundary; the page sends only the profile and Host release it already
 * displays, and a launcher result must echo that exact target. Protocol v1 was
 * never implemented by an upstream Desktop release, so this seam deliberately
 * replaces it instead of keeping a compatibility branch.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-install-launcher
 */

/** Phases the launcher may report while it owns install or restart work. */
export type SshInstallPhase = 'stopping' | 'installing' | 'restarting' | 'checking' | 'done'

/** The result of one launcher-owned fixed install/upgrade. */
export interface SshInstallLauncherResult {
  readonly status: 'ready' | 'installed' | 'restart-required'
  readonly profile: string
  readonly release: string
}

/** The result of one explicit launcher-owned Host restart. */
export interface SshRestartLauncherResult {
  readonly status: 'done' | 'restart-required'
  readonly profile: string
  readonly release: string
}

/** The operation target; the launcher supplies every executable detail. */
export interface SshInstallLauncherRequest {
  readonly profile: string
  readonly release: string
}

/** Independent capability bits: install/upgrade availability does not imply restart availability. */
export interface SshInstallLauncherCapabilities {
  readonly install: boolean
  readonly restart: boolean
}

/** A verified Desktop launcher seam. */
export interface SshInstallLauncher {
  readonly protocolVersion: 2
  readonly capabilities: SshInstallLauncherCapabilities
  install?(request: SshInstallLauncherRequest): Promise<SshInstallLauncherResult>
  restart?(request: SshInstallLauncherRequest): Promise<SshRestartLauncherResult>
  subscribe(listener: (phase: SshInstallPhase) => void): () => void
}

type LauncherWindow = Window & {
  readonly dshDesktop?: { readonly sshDependencies?: unknown }
  readonly deepseekDesktop?: { readonly sshDependencies?: unknown }
}

const phases: readonly SshInstallPhase[] = ['stopping', 'installing', 'restarting', 'checking', 'done']

function verifyTarget<T extends { readonly status: string; readonly profile: string; readonly release: string }>(
  raw: unknown, request: SshInstallLauncherRequest, statuses: readonly T['status'][],
): T {
  if (typeof raw !== 'object' || raw === null) throw new Error('launcher returned no result')
  const outcome = raw as Record<string, unknown>
  if (typeof outcome.status !== 'string' || !(statuses as readonly string[]).includes(outcome.status)) {
    throw new Error('launcher returned an unknown status')
  }
  if (typeof outcome.profile !== 'string' || typeof outcome.release !== 'string') {
    throw new Error('launcher returned an incomplete result')
  }
  if (outcome.profile !== request.profile || outcome.release !== request.release) {
    throw new Error('launcher returned a different target')
  }
  return outcome as T
}

function launcherFrom(value: unknown): SshInstallLauncher | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.protocolVersion !== 2) return undefined
  const capabilities = candidate.capabilities as Record<string, unknown> | undefined
  if (capabilities === null || capabilities === undefined || typeof capabilities.install !== 'boolean' || typeof capabilities.restart !== 'boolean') return undefined
  if (capabilities.install && typeof candidate.install !== 'function') return undefined
  if (capabilities.restart && typeof candidate.restart !== 'function') return undefined
  if (typeof candidate.subscribe !== 'function') return undefined
  return {
    protocolVersion: 2,
    capabilities: { install: capabilities.install, restart: capabilities.restart },
    ...(capabilities.install ? {
      install: async (request: SshInstallLauncherRequest) => verifyTarget<SshInstallLauncherResult>(
        await (candidate.install as (input: SshInstallLauncherRequest) => Promise<unknown>)(request),
        request, ['ready', 'installed', 'restart-required'],
      ),
    } : {}),
    ...(capabilities.restart ? {
      restart: async (request: SshInstallLauncherRequest) => verifyTarget<SshRestartLauncherResult>(
        await (candidate.restart as (input: SshInstallLauncherRequest) => Promise<unknown>)(request),
        request, ['done', 'restart-required'],
      ),
    } : {}),
    subscribe: (listener) => {
      const wrapped = (phase: unknown): void => {
        if (typeof phase === 'string' && (phases as readonly string[]).includes(phase)) listener(phase as SshInstallPhase)
      }
      const unsubscribe = (candidate.subscribe as (callback: (phase: unknown) => void) => unknown)(wrapped)
      return () => {
        if (typeof unsubscribe === 'function') (unsubscribe as () => void)()
      }
    },
  }
}

/**
 * Find a launcher that explicitly supports protocol v2.
 * @param targetWindow - the page window; a test can supply a stand-in.
 * @returns the verified operations, or undefined for Web and older Desktop builds.
 */
export function sshInstallLauncher(targetWindow: LauncherWindow = window): SshInstallLauncher | undefined {
  return launcherFrom(targetWindow.dshDesktop?.sshDependencies)
    ?? launcherFrom(targetWindow.deepseekDesktop?.sshDependencies)
}
