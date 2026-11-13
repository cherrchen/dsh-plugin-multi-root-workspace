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

/** The live value the panel edits; `read()` hands it back whole (ADR-0041). */
export interface RemoteSettingsValue {
  readonly enabled?: unknown
  readonly mode?: unknown
  readonly team?: unknown
}

interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean; mode: string }, hooks: {
    setSource(source: () => RemoteSettingsValue): void; onChange(): void; validate(value: RemoteSettingsValue): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}

const REMOTE_MODES = new Set(['personal', 'team', 'hardened'])

/** Fail closed: an unknown mode makes the whole read act disabled (ADR-0041). */
export function readRemoteSettingsValue(value: RemoteSettingsValue | undefined, warn: (message: string) => void): { enabled: boolean; mode?: 'personal' | 'team' | 'hardened' | undefined; team?: unknown } {
  const enabled = value?.enabled === true
  if (enabled && value?.mode !== undefined && (typeof value.mode !== 'string' || !REMOTE_MODES.has(value.mode))) {
    warn(`multi-root remote tools: unknown mode ${JSON.stringify(value.mode)}; acting disabled`)
    return { enabled: false }
  }
  const mode = typeof value?.mode === 'string' && REMOTE_MODES.has(value.mode) ? value.mode as 'personal' | 'team' | 'hardened' : undefined
  const team = value?.team !== null && typeof value?.team === 'object' ? value.team : undefined
  return { enabled, ...(mode === undefined ? {} : { mode }), ...(team === undefined ? {} : { team }) }
}

/**
 * Install the live `multi-root-remote-tools.enabled` switch.
 * @param ctx - the host context.
 * @param initial - the loader Config value (read lazily); absent means off.
 * @param changed - called on every settings change.
 * @returns the read accessor and the settings fiber.
 */
export function installRemoteSettings(ctx: Context, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let source: (() => RemoteSettingsValue) | undefined
  const initialValue = (): RemoteSettingsValue => {
    const value = configValue(initial())
    return typeof value === 'object' && value !== null ? value as RemoteSettingsValue : { enabled: value === true }
  }
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      const seed = initialValue()
      const initialEnabled = seed.enabled === true
      const initialMode = typeof seed.mode === 'string' ? seed.mode : 'personal'
      settings.installSection(scope, REMOTE_SETTINGS_ID, z.object({
        enabled: z.boolean().default(false),
        mode: z.union([z.const('personal'), z.const('team'), z.const('hardened')]).default('personal'),
        team: z.object({
          manifestPath: z.string(),
          socketPath: z.string(),
          brokerUid: z.natural(),
          credentialRoot: z.string(),
        }),
      }), { enabled: initialEnabled, mode: initialMode }, {
        // Re-sync on bind too: unlike the worktree row (which re-reads lazily
        // on every call), the remote row mounts on CHANGE events, so a
        // persisted override applied while the section binds must still fire.
        setSource: current => { source = current; changed() },
        onChange: changed,
        validate: value => {
          if (typeof value.enabled !== 'boolean') throw new Error('multi-root remote tools: enabled must be boolean')
          if (value.mode !== undefined && !REMOTE_MODES.has(value.mode as string)) {
            throw new Error(`multi-root remote tools: unknown mode ${JSON.stringify(value.mode)}`)
          }
        },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root remote tools: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    // Events are service-owned on newer hosts; the compat boundary narrows the shared name.
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === REMOTE_SETTINGS_ID) changed() })
    return () => { stopEvent(); stop() }
  })
  return { fiber, read: () => source === undefined ? initialValue() : source() }
}
