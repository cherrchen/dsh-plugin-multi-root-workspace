import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import { AdditionalSkillCatalog, internalSkillName } from '../src/skills/catalog.ts'

let fixture: FixtureWorkspace, stack: Awaited<ReturnType<typeof skillsStack>>, primary: string, extra: string, agent: ReturnType<typeof stack.agent>, root: ReturnType<typeof stack.registry.list>[number]
beforeEach(async () => {
  fixture = createFixtureWorkspace('skills-invocation'); stack = await skillsStack(fixture.base)
  primary = project(fixture.base, 'a'); extra = project(fixture.base, 'extra')
  root = (await stack.registry.add(primary, { path: extra }))[0]!
  agent = stack.agent(primary)
})
afterEach(async () => { vi.restoreAllMocks(); await stack.dispose(); fixture.dispose() })
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function execute(name: string, caller: Agent = agent) {
  return await stack.ctx.tools.execute({ callId: 'skills-call' as never, name: 'skill', arguments: { name }, agent: caller, signal: new AbortController().signal })
}

describe('native loading and Host aliases', () => {
  it('runs the real native tool dispatcher with fresh model/user invocation policy', async () => {
    writeSkill(extra, 'review', 'DEFAULT BODY')
    writeSkill(extra, 'user-only', 'USER BODY', 'disable-model-invocation: true\n')
    writeSkill(extra, 'model-only', 'MODEL BODY', 'user-invocable: false\n')
    const review = internalSkillName(primary, root.id, 'review')
    expect(await execute(review)).toMatchObject({ isError: false })
    expect(JSON.stringify(await execute(review))).toContain('DEFAULT BODY')
    expect(await execute(internalSkillName(primary, root.id, 'user-only'))).toMatchObject({ isError: true })
    expect(await execute('extra:review')).toMatchObject({ isError: true })
    const request = user('/extra:user-only do it')
    const resolved = await stack.preStep(agent, [request])
    expect(resolved.kind).toBe('enter')
    if (resolved.kind !== 'enter') throw new Error('pre-step rejected')
    expect(resolved.messages[0]).toBe(request)
    expect(JSON.stringify(resolved.messages.at(-1))).toContain('USER BODY')
    expect(JSON.stringify(await stack.preStep(agent, [user('/extra:model-only')]))).not.toContain('MODEL BODY')
    const forged = createUserMessage({ source: { kind: 'multi-root-workspace', plugin: 'external', form: 'instructions' }, content: [{ type: 'text', text: '/extra:user-only' }] })
    expect(JSON.stringify(await stack.preStep(agent, [forged]))).not.toContain('USER BODY')
    expect(JSON.stringify(await stack.preStep(agent, [user(`/${review}`)]))).not.toContain('DEFAULT BODY')
  })

  it('blocks old aliases/IDs after disable or rename and recovers without changing Root choice', async () => {
    writeSkill(extra, 'review', 'BODY')
    const id = internalSkillName(primary, root.id, 'review')
    await stack.snapshot(agent)
    await stack.registry.setAliasId(primary, { kind: 'id', id: root.id }, 'renamed')
    expect(JSON.stringify(await stack.preStep(agent, [user('/extra:review')]))).not.toContain('<skill_instructions>')
    expect(JSON.stringify(await stack.preStep(agent, [user('/renamed:review')]))).toContain('<skill_instructions>')
    await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root.id }, false)
    expect(await execute(id)).toMatchObject({ isError: true })
    expect(JSON.stringify(await stack.preStep(agent, [user('/renamed:review')]))).not.toContain('<skill_instructions>')
    await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root.id }, true)
    expect(await execute(id)).toMatchObject({ isError: false })
    stack.scope.setRegistryAuthority(false)
    expect(await execute(id)).toMatchObject({ isError: true })
  })

  it.each(['disable', 'remove', 'policy', 'abort'] as const)('discards a delayed get when %s occurs before completion', async action => {
    const path = writeSkill(extra, 'review', 'OLD BODY')
    const id = internalSkillName(primary, root.id, 'review')
    await stack.snapshot(agent)
    let resume!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const original = FileSystemSkillProvider.prototype.get
    vi.spyOn(FileSystemSkillProvider.prototype, 'get').mockImplementation(async function(...args) {
      const loaded = await original.apply(this, args); entered(); await gate; return loaded
    })
    const controller = new AbortController()
    const loading = stack.ctx.skills.get(id, { scope: agent, cwd: agent.effectiveCwd, signal: controller.signal })
    await started
    if (action === 'disable') await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root.id }, false)
    if (action === 'remove') await stack.registry.remove(primary, { kind: 'id', id: root.id })
    if (action === 'policy') writeFileSync(path, '---\nname: review\ndescription: changed\ndisable-model-invocation: true\n---\nNEW BODY')
    if (action === 'abort') controller.abort()
    resume()
    if (action === 'abort') await expect(loading).rejects.toThrow()
    else expect(await loading).toBeUndefined()
  })

  it('delivers an unchanged multi-Skill batch in request order, without duplicate bodies', async () => {
    writeSkill(extra, 'first', 'FIRST BODY')
    writeSkill(extra, 'second', 'SECOND BODY')
    const request = user('/extra:first /extra:second /extra:first')
    const result = await stack.preStep(agent, [request])
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('pre-step rejected')
    expect(result.messages[0]).toBe(request)
    const bodies = result.messages.filter(message => 'plugin' in message.source && message.source.plugin === 'multi-root-skills')
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[0])).toContain('FIRST BODY')
    expect(JSON.stringify(bodies[1])).toContain('SECOND BODY')
  })

  it.each(['disable', 'remove', 'edit', 'policy', 'alias', 'global', 'authority'] as const)('discards the pending batch when %s invalidates an earlier Skill during a later load', async action => {
    writeSkill(extra, 'first', 'FIRST BODY')
    const other = project(fixture.base, 'other')
    await stack.registry.add(primary, { path: other })
    writeSkill(other, 'second', 'SECOND BODY')
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    const get = FileSystemSkillProvider.prototype.get
    vi.spyOn(FileSystemSkillProvider.prototype, 'get').mockImplementation(async function(...args) {
      const loaded = await get.apply(this, args)
      if (loaded?.name === 'second') { entered(); await held }
      return loaded
    })
    const request = user('/extra:first /other:second')
    const loading = stack.preStep(agent, [request])
    await started
    try {
      if (action === 'disable') await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root.id }, false)
      if (action === 'remove') await stack.registry.remove(primary, { kind: 'id', id: root.id })
      if (action === 'edit') writeSkill(extra, 'first', 'CHANGED BODY')
      if (action === 'policy') writeSkill(extra, 'first', 'FIRST BODY', 'user-invocable: false\n')
      if (action === 'alias') await stack.registry.setAliasId(primary, { kind: 'id', id: root.id }, 'renamed')
      if (action === 'global') {
        vi.spyOn(stack.ctx.multiRootSkills, 'enabled', 'get').mockReturnValue(false)
        stack.ctx.multiRootSkills.invalidate()
      }
      if (action === 'authority') stack.scope.setRegistryAuthority(false)
    } finally { resume() }
    const result = await loading
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('pre-step rejected')
    expect(result.messages[0]).toBe(request)
    expect(JSON.stringify(result.messages)).not.toContain('FIRST BODY')
    expect(JSON.stringify(result.messages)).not.toContain('SECOND BODY')
  })

  it('discards the batch if its generation changes during the final admission checks', async () => {
    writeSkill(extra, 'first', 'FIRST BODY')
    writeSkill(extra, 'second', 'SECOND BODY')
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    const validate = AdditionalSkillCatalog.prototype.admissionValid
    vi.spyOn(AdditionalSkillCatalog.prototype, 'admissionValid').mockImplementation(async function(definition) {
      const valid = await validate.call(this, definition)
      if (definition.name === 'extra:second') { entered(); await held }
      return valid
    })
    const request = user('/extra:first /extra:second')
    const loading = stack.preStep(agent, [request])
    await started
    try { await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: root.id }, false) }
    finally { resume() }
    const result = await loading
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('pre-step rejected')
    expect(result.messages[0]).toBe(request)
    expect(JSON.stringify(result.messages)).not.toContain('FIRST BODY')
    expect(JSON.stringify(result.messages)).not.toContain('SECOND BODY')
  })

  it('rereads changed policy/name and independently revokes when another native provider is incomplete', async () => {
    const path = writeSkill(extra, 'review', 'BODY')
    const id = internalSkillName(primary, root.id, 'review')
    await stack.snapshot(agent)
    writeSkill(extra, 'review', 'BODY', 'disable-model-invocation: true\n')
    expect(await execute(id)).toMatchObject({ isError: true })
    expect(JSON.stringify(await stack.preStep(agent, [user('/extra:review')]))).toContain('<skill_instructions>')
    stack.ctx.skills.registerProvider(() => ({ name: 'incomplete', list: async () => ({ candidates: [], complete: false }), get: async () => undefined }))
    rmSync(path)
    expect(JSON.stringify(await stack.preStep(agent))).toContain('no longer available for new invocations')
    expect(await execute(id)).toMatchObject({ isError: true })
  })

  it('closes admission and awaits an in-flight read before owner disposal finishes', async () => {
    writeSkill(extra, 'review', 'BODY')
    const id = internalSkillName(primary, root.id, 'review')
    await stack.snapshot(agent)
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    const get = FileSystemSkillProvider.prototype.get
    vi.spyOn(FileSystemSkillProvider.prototype, 'get').mockImplementation(async function(...args) { const loaded = await get.apply(this, args); entered(); await held; return loaded })
    const loading = stack.ctx.skills.get(id, { scope: agent })
    await started
    let disposed = false
    const disposing = stack.owner.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 10)); expect(disposed).toBe(false)
    resume(); expect(await loading).toBeUndefined()
    await disposing; expect(disposed).toBe(true)
  })

  it('retains a native exact-name winner instead of overriding it', async () => {
    writeSkill(extra, 'review', 'PLUGIN BODY')
    const id = internalSkillName(primary, root.id, 'review')
    stack.ctx.skills.register({ name: id, description: 'foreign winner', source: 'runtime', content: 'FOREIGN BODY' })
    expect((await stack.snapshot(agent)).skills.find(row => row.name === id)?.provider).toBe('runtime')
    expect(JSON.stringify(await execute(id))).toContain('FOREIGN BODY')
  })
})
