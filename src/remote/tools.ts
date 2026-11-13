/**
 * Optional remote tool row — EXPERIMENTAL and off by default. The row ships
 * in the default bundle behind the `multi-root-remote-tools.enabled` live
 * switch: the switch re-evaluates the registry's remote control plane and
 * gates everything model-visible. The broker block stays deployment-supplied;
 * without `broker.config` the plane still follows the switch but no tool,
 * verifier, capability projection, or profile guard ever mounts.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-tools
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '../compat.ts'
import type {} from '../providers.ts'
import { configValue, volatileField } from '../compat/skills.ts'
import { classifySshCapability, sshPackageVersion, sshPrivateCopy } from '../compat/dsh-version.ts'
import { installRemoteSettings } from '../compat/remote-settings.ts'
import type { BrokerConfig } from './broker/attest.ts'
import { installRemoteProfileGuard } from './profile-guard.ts'
import { mountRemoteTools } from './tools-registration.ts'

export interface Config {
  /** The live switch; the persisted Settings value overrides the row config. */
  readonly enabled?: boolean
  readonly broker?: { readonly config: BrokerConfig }
}

/** The schemastery face of {@link Config}; `broker` passes through untyped. */
export const Config = z.object({
  enabled: volatileField(z.boolean().default(false)).description('SSH 远端环境（实验性）：默认关闭。开启后 Agent 可对已注册的远端端点使用 remote_copy / remote_bash，每次调用仍经过 Registry 准入；远端凭据托管取决于部署。'),
})

export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools', 'sandboxPolicy', 'permissionPresets', 'sandbox', 'subprocess', 'sessions']

export function apply(ctx: Context, config: Config = {}): void {
  const broker = config.broker
  let child: Fiber | undefined
  let closed = false
  let chain: Promise<void> = Promise.resolve()

  /**
   * The gated subtree, mounted per switch-on: SSH capability gate, profile
   * guard, broker attestation, tools + verifier + capability projection.
   * Every existing refusal is unchanged — this is the previous row body moved
   * under the child context so fiber disposal unwinds it completely.
   */
  const mount = (scope: Context): void => {
    if (broker === undefined) return
    const capability = classifySshCapability({
      platform: process.platform, local: scope.multiRootCompat.report,
      readVersion: sshPackageVersion, privateCopy: sshPrivateCopy,
    })
    if (capability.status !== 'eligible') return
    const restoreGuard = installRemoteProfileGuard(scope)
    scope.effect(() => () => restoreGuard())
    void scope.effect(async function* () {
      const manifest = scope.multiRootRegistry.remoteManifest
      if (manifest === undefined || scope.multiRootRegistry.remoteStatus.state !== 'ready') {
        scope.logger.warn('multi-root remote tools: the remote control plane is not ready; broker tools stay unmounted')
        return
      }
      const presets = scope.permissionPresets
      if (scope.sandboxPolicy.defaultMode === 'danger-full-access'
        || presets.names.some(name => presets.resolve(name).sandbox === 'danger-full-access')) {
        scope.logger.warn('multi-root remote tools: the profile permits danger-full-access; broker tools stay unmounted')
        return
      }
      const { attestBroker } = await import('./broker/attest.ts')
      const attested = await attestBroker(broker.config, manifest).catch(error => ({
        status: 'unavailable' as const, code: 'broker-failed', reason: error instanceof Error ? error.message : String(error),
      }))
      if (attested.status !== 'attested') {
        scope.logger.warn(`multi-root remote tools: credential broker is unavailable (${attested.code}: ${attested.reason}); broker tools stay unmounted`)
        return
      }
      // Publish cleanup before registering anything. If the switch flipped
      // while attestation was in flight, Cordis disposes without resuming.
      yield () => attested.manager.disposeAll()
      mountRemoteTools(scope, attested.manager)
    })
  }

  /**
   * Fold one live read into the plane and the gated subtree. Plane first on
   * enable (mount needs `ready`), subtree first on disable (nothing remote
   * stays model-visible while the plane tears down). Serialized per change —
   * every switch event re-reads the source, so queued stale events settle on
   * the current value.
   */
  const sync = async (): Promise<void> => {
    const enabled = configValue(read()) === true
    if (enabled) {
      await ctx.multiRootRegistry.configureRemote(true)
      if (closed || child !== undefined) return
      try {
        child = ctx.plugin(mount).ctx.fiber
      } catch (error) {
        ctx.logger.warn(`multi-root remote tools: cannot mount the gated subtree: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const current = child
    child = undefined
    try {
      if (current !== undefined) { await current.dispose(); await current.await() }
    } finally {
      await ctx.multiRootRegistry.configureRemote(false)
    }
  }

  const changed = (): void => {
    chain = chain.then(sync).catch(error => {
      ctx.logger.warn(`multi-root remote tools: live switch sync failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // `remoteEnvironments.enabled` on the registry row is only the plane's
  // initial value; a dedicated profile without this row's own `enabled`
  // keeps its behavior by falling through to the plane's initial flag.
  const settings = installRemoteSettings(ctx, () => config.enabled ?? ctx.multiRootRegistry.remoteEnabled, changed)
  const read = settings.read
  ctx.effect(() => () => {
    closed = true
    const current = child
    child = undefined
    void current?.dispose()
    settings.fiber.dispose()
    void ctx.multiRootRegistry.configureRemote(false).catch(() => {})
  })
  changed()
}
