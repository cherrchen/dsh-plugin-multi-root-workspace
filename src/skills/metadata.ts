/** Registry metadata only; this module never resolves or grants a directory. */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { RootValidationError } from '../roots.ts'

export interface SkillsMetadata {
  readonly id: string
  readonly path: string
  readonly alias?: string | undefined
  readonly aliasId?: unknown
  readonly skillsEnabled?: unknown
  readonly readOnlyRecordedPath?: string | undefined
}
export function validAliasId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}
export function skillsMetadataValid(row: SkillsMetadata, rows: readonly SkillsMetadata[]): boolean {
  return validAliasId(row.aliasId) && typeof row.skillsEnabled === 'boolean'
    && rows.filter(other => other.aliasId === row.aliasId).length === 1
}
export function validateAliasId(value: string, others: readonly SkillsMetadata[]): string {
  if (!validAliasId(value) || others.some(row => row.aliasId === value)) {
    throw new RootValidationError('invalid-alias-id', 'aliasId must be unique kebab-case, between 1 and 48 characters')
  }
  return value
}

/** Missing metadata is legacy; malformed supplied metadata is preserved and withheld. */
export function migrateRootSkills<T extends SkillsMetadata>(rows: readonly T[]): T[] {
  const used = new Set(rows.flatMap(row => validAliasId(row.aliasId) ? [row.aliasId] : []))
  const generated = new Map<T, string>()
  for (const row of [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (row.aliasId !== undefined) continue
    const base = (row.alias || basename(row.path)).normalize('NFKD').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/g, '') || 'root'
    const aliasId = used.has(base) ? `${base}-${createHash('sha256').update(row.id).digest('hex').slice(0, 12)}` : base
    if (used.has(aliasId)) continue // A deterministic collision with a reserved alias never renames it.
    used.add(aliasId); generated.set(row, aliasId)
  }
  return rows.map(row => ({ ...row,
    ...(row.aliasId === undefined && generated.has(row) ? { aliasId: generated.get(row)! } : {}),
    ...(row.skillsEnabled === undefined ? { skillsEnabled: row.readOnlyRecordedPath === undefined } : {}),
  }))
}
