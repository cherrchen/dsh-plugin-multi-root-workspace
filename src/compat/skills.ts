/** Public native Skills seams. All borrowed-scope and optional-package coupling lives here. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { isPackageInstalled } from './agent-instructions.ts'

/** Never infer authority from cwd, a preset key, or a lookalike Agent. */
export function skillAgent(ctx: Context, options: SkillLookupOptions): Agent | undefined {
  const scope = (options as SkillLookupOptions & { scope?: unknown }).scope
  if (typeof scope !== 'object' || scope === null || !('id' in scope) || typeof scope.id !== 'string') return undefined
  const agent = ctx.get('agents')?.get(scope.id as Agent['id'])
  return agent === scope ? agent : undefined
}

export function skillOrigin(ctx: Context, options: SkillLookupOptions): string | undefined {
  const cwd = skillAgent(ctx, options)?.session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? canonicalPath(cwd) : undefined
}

/** Absence is optional; a present but broken module must fail visibly. */
export async function filesystemSkillsApi(): Promise<typeof import('@deepseek-ai/dsh-skill-filesystem') | undefined> {
  if (!isPackageInstalled('@deepseek-ai/dsh-skill-filesystem')) return undefined
  const api = await import('@deepseek-ai/dsh-skill-filesystem')
  if (typeof api.FileSystemSkillProvider !== 'function') throw new Error('multi-root skills: FileSystemSkillProvider is unavailable')
  return api
}

export function volatileField<S>(schema: S): S {
  const method = (schema as S & { volatile?: () => S }).volatile
  return typeof method === 'function' ? method.call(schema) : schema
}

export function configValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && Symbol.for('cosmokit.volatile.write') in value) {
    const get = (value as { get?: () => unknown }).get
    if (typeof get === 'function') return get.call(value)
  }
  return value
}
