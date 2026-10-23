/** Optional Skills host entry. Kept outside the carrier's module evaluation graph. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './registry.ts'
import type {} from './scope.ts'
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
  get enabled(): boolean { return configValue(this.settingsConfig.enabled) !== false }
}
export default MultiRootSkills
