import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './compat.ts'
import type {} from './providers.ts'
import type {} from './scope.ts'
import { configValue } from './compat/skills.ts'
import { installOpsCompatibilitySettings, opsCompatibilityField } from './compat/ops-settings.ts'

export interface Config { readonly enabled?: boolean }
const enabledField = opsCompatibilityField(z.boolean().default(false))
const experimental = (enabledField as { experimental?: () => typeof enabledField }).experimental
const described = (typeof experimental === 'function' ? experimental.call(enabledField) : enabledField) as typeof enabledField
export const Config = z.object({
  enabled: described.description('OPS 兼容模式（实验性，仅限 DSH 0.2.*）：可能存在功能、版本和平台限制。启用 OPS 写保护、实时活动与 Review 增强；受限模式可能拒绝附加根操作（包括读取），后台缓存可能残留；关闭时显式只读附加根可能被 OPS 写入。'),
})

declare module '@deepseek-ai/cordis' {
  interface Context { multiRootOpsCompatibility: MultiRootOpsCompatibility }
}

export class MultiRootOpsCompatibility extends Service {
  static Config = Config
  static provide = 'multiRootOpsCompatibility'
  static inject = ['multiRootCompat', 'multiRootProviders', 'multiRootScope']
  constructor(ctx: Context, private readonly settingsConfig: Config = {}) {
    super(ctx, 'multiRootOpsCompatibility')
    const settings = installOpsCompatibilitySettings(ctx, () => this.settingsConfig.enabled, () => this.sync())
    this.settingsRead = settings.read
    ctx.effect(() => () => { this.closing = true; this.enabledNow = false; this.currentToken = undefined })
    this.sync()
  }
  private settingsRead: (() => unknown) | undefined
  private currentToken: object | undefined
  private enabledNow = false
  private closing = false
  get token(): object | undefined { this.sync(); return this.currentToken }
  get enabled(): boolean { this.sync(); return this.enabledNow }
  private sync(): void {
    if (this.closing) { this.enabledNow = false; this.currentToken = undefined; return }
    const raw = this.settingsRead?.()
    const enabled = configValue(raw) === true
    if (enabled === this.enabledNow) return
    this.enabledNow = enabled
    this.currentToken = enabled ? Object.freeze({ id: randomUUID() }) : undefined
  }
}
export default MultiRootOpsCompatibility
