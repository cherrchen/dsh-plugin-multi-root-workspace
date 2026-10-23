/** Origin-scoped metadata discovery; Registry remains the only registration source. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { SkillReaderPool } from './pool.ts'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SkillCandidate, SkillLookupOptions, SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { RootStatus } from '../roots.ts'
import { skillsMetadataValid } from './metadata.ts'
import { rootReader } from './reader.ts'

export const SKILLS_PROVIDER = 'multi-root-workspace'
export function internalSkillName(primary: string, rootId: string, skillName: string): string {
  return `mr-${createHash('sha256').update(`${primary}\0${rootId}`).digest('hex')}-${skillName}`
}
export interface LocatedSkill {
  readonly primary: string
  readonly rootId: string
  readonly aliasId: string
  readonly candidate: SkillCandidate
}
export type Reader = NonNullable<Awaited<ReturnType<typeof rootReader>>>

export class AdditionalSkillCatalog {
  private readonly loadedReceipts = new WeakMap<SkillDefinition, { revision: number; locator: LocatedSkill; stamp: string }>()
  private readonly locators = new WeakSet<object>()
  private readonly requests = new AsyncLocalStorage<{ primary: string; id: string }>()
  readonly pool: SkillReaderPool
  constructor(private readonly ctx: Context, private readonly signal: AbortSignal, private readonly enabled: () => boolean, private readonly generation: () => number = () => 0, invalidate: () => void = () => {}) { this.pool = new SkillReaderPool(invalidate) }
  current(primary: string, id: string): RootStatus | undefined {
    if (this.signal.aborted || !this.enabled() || this.ctx.multiRootRegistry.authority.kind !== 'active' || this.ctx.multiRootScope.resolve({ mode: 'read-only', workspaceRoot: primary }).authority !== 'available') return undefined
    const rows = this.ctx.multiRootRegistry.list(primary)
    const root = rows.find(row => row.id === id)
    if (root === undefined || root.state !== 'available' || root.skillsEnabled !== true || !skillsMetadataValid(root, rows)) return undefined
    const recorded = root.recordedPath ?? root.readOnlyRecordedPath ?? root.readWriteRecordedPath
    try { return recorded === canonicalPath(root.path) && statSync(root.path).isDirectory() ? root : undefined } catch { return undefined }
  }
  private async withReader<T>(primary: string, id: string, options: SkillLookupOptions, run: (reader: Reader | undefined) => Promise<T>): Promise<T> {
    const root = this.current(primary, id)
    if (root === undefined) return await run(undefined)
    return await this.requests.run({ primary, id }, () => this.pool.use(root.path, signal => rootReader(this.ctx, root.path,
      AbortSignal.any([signal, this.signal]), () => {
        const request = this.requests.getStore()
        return request !== undefined && this.current(request.primary, request.id)?.path === root.path
      }), run, options.signal))
  }
  async list(primary: string, options: SkillLookupOptions): Promise<SkillCandidate[]> {
    options.signal?.throwIfAborted()
    if (!this.enabled()) return []
    const roots = await this.ctx.multiRootRegistry.refresh(primary)
    const revision = this.generation()
    const candidates: SkillCandidate[] = []
    for (const root of roots) {
      if (this.current(primary, root.id) === undefined) continue
      try {
        const observed = await this.withReader(primary, root.id, options, async reader => await reader?.list(options))
        if (observed === undefined) continue
        options.signal?.throwIfAborted()
        const fresh = this.current(primary, root.id)
        if (fresh === undefined || fresh.aliasId !== root.aliasId) continue
        const seen = new Set<string>()
        for (const candidate of Array.isArray(observed) ? observed : observed.candidates) {
          if (seen.has(candidate.name)) continue
          seen.add(candidate.name)
          const locator: LocatedSkill = { primary, rootId: root.id, aliasId: root.aliasId as string, candidate }
          this.locators.add(locator)
          candidates.push({ ...candidate, provider: SKILLS_PROVIDER, description: `/${locator.aliasId}:${candidate.name} — ${candidate.description}`, name: internalSkillName(primary, root.id, candidate.name), rank: Number.MAX_SAFE_INTEGER, invocation: { modelInvocable: candidate.invocation.modelInvocable, userInvocable: false }, locator })
        }
      } catch (error: unknown) {
        options.signal?.throwIfAborted()
        this.ctx.logger.warn(`multi-root skills: discovery withheld for ${root.path}: ${String(error)}`)
      }
    }
    return revision === this.generation() ? candidates : []
  }
  /** Locators are created here and are not accepted from a client path or object. */
  async load(primary: string, entry: SkillCandidate, options: SkillLookupOptions, user: boolean): Promise<SkillDefinition | undefined> {
    const locator = entry.locator as LocatedSkill | undefined
    if (typeof locator !== 'object' || locator === null || !this.locators.has(locator) || locator.primary !== primary) return undefined
    const root = this.current(primary, locator.rootId)
    if (root === undefined || root.aliasId !== locator.aliasId || entry.name !== internalSkillName(primary, root.id, locator.candidate.name)) return undefined
    const revision = this.generation()
    let loaded: SkillDefinition | undefined
    let stamp: string
    try {
      stamp = await fileStamp(locator.candidate.path)
      loaded = await this.withReader(primary, root.id, options, async reader => await reader?.get(locator.candidate, options))
      if (stamp !== await fileStamp(locator.candidate.path)) return undefined
    }
    catch (error: unknown) {
      options.signal?.throwIfAborted()
      this.ctx.logger.warn(`multi-root skills: load withheld: ${String(error)}`)
      return undefined
    }
    options.signal?.throwIfAborted()
    const current = this.current(primary, root.id)
    if (loaded === undefined || revision !== this.generation() || current === undefined || current.aliasId !== locator.aliasId || loaded.name !== locator.candidate.name) return undefined
    if (!(user ? loaded.invocation.userInvocable : loaded.invocation.modelInvocable)) return undefined
    const definition = { ...loaded, name: user ? `${locator.aliasId}:${loaded.name}` : entry.name, provider: SKILLS_PROVIDER,
      invocation: user ? loaded.invocation : { modelInvocable: loaded.invocation.modelInvocable, userInvocable: false } }
    this.loadedReceipts.set(definition, { revision, locator, stamp })
    return definition
  }

  async admissionValid(definition: SkillDefinition): Promise<boolean> {
    const receipt = this.loadedReceipts.get(definition)
    if (receipt === undefined) return false
    const current = this.current(receipt.locator.primary, receipt.locator.rootId)
    if (current === undefined || current.aliasId !== receipt.locator.aliasId || receipt.revision !== this.generation()) return false
    try { return receipt.stamp === await fileStamp(definition.path) && receipt.revision === this.generation() && this.current(receipt.locator.primary, receipt.locator.rootId)?.aliasId === receipt.locator.aliasId } catch { return false }
  }

  async dispose(): Promise<void> {
    await this.pool.dispose()
  }
}

async function fileStamp(path: string | undefined): Promise<string> {
  if (path === undefined) throw new Error('multi-root skills: missing file identity')
  const value = await stat(path, { bigint: true })
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
}
