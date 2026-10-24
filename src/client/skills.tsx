/** Namespaced Slash completion and plain-text sent-message references. */
import type { Context } from '@deepseek-ai/cordis'
import { clientInject, registerNamespaceRule, type NamespaceRule } from '../compat/skills-client.ts'
import { SkillsClient } from './skills-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

interface Source {
  trigger: '/'; name: string; order: number
  candidates(session: { sessionId: string }, request: { query: string; signal: AbortSignal }): Promise<readonly { name: string; description: string }[]>
  onPick(pick: { candidate: { name: string } }): { text: string }
  lexicon(session: { sessionId: string }): readonly string[] | undefined
  subscribeLexicon(session: { sessionId: string }, listener: () => void): () => void
}
export const namespaceSkillRule: NamespaceRule = {
  id: 'multi-root-skill', order: 19,
  match(text, from) {
    const regex = /(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)(?!\S)/g
    regex.lastIndex = from
    const match = regex.exec(text)
    return match === null ? undefined : { id: 'multi-root-skill', start: match.index, end: match.index + match[0].length, data: { name: match[1]! } }
  },
}
export function namespaceSource(client: SkillsClient, t: Translate): Source {
  return {
    trigger: '/', name: 'multi-root-skills', order: 3,
    async candidates({ sessionId }, { query, signal }) {
      try {
        const view = client.snapshot(sessionId) ?? await client.list(sessionId, signal)
        signal.throwIfAborted()
        return view.skills.filter(skill => skill.name.toLowerCase().includes(query.toLowerCase())).map(skill => ({ name: skill.name, description: skill.modelInvocable ? skill.description : `${t('skills.userOnly')} · ${skill.description}` }))
      } catch (error) { if (signal.aborted) return []; throw error }
    },
    onPick({ candidate }) { return { text: `/${candidate.name} ` } },
    lexicon({ sessionId }) { return client.snapshot(sessionId)?.skills.map(skill => skill.name) },
    subscribeLexicon({ sessionId }, listener) { return client.subscribe(sessionId, listener) },
  }
}

export function installSkillsClient(ctx: Context, t: Translate, subscribeSession: (listener: () => void) => () => void): void {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  const client = new SkillsClient(connection)
  ctx.effect(() => () => client.dispose())
  ctx.effect(() => subscribeSession(() => { client.reset() }))
  const source = namespaceSource(client, t)
  clientInject(ctx, ['inputTriggers'], scope => {
    const triggers = scope.get('inputTriggers' as never) as unknown as { registerSource(source: Source): () => void }
    return triggers.registerSource(source)
  })
  clientInject(ctx, ['uiConversation'], scope => {
    const stop = registerNamespaceRule(scope, namespaceSkillRule)
    if (stop === undefined) return
    const slots = scope.slots as unknown as { inject(name: string, callback: () => unknown): () => void; register(options: object, component: unknown): () => void }
    const stopRenderer = slots.inject('conversation.user.text.node', () => slots.register({
      name: 'conversation.user.text.node', key: namespaceSkillRule.id, priority: 100,
    }, ({ node }: { node: { data: { name: string } } }) => `/${node.data.name}`))
    return () => { stopRenderer(); stop() }
  })
  if (typeof ctx.on === 'function') (ctx.on as (...args: any[]) => unknown)('connection/reset', () => { client.reset() })
}
