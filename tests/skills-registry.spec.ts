import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { migrateRootSkills, skillsMetadataValid } from '../src/skills/metadata.ts'
import { DOMAIN_NAME } from '../src/registry.ts'

let fixture: FixtureWorkspace, stack: RegistryStack, primary: string, store: string
const ref = (id: string) => ({ kind: 'id' as const, id })
beforeEach(async () => {
  fixture = createFixtureWorkspace('skills-registry'); primary = fixture.workspace; store = join(fixture.base, 'store')
  stack = await mountRegistryStack(store)
})
afterEach(async () => { await stack.dispose(); fixture.dispose(); vi.restoreAllMocks() })
const extra = (name: string) => { const path = join(fixture.base, name); mkdirSync(path); return path }
const document = () => JSON.parse(readFileSync(join(store, `${DOMAIN_NAME}.json`), 'utf8'))
async function reopen(transform?: (data: any) => void) {
  await stack.dispose()
  if (transform) { const data = document(); transform(data); writeFileSync(stack.storeFile, JSON.stringify(data)) }
  stack = await mountRegistryStack(store)
}

describe('Skills metadata on the production Registry', () => {
  it('initializes each registered permission, permits read-only toggles, and never changes write grants', async () => {
    for (const access of ['inherit', 'read-write', 'read-only'] as const) {
      const path = extra(access)
      await stack.registry.add(primary, { path, access })
      const row = stack.registry.list(primary).at(-1)!
      expect(row.skillsEnabled).toBe(access !== 'read-only')
      expect(row.aliasId).toBe(access)
      const before = stack.scope.resolve({ mode: 'workspace-write', workspaceRoot: primary })
      await stack.registry.setSkillsEnabled(primary, ref(row.id), !row.skillsEnabled)
      expect(stack.scope.resolve({ mode: 'workspace-write', workspaceRoot: primary })).toEqual(before)
    }
    await reopen()
    expect(stack.registry.list(primary).map(row => row.skillsEnabled)).toEqual([false, false, true])
  })

  it('resets only actual access changes; alias, reorder, refresh and same-access preserve choice', async () => {
    const [row] = await stack.registry.add(primary, { path: extra('root') })
    await stack.registry.setSkillsEnabled(primary, ref(row!.id), false)
    await stack.registry.setAccess(primary, ref(row!.id), 'inherit')
    await stack.registry.setAlias(primary, ref(row!.id), 'New name')
    await stack.registry.move(primary, ref(row!.id))
    await stack.registry.refresh(primary)
    expect(stack.registry.list(primary)[0]).toMatchObject({ skillsEnabled: false, aliasId: 'root' })
    await stack.registry.setAccess(primary, ref(row!.id), 'read-write')
    expect(stack.registry.list(primary)[0]?.skillsEnabled).toBe(true)
    await stack.registry.setAccess(primary, ref(row!.id), 'read-only')
    expect(stack.registry.list(primary)[0]?.skillsEnabled).toBe(false)
  })

  it('keeps manual choice on revive without an actual permission change', async () => {
    const path = extra('revive')
    const [row] = await stack.registry.add(primary, { path })
    for (const access of [undefined, 'inherit', 'read-only'] as const) {
      await stack.registry.setSkillsEnabled(primary, ref(row!.id), false)
      rmSync(path, { recursive: true }); await stack.registry.refresh(primary); mkdirSync(path)
      await stack.registry.add(primary, { path, ...(access === undefined ? {} : { access }) })
      expect(stack.registry.list(primary)[0]?.skillsEnabled).toBe(false)
    }
    await stack.registry.setSkillsEnabled(primary, ref(row!.id), true)
    rmSync(path, { recursive: true }); await stack.registry.refresh(primary); mkdirSync(path)
    await stack.registry.add(primary, { path, access: 'inherit' })
    expect(stack.registry.list(primary)[0]?.skillsEnabled).toBe(true)
  })

  it('serializes alias edits, reserves unavailable names, and notifies metadata observers', async () => {
    const first = extra('a'), second = extra('b')
    await stack.registry.add(primary, { path: first }); await stack.registry.add(primary, { path: second })
    const rows = stack.registry.list(primary); rmSync(second, { recursive: true }); await stack.registry.refresh(primary)
    const changes: string[] = []; const stop = stack.registry.onChange(key => changes.push(key))
    await expect(stack.registry.setAliasId(primary, ref(rows[0]!.id), 'b')).rejects.toMatchObject({ code: 'invalid-alias-id' })
    const results = await Promise.allSettled(rows.map(row => stack.registry.setAliasId(primary, ref(row.id), 'same')))
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await stack.registry.setSkillsEnabled(primary, ref(rows[0]!.id), false)
    expect(changes).toHaveLength(2); stop()
    for (const alias of ['', 'Repo A', 'a:b', 'a'.repeat(49)]) {
      await expect(stack.registry.setAliasId(primary, ref(rows[0]!.id), alias)).rejects.toMatchObject({ code: 'invalid-alias-id' })
    }
  })

  it('migrates legacy records before publication, once; refresh is write-free', async () => {
    await stack.registry.add(primary, { path: extra('中文') })
    await stack.registry.add(primary, { path: extra('other'), access: 'read-only' })
    const original = document().tables.roots[primary].roots
    await reopen(data => { for (const row of data.tables.roots[primary].roots) { delete row.aliasId; delete row.skillsEnabled; row.alias = 'same' } })
    const rows = stack.registry.list(primary)
    expect(rows.map(row => row.skillsEnabled)).toEqual([true, false])
    expect(new Set(rows.map(row => row.aliasId)).size).toBe(2)
    expect(rows.every(row => skillsMetadataValid(row, rows))).toBe(true)
    expect(rows.map(row => [row.recordedPath, row.readOnlyRecordedPath])).toEqual(original.map((row: any) => [row.recordedPath, row.readOnlyRecordedPath]))
    const saved = readFileSync(stack.storeFile, 'utf8'); await stack.registry.refresh(primary)
    expect(readFileSync(stack.storeFile, 'utf8')).toBe(saved)
    await reopen(); expect(readFileSync(stack.storeFile, 'utf8')).toBe(saved)
  })

  it('keeps corrupt metadata distinct from missing fields without revoking filesystem grants', async () => {
    await stack.registry.add(primary, { path: extra('corrupt') })
    await reopen(data => { const row = data.tables.roots[primary].roots[0]; row.aliasId = 4; row.skillsEnabled = 'false' })
    const rows = stack.registry.list(primary)
    expect(rows[0]).toMatchObject({ state: 'available', aliasId: 4, skillsEnabled: 'false' })
    expect(skillsMetadataValid(rows[0]!, rows)).toBe(false)
    await stack.registry.setAlias(primary, ref(rows[0]!.id), 'display')
    await reopen()
    expect(stack.registry.list(primary)[0]).toMatchObject({ aliasId: 4, skillsEnabled: 'false', state: 'available' })
  })

  it('does not migrate a contended store and migrates on authority takeover', async () => {
    await stack.registry.add(primary, { path: extra('takeover') })
    await reopen(data => { delete data.tables.roots[primary].roots[0].aliasId })
    const contender = await mountRegistryStack(store)
    try {
      expect(contender.registry.authority.kind).toBe('contended')
      await expect(contender.registry.setSkillsEnabled(primary, { kind: 'ordinal', ordinal: 1 }, false)).rejects.toMatchObject({ code: 'registry-contended' })
      await stack.dispose(); await contender.registry.refresh(primary)
      expect(contender.registry.list(primary)[0]?.aliasId).toBe('takeover')
    } finally { await contender.dispose() }
  })

  it('withholds Skills on migration write failure while preserving registered grants', async () => {
    await stack.registry.add(primary, { path: extra('write-failure') })
    await stack.dispose()
    const data = document(); delete data.tables.roots[primary].roots[0].aliasId
    writeFileSync(stack.storeFile, JSON.stringify(data))
    let writes = 0
    stack = await mountRegistryStack(store, {}, { beforeGate: async ctx => {
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (...args) => {
        const domain = await open(...args)
        const table = domain.table('roots')
        vi.spyOn(table, 'put').mockImplementation(async () => { writes++; throw new Error('disk full') })
        return domain
      })
    } })
    const rows = stack.registry.list(primary)
    expect(rows[0]).toMatchObject({ state: 'available' })
    expect(skillsMetadataValid(rows[0]!, rows)).toBe(false)
    expect(writes).toBe(1)
    await stack.registry.refresh(primary); expect(writes).toBe(1)
  })

  it('remigrates after a legacy writer strips Skills metadata without changing grants', async () => {
    const [row] = await stack.registry.add(primary, { path: extra('downgrade') })
    await stack.registry.setSkillsEnabled(primary, ref(row!.id), false)
    await stack.registry.setAliasId(primary, ref(row!.id), 'manual')
    await reopen(data => { for (const entry of data.tables.roots[primary].roots) { delete entry.aliasId; delete entry.skillsEnabled } })
    expect(stack.registry.list(primary)[0]).toMatchObject({ aliasId: 'downgrade', skillsEnabled: true, recordedPath: row!.recordedPath })
  })

  it('allocates deterministic names independent of row order and preserves supplied invalid values', () => {
    const rows = [{ id: 'b', path: '/one', alias: 'Same', skillsEnabled: false }, { id: 'a', path: '/two', alias: 'Same' }, { id: 'c', path: '/中文', aliasId: null, skillsEnabled: null }]
    const migrated = migrateRootSkills(rows)
    expect(migrateRootSkills(migrated)).toEqual(migrated)
    expect(migrateRootSkills([...rows].reverse()).reverse()).toEqual(migrated)
    expect(migrated[2]).toMatchObject({ aliasId: null, skillsEnabled: null })
    expect(migrateRootSkills([{ id: 'd', path: '/four', aliasId: null }])[0]?.skillsEnabled).toBe(false)
    expect(migrateRootSkills([{ id: 'e', path: '/five', aliasId: 'duplicate' }, { id: 'f', path: '/six', aliasId: 'duplicate' }]).map(row => row.skillsEnabled)).toEqual([false, false])
  })
})
