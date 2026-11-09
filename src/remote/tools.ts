/**
 * Optional remote tool row. A deployment opts in with a credential broker;
 * the default profile does not mount this row.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '../compat.ts'
import type {} from '../providers.ts'
import { classifySshCapability, sshPackageVersion, sshPrivateCopy } from '../compat/dsh-version.ts'
import type { BrokerConfig } from './broker/attest.ts'
import { mountRemoteTools } from './tools-registration.ts'

export interface Config {
  readonly broker?: { readonly config: BrokerConfig }
}

export const inject = ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools', 'sandboxPolicy', 'permissionPresets']

export function apply(ctx: Context, config: Config = {}): void {
  const broker = config.broker
  if (broker === undefined) return

  const capability = classifySshCapability({
    platform: process.platform, local: ctx.multiRootCompat.report,
    readVersion: sshPackageVersion, privateCopy: sshPrivateCopy,
  })
  if (capability.status !== 'eligible') return

  void ctx.effect(async function* () {
    const manifest = ctx.multiRootRegistry.remoteManifest
    if (manifest === undefined || ctx.multiRootRegistry.remoteStatus.state !== 'ready') {
      ctx.logger.warn('multi-root remote tools: the remote control plane is not ready; broker tools stay unmounted')
      return
    }
    const presets = ctx.permissionPresets
    if (ctx.sandboxPolicy.defaultMode === 'danger-full-access'
      || presets.names.some(name => presets.resolve(name).sandbox === 'danger-full-access')) {
      ctx.logger.warn('multi-root remote tools: the profile permits danger-full-access; broker tools stay unmounted')
      return
    }
    const { attestBroker } = await import('./broker/attest.ts')
    const attested = await attestBroker(broker.config, manifest).catch(error => ({
      status: 'unavailable' as const, code: 'broker-failed', reason: error instanceof Error ? error.message : String(error),
    }))
    if (attested.status !== 'attested') {
      ctx.logger.warn(`multi-root remote tools: credential broker is unavailable (${attested.code}: ${attested.reason}); broker tools stay unmounted`)
      return
    }
    // Publish cleanup before registering anything. If the row was removed while
    // attestation was in flight, Cordis disposes the result without resuming.
    yield () => attested.manager.disposeAll()
    mountRemoteTools(ctx, attested.manager)
  })
}
