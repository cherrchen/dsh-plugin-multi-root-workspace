import type { Context, Fiber } from '@deepseek-ai/cordis'
import { configValue } from './skills.ts'
import type { MultiRootOpsCompatibility } from '../ops-compatibility.ts'

export const OPS_SETTINGS_ID = 'multi-root-ops-compatibility'
interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean }, hooks: {
    setSource(source: () => { enabled?: unknown }): void; onChange(): void; validate(value: { enabled?: unknown }): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}
export function installOpsCompatibilitySettings(ctx: Context, schema: unknown, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let source: (() => { enabled?: unknown }) | undefined
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(scope, OPS_SETTINGS_ID, schema, { enabled: configValue(initial()) === true }, {
        setSource: current => { source = current }, onChange: changed,
        validate: value => { if (typeof value.enabled !== 'boolean') throw new Error('multi-root ops-compatibility: enabled must be boolean') },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root ops-compatibility: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === OPS_SETTINGS_ID) changed() })
    return () => { stopEvent(); stop() }
  })
  return { fiber, read: () => source === undefined ? initial() : source().enabled }
}
export function opsCompatibilityToken(ctx: Context): object | undefined {
  const service = ctx.get('multiRootOpsCompatibility') as MultiRootOpsCompatibility | undefined
  return service === undefined ? undefined : service.token
}
