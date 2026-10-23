/** Optional Skills host entry. Kept outside the carrier's module evaluation graph. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './registry.ts'
import type {} from './scope.ts'
import { AdditionalSkillCatalog, SKILLS_PROVIDER, type LocatedSkill } from './skills/catalog.ts'
import { installSkillInvocations } from './skills/invocation.ts'
import { installSkillRouting } from './skills/routing.ts'
import { skillOrigin, skillAgent } from './compat/skills.ts'
import type {} from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  private revision = 0
  protected [Service.init](): void {
    installSkillRouting(this.ctx)
    this.ctx.inject(['skills', 'fs'], scope => {
      const controller = new AbortController()
      const catalog = new AdditionalSkillCatalog(scope, controller.signal, () => this.enabled, () => this.revision)
      scope.effect(() => () => { controller.abort(); return catalog.dispose() })
      const known = new WeakMap<Agent, Map<string, LocatedSkill>>()
      installSkillInvocations(scope, catalog, known)
      scope.skills.registerProvider(control => {
        const invalidate = () => { this.revision++; control.invalidate() }
        scope.effect(() => scope.multiRootRegistry.onChange(invalidate))
        scope.effect(() => scope.multiRootScope.subscribe(invalidate))
        return { name: SKILLS_PROVIDER,
          list: async options => {
            const primary = skillOrigin(scope, options)
            if (primary === undefined) return []
            const entries = await catalog.list(primary, options)
            const agent = skillAgent(scope, options)!
            let tracked = known.get(agent)
            if (tracked === undefined) { tracked = new Map(); known.set(agent, tracked) }
            for (const entry of entries) tracked.set(entry.name, entry.locator as LocatedSkill)
            return entries
          },
          get: async (entry, options) => { const primary = skillOrigin(scope, options); return primary === undefined ? undefined : await catalog.load(primary, entry, options, false) },
        }
      })
    })
  }
  get enabled(): boolean { return configValue(this.settingsConfig.enabled) !== false }
}
export default MultiRootSkills
