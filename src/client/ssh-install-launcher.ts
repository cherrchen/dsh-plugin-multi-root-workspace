/**
 * The optional Desktop launcher operation for installing SSH dependencies.
 *
 * The launcher owns stopping the Host, the profile install, and restarting the
 * same profile. The page only requests the fixed operation with the profile
 * and release it already displays; package names and argv never cross the
 * window boundary. Web hosts and older Desktop builds expose no such bridge,
 * so the dialog keeps the copyable command and the recheck entry.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/ssh-install-launcher
 */

/** Phases the launcher may report while it owns the operation. */
export type SshInstallPhase = 'stopping' | 'installing' | 'restarting' | 'checking' | 'done'

/** The result of one launcher-owned install. */
export interface SshInstallLauncherResult {
  readonly status: 'ready' | 'installed' | 'restart-required'
  readonly profile: string
  readonly release: string
}

/** The operation the dialog may request; the launcher supplies everything else. */
export interface SshInstallLauncherRequest {
  readonly profile: string
  readonly release: string
}

/** A verified Desktop launcher operation. */
export interface SshInstallLauncher {
  readonly protocolVersion: 1
  install(request: SshInstallLauncherRequest): Promise<SshInstallLauncherResult>
  subscribe(listener: (phase: SshInstallPhase) => void): () => void
}

type LauncherWindow = Window & {
  readonly dshDesktop?: { readonly sshDependencies?: unknown }
  readonly deepseekDesktop?: { readonly sshDependencies?: unknown }
}

const phases: readonly SshInstallPhase[] = ['stopping', 'installing', 'restarting', 'checking', 'done']

function launcherFrom(value: unknown): SshInstallLauncher | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.protocolVersion !== 1 || typeof candidate.install !== 'function') return undefined
  if (!('subscribe' in candidate) || typeof candidate.subscribe !== 'function') return undefined
  return {
    protocolVersion: 1,
    install: async (request) => {
      const result = await (candidate.install as (input: SshInstallLauncherRequest) => Promise<unknown>)(request)
      if (typeof result !== 'object' || result === null) throw new Error('launcher returned no result')
      const outcome = result as Record<string, unknown>
      if (outcome.status !== 'ready' && outcome.status !== 'installed' && outcome.status !== 'restart-required') {
        throw new Error('launcher returned an unknown status')
      }
      if (typeof outcome.profile !== 'string' || typeof outcome.release !== 'string') {
        throw new Error('launcher returned an incomplete result')
      }
      if (outcome.profile !== request.profile || outcome.release !== request.release) {
        throw new Error('launcher returned a different target')
      }
      return { status: outcome.status, profile: outcome.profile, release: outcome.release }
    },
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
 * Find a launcher that explicitly supports the fixed SSH dependency action.
 * @param targetWindow - the page window; a test can supply a stand-in.
 * @returns the verified operation, or undefined for Web and older Desktop builds.
 */
export function sshInstallLauncher(targetWindow: LauncherWindow = window): SshInstallLauncher | undefined {
  return launcherFrom(targetWindow.dshDesktop?.sshDependencies)
    ?? launcherFrom(targetWindow.deepseekDesktop?.sshDependencies)
}
