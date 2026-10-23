/** Legacy namespace sections and modern volatile Config forms share one live switch. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { configValue } from './skills.ts'
export const SKILLS_SETTINGS_ID = 'multi-root-skills'
export const SKILLS_BUNDLE_KEY = '@dsh-electron/dsh-plugin-multi-root-workspace'
interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean }, hooks: {
    setSource(source: () => { enabled?: unknown }): void; onChange(): void; validate(value: { enabled?: unknown }): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}
export function installSkillsSettings(ctx: Context, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let source: (() => { enabled?: unknown }) | undefined
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(scope, SKILLS_SETTINGS_ID, z.object({ enabled: z.boolean().default(true) }), { enabled: configValue(initial()) !== false }, {
        setSource: current => { source = current }, onChange: changed,
        validate: value => { if (typeof value.enabled !== 'boolean') throw new Error('multi-root skills: enabled must be boolean') },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root skills: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    // Events are service-owned on newer hosts; the compat boundary narrows the shared name.
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === SKILLS_SETTINGS_ID) changed() })
    return () => { stopEvent(); stop() }
  })
  return { fiber, read: () => source === undefined ? initial() : source().enabled }
}
