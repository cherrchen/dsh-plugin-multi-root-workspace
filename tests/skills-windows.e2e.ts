/** Windows filesystem evidence for ADR-0023; no simulated path dialect. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { internalSkillName } from '../src/skills/catalog.ts'
import { rootReader } from '../src/skills/reader.ts'
import { SkillReaderPool } from '../src/skills/pool.ts'

describe.runIf(process.platform === 'win32')('Windows additional-root Skills', () => {
  let fixture: FixtureWorkspace, stack: Awaited<ReturnType<typeof skillsStack>>
  beforeEach(async () => { fixture = createFixtureWorkspace('skills-windows'); stack = await skillsStack(fixture.base) })
  afterEach(async () => { vi.restoreAllMocks(); await stack.dispose(); fixture.dispose() })

  it('keeps a mixed-case effective cwd behind the Root switch for live and cold catalogs', async () => {
    const primary = project(fixture.base, 'Primary'), extra = project(fixture.base, 'MixedCaseRoot')
    writeSkill(primary, 'primary', 'PRIMARY'); writeSkill(extra, 'review', 'ADDITIONAL')
    const [root] = await stack.registry.add(primary, { path: extra })
    const agent = stack.agent(primary)
    agent.effectiveCwd = extra.toUpperCase()
    expect((await stack.snapshot(agent)).skills.map(row => row.name)).toContain(internalSkillName(primary, root!.id, 'review'))
    await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root!.id }, false)
    expect((await stack.snapshot(agent)).skills.map(row => row.name)).toEqual(['primary'])
    const observe = stack.ctx.sessionQuery.observeSession.bind(stack.ctx.sessionQuery)
    stack.ctx.sessionQuery.observeSession = async (...args) => ({ ...await observe(...args), projections: { values: { workingDirectory: extra.toLowerCase() } } }) as never
    const cold = 'windows-cold' as typeof agent.id
    stack.headers.set(cold, { ...agent.session.header, id: cold })
    expect((await stack.remote.list({ sessionId: cold }, new AbortController().signal)).skills.map(row => row.name)).toEqual(['primary'])
  })

  it('withdraws old IDs and previews when a registered directory is replaced with a junction', async () => {
    const primary = project(fixture.base, 'primary'), extra = project(fixture.base, 'extra'), outside = project(fixture.base, 'outside')
    writeSkill(extra, 'review', 'ORIGINAL'); writeSkill(outside, 'review', 'OUTSIDE SECRET')
    const [root] = await stack.registry.add(primary, { path: extra })
    const agent = stack.agent(primary), id = internalSkillName(primary, root!.id, 'review')
    expect((await stack.ctx.multiRootSkills.previewSession(agent.id, 'extra:review')).content).toContain('ORIGINAL')
    renameSync(extra, join(fixture.base, 'original'))
    symlinkSync(outside, extra, 'junction')
    agent.effectiveCwd = extra
    expect((await stack.snapshot(agent)).skills).toEqual([])
    expect(stack.registry.list(primary)[0]?.state).toBe('redirected')
    expect(await stack.ctx.skills.get(id, { scope: agent, cwd: extra })).toBeUndefined()
    await expect(stack.ctx.multiRootSkills.previewSession(agent.id, 'extra:review')).rejects.toThrow()
  })

  it('observes junction retargeting without discovering the escaped target', async () => {
    const root = project(fixture.base, 'root'), inside = join(root, 'inside'), outside = project(fixture.base, 'outside')
    mkdirSync(inside)
    writeSkill(root, 'review', 'INSIDE', '', 'inside')
    writeSkill(outside, 'secret', 'OUTSIDE')
    const directory = join(root, '.dsh/skills'); mkdirSync(directory, { recursive: true })
    const link = join(directory, 'linked')
    symlinkSync(join(inside, 'review'), link, 'junction')
    let changes = 0
    const pool = new SkillReaderPool(() => { changes++ })
    const reader = await rootReader(stack.ctx, canonicalPath(root), new AbortController().signal, () => true)
    try {
      await pool.use(root, async () => undefined, async () => {})
      expect(await reader!.list({})).toHaveLength(1)
      rmSync(link); symlinkSync(join(outside, '.dsh/skills/secret'), link, 'junction')
      await pool.poll(); expect(changes).toBe(1)
      expect(await reader!.list({})).toEqual([])
      await pool.poll(); expect(changes).toBe(1)
    } finally { await reader?.dispose(); await pool.dispose() }
  })

  it.each(['replace', 'delete', 'revoke', 'abort'] as const)('rejects an open-handle read after %s and closes the handle', async action => {
    const root = project(fixture.base, 'root'), path = writeSkill(root, 'review', 'HANDLE BODY')
    let valid = true
    const reader = await rootReader(stack.ctx, canonicalPath(root), new AbortController().signal, () => valid)
    const listed = await reader!.list({})
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    expect(candidates).toHaveLength(1)
    const probe = await open(path)
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const read = prototype.readFile
    let entered!: () => void, release!: () => void, active: FileHandle | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(prototype, 'readFile').mockImplementation(async function(this: FileHandle, ...args) {
      const content = await read.apply(this, args)
      active = this; entered(); await held
      return content
    })
    const controller = new AbortController()
    // Attach a rejection handler immediately; abort can reject before we await.
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
      // Native parsing maps absent/revoked (ENOENT) files to no contribution.
      if (action === 'delete' || action === 'revoke') expect(result).toBeUndefined()
      else expect(result).toBeInstanceOf(Error)
      expect(active!.fd).toBe(-1)
    } finally { release(); await loading; await reader?.dispose() }
  })
})
