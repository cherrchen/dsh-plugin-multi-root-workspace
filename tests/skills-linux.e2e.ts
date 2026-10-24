/** Linux filesystem evidence for ADR-0023, including real open-file races. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { internalSkillName } from '../src/skills/catalog.ts'
import { rootReader } from '../src/skills/reader.ts'
import { SkillReaderPool } from '../src/skills/pool.ts'

describe.runIf(process.platform === 'linux')('Linux additional-root Skills', () => {
  let fixture: FixtureWorkspace, stack: Awaited<ReturnType<typeof skillsStack>>
  beforeEach(async () => { fixture = createFixtureWorkspace('skills-linux'); stack = await skillsStack(fixture.base) })
  afterEach(async () => { vi.restoreAllMocks(); await stack.dispose(); fixture.dispose() })

  it('keeps case-distinct roots separate for live and cold catalogs', async () => {
    const primary = project(fixture.base, 'primary'), upper = project(fixture.base, 'Repo'), lower = project(fixture.base, 'repo')
    expect(canonicalPath(upper)).not.toBe(canonicalPath(lower))
    writeSkill(primary, 'primary', 'PRIMARY'); writeSkill(upper, 'review', 'UPPER'); writeSkill(lower, 'review', 'LOWER')
    const [upperRoot] = await stack.registry.add(primary, { path: upper })
    const roots = await stack.registry.add(primary, { path: lower })
    const lowerRoot = roots.find(root => root.path === lower)!
    const agent = stack.agent(primary)
    agent.effectiveCwd = upper
    await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: upperRoot!.id }, false)
    const expected = ['primary', internalSkillName(primary, lowerRoot.id, 'review')].sort()
    expect((await stack.snapshot(agent)).skills.map(row => row.name).sort()).toEqual(expected)
    const observe = stack.ctx.sessionQuery.observeSession.bind(stack.ctx.sessionQuery)
    stack.ctx.sessionQuery.observeSession = async (...args) => ({ ...await observe(...args), projections: { values: { workingDirectory: upper } } }) as never
    const cold = 'linux-cold' as typeof agent.id
    stack.headers.set(cold, { ...agent.session.header, id: cold })
    expect((await stack.remote.list({ sessionId: cold }, new AbortController().signal)).skills.map(row => row.name).sort()).toEqual(['primary'])
    expect((await stack.ctx.multiRootSkills.previewSession(agent.id, `${lowerRoot.aliasId}:review`)).content).toContain('LOWER')
    await expect(stack.ctx.multiRootSkills.previewSession(agent.id, `${upperRoot!.aliasId}:review`)).rejects.toThrow()
  })

  it('withdraws old IDs and previews after a registered directory becomes an escaping symlink', async () => {
    const primary = project(fixture.base, 'primary'), extra = project(fixture.base, 'extra'), outside = project(fixture.base, 'outside')
    writeSkill(extra, 'review', 'ORIGINAL'); writeSkill(outside, 'review', 'OUTSIDE SECRET')
    const [root] = await stack.registry.add(primary, { path: extra })
    const agent = stack.agent(primary), id = internalSkillName(primary, root!.id, 'review')
    expect((await stack.ctx.multiRootSkills.previewSession(agent.id, 'extra:review')).content).toContain('ORIGINAL')
    renameSync(extra, join(fixture.base, 'original')); symlinkSync(outside, extra, 'dir')
    agent.effectiveCwd = extra
    expect((await stack.snapshot(agent)).skills).toEqual([])
    expect(stack.registry.list(primary)[0]?.state).toBe('redirected')
    expect(await stack.ctx.skills.get(id, { scope: agent, cwd: extra })).toBeUndefined()
    await expect(stack.ctx.multiRootSkills.previewSession(agent.id, 'extra:review')).rejects.toThrow()
  })

  it('observes symlink retargeting without discovering the escaped target', async () => {
    const root = project(fixture.base, 'root'), inside = join(root, 'inside'), outside = project(fixture.base, 'outside')
    mkdirSync(inside); writeSkill(root, 'review', 'INSIDE', '', 'inside'); writeSkill(outside, 'secret', 'OUTSIDE')
    const directory = join(root, '.dsh/skills'); mkdirSync(directory, { recursive: true })
    const link = join(directory, 'linked'); symlinkSync(join(inside, 'review'), link, 'dir')
    let changes = 0
    const pool = new SkillReaderPool(() => { changes++ })
    const reader = await rootReader(stack.ctx, canonicalPath(root), new AbortController().signal, () => true)
    try {
      await pool.use(root, async () => undefined, async () => {})
      expect(await reader!.list({})).toHaveLength(1)
      unlinkSync(link); symlinkSync(join(outside, '.dsh/skills/secret'), link, 'dir')
      await pool.poll(); expect(changes).toBe(1)
      expect(await reader!.list({})).toEqual([])
      await pool.poll(); expect(changes).toBe(1)
    } finally { await reader?.dispose(); await pool.dispose() }
  })

  it.each(['replace', 'delete', 'revoke', 'abort'] as const)('rejects an open-handle read after %s and closes the handle', async action => {
    const root = project(fixture.base, 'root'), path = writeSkill(root, 'review', 'HANDLE BODY')
    let valid = true
    const reader = await rootReader(stack.ctx, canonicalPath(root), new AbortController().signal, () => valid)
    const listed = await reader!.list({}), candidates = Array.isArray(listed) ? listed : listed.candidates
    expect(candidates).toHaveLength(1)
    const probe = await open(path), prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const read = prototype.readFile
    let entered!: () => void, release!: () => void, active: FileHandle | undefined
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(prototype, 'readFile').mockImplementation(async function(this: FileHandle, ...args) {
      const content = await read.apply(this, args)
      active = this; entered(); await held
      return content
    })
    const controller = new AbortController()
    const loading = reader!.get(candidates[0]!, { signal: controller.signal }).catch(error => error as Error)
    try {
      await started
      expect(active!.fd).toBeGreaterThanOrEqual(0)
      if (action === 'replace') { renameSync(path, `${path}.old`); writeSkill(root, 'review', 'REPLACEMENT') }
      if (action === 'delete') rmSync(path)
      if (action === 'revoke') valid = false
      if (action === 'abort') controller.abort()
      release()
      const result = await loading
      if (action === 'delete' || action === 'revoke') expect(result).toBeUndefined()
      else expect(result).toBeInstanceOf(Error)
      expect(active!.fd).toBe(-1)
    } finally { release(); await loading; await reader?.dispose() }
  })
})
