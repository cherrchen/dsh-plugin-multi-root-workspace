/**
 * G5: the explicit tools exist only where the dedicated headless composition
 * mounts them, and their absence elsewhere is a hard refusal — not a silent
 * fallback to native bash or to a local path.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { renderRemoteCapabilities } from '../src/remote/capabilities.ts'
import { apply as applyRemoteTools } from '../src/remote/tools.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'

let fixture: FixtureWorkspace
let world: RemoteToolsWorld | undefined
beforeEach(() => { fixture = createFixtureWorkspace('remote-tools') })
afterEach(async () => { await world?.dispose(); world = undefined; fixture.dispose() })

const names = (ctx: RemoteToolsWorld['ctx']) => ctx.tools.definitions().map(definition => definition.name).sort()

interface Failure { readonly isError: true; readonly error: { readonly info?: { readonly name?: string } } }

describe.skipIf(process.platform === 'win32')('the explicit remote tools row', () => {
  it('registers both tools only in a composition that mounts the row', async () => {
    world = await mountRemoteTools(fixture)
    expect(names(world.ctx)).toEqual(expect.arrayContaining(['remote_bash', 'remote_copy']))
    await world.dispose()

    world = await mountRemoteTools(fixture, { withTools: false })
    expect(names(world.ctx)).not.toContain('remote_copy')
    expect(names(world.ctx)).not.toContain('remote_bash')
    const missing = await world.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'a' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'a' },
    }) as Failure
    expect(missing.isError).toBe(true)
    expect(missing.error.info?.name).toBe('ToolNotFoundError')
  })

  it('is also the endpoint-registration path: without the row nothing verifies a session endpoint', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    await expect(registerRemote(world, 'build', 'app')).rejects.toThrow(/no remote endpoint verifier is configured/)
  })

  it('refuses to mount while the remote control plane is not ready', async () => {
    const stack = await mountRegistryStack(join(fixture.base, 'store'), {})
    try {
      const failure = await stack.ctx.plugin({ name: 'g5-remote-tools-disabled', inject: ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry'], apply: (ctx: typeof stack.ctx) => applyRemoteTools(ctx, { enabled: true }) })
        .then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
      expect(failure).toMatch(/remote control plane is not ready/)
    } finally {
      await stack.dispose()
    }
  })

  it('does not mount when the credential broker fails attestation', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    const uid = process.getuid?.() ?? -1
    await world.ctx.plugin({
      name: 'g5-broker-gate', inject: ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools'],
      apply: (ctx: typeof world.ctx) => applyRemoteTools(ctx, {
        broker: { config: { socketPath: '/nonexistent/broker.sock', brokerUid: uid, credentialRoot: '/nonexistent', confinementProbe: { verified: true } } },
      }),
    })
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    expect(names(world.ctx)).not.toContain('remote_copy')
    expect(names(world.ctx)).not.toContain('remote_bash')
  })

  it('stays disabled unless the switch is explicitly true', async () => {
    const stack = await mountRegistryStack(join(fixture.base, 'store'), {})
    try {
      await stack.ctx.plugin(SystemPrompt)
      await stack.ctx.plugin(Tools)
      await stack.ctx.plugin({ name: 'g5-remote-tools-off', inject: ['multiRootCompat', 'multiRootProviders', 'multiRootRegistry', 'tools'], apply: (ctx: typeof stack.ctx) => applyRemoteTools(ctx, {}) })
      // The switch is off: the row loads and registers nothing.
      expect(stack.ctx.tools.definitions()).toHaveLength(0)
    } finally {
      await stack.dispose()
    }
  })
})

describe('the model-facing capability projection', () => {
  const manifest = {
    environments: [
      { environmentId: 'build', platform: 'linux', account: 'builder', connection: { host: 'build-host' } },
      { environmentId: 'device', platform: 'linux', account: 'deploy', connection: { host: 'device-host' } },
    ],
  } as unknown as DeploymentManifest
  const bindings = [{
    primary: '/work/app', environmentId: 'build', rootId: 'app', path: '/srv/root',
    actions: ['exec', 'read', 'write'],
    transfers: [
      { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
      { direction: 'export', peer: { environmentId: 'device', rootId: 'out' } },
    ],
  }] as unknown as DeploymentManifest['bindings']

  it('contributes nothing when this project has no remote binding', () => {
    expect(renderRemoteCapabilities({ bindings: [], environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } })).toBe('')
  })

  it('names capabilities and pairings but never the connection account or host', () => {
    const text = renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } })
    expect(text).toContain('build/app at "/srv/root" (linux): actions read, write, exec')
    expect(text).toContain('accepts copies from local/primary')
    expect(text).toContain('sends copies to device/out')
    expect(text).not.toContain('builder')
    expect(text).not.toContain('build-host')
  })

  it('explains a degraded control plane and a read-only session', () => {
    const degraded = renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'config-invalid', reason: 'bad manifest' } })
    expect(degraded).toContain('remote-unavailable')
    expect(degraded).toContain('bad manifest')
    const readOnly = renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'read-only', status: { state: 'ready' } })
    expect(readOnly).toContain('This session is read-only')
    expect(renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } }))
      .toBe(renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } }))
  })

  it('stays out of the production profile patch', () => {
    const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('remote-tools')
    expect(patch).not.toMatch(/id: multi-root-remote/)
  })
})
