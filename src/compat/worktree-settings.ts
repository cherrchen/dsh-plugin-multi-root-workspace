/** The worktree suggestion switch: modern volatile Config and legacy namespace forms. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { configValue } from './skills.ts'

/** The settings namespace / plugin row id of the worktree feature. */
export const WORKTREE_SETTINGS_ID = 'multi-root-worktrees'
/** The bundle key the modern plugin-detail card is registered under. */
export const WORKTREE_BUNDLE_KEY = '@dsh-electron/dsh-plugin-multi-root-workspace'

interface Settings {
  installSection?: (owner: Context, ns: string, schema: unknown, value: { enabled: boolean }, hooks: {
    setSource(source: () => { enabled?: unknown }): void; onChange(): void; validate(value: { enabled?: unknown }): void
  }) => void
  configure?: (presentation: { auto: boolean }, owner: unknown) => () => void
}

/**
 * Install the live `multi-root-worktrees.enabled` switch.
 * @param ctx - the host context.
 * @param initial - the loader Config value (read lazily).
 * @param changed - called on every settings change.
 * @returns the read accessor and the settings fiber.
 */
export function installWorktreeSettings(ctx: Context, initial: () => unknown, changed: () => void): { read(): unknown; fiber: Fiber } {
  let source: (() => { enabled?: unknown }) | undefined
  const fiber = ctx.inject(['settings'], scope => {
    const settings = scope.get('settings') as unknown as Settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(scope, WORKTREE_SETTINGS_ID, z.object({ enabled: z.boolean().default(true) }), { enabled: configValue(initial()) !== false }, {
        setSource: current => { source = current },
        onChange: changed,
        validate: value => { if (typeof value.enabled !== 'boolean') throw new Error('multi-root worktrees: enabled must be boolean') },
      })
      return () => { source = undefined; changed() }
    }
    if (typeof settings.configure !== 'function') throw new Error('multi-root worktrees: unsupported Settings service')
    const stop = settings.configure({ auto: false }, scope.fiber)
    // Events are service-owned on newer hosts; the compat boundary narrows the shared name.
    const stopEvent = (scope.on as (...args: any[]) => () => void)('settings/document-updated', (id: string) => { if (id === WORKTREE_SETTINGS_ID) changed() })
    return () => { stopEvent(); stop() }
  })
  return { fiber, read: () => source === undefined ? initial() : source().enabled }
}
