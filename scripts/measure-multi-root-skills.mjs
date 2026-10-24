/** Local IO baseline, not a performance gate. Run with --experimental-transform-types. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createFixtureWorkspace } from '../tests/support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from '../tests/support/skills-stack.ts'

const fixture = createFixtureWorkspace('skills-cost')
const stack = await skillsStack(fixture.base)
const measure = async callback => {
  const start = performance.now(), value = await callback()
  return { value, ms: Number((performance.now() - start).toFixed(2)) }
}
try {
  const primary = project(fixture.base, 'primary')
  for (let root = 0; root < 16; root++) {
    const path = project(fixture.base, `repo-${root}`)
    for (let skill = 0; skill < 8; skill++) writeSkill(path, `task-${skill}`, 'MEASURE BODY '.repeat(512))
    await stack.registry.add(primary, { path })
  }
  const agent = stack.agent(primary), skills = stack.ctx.multiRootSkills
  const first = await measure(() => skills.listSession(agent.id))
  assert.equal(first.value.skills.length, 128)
  assert(!JSON.stringify(first.value).includes('MEASURE BODY'))
  const lists = [], previews = []
  for (let i = 0; i < 5; i++) {
    lists.push((await measure(() => skills.listSession(agent.id))).ms)
    const preview = await measure(() => skills.previewSession(agent.id, 'repo-0:task-0'))
    assert(preview.value.content.includes('MEASURE BODY'))
    previews.push(preview.ms)
  }
  console.log(JSON.stringify({ platform: process.platform, node: process.version, roots: 16, skills: 128, firstListMs: first.ms, repeatedListMs: lists, guardedPreviewMs: previews }, null, 2))
} finally { await stack.dispose(); fixture.dispose() }
