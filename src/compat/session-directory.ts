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
