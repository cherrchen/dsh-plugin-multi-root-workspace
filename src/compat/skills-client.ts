/** Structural client seams: older hosts have namespace forms and no UserTextRule registry. */
import type { Context } from '@deepseek-ai/cordis'
export interface SkillsForm {
  getSnapshot(): { value?: { enabled?: boolean } | undefined; status: string; writable: boolean; revision?: number | undefined }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: string[]; value: boolean }[], revision?: number): Promise<boolean>
}
interface SettingsScope { bind(input: { namespace: string }): SkillsForm }
interface ConfigForms { get(entryId: string): SkillsForm }

export function bindSkillsForm(ctx: Context): SkillsForm | undefined {
  const modern = ctx.get('configForms' as never) as ConfigForms | undefined
  if (modern !== undefined) return modern.get('multi-root-skills')
  const legacy = ctx.get('settingsScope' as never) as SettingsScope | undefined
  return legacy?.bind({ namespace: 'multi-root-skills' })
}
export function clientInject(ctx: Context, services: string[], callback: (scope: Context) => void | (() => void)): void {
  // Recording client fixtures may omit dynamic injection; real Cordis always supplies it.
  if (typeof ctx.inject === 'function') ctx.inject(services, callback)
}
export interface NamespaceRule {
  id: string; order: number
  match(text: string, from: number): { id: string; start: number; end: number; data: { name: string } } | undefined
}
export function registerNamespaceRule(ctx: Context, rule: NamespaceRule): (() => void) | undefined {
  const conversation = ctx.get('uiConversation' as never) as { userText?: { register(rule: NamespaceRule): () => void } } | undefined
  return typeof conversation?.userText?.register === 'function' ? conversation.userText.register(rule) : undefined
}
