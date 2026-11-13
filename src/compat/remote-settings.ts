/**
 * The SSH remote-environments switch: modern volatile Config and legacy
 * namespace forms. Experimental and OFF by default; the plugin-detail card
 * carries a warning-tone experimental tag next to the same switch, and
 * enabling asks for a risk confirmation first.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { configValue } from './skills.ts'

/** The settings namespace / plugin row id of the remote-tools feature. */
export const REMOTE_SETTINGS_ID = 'multi-root-remote-tools'

interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean }, hooks: {
    setSource(source: () => { enabled?: unknown }): void; onChange(): void; validate(value: { enabled?: unknown }): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}

/**
 * Install the live `multi-root-remote-tools.enabled` switch.
 * @param ctx - the host context.
 * @param initial - the loader Config value (read lazily); absent means off.
 * @param changed - called on every settings change.
 * @returns the read accessor and the settings fiber.
 */
export function installRemoteSettings(ctx: Context, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let source: (() => { enabled?: unknown }) | undefined
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(scope, REMOTE_SETTINGS_ID, z.object({ enabled: z.boolean().default(false) }), { enabled: configValue(initial()) === true }, {
        // Re-sync on bind too: unlike the worktree row (which re-reads lazily
        // on every call), the remote row mounts on CHANGE events, so a
        // persisted override applied while the section binds must still fire.
        setSource: current => { source = current; changed() },
        onChange: changed,
        validate: value => { if (typeof value.enabled !== 'boolean') throw new Error('multi-root remote tools: enabled must be boolean') },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root remote tools: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    // Events are service-owned on newer hosts; the compat boundary narrows the shared name.
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === REMOTE_SETTINGS_ID) changed() })
    return () => { stopEvent(); stop() }
  })
  return { fiber, read: () => source === undefined ? initial() : source().enabled }
}
