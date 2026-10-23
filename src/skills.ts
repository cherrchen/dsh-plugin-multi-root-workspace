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
import { skillOrigin, skillAgent, observedSkillOrigin } from './compat/skills.ts'
import type {} from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillsCatalogView, SkillsPreviewView, SkillsStatusView } from './skills-contract.ts'
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
  private catalog: AdditionalSkillCatalog | undefined
  private readonly changed = new Set<() => void>()
  private closing = false
  get generation(): number { return this.revision }
  invalidate(): void { this.revision++; for (const notify of [...this.changed]) notify() }
  private status(sessionId: string): SkillsStatusView { return { sessionId, generation: this.revision, enabled: this.enabled && !this.closing } }
  async listSession(sessionId: string, signal?: AbortSignal): Promise<SkillsCatalogView> {
    signal?.throwIfAborted()
    const primary = await observedSkillOrigin(this.ctx, sessionId), revision = this.revision
    const entries = await this.catalog?.list(primary, { signal }) ?? []
    signal?.throwIfAborted()
    if (this.closing || primary !== await observedSkillOrigin(this.ctx, sessionId) || revision !== this.revision) throw new Error('multi-root skills: stale Session catalog; retry')
    return { ...this.status(sessionId), skills: entries.flatMap(entry => {
      const locator = entry.locator as LocatedSkill
      return locator.candidate.invocation.userInvocable ? [{ name: `${locator.aliasId}:${locator.candidate.name}`, description: entry.description, modelInvocable: entry.invocation.modelInvocable }] : []
    }) }
  }
  async previewSession(sessionId: string, name: string, signal?: AbortSignal): Promise<SkillsPreviewView> {
    signal?.throwIfAborted()
    const primary = await observedSkillOrigin(this.ctx, sessionId), catalog = this.catalog
    const entries = await catalog?.list(primary, { signal }) ?? []
    const entry = entries.find(entry => { const locator = entry.locator as LocatedSkill; return `${locator.aliasId}:${locator.candidate.name}` === name })
    const loaded = entry === undefined ? undefined : await catalog?.load(primary, entry, { signal }, true)
    signal?.throwIfAborted()
    if (loaded === undefined || primary !== await observedSkillOrigin(this.ctx, sessionId) || !await catalog!.admissionValid(loaded) || this.closing) throw new Error('multi-root skills: Skill is unavailable')
    return { ...this.status(sessionId), name, content: loaded.content }
  }
  async changes(sessionId: string, generation: number, signal?: AbortSignal): Promise<SkillsStatusView> {
    await observedSkillOrigin(this.ctx, sessionId)
    signal?.throwIfAborted()
    if (this.closing) throw new Error('multi-root skills: closing')
    if (generation === this.revision) await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.changed.delete(finish); signal?.removeEventListener('abort', abort); resolve() }
      const abort = () => { finish(); reject(signal?.reason) }
      const timer = setTimeout(finish, 20000); timer.unref()
      this.changed.add(finish); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    signal?.throwIfAborted()
    await observedSkillOrigin(this.ctx, sessionId)
    return this.status(sessionId)
  }
  protected async [Service.init](): Promise<void> {
    const owner = this, ctx = this.ctx
    await ctx.effect(async function* () {
      yield ctx.multiRootRegistry.onChange(() => owner.invalidate())
      yield ctx.multiRootScope.subscribe(() => owner.invalidate())
      for (const fiber of installSkillRouting(ctx)) yield fiber.dispose
      const native = ctx.inject(['skills', 'fs'], scope => {
      const controller = new AbortController()
      const catalog = new AdditionalSkillCatalog(scope, controller.signal, () => owner.enabled, () => owner.revision, () => owner.invalidate())
      owner.catalog = catalog
      scope.effect(() => () => { controller.abort(); if (owner.catalog === catalog) owner.catalog = undefined; return catalog.dispose() })
      const known = new WeakMap<Agent, Map<string, LocatedSkill>>()
      installSkillInvocations(scope, catalog, known)
      scope.skills.registerProvider(control => {
        scope.effect(() => { owner.changed.add(control.invalidate); return () => { owner.changed.delete(control.invalidate) } })
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
      yield native.dispose
      // Separate Cordis effects unload concurrently. This ordered owner closes
      // admission before draining delegates and restoring public methods.
      yield () => { owner.closing = true; owner.invalidate() }
    }, 'multi-root skills: ordered owner')
  }
  get enabled(): boolean { return !this.closing && configValue(this.settingsConfig.enabled) !== false }
}
export default MultiRootSkills
