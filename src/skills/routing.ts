/** Public native reads must not discover an additional Root as an unqualified project. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { skillOrigin, observedSkillOrigin } from '../compat/skills.ts'
import { wrapMethod } from '../method-wrapper.ts'
import { containsPath } from './reader.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'

export function installSkillRouting(ctx: Context): void {
  const cold = new AsyncLocalStorage<string>()
  const optionsFor = (options: SkillViewOptions): SkillViewOptions => {
    const primary = skillOrigin(ctx, options) ?? cold.getStore()
    if (primary === undefined || options.cwd === undefined) return options
    const rows = ctx.multiRootRegistry.list(primary)
    if (rows.length === 0) return options
    const lexical = resolve(options.cwd), canonical = canonicalPath(options.cwd)
    return rows.some(root => containsPath(root.path, lexical) || containsPath(root.path, canonical)) ? { ...options, cwd: primary } : options
  }
  ctx.inject(['skills'], scope => {
    const registry = scope.skills
    scope.effect(() => wrapMethod(registry, 'snapshot', original => function(this: typeof registry, options = {}) { return original.call(this, optionsFor(options)) }))
    scope.effect(() => wrapMethod(registry, 'get', original => function(this: typeof registry, name, options = {}) { return original.call(this, name, optionsFor(options)) }))
  })
  ctx.inject(['sessionSkillCatalog', 'sessionQuery'], scope => {
    scope.effect(() => wrapMethod(scope.sessionSkillCatalog, 'list', original => async function(this: typeof scope.sessionSkillCatalog, request, signal) {
      const primary = await observedSkillOrigin(scope, request.sessionId)
      return await cold.run(primary, () => original.call(this, request, signal))
    }))
  })
}
