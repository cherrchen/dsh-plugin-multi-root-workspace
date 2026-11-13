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
  /**
   * The modern settings service's live view. The legacy `configure` path has
   * no `setSource` push, so the row must read the namespace's effective value
   * here after a write; otherwise it keeps replaying the boot-time loader
   * config until restart.
   */
  describe?: () => readonly { readonly ns: string; readonly value?: unknown }[]
}

/** The three custody modes (ADR-0041). */
export type RemoteMode = 'personal' | 'team' | 'hardened'

const REMOTE_MODES = new Set<string>(['personal', 'team', 'hardened'])

/**
 * Unwrap one Schemastery volatile field. A row config validated by its
 * Schemastery schema carries `volatileField` values as wrapper objects with a
 * `get()`; the wrapper is not the value. `configValue` leaves plain values
 * alone, so this is safe for both loader and Settings sources.
 * @param value - a plain value or a volatile wrapper.
 * @returns the mode when the unwrapped value is one of the three modes.
 */
export function remoteModeOf(value: unknown): RemoteMode | undefined {
  const unwrapped = configValue(value)
  return typeof unwrapped === 'string' && REMOTE_MODES.has(unwrapped) ? unwrapped as RemoteMode : undefined
}

/** Unwrap every volatile field of a raw settings/row-config value. */
function unwrapSettings(value: RemoteSettingsValue | undefined): RemoteSettingsValue {
  return {
    enabled: configValue(value?.enabled),
    mode: configValue(value?.mode),
    team: configValue(value?.team),
  }
}

/** Fail closed: an unknown mode makes the whole read act disabled (ADR-0041). */
export function readRemoteSettingsValue(value: RemoteSettingsValue | undefined, warn: (message: string) => void): { enabled: boolean; mode?: RemoteMode | undefined; team?: unknown } {
  const current = unwrapSettings(value)
  const enabled = current.enabled === true
  if (enabled && current.mode !== undefined && (typeof current.mode !== 'string' || !REMOTE_MODES.has(current.mode))) {
    warn(`multi-root remote tools: unknown mode ${JSON.stringify(current.mode)}; acting disabled`)
    return { enabled: false }
  }
  const mode = remoteModeOf(current.mode)
  const team = current.team !== null && typeof current.team === 'object' ? current.team : undefined
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
  let live: (() => RemoteSettingsValue | undefined) | undefined
  const initialValue = (): RemoteSettingsValue => {
    const value = configValue(initial())
    return typeof value === 'object' && value !== null ? unwrapSettings(value as RemoteSettingsValue) : { enabled: value === true }
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
    // The legacy service pushes a document-updated event but no setSource. Read
    // the namespace's effective value from describe() on every re-sync; the
    // boot-time loader config is only the fallback when this service cannot
    // answer (older hosts, a not-yet-ready settings provider).
    const readLive = (): RemoteSettingsValue | undefined => {
      try {
        const row = settings.describe?.().find(entry => entry.ns === REMOTE_SETTINGS_ID)
        return row?.value as RemoteSettingsValue | undefined
      } catch {
        return undefined
      }
    }
    live = readLive
    // Events are service-owned on newer hosts; the compat boundary narrows the shared name.
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === REMOTE_SETTINGS_ID) changed() })
    // The inject callback may run after the row's first sync; re-read now that
    // the live source exists so a persisted value is not lost until restart.
    changed()
    return () => { stopEvent(); stop(); if (live === readLive) live = undefined }
  })
  return { fiber, read: () => source === undefined ? (live?.() ?? initialValue()) : source() }
}
