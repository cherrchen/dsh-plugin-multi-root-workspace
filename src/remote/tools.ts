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
import { installRemoteSettings, readRemoteSettingsValue, type RemoteSettingsValue } from '../compat/remote-settings.ts'
import type { BrokerConfig } from './broker/attest.ts'
import { installRemoteProfileGuard } from './profile-guard.ts'
import type { RemoteMode } from './plane.ts'
import { mountRemoteTools } from './tools-registration.ts'

/** The live `team` block: per-field overrides over the row's broker config. */
export interface TeamConfig {
  readonly manifestPath?: string
  readonly socketPath?: string
  readonly brokerUid?: number
  readonly credentialRoot?: string
}

export interface Config {
  /** The live switch; the persisted Settings value overrides the row config. */
  readonly enabled?: boolean
  /** The custody mode; `remoteEnvironments.enabled` profiles stay 'hardened'. */
  readonly mode?: RemoteMode
  readonly team?: TeamConfig
  readonly broker?: { readonly config: BrokerConfig }
}

/** The schemastery face of {@link Config}; `broker`/`team` pass through untyped. */
export const Config = z.object({
  enabled: volatileField(z.boolean().default(false)).description('SSH 远端环境（实验性）：默认关闭。开启后 Agent 可对已注册的远端端点使用 remote_copy / remote_bash，每次调用仍经过 Registry 准入；远端凭据托管取决于部署。'),
  mode: volatileField(z.union([z.const('personal'), z.const('team'), z.const('hardened')]).default('personal')).description('凭据托管档位：personal（用户自己的 SSH）、team（共享 broker）、hardened（部署托管 broker）。'),
  team: z.object({
    manifestPath: z.string(),
    socketPath: z.string(),
    brokerUid: z.natural(),
    credentialRoot: z.string(),
  }),
})

export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools', 'sandboxPolicy', 'permissionPresets', 'sandbox', 'subprocess', 'sessions']

export function apply(ctx: Context, config: Config = {}): void {
  const broker = config.broker
  let child: Fiber | undefined
  let mountedDigest: string | undefined
  let closed = false
  let chain: Promise<void> = Promise.resolve()

  /** The live settings, fail-closed on any unknown value (ADR-0041). */
  const live = (): { enabled: boolean; mode: RemoteMode; team?: TeamConfig | undefined } => {
    const value = readRemoteSettingsValue(
      (configValue(read()) ?? {}) as RemoteSettingsValue,
      message => ctx.logger.warn(message),
    )
    // Settings `mode` wins; absent means the row's own default — a profile
    // with a broker block and no mode keeps 'hardened'.
    const mode = value.mode ?? config.mode ?? (broker === undefined ? 'personal' : 'hardened')
    return { enabled: value.enabled, mode, ...(value.team === undefined ? { ...(config.team === undefined ? {} : { team: config.team }) } : { team: value.team as TeamConfig }) }
  }

  /**
   * The gated subtree, mounted per switch-on per mode (ADR-0041 §5): SSH
   * capability gate is shared; personal runs the host-side manager directly,
   * team attests a relaxed broker, hardened is the previous full path.
   */
  const mount = (scope: Context, mode: RemoteMode, team?: TeamConfig): void => {
    const capability = classifySshCapability({
      platform: process.platform, local: scope.multiRootCompat.report,
      readVersion: sshPackageVersion, privateCopy: sshPrivateCopy,
    })
    if (capability.status !== 'eligible') return
    const restoreGuard = mode === 'hardened' ? installRemoteProfileGuard(scope) : undefined
    if (restoreGuard !== undefined) scope.effect(() => () => restoreGuard())
    void scope.effect(async function* () {
      const manifest = scope.multiRootRegistry.remoteManifest
      if (manifest === undefined || scope.multiRootRegistry.remoteStatus.state !== 'ready') {
        scope.logger.warn('multi-root remote tools: the remote control plane is not ready; remote tools stay unmounted')
        return
      }
      if (mode === 'personal') {
        const { SshEnvironmentManager } = await import('./ssh-environment.ts')
        const manager = new SshEnvironmentManager({ manifest, logger: scope.logger, custody: 'personal' })
        yield () => manager.disposeAll()
        mountRemoteTools(scope, manager)
        return
      }
      const presets = scope.permissionPresets
      if (mode === 'hardened'
        && (scope.sandboxPolicy.defaultMode === 'danger-full-access'
          || presets.names.some(name => presets.resolve(name).sandbox === 'danger-full-access'))) {
        scope.logger.warn('multi-root remote tools: the profile permits danger-full-access; broker tools stay unmounted')
        return
      }
      const brokerConfig = mode === 'team' && team !== undefined
        ? ({
            ...broker?.config,
            socketPath: team.socketPath ?? broker?.config.socketPath,
            brokerUid: team.brokerUid ?? broker?.config.brokerUid,
            credentialRoot: team.credentialRoot ?? broker?.config.credentialRoot,
          } as BrokerConfig | undefined)
        : broker?.config
      if (brokerConfig === undefined || (mode === 'team' && (brokerConfig.socketPath === undefined || brokerConfig.brokerUid === undefined || brokerConfig.credentialRoot === undefined))) {
        scope.logger.warn('multi-root remote tools: no usable broker configuration; remote tools stay unmounted')
        return
      }
      const { attestBroker } = await import('./broker/attest.ts')
      const attested = await attestBroker(brokerConfig, manifest, { mode }).catch(error => ({
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
    const { enabled, mode, team } = live()
    if (enabled) {
      await ctx.multiRootRegistry.configureRemote({
        enabled: true, mode,
        ...(mode === 'team' && team?.manifestPath !== undefined ? { manifestPath: team.manifestPath } : {}),
      })
      if (closed) return
      const digest = ctx.multiRootRegistry.remoteManifestDigest
      if (child !== undefined && mountedDigest === digest) return
      const stale = child
      child = undefined
      if (stale !== undefined) { await stale.dispose(); await stale.await() }
      try {
        child = ctx.plugin(childScope => mount(childScope, mode, team)).ctx.fiber
        mountedDigest = digest
      } catch (error) {
        ctx.logger.warn(`multi-root remote tools: cannot mount the gated subtree: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const current = child
    child = undefined
    mountedDigest = undefined
    try {
      if (current !== undefined) { await current.dispose(); await current.await() }
    } finally {
      await ctx.multiRootRegistry.configureRemote({ enabled: false, mode })
    }
  }

  const changed = (): void => {
    chain = chain.then(sync).catch(error => {
      ctx.logger.warn(`multi-root remote tools: live switch sync failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // `remoteEnvironments.enabled` on the registry row is only the plane's
  // initial value; a dedicated profile without this row's own `enabled`
  // keeps its behavior by falling through to the plane's initial flag, and
  // a profile without a `mode` but with a broker block stays 'hardened'.
  const settings = installRemoteSettings(ctx, (): RemoteSettingsValue => ({
    enabled: config.enabled ?? ctx.multiRootRegistry.remoteEnabled,
    mode: config.mode ?? (broker === undefined ? 'personal' : 'hardened'),
    ...(config.team === undefined ? {} : { team: config.team }),
  }), changed)
  const read = settings.read
  // A manifest reload (mode switch, personal file change) remounts the
  // subtree so the manager is rebuilt against the new digest.
  const unsubscribe = ctx.multiRootRegistry.onRemoteChange(() => { changed() })
  ctx.effect(() => () => {
    closed = true
    unsubscribe()
    const current = child
    child = undefined
    mountedDigest = undefined
    void current?.dispose()
    settings.fiber.dispose()
    void ctx.multiRootRegistry.configureRemote({ enabled: false, mode: 'personal' }).catch(() => {})
  })
  changed()
}
