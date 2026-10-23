/** Optional Skills host entry. Kept outside the carrier's module evaluation graph. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './registry.ts'
import type {} from './scope.ts'
import { AdditionalSkillCatalog, SKILLS_PROVIDER } from './skills/catalog.ts'
import { installSkillRouting } from './skills/routing.ts'
import { skillOrigin } from './compat/skills.ts'
import type {} from '@deepseek-ai/dsh-skill'
import { configValue, volatileField } from './compat/skills.ts'

export interface Config { readonly enabled?: boolean }
export const Config = z.object({ enabled: volatileField(z.boolean().default(true)) })

declare module '@deepseek-ai/cordis' {
  interface Context { multiRootSkills: MultiRootSkills }
}

/** Assembly owner; discovery is installed only after native services arrive. */
export class MultiRootSkills extends Service {
  static provide = 'multiRootSkills'
  static inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'multiRootScope']
  constructor(ctx: Context, private readonly settingsConfig: Config = {}) { super(ctx, 'multiRootSkills') }
  protected [Service.init](): void {
    installSkillRouting(this.ctx)
    this.ctx.inject(['skills', 'fs'], scope => {
      const controller = new AbortController()
      const catalog = new AdditionalSkillCatalog(scope, controller.signal, () => this.enabled)
      scope.effect(() => () => { controller.abort(); return catalog.dispose() })
      scope.skills.registerProvider(control => {
        scope.effect(() => scope.multiRootRegistry.onChange(() => control.invalidate()))
        scope.effect(() => scope.multiRootScope.subscribe(() => control.invalidate()))
        return { name: SKILLS_PROVIDER,
          list: async options => { const primary = skillOrigin(scope, options); return primary === undefined ? [] : await catalog.list(primary, options) },
          get: async () => undefined,
        }
      })
    })
  }
  get enabled(): boolean { return configValue(this.settingsConfig.enabled) !== false }
}
export default MultiRootSkills
