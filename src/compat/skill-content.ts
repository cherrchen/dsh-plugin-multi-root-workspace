/** Native rendering is loaded only when a namespaced invocation delivers a body. */
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
export async function renderAdditionalSkill(skill: SkillDefinition): Promise<string> {
  const { renderSkillContent } = await import('@deepseek-ai/dsh-skill')
  return renderSkillContent(skill)
}
