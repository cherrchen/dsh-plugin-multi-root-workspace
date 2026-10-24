/** Host-only explicit gesture parsing. External messages cannot forge user intent. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInstructionMessage } from '../compat/llm-message.ts'
import { renderAdditionalSkill } from '../compat/skill-content.ts'
import { skillOrigin } from '../compat/skills.ts'
import type { AdditionalSkillCatalog, LocatedSkill } from './catalog.ts'

export function installSkillInvocations(ctx: Context, catalog: AdditionalSkillCatalog, known: WeakMap<Agent, Map<string, LocatedSkill>>): void {
  ctx.inject(['agents'], scope => {
    scope.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const primary = skillOrigin(scope, { scope: agent } as never)
      if (primary === undefined) return decision
      const invoked = new Set<string>()
      for (const message of messages) {
        if (message.source.kind !== 'user') continue
        for (const block of message.content) {
          if (block.type !== 'text') continue
          for (const match of block.text.matchAll(/(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)(?!\S)/g)) invoked.add(`${match[1]}:${match[2]}`)
        }
      }
      const previous = known.get(agent)
      if (invoked.size === 0 && (previous === undefined || previous.size === 0)) return decision
      const options = { scope: agent, signal }
      const entries = await catalog.list(primary, options)
      const revision = catalog.revision
      const injections = [], pending = []
      if (previous !== undefined) {
        const remaining = new Set(entries.map(entry => entry.name))
        const revoked: string[] = []
        for (const [name, locator] of previous) {
          if (remaining.has(name) && catalog.current(primary, locator.rootId)?.aliasId === locator.aliasId) continue
          revoked.push(`${locator.aliasId}:${locator.candidate.name}`); previous.delete(name)
        }
        if (revoked.length > 0) injections.push(await createInstructionMessage({ plugin: 'multi-root-skills', text: `The following additional-root Skills are no longer available for new invocations: ${revoked.join(', ')}. Previously delivered content remains in the conversation history.` }))
      }
      for (const name of invoked) {
        signal.throwIfAborted()
        const entry = entries.find(entry => { const locator = entry.locator as LocatedSkill; return `${locator.aliasId}:${locator.candidate.name}` === name })
        if (entry === undefined) continue
        const loaded = await catalog.load(primary, entry, options, true)
        if (loaded === undefined) continue
        const rendered = await renderAdditionalSkill(loaded)
        signal.throwIfAborted()
        // Keep the receipt until every load and optional-peer await in the batch has finished.
        const message = await createInstructionMessage({ plugin: 'multi-root-skills', text: rendered })
        pending.push({ entry, loaded, message })
      }
      const admitted = await Promise.all(pending.map(({ loaded }) => catalog.admissionValid(loaded)))
      signal.throwIfAborted()
      // No await after this fence: later loads or receipt checks may have revoked an earlier body.
      if (revision === catalog.revision && admitted.every(Boolean)) for (const { entry, message } of pending) {
        let tracked = known.get(agent)
        if (tracked === undefined) { tracked = new Map(); known.set(agent, tracked) }
        tracked.set(entry.name, entry.locator as LocatedSkill)
        injections.push(message)
      }
      return { ...decision, messages: [...decision.messages, ...injections] }
    }, { prepend: true })
  })
}

/** The tracked identity is an Agent object, never a process-global current Session. */
export type SkillCaller = Agent
