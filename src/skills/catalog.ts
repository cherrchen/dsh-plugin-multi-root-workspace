/** Origin-scoped metadata discovery; Registry remains the only registration source. */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SkillCandidate, SkillLookupOptions } from '@deepseek-ai/dsh-skill'
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
  private readonly readers = new Map<string, Promise<Reader | undefined>>()
  constructor(private readonly ctx: Context, private readonly signal: AbortSignal, private readonly enabled: () => boolean) {}
  current(primary: string, id: string): RootStatus | undefined {
    if (this.signal.aborted || !this.enabled() || this.ctx.multiRootRegistry.authority.kind !== 'active') return undefined
    const rows = this.ctx.multiRootRegistry.list(primary)
    const root = rows.find(row => row.id === id)
    if (root === undefined || root.state !== 'available' || root.skillsEnabled !== true || !skillsMetadataValid(root, rows)) return undefined
    const recorded = root.recordedPath ?? root.readOnlyRecordedPath ?? root.readWriteRecordedPath
    try { return recorded === canonicalPath(root.path) && statSync(root.path).isDirectory() ? root : undefined } catch { return undefined }
  }
  async reader(primary: string, id: string): Promise<Reader | undefined> {
    const root = this.current(primary, id)
    if (root === undefined) return undefined
    const key = `${primary}\0${id}\0${root.path}`
    let reader = this.readers.get(key)
    if (reader === undefined) {
      reader = rootReader(this.ctx, root.path, this.signal, () => this.current(primary, id)?.path === root.path)
      this.readers.set(key, reader)
      reader.catch(() => { if (this.readers.get(key) === reader) this.readers.delete(key) })
    }
    return await reader
  }
  async list(primary: string, options: SkillLookupOptions): Promise<SkillCandidate[]> {
    options.signal?.throwIfAborted()
    if (!this.enabled()) return []
    const roots = await this.ctx.multiRootRegistry.refresh(primary)
    const candidates: SkillCandidate[] = []
    for (const root of roots) {
      if (this.current(primary, root.id) === undefined) continue
      const reader = await this.reader(primary, root.id)
      if (reader === undefined) continue
      try {
        const observed = await reader.list(options)
        options.signal?.throwIfAborted()
        const fresh = this.current(primary, root.id)
        if (fresh === undefined || fresh.aliasId !== root.aliasId) continue
        const seen = new Set<string>()
        for (const candidate of Array.isArray(observed) ? observed : observed.candidates) {
          if (seen.has(candidate.name)) continue
          seen.add(candidate.name)
          const locator: LocatedSkill = { primary, rootId: root.id, aliasId: root.aliasId as string, candidate }
          candidates.push({ ...candidate, provider: SKILLS_PROVIDER, name: internalSkillName(primary, root.id, candidate.name), rank: Number.MAX_SAFE_INTEGER, invocation: { modelInvocable: candidate.invocation.modelInvocable, userInvocable: false }, locator })
        }
      } catch (error: unknown) {
        options.signal?.throwIfAborted()
        this.ctx.logger.warn(`multi-root skills: discovery withheld for ${root.path}: ${String(error)}`)
      }
    }
    return candidates
  }
  async dispose(): Promise<void> {
    const readers = [...this.readers.values()]; this.readers.clear()
    await Promise.allSettled(readers.map(async reader => (await reader)?.dispose()))
  }
}
