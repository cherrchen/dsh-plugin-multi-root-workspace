import type { Context } from '@deepseek-ai/cordis'
import { primaryKey } from '../roots.ts'
import { REMOTE_CONTEXT_NAME, renderRemoteCapabilities } from './capabilities.ts'
import { remoteBashTool } from './exec-tool.ts'
import type { RemoteExecutionBackend } from './exec.ts'
import { lazySshExecBackend } from './ssh-exec-backend.ts'
import type { SshEnvironmentManager } from './ssh-environment.ts'
import { SshEndpointVerifier, type SshEndpointManager } from './ssh-verifier.ts'
import { remoteCopyTool, type RemoteConnectionManager } from './transfer.ts'

/**
 * What this row needs from a verified connection manager: the deployment and
 * SFTP openings a copy uses, plus the two openings endpoint verification
 * performs. The official manager implements it; a bounded test manager can too.
 */
export type RemoteToolsManager = RemoteConnectionManager & SshEndpointManager

/** Register both tools and their verifier for a manager owned by the caller. */
export function mountRemoteTools(
  ctx: Context,
  manager: RemoteToolsManager,
  backends?: (environmentId: string) => RemoteExecutionBackend | undefined,
): void {
  const registry = ctx.multiRootRegistry
  const shutdown = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const track = <Exec extends { agent?: unknown; name: string; signal?: AbortSignal }, Result>(tool: {
    execute(args: unknown, exec: Exec): Promise<Result>
  }) => async (args: unknown, exec: Exec): Promise<Result> => {
    shutdown.signal.throwIfAborted()
    const signal = exec.signal === undefined ? shutdown.signal : AbortSignal.any([exec.signal, shutdown.signal])
    const task = tool.execute(args, { ...exec, agent: exec.agent, name: exec.name, signal })
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }

  const backendFor = backends ?? (() => {
    // Admission A (confine) and admission B (spawn) each call backendFor: the
    // lazy adapter binds its connection inside confine, so both admissions
    // must see the SAME instance — a fresh one would spawn with no bound env.
    const cache = new Map<string, RemoteExecutionBackend | undefined>()
    return (environmentId: string) => {
      if (cache.has(environmentId)) return cache.get(environmentId)
      const manifest = registry.remoteManifest
      const environment = manifest?.environments.find(entry => entry.environmentId === environmentId)
      // The SSH adapter needs a connection opening and a live generation. Probe
      // the structure, never the class: an injected manager that cannot open a
      // connection simply has no execution backend.
      const opening = manager as Partial<SshEnvironmentManager>
      const backend = environment === undefined || typeof opening.open !== 'function' || typeof opening.generationOf !== 'function'
        ? undefined
        : lazySshExecBackend(environment, opening as SshEnvironmentManager)
      cache.set(environmentId, backend)
      return backend
    }
  })()

  // Verification is the registration path: a host that mounts these tools
  // can also register the deployment's endpoints, and it unpins the verifier
  // on unload.
  ctx.effect(() => async () => { await Promise.allSettled(pending) })
  ctx.effect(() => registry.setRemoteEndpointVerifier(new SshEndpointVerifier(manager)))
  const copy = remoteCopyTool({ registry, deps: { manager } })
  const bash = remoteBashTool({ registry, backendFor })
  ctx.effect(() => ctx.tools.register({ ...copy, execute: track(copy) } as never))
  ctx.effect(() => ctx.tools.register({ ...bash, execute: track(bash) } as never))
  ctx.effect(() => () => shutdown.abort())

  // The projection is a SOFT dependency: a composition without a
  // system-prompt seam still gets the tools, it just never describes them.
  // The contribution reads only manifest facts for the session's own primary.
  ctx.inject(['systemPrompt', 'sandboxPolicy'], scope => {
    scope.systemPrompt.context({
      name: REMOTE_CONTEXT_NAME,
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 2,
      text: assembly => {
        const session = assembly.agent?.session
        const cwd = session?.header.cwd
        if (session === undefined || cwd === undefined || cwd === '') return ''
        const manifest = registry.remoteManifest
        if (manifest === undefined) return ''
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
