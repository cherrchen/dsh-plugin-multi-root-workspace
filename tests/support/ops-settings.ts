import type { Context } from '@deepseek-ai/cordis'
import { OPS_SETTINGS_ID } from '../../src/compat/ops-settings.ts'

/** A modern Settings fixture that edits the owner's volatile Config in place. */
export function installOpsSetting(ctx: Context, initial = true): (value: boolean) => void {
  let config: { enabled?: unknown } | undefined
  const set = (value: boolean) => {
    if (config === undefined) throw new Error('OPS settings form is not installed')
    const field = config.enabled as { [key: symbol]: ((value: boolean) => void) | undefined } | undefined
    const write = typeof field === 'object' && field !== null ? field[Symbol.for('cosmokit.volatile.write')] : undefined
    if (typeof write === 'function') write(value)
    else config.enabled = value
  }
  ctx.provide('settings', {
    configure: (_presentation: unknown, owner: { effectiveConfig?: unknown; config: unknown }) => {
      config = (owner.effectiveConfig ?? owner.config) as { enabled?: unknown }
      set(initial)
      return () => { config = undefined }
    },
  } as never)
  return value => {
    set(value)
    ;(ctx.emit as (...args: any[]) => void)('settings/document-updated', OPS_SETTINGS_ID)
  }
}
