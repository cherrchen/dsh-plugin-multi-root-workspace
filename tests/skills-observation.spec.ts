import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileSync, rmSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SkillReaderPool } from '../src/skills/pool.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { SkillsClient } from '../src/client/skills-client.ts'
let fixture: FixtureWorkspace
beforeEach(() => { fixture = createFixtureWorkspace('skills-observe') })
afterEach(() => { fixture.dispose() })

describe('shared observation pool', () => {
  it('deduplicates Roots, bounds delegates and releases LRU readers and the timer', async () => {
    const closed: string[] = [], pool = new SkillReaderPool(() => {}, 2)
    const create = (name: string) => async () => ({ dispose: async () => { closed.push(name) } }) as never
    try {
      const a = project(fixture.base, 'a'), b = project(fixture.base, 'b'), c = project(fixture.base, 'c')
      const first = await pool.use(a, create('a'), async reader => reader)
      expect(await pool.use(a, create('duplicate'), async reader => reader)).toBe(first)
      await pool.use(b, create('b'), async () => {})
      await pool.use(c, create('c'), async () => {})
      expect(pool.size).toBe(2); expect(closed).toEqual(['a'])
    } finally { await pool.dispose() }
    expect(closed.sort()).toEqual(['a', 'b', 'c']); expect(pool.size).toBe(0)
  })

  it('invalidates on actual add/edit/delete and Root disappearance with one scheduler', async () => {
    let changes = 0
    const pool = new SkillReaderPool(() => { changes++ })
    const root = project(fixture.base, 'root')
    try {
      await pool.use(root, async () => undefined, async () => {})
      const path = writeSkill(root, 'review', 'first')
      await pool.poll(); expect(changes).toBe(1)
      await pool.poll(); expect(changes).toBe(1)
      writeFileSync(path, 'changed'); await pool.poll(); expect(changes).toBe(2)
      rmSync(path); await pool.poll(); expect(changes).toBe(3)
      rmSync(root, { recursive: true }); await pool.poll(); expect(changes).toBe(4)
    } finally { await pool.dispose() }
  })

  it('waits rather than evicting a borrowed delegate and aborts queued admission', async () => {
    const pool = new SkillReaderPool(() => {}, 1)
    const a = project(fixture.base, 'a'), b = project(fixture.base, 'b')
    let resume!: () => void, start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const hold = pool.use(a, async () => undefined, async () => { start(); await new Promise<void>(resolve => { resume = resolve }) })
    await started
    const signal = new AbortController()
    const waiting = pool.use(b, async () => undefined, async () => {}, signal.signal)
    signal.abort(); await expect(waiting).rejects.toThrow()
    resume(); await hold; await pool.dispose()
  })

  it('ignores ordinary root outputs but detects replacement at the same path', async () => {
    let changes = 0
    const pool = new SkillReaderPool(() => { changes++ })
    const root = project(fixture.base, 'root')
    try {
      await pool.use(root, async () => undefined, async () => {})
      const output = join(root, 'output.txt')
      writeFileSync(output, 'created'); await pool.poll()
      rmSync(output); await pool.poll()
      expect(changes).toBe(0)
      renameSync(root, `${root}-old`); mkdirSync(root)
      await pool.poll(); expect(changes).toBe(1)
    } finally { await pool.dispose() }
  })
})

describe('Session read API and Client fences', () => {
  it('serves cold metadata and guarded preview; generation wakes when a Root is disabled', async () => {
    const stack = await skillsStack(fixture.base)
    try {
      const a = project(fixture.base, 'a'), root = project(fixture.base, 'root')
      writeSkill(root, 'review', 'PREVIEW BODY')
      const [row] = await stack.registry.add(a, { path: root })
      const agent = stack.agent(a)
      const cold = 'cold' as typeof agent.id; stack.headers.set(cold, { ...agent.session.header, id: cold })
      const skills = stack.ctx.multiRootSkills
      const catalog = await skills.listSession(cold)
      expect(catalog.skills.map(row => row.name)).toEqual(['root:review'])
      expect(JSON.stringify(catalog)).not.toContain('PREVIEW BODY')
      expect((await skills.previewSession(cold, 'root:review')).content).toContain('PREVIEW BODY')
      const changed = skills.changes(cold, catalog.generation)
      await stack.registry.setSkillsEnabled(a, { kind: 'id', id: row!.id }, false)
      expect((await changed).generation).toBeGreaterThan(catalog.generation)
      expect((await skills.listSession(cold)).skills).toEqual([])
      await expect(skills.previewSession(cold, 'root:review')).rejects.toThrow()
      await expect(skills.listSession('unknown')).rejects.toThrow()
    } finally { await stack.dispose() }
  })

  it('drops old Connection replies after invalidation and after a later request', async () => {
    const replies: ((value: unknown) => void)[] = []
    const client = new SkillsClient({ rpc: { call: async () => await new Promise(resolve => replies.push(resolve)) } })
    const old = client.list('a').catch(error => error)
    client.reset()
    const current = client.list('a')
    const value = { sessionId: 'a', generation: 2, enabled: true, skills: [{ name: 'root:review', description: 'new', modelInvocable: true }] }
    replies[1]!({ ok: true, value }); expect(await current).toEqual(value)
    replies[0]!({ ok: true, value: { ...value, generation: 1 } }); expect(await old).toBeInstanceOf(Error)
    expect(client.snapshot('a')).toEqual(value)
    const late = client.list('a').catch(error => error); client.reset()
    replies[2]!({ ok: true, value }); expect(await late).toBeInstanceOf(Error)
    expect(client.snapshot('a')).toBeUndefined(); client.dispose()
  })
})
