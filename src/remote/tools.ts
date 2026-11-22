/**
 * Personal SSH tools, behind the default-off experimental switch.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-tools
 */
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../compat.ts'
import type {} from '../providers.ts'
import { configValue, volatileField } from '../compat/skills.ts'
import { classifySshCapability, sshPackageVersion, sshPrivateCopy } from '../compat/dsh-version.ts'
import { installRemoteSettings, readRemoteSettingsValue, type RemoteSettingsValue } from '../compat/remote-settings.ts'
import { mountRemoteTools } from './tools-registration.ts'

export interface Config {
  readonly enabled?: boolean
  /** Legacy profile fields. They are read only to keep broker configurations disabled. */
  readonly mode?: unknown
  readonly team?: unknown
  readonly broker?: unknown
}

export const Config = z.object({
  enabled: volatileField(z.boolean().default(false)).description('SSH 远端环境（实验性）：默认关闭。个人模式使用本机 SSH 凭据，远端调用经过 Registry 准入。'),
  mode: z.any().hidden(),
  team: z.any().hidden(),
  broker: z.any().hidden(),
})

export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools', 'sandboxPolicy', 'sessions']

export function apply(ctx: Context, config: Config = {}): void {
  const registry = ctx.multiRootRegistry
  let child: Fiber | undefined
  let closed = false
  let chain: Promise<void> = Promise.resolve()

  const mode = configValue(config.mode)
  const hasLegacyBroker = configValue(config.team) !== undefined || configValue(config.broker) !== undefined
  const configuredMode = mode === undefined && hasLegacyBroker ? 'legacy-broker' : mode

  const mount = (scope: Context): void => {
    if (classifySshCapability({
      platform: process.platform, local: scope.multiRootCompat.report,
      readVersion: sshPackageVersion, privateCopy: sshPrivateCopy,
    }).status !== 'eligible') return

    void scope.effect(async function* () {
      const { SshEnvironmentManager } = await import('./ssh-environment.ts')
      const credentialRoot = registry.remoteCredentialRoot
      const manager = new SshEnvironmentManager({
        manifest: registry.remoteManifest, logger: scope.logger, custody: 'personal',
        managedKnownHostsFile: credentialRoot === undefined ? undefined : join(credentialRoot, 'known_hosts'),
      })
      yield () => manager.disposeAll()
      const rebind = () => manager.rebind(registry.remoteManifest)
      scope.effect(() => registry.onRemoteChange(rebind))
      rebind()
      mountRemoteTools(scope, manager)
    })
  }

  const unmount = async (): Promise<void> => {
    const current = child
    child = undefined
    if (current !== undefined) { await current.dispose(); await current.await() }
  }

  const sync = async (): Promise<void> => {
    if (closed) return
    const current = configValue(settings.read()) as RemoteSettingsValue | undefined
    const enabled = readRemoteSettingsValue(current, configuredMode, message => ctx.logger.warn(message))
    if (enabled) {
      await registry.configureRemote({ enabled: true, mode: 'personal' })
      if (closed) return
      if (!registry.remoteEnabled) { await unmount(); return }
      // Personal config changes rebind the existing manager, including while
      // the plane is temporarily unready. Wait for readiness on the first mount.
      if (child === undefined && registry.remoteStatus.state === 'ready') child = ctx.plugin(mount).ctx.fiber
      return
    }
    try {
      await unmount()
    } finally {
      await registry.configureRemote({ enabled: false, mode: 'personal' })
    }
  }

  const changed = (): void => {
    chain = chain.then(sync).catch(error => {
      ctx.logger.warn(`multi-root remote tools: live switch sync failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const configuredEnabled = configValue(config.enabled)
  const initialEnabled = typeof configuredEnabled === 'boolean' ? configuredEnabled : registry.remoteEnabled
  const settings = installRemoteSettings(ctx, () => configValue(config.enabled) ?? initialEnabled, changed)
  const unsubscribe = registry.onRemoteChange(changed)
  ctx.effect(() => () => {
    closed = true
    unsubscribe()
    settings.fiber.dispose()
    return unmount().finally(() => registry.configureRemote({ enabled: false, mode: 'personal' }))
  })
  changed()
}
