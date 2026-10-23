import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { internalSkillName } from '../src/skills/catalog.ts'
let fixture: FixtureWorkspace, stack: Awaited<ReturnType<typeof skillsStack>>
beforeEach(async () => { fixture = createFixtureWorkspace('skills-discovery'); stack = await skillsStack(fixture.base) })
afterEach(async () => { await stack.dispose(); fixture.dispose() })

describe('production Skill discovery and native cwd routing', () => {
  it('isolates concurrent Origins sharing cwd and advertises metadata on the first native pre-step', async () => {
    const a = project(fixture.base, 'a'), b = project(fixture.base, 'b'), extraA = project(fixture.base, 'extra-a'), extraB = project(fixture.base, 'extra-b')
    writeSkill(extraA, 'review', 'A SECRET BODY'); writeSkill(extraB, 'review', 'B SECRET BODY')
    const [rootA] = await stack.registry.add(a, { path: extraA }); const [rootB] = await stack.registry.add(b, { path: extraB })
    const agentA = stack.agent(a), agentB = stack.agent(b)
    const [first, second] = await Promise.all([stack.snapshot(agentA), stack.snapshot(agentB)])
    expect(first.skills.map(row => row.name)).toEqual([internalSkillName(a, rootA!.id, 'review')])
    expect(second.skills.map(row => row.name)).toEqual([internalSkillName(b, rootB!.id, 'review')])
    const decision = await stack.preStep(agentA)
    expect(JSON.stringify(decision)).toContain(internalSkillName(a, rootA!.id, 'review'))
    expect(JSON.stringify(decision)).not.toContain('A SECRET BODY')
    expect((await stack.ctx.skills.snapshot({ cwd: extraA })).skills.some(row => row.provider === 'multi-root-workspace')).toBe(false)
  })

  it('scans both directories, preserves first-directory precedence, and rejects escaped files before parsing', async () => {
    const a = project(fixture.base, 'a'), extra = project(fixture.base, 'extra'), outside = project(fixture.base, 'outside')
    writeSkill(extra, 'review', 'FIRST'); writeSkill(extra, 'review', 'SECOND', '', '.agents/skills')
    writeSkill(extra, 'second', 'SECOND', '', '.agents/skills')
    const outsidePath = writeSkill(outside, 'outside-secret', 'SECRET')
    symlinkSync(dirname(outsidePath), join(extra, '.dsh/skills', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await stack.registry.add(a, { path: extra })
    const rows = (await stack.snapshot(stack.agent(a))).skills
    expect(rows).toHaveLength(2)
    expect(rows.every(row => !row.name.includes('outside-secret'))).toBe(true)
  })

  it('reproduces bare native discovery and blocks it for live and cold Session reads', async () => {
    const a = project(fixture.base, 'a'), extra = project(fixture.base, 'extra')
    writeSkill(a, 'primary', 'PRIMARY'); writeSkill(extra, 'review', 'EXTRA')
    const [row] = await stack.registry.add(a, { path: extra })
    const agent = stack.agent(a); agent.effectiveCwd = extra
    const raw = await stack.rawSnapshot.call(stack.ctx.skills, { cwd: extra, scope: agent })
    expect(raw.skills.some(row => row.name === 'review')).toBe(true)
    await stack.registry.setSkillsEnabled(a, { kind: 'id', id: row!.id }, false)
    expect((await stack.snapshot(agent)).skills.map(row => row.name)).toEqual(['primary'])
    expect((await stack.remote.list({ sessionId: agent.id }, new AbortController().signal)).skills.map(row => row.name)).toEqual(['primary'])
    const cold = 'cold-session' as typeof agent.id
    stack.headers.set(cold, { ...agent.session.header, id: cold })
    // Force cold native cwd inside the registered root, independently of its Origin.
    const query = stack.ctx.sessionQuery
    const observe = query.observeSession.bind(query)
    query.observeSession = async (...args) => { const value = await observe(...args); return { ...value, projections: { values: { workingDirectory: extra } } } as never }
    expect((await stack.remote.list({ sessionId: cold }, new AbortController().signal)).skills.map(row => row.name)).toEqual(['primary'])
    await expect(stack.remote.list({ sessionId: 'unknown' }, new AbortController().signal)).rejects.toThrow()
  })

  it('preserves borrowed query options with zero registrations, handles late native services and reload', async () => {
    const a = project(fixture.base, 'empty')
    const agent = stack.agent(a)
    let received: unknown
    const stop = stack.ctx.skills.registerProvider(() => ({ name: 'options-observer', list: async options => { received = options; return [] }, get: async () => undefined }))
    const options = { cwd: a, scope: agent, signal: new AbortController().signal }
    await stack.ctx.skills.snapshot(options)
    expect(received).toBe(options)
    stop()
    await stack.owner.dispose()
    const { default: Skills } = await import('../src/skills.ts')
    const reloaded = await stack.ctx.plugin(Skills)
    expect((await stack.ctx.skills.snapshot(options)).skills).toEqual([])
    await reloaded.dispose()
  })

  it('restores native instance descriptors when the Skills owner unloads', async () => {
    await stack.owner.dispose()
    expect(Object.getOwnPropertyDescriptor(stack.ctx.skills, 'snapshot')).toEqual(stack.rawSnapshotDescriptor)
    expect(Object.getOwnPropertyDescriptor(stack.ctx.skills, 'get')).toEqual(stack.rawGet)
  })
})
