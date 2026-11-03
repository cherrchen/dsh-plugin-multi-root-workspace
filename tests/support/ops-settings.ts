import type { Context } from '@deepseek-ai/cordis'
import { OPS_SETTINGS_ID } from '../../src/compat/ops-settings.ts'

export function installOpsSetting(ctx: Context, initial = true): (value: boolean) => void {
  let enabled = initial
  let changed: (() => void) | undefined
  ctx.provide('settings', {
    installSection: (_owner: unknown, ns: string, _schema: unknown, _initial: unknown, hooks: {
      setSource(source: () => { enabled: boolean }): void
      onChange(): void
    }) => {
      if (ns !== OPS_SETTINGS_ID) return
      hooks.setSource(() => ({ enabled }))
      changed = hooks.onChange
    },
  } as never)
  return value => {
    if (changed === undefined) throw new Error('OPS settings section is not installed')
    enabled = value
    changed()
  }
}
