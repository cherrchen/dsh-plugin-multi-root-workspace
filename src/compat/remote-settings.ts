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

/** Legacy providers may still return the old mode and team fields. */
export interface RemoteSettingsValue {
  readonly enabled?: unknown
  readonly mode?: unknown
  readonly team?: unknown
}

interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean }, hooks: {
    setSource(source: () => RemoteSettingsValue): void; onChange(): void; validate(value: RemoteSettingsValue): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
  /**
   * The Settings service's live view. The `configure` path has
   * no `setSource` push, so the row must read the namespace's effective value
   * here after a write; otherwise it keeps replaying the boot-time loader
   * config until restart.
   */
  describe?: () => readonly { readonly ns: string; readonly value?: unknown }[]
}

/** A legacy broker configuration stays off. Never reinterpret it as personal. */
export function readRemoteSettingsValue(value: RemoteSettingsValue | undefined, configuredMode: unknown, warn: (message: string) => void): boolean {
  if (configValue(value?.enabled) !== true) return false
  const liveMode = configValue(value?.mode)
  if ((configuredMode !== undefined && configuredMode !== 'personal')
    || (liveMode !== undefined && liveMode !== 'personal')
    || (liveMode === undefined && configuredMode === undefined && configValue(value?.team) !== undefined)) {
    warn('multi-root remote tools: only personal SSH custody is available; acting disabled')
    return false
  }
  return true
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
  const initialValue = (): RemoteSettingsValue => ({ enabled: configValue(initial()) === true })
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(scope, REMOTE_SETTINGS_ID, z.object({
        enabled: z.boolean().default(false),
      }), { enabled: initialValue().enabled === true }, {
        // Re-sync on bind too: unlike the worktree row (which re-reads lazily
        // on every call), the remote row mounts on CHANGE events, so a
        // persisted override applied while the section binds must still fire.
        setSource: current => { source = current; changed() },
        onChange: changed,
        validate: value => {
          if (typeof value.enabled !== 'boolean') throw new Error('multi-root remote tools: enabled must be boolean')
          if (value.mode !== undefined || value.team !== undefined) {
            throw new Error('multi-root remote tools: SSH custody is fixed to personal')
          }
        },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root remote tools: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    // This service pushes a document-updated event but no setSource. Read
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
