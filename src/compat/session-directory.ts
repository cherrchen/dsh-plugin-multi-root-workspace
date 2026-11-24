/** Session origin versus effective directory: identity always stays in the Session header. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'

interface WorkingDirectory {
  get(session: Session): string
}

export function effectiveDirectory(ctx: Context, session: Session): string | undefined {
  const service = ctx.get('workingDirectory' as never) as WorkingDirectory | undefined
  if (service === undefined) return session.header.cwd
  if (typeof service.get !== 'function') throw new Error('multi-root workspace: unsupported workingDirectory service')
  return service.get(session)
}

/**
 * The immutable origin of one live Session: the directory its header records.
 *
 * Upstream `0.2.3` resolves `sandboxPolicy.workspaceRoot` through the
 * `workingDirectory` service, so that policy root is the Session's current
 * directory, not its identity. The Registry key, the authorization set and the
 * prompt's primary root stay on this origin (ADR-0012); the effective
 * directory is only the display and relative-path base.
 * @param ctx - host context; the header is read directly, so the lookup does
 *   not depend on a mounted `sessions` service.
 * @param session - the live Session.
 * @returns the origin spelling verbatim — never re-resolved — or the effective
 *   directory for a Session that never recorded one (no origin exists then).
 */
export function originDirectory(ctx: Context, session: Session): string | undefined {
  const cwd = session.header.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return effectiveDirectory(ctx, session)
}

/**
 * The Session origin named by one resolved sandbox policy: the live Session's
 * header directory, never the policy's workspace root.
 *
 * A policy can be resolved without a Session (agentless or stored callers), and
 * a Session id can outlive its live Session; in both cases there is no origin
 * to distinguish from the policy root, which is then authoritative by itself.
 * @param ctx - host context carrying the Session store.
 * @param policy - the per-call policy to key by.
 * @returns the origin spelling verbatim, or `policy.workspaceRoot` when no
 *   live Session answers for it.
 */
export function policyOriginRoot(ctx: Context, policy: SandboxExecutionPolicy): string {
  const id = policy.sessionId
  if (id === undefined) return policy.workspaceRoot
  const session = ctx.get('sessions')?.get(id)
  if (session === undefined) return policy.workspaceRoot
  return originDirectory(ctx, session) ?? policy.workspaceRoot
}

/** The slice of the host projection registry this module reads. */
interface ProjectionCheckpointRegistry {
  checkpoint(session: Session): Record<string, { readonly ver?: unknown } | undefined>
}

/** Per-registry memo; `null` records a Host that exposes no working-directory unit. */
const workingDirectoryVersions = new WeakMap<object, number | null>()

/**
 * The `stateVersion` the installed Host registers its working-directory
 * projection at.
 *
 * The version is the structural marker of the event generation that unit folds:
 * releases through the `0.2.2` line register it at `1` and apply the deprecated
 * `working-directory/change`; `0.2.3` renamed the event and raised the version
 * to `3`. Reading it from the public projection checkpoint keeps the probe
 * structural — no DSH release string is compared — and it answers the case the
 * chain comparison cannot: a Session that entered another directory and
 * returned, where both candidate chains end at the same directory.
 * @param ctx - host context carrying the projection registry.
 * @param session - an attached Session the registry can checkpoint.
 * @returns the registered version, or `undefined` when the Host exposes no
 *   working-directory projection (early harnesses, bare compositions).
 */
export function workingDirectoryStateVersion(ctx: Context, session: Session): number | undefined {
  const registry = ctx.get('sessionProjections' as never) as ProjectionCheckpointRegistry | undefined
  if (registry === undefined || typeof registry.checkpoint !== 'function') return undefined
  const cached = workingDirectoryVersions.get(registry)
  if (cached !== undefined) return cached ?? undefined
  let version: number | undefined
  try {
    const row = registry.checkpoint(session)['workingDirectory']
    version = typeof row?.ver === 'number' && Number.isSafeInteger(row.ver) ? row.ver : undefined
  } catch {
    // A registry that cannot checkpoint this Session has not answered the
    // question; the chain comparison stays the fallback evidence. Cache the
    // refusal so later snapshots do not retry registry work.
    workingDirectoryVersions.set(registry, null)
    return undefined
  }
  workingDirectoryVersions.set(registry, version ?? null)
  return version
}
