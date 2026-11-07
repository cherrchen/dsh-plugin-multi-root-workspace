/**
 * The explicit remote tools row (G5): `remote_copy` and `remote_bash` in one
 * composition, behind the same Registry admission every other remote operation
 * passes. This row is NOT in `cordis.patch.yml`: the remote experiment stays
 * default-off and unreleased, and the only composition that mounts it today is
 * the dedicated headless test composition (`tests/support/remote-tools.ts`).
 *
 * A mount needs a ready remote control plane: `remoteEnvironments.enabled` plus
 * a valid deployment manifest produce the verified manifest this row builds its
 * connection manager and its model-facing capability projection from. With the
 * experiment off, or the manifest invalid, the row refuses to load — there are
 * no tools to register and no target to describe.
 *
 * The two injection seams exist because the same row serves the headless test
 * composition and, later, a real profile: `manager` is the verified connection
 * manager (default: the official SSH stack over the registry's manifest), and
 * `backends` is the execution backend factory (default: the SSH exec adapter
 * that opens its connection during preparation). Neither seam grants
 * authority: the registry still admits every call.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../compat.ts'
import type {} from '../providers.ts'
import { primaryKey } from '../roots.ts'
import { REMOTE_CONTEXT_NAME, renderRemoteCapabilities } from './capabilities.ts'
import { remoteBashTool } from './exec-tool.ts'
import type { RemoteExecutionBackend } from './exec.ts'
import { lazySshExecBackend } from './ssh-exec-backend.ts'
import { SshEnvironmentManager } from './ssh-environment.ts'
import { SshEndpointVerifier, type SshEndpointManager } from './ssh-verifier.ts'
import { remoteCopyTool, type RemoteConnectionManager } from './transfer.ts'

/**
 * What this row needs from a verified connection manager: the deployment and
 * SFTP openings a copy uses, plus the two openings endpoint verification
 * performs. The official manager implements it; a bounded test manager can too.
 */
export type RemoteToolsManager = RemoteConnectionManager & SshEndpointManager

/** The tool names this row contributes; nothing else registers them. */
export const REMOTE_TOOL_NAMES = ['remote_copy', 'remote_bash'] as const

/** The row's configuration. */
export interface Config {
  /** The experiment's own switch; absent/false means the row contributes nothing. */
  readonly enabled?: boolean
  /**
   * The verified connection manager. Defaults to the official SSH stack built
   * over the registry's manifest. The test composition injects a bounded
   * in-memory manager here so the full journey needs no network.
   */
  readonly manager?: RemoteToolsManager
  /**
   * Execution backends by environment. Defaults to the SSH adapter, which
   * opens its connection during preparation. A composition that supplies its
   * own factory accepts responsibility for the same admission contract.
   */
  readonly backends?: (environmentId: string) => RemoteExecutionBackend | undefined
}

// The compatibility and provider gates are preconditions, not collaborators:
// these tools widen a model's reach past the local workspace, so they must not
// exist on an unverified release or beside a foreign fs/sandbox provider.
export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools']

/**
 * Register the explicit tools and their capability projection.
 * @param ctx - a context that provides the registry and a tool registry.
 * @param config - the switch plus the two composition seams.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled !== true) return
  const registry = ctx.multiRootRegistry
  const manifest = registry.remoteManifest
  if (manifest === undefined) {
    throw new Error('multi-root remote tools: the remote control plane is not ready (remoteEnvironments.enabled with a valid manifest is required)')
  }
  const manager: RemoteToolsManager = config.manager ?? new SshEnvironmentManager({ manifest, logger: ctx.logger })
  const ownsManager = config.manager === undefined
  const backendFor = config.backends ?? ((environmentId: string) => {
    const environment = manifest.environments.find(entry => entry.environmentId === environmentId)
    // The SSH adapter needs a connection opening and a live generation. Probe
    // the structure, never the class: an injected manager that cannot open a
    // connection simply has no execution backend.
    const opening = manager as Partial<SshEnvironmentManager>
    return environment === undefined || typeof opening.open !== 'function' || typeof opening.generationOf !== 'function'
      ? undefined
      : lazySshExecBackend(environment, opening as SshEnvironmentManager)
  })

  // Verification is the registration path: a host that mounts these tools can
  // also register the deployment's endpoints, and it unpins the verifier on unload.
  ctx.effect(() => {
    const dispose = registry.setRemoteEndpointVerifier(new SshEndpointVerifier(manager))
    return () => {
      dispose()
      if (ownsManager) void (manager as SshEnvironmentManager).disposeAll()
    }
  })
  ctx.effect(() => ctx.tools.register(remoteCopyTool({ registry, deps: { manager } }) as never))
  ctx.effect(() => ctx.tools.register(remoteBashTool({ registry, backendFor }) as never))

  // The projection is a SOFT dependency: a composition without a system-prompt
  // seam still gets the tools, it just never describes them. The contribution
  // reads only manifest facts for the session's own primary root.
  ctx.inject(['systemPrompt', 'sandboxPolicy'], scope => {
    scope.systemPrompt.context({
      name: REMOTE_CONTEXT_NAME,
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 2,
      text: assembly => {
        const session = assembly.agent?.session
        const cwd = session?.header.cwd
        if (session === undefined || cwd === undefined || cwd === '') return ''
        const key = primaryKey(cwd)
        const bindings = manifest.bindings.filter(binding => primaryKey(binding.primary) === key)
        return renderRemoteCapabilities({
          bindings,
          environments: manifest.environments,
          mode: scope.sandboxPolicy.resolve({ session }).mode,
          status: registry.remoteStatus,
        })
      },
    })
  })
}
