import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { MultiRootOpsCompatibility } from '../ops-compatibility.ts'
import { readInstalledVersion } from './dsh-version.ts'

export const OPS_SETTINGS_ID = 'multi-root-ops-compatibility'
interface Settings {
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}
/** Product availability policy, independent of structural Settings adaptation. */
export function opsCompatibilityRelease(release: string | undefined): boolean {
  return release !== undefined && /^0\.2\.\d+(?:[-+].*)?$/.test(release)
}
/** Unsupported hosts retain the config input but expose no editable live field. */
export function opsCompatibilityField<S>(schema: S): S {
  if (!opsCompatibilityRelease(readInstalledVersion('@deepseek-ai/dsh-sandbox'))) return schema
  const method = (schema as S & { volatile?: () => S }).volatile
  return typeof method === 'function' ? method.call(schema) : schema
}
export function installOpsCompatibilitySettings(ctx: Context, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let active = false
  const fiber = ctx.inject(['settings'], scope => {
    if (!opsCompatibilityRelease(scope.get('multiRootCompat')?.release)) return
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.configure !== 'function') return
    const stop = settings.configure({ auto: false }, ctx.fiber)
    active = true
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === OPS_SETTINGS_ID) changed() })
    changed()
    return () => { active = false; stopEvent(); stop(); changed() }
  })
  return { fiber, read: () => active && opsCompatibilityRelease(ctx.get('multiRootCompat')?.release) ? initial() : undefined }
}
export function opsCompatibilityToken(ctx: Context): object | undefined {
  const service = ctx.get('multiRootOpsCompatibility') as MultiRootOpsCompatibility | undefined
  return service === undefined ? undefined : service.token
}
