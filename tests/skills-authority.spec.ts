/** Issue #24: real lease + Registry + native Skills + a requerying client. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { internalSkillName } from '../src/skills/catalog.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

type Stack = Awaited<ReturnType<typeof skillsStack>>
let fixture: FixtureWorkspace
let stacks: Stack[]
beforeEach(() => { fixture = createFixtureWorkspace('skills-authority'); stacks = [] })
afterEach(async () => { for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })
async function mount(): Promise<Stack> {
  const stack = await skillsStack(fixture.base)
  stacks.push(stack)
  return stack
}

/** Queries immediately on change, like a client refreshing its command menu.
 * The hard cap makes the unfixed feedback loop fail safely instead of hanging.
 */
function autoClient(stack: Stack, agent: Agent & { effectiveCwd: string }) {
  const pending = new Set<Promise<unknown>>()
  const errors: unknown[] = []
  let queries = 0, changes = 0, stopped = false
  const limit = 20
  function query() {
    if (stopped || queries >= limit) return
    queries++
    const task = stack.snapshot(agent).catch(error => { errors.push(error) })
    pending.add(task)
    void task.finally(() => { pending.delete(task) })
  }
  const stop = stack.ctx.on('skills/change', () => { changes++; query() })
  return {
    query,
    get queries() { return queries },
    get changes() { return changes },
    async settle() {
      while (pending.size > 0) await Promise.all([...pending])
      expect(errors).toEqual([])
      expect(queries, 'client hit the feedback-loop safety cap').toBeLessThan(limit)
    },
    stop() { stopped = true; stop() },
  }
}

function expectWithheld(stack: Stack, primary: string) {
  for (const mode of ['workspace-write', 'danger-full-access', 'read-only'] as const) {
    expect(stack.scope.resolve({ workspaceRoot: primary, mode })).toMatchObject({
      authority: 'unavailable', additionalRoots: [], writableRoots: [],
    })
  }
  expect(stack.scope.hasActiveDenyRoots()).toBe(true)
}

describe('Registry authority does not feed a native Skills refresh loop', () => {
  it('keeps a healthy holder quiet on queries and repeated refreshes', async () => {
    const stack = await mount(), agent = stack.agent(fixture.workspace)
    const client = autoClient(stack, agent)
    try {
      client.query(); await client.settle()
      for (let i = 0; i < 3; i++) await stack.registry.refresh(fixture.workspace)
      await client.settle()
      expect(client.queries).toBe(1); expect(client.changes).toBe(0)
    } finally { client.stop() }
  })

  it.each([false, true])('stays quiet under contention and takes over after release (registered roots: %s)', async registered => {
    const holder = await mount(), primary = fixture.workspace
    const extra = project(fixture.base, 'extra')
    writeSkill(extra, 'review', 'TAKEOVER BODY')
    const row = registered ? (await holder.registry.add(primary, { path: extra }))[0]! : undefined
    const waiter = await mount(), agent = waiter.agent(primary)
    expect(waiter.registry.authority.kind).toBe('contended')
    const client = autoClient(waiter, agent)
    try {
      client.query(); await client.settle()
      for (let i = 0; i < 3; i++) await waiter.registry.refresh(primary)
      await expect(waiter.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'registry-contended' })
      await client.settle()
      expect(client.queries).toBe(1); expect(client.changes).toBe(0)
      expect((await waiter.snapshot(agent)).skills).toEqual([])
      expectWithheld(waiter, primary)
      expect(holder.registry.authority.kind).toBe('active')

      const authorities: string[] = []
      const stop = waiter.scope.subscribe(() => { authorities.push(waiter.scope.resolve({ workspaceRoot: primary, mode: 'workspace-write' }).authority) })
      try {
        await holder.dispose()
        await waiter.registry.refresh(primary)
        await client.settle()
        expect(waiter.registry.authority.kind).toBe('active')
        expect(authorities.filter(value => value === 'available')).toHaveLength(1)
        expect(client.changes).toBeGreaterThan(0)
        expect(waiter.scope.resolve({ workspaceRoot: primary, mode: 'workspace-write' })).toMatchObject({
          authority: 'available', writableRoots: registered ? [extra] : [],
        })
        const skills = (await waiter.snapshot(agent)).skills
        expect(skills.map(skill => skill.name)).toEqual(row ? [internalSkillName(primary, row.id, 'review')] : [])
        if (row) expect((await waiter.ctx.skills.get(internalSkillName(primary, row.id, 'review'), { cwd: primary, scope: agent }))?.content).toContain('TAKEOVER BODY')
        const changes = client.changes
        for (let i = 0; i < 3; i++) await waiter.registry.refresh(primary)
        await client.settle()
        expect(client.changes).toBe(changes)
      } finally { stop() }
    } finally { client.stop() }
  })

  it('stays quiet on repeated storage failures, retains its lease, and restores Skills after repair', async () => {
    const primary = fixture.workspace, extra = project(fixture.base, 'extra')
    writeSkill(extra, 'review', 'REPAIRED BODY')
    const seed = await mount()
    const [row] = await seed.registry.add(primary, { path: extra })
    await seed.dispose()
    const saved = readFileSync(seed.storeFile, 'utf8')
    writeFileSync(seed.storeFile, '{ corrupt registry')
    const failed = await mount(), agent = failed.agent(primary)
    expect(failed.registry.authority.kind).toBe('storage-failed')
    const client = autoClient(failed, agent)
    try {
      client.query(); await client.settle()
      for (let i = 0; i < 3; i++) await failed.registry.refresh(primary)
      await expect(failed.registry.add(primary, { path: extra })).rejects.toMatchObject({ code: 'storage-unavailable' })
      await client.settle()
      expect(client.queries).toBe(1); expect(client.changes).toBe(0)
      expect((await failed.snapshot(agent)).skills).toEqual([])
      expectWithheld(failed, primary)
      const contender = await mount()
      expect(contender.registry.authority.kind).toBe('contended')

      writeFileSync(failed.storeFile, saved)
      await failed.registry.refresh(primary)
      await client.settle()
      expect(failed.registry.authority.kind).toBe('active')
      expect(failed.scope.resolve({ workspaceRoot: primary, mode: 'workspace-write' }).writableRoots).toEqual([extra])
      expect((await failed.snapshot(agent)).skills.map(skill => skill.name)).toEqual([internalSkillName(primary, row!.id, 'review')])
      const changes = client.changes
      await failed.registry.refresh(primary); await client.settle()
      expect(client.changes).toBe(changes)
    } finally { client.stop() }
  })
})
