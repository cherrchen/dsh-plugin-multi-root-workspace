/**
 * G5: the explicit tools exist only where the dedicated headless composition
 * mounts them, and their absence elsewhere is a hard refusal — not a silent
 * fallback to native bash or to a local path.
 */
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderRemoteCapabilities } from '../src/remote/capabilities.ts'
import { apply as applyRemoteTools, inject } from '../src/remote/tools.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { executeTool } from './support/tool-executor.ts'
import { mountRemoteTools, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'

let fixture: FixtureWorkspace
let world: RemoteToolsWorld | undefined
beforeEach(() => { fixture = createFixtureWorkspace('remote-tools') })
afterEach(async () => { await world?.dispose(); world = undefined; fixture.dispose() })

interface Failure { readonly isError: true; readonly error: unknown }

/** A valid local→local copy: the tool refuses it itself, without admission. */
const localToLocal = {
  from: { environmentId: 'local', rootId: 'primary', relativePath: 'a' },
  to: { environmentId: 'local', rootId: 'primary', relativePath: 'b' },
}

describe.skipIf(process.platform === 'win32')('the explicit remote tools row', () => {
  it('registers both tools only in a composition that mounts the row', async () => {
    world = await mountRemoteTools(fixture)
    // Dispatch through the host pipeline: a registered tool answers with its
    // own contract, an unregistered one with ToolNotFoundError. This probe
    // works on every supported release, unlike a tools-list method that older
    // releases do not expose.
    const copy = await world.call('remote_copy', localToLocal)
    expect(copy).toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    const bash = await world.call('remote_bash', { environmentId: 'build', rootId: 'app', command: 'x', timeoutMs: 10 })
    expect(bash).toMatchObject({ status: 'not-started' })
    await world.dispose()

    world = await mountRemoteTools(fixture, { withTools: false })
    const missing = await world.call('remote_copy', localToLocal) as Failure
    expect(missing.isError).toBe(true)
  })

  it('executes remote_bash through the default backend factory across both admissions', async () => {
    // Regression: admission A (confine) and admission B (spawn) each call
    // backendFor; the default factory must return the SAME lazy adapter or B
    // spawns with no bound environment (admitted-may-start forever).
    world = await mountRemoteTools(fixture, {
      defaultBackends: true,
      seed: { build: { '/srv/root/src/a.txt': 'a', '/srv/root/src/b.txt': 'b' } },
    })
    await registerRemote(world, 'build', 'app')
    const built = await world.call('remote_bash', { environmentId: 'build', rootId: 'app', command: 'build app', timeoutMs: 5_000 })
    expect(built, JSON.stringify(built)).toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 0, stdout: 'built app\n' })
    const again = await world.call('remote_bash', { environmentId: 'build', rootId: 'app', command: 'test app', timeoutMs: 5_000 })
    expect(again, JSON.stringify(again)).toMatchObject({ status: 'scope-exited', exitCode: 0 })
  })

  it('renders operation results to the model through the host pipeline', async () => {
    world = await mountRemoteTools(fixture)
    for (const [name, args] of [
      ['remote_copy', localToLocal],
      ['remote_bash', { environmentId: 'build', rootId: 'app', command: 'true', timeoutMs: 10 }],
    ] as const) {
      const outcome = await executeTool(world.ctx, {
        name, args, agent: world.agent, callId: name, signal: new AbortController().signal,
      }) as { value: unknown; content: unknown }
      expect(outcome.value).toHaveProperty('status')
      expect(outcome.content).toEqual([{ type: 'text', text: JSON.stringify(outcome.value) }])
    }
  })

  it('is also the endpoint-registration path: without the row nothing verifies a session endpoint', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    await expect(registerRemote(world, 'build', 'app')).rejects.toThrow(/no remote endpoint verifier is configured/)
  })

  it('stops new calls and drains staging before the tools row is removed', async () => {
    world = await mountRemoteTools(fixture)
    const mounted = world
    await registerRemote(mounted, 'build', 'app')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'copy in flight')
    const remote = mounted.remotes.get('build')!
    const write = remote.sftp.write
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(remote.sftp, 'write').mockImplementation(async (...args) => {
      await write(...args)
      entered.resolve()
      await release.promise
    })
    const copying = mounted.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'source.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'rollback.txt' },
    })
    await Promise.race([entered.promise, copying.then(result => { throw new Error(JSON.stringify(result)) })])
    const unloaded = mounted.unmountTools()
    try {
      await expect.poll(() => mounted.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
    } finally {
      release.resolve()
    }
    await expect(copying).resolves.toMatchObject({ code: 'cancelled', staging: 'removed' })
    await unloaded
    expect(remote.read('/srv/root/rollback.txt')).toBeUndefined()
    expect(remote.sftpCalls.some(call => call.startsWith('hardlink '))).toBe(false)
    await expect(registerRemote(mounted, 'build', 'app')).rejects.toThrow(/no remote endpoint verifier/)
    expect(await mounted.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
  })

  it('refuses a declarative enabled switch without broker custody', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    const directConfig = { enabled: true, broker: undefined }
    await world.ctx.plugin({ name: 'g5-direct-refused', inject, apply: ctx => applyRemoteTools(ctx, directConfig) })
    expect(await world.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
    await expect(registerRemote(world, 'build', 'app')).rejects.toThrow(/no remote endpoint verifier/)
  })

  it('does not mount when the credential broker fails attestation', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    const uid = process.getuid?.() ?? -1
    await world.ctx.plugin({
      name: 'g5-broker-gate', inject,
      apply: (ctx: typeof world.ctx) => applyRemoteTools(ctx, {
        broker: { config: { socketPath: '/nonexistent/broker.sock', brokerUid: uid, credentialRoot: '/nonexistent', confinementProbe: { verified: true } } },
      }),
    })
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    const missing = await world.call('remote_copy', localToLocal) as Failure
    expect(missing.isError).toBe(true)
  })

  it('stays disabled without an explicit broker configuration', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    await world.ctx.plugin({ name: 'g5-remote-tools-off', inject, apply: (ctx: typeof world.ctx) => applyRemoteTools(ctx, {}) })
    // The switch is off: the row loads and registers nothing.
    const missing = await world.call('remote_copy', localToLocal) as Failure
    expect(missing.isError).toBe(true)
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
