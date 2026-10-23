/** Namespaced plain-text Slash source and optional sent-message references. */
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { clientInject, registerNamespaceRule, type NamespaceRule } from '../compat/skills-client.ts'
import { SkillsClient } from './skills-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

interface Source {
  trigger: '/'; name: string; order: number
  candidates(session: { sessionId: string }, request: { query: string; signal: AbortSignal }): Promise<readonly { name: string; description: string }[]>
  onPick(pick: { candidate: { name: string } }): { text: string }
  lexicon(session: { sessionId: string }): readonly string[] | undefined
  subscribeLexicon(session: { sessionId: string }, listener: () => void): () => void
  openReference(session: { sessionId: string }, reference: { ref: string }): boolean
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
export function namespaceSource(client: SkillsClient, t: Translate, preview: (sessionId: string, name: string) => void): Source {
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
    openReference({ sessionId }, { ref }) {
      if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref)) return false
      preview(sessionId, ref.slice(1)); return true
    },
  }
}
function Preview({ client, sessionId, name, t, close }: { client: SkillsClient; sessionId: string; name: string; t: Translate; close(): void }) {
  const [content, setContent] = useState<string>(), [error, setError] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let generation: number | undefined
    const stop = client.subscribe(sessionId, () => {
      if (generation !== undefined && client.snapshot(sessionId)?.generation !== generation) { abort.abort(); setContent(undefined); setError(true) }
    })
    void client.list(sessionId, abort.signal).then(() => client.preview(sessionId, name, abort.signal)).then(value => {
      if (abort.signal.aborted) return
      generation = value.generation; setContent(value.content)
    }).catch(() => { if (!abort.signal.aborted) setError(true) })
    return () => { abort.abort(); stop() }
  }, [client, sessionId, name])
  return <Modal open onClose={close} title={`/${name}`} closeLabel={t('panel.close')} description={t('skills.referenceHint')}>
    {error ? <p role="alert">{t('skills.previewUnavailable')}</p> : content === undefined ? <p>{t('skills.loading')}</p> : <pre className="mrfw-skillBody">{content}</pre>}
  </Modal>
}
export function installSkillsClient(ctx: Context, t: Translate, subscribeSession: (listener: () => void) => () => void): void {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  const client = new SkillsClient(connection)
  let previewRoot: Root | undefined, element: HTMLDivElement | undefined
  const close = () => { previewRoot?.unmount(); previewRoot = undefined; element?.remove(); element = undefined }
  const preview = (sessionId: string, name: string) => {
    close(); element = document.createElement('div'); document.body.append(element); previewRoot = createRoot(element)
    previewRoot.render(<Preview key={`${sessionId}:${name}`} client={client} sessionId={sessionId} name={name} t={t} close={close} />)
  }
  ctx.effect(() => () => { close(); client.dispose() })
  ctx.effect(() => subscribeSession(() => { close(); client.reset() }))
  const source = namespaceSource(client, t, preview)
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
      inject: (sessionId: string) => ({ open: (name: string) => { preview(sessionId, name) } }),
    }, ({ node, interactive, open }: { node: { data: { name: string } }; interactive: boolean; open(name: string): void }) => interactive
      ? <button type="button" className="mrfw-skillReference" title={t('skills.referenceHint')} onClick={() => { open(node.data.name) }}>{`/${node.data.name}`}</button>
      : <span>{`/${node.data.name}`}</span>))
    return () => { stopRenderer(); stop() }
  })
  if (typeof ctx.on === 'function') (ctx.on as (...args: any[]) => unknown)('connection/reset', () => { close(); client.reset() })
}
