/** Optional upstream workingDirectory lookup; identity always stays in the Session header. */
import type { Context } from '@deepseek-ai/cordis'
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
