/**
 * The live `multi-root-remote-tools.enabled` switch. The row ships in the
 * default bundle but is inert while off — nothing registers and the remote
 * control plane stays `disabled` — and flipping it drives the plane and the
 * gated tool subtree (guard, attestation, tools, verifier, projection)
 * together.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyRemoteTools, Config as RemoteToolsConfig, inject } from '../src/remote/tools.ts'
import { classifyInstallation, classifySshCapability, sshPackageVersion, sshPrivateCopy } from '../src/compat/dsh-version.ts'
import type { RemoteExecutionBackend } from '../src/remote/exec.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import { fakeExecBackend, FAKE_EXEC, type FakeRemote } from './support/fake-remote.ts'

/** The broker answer this spec controls; the wire itself is faked out. */
const probe = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  remotes: undefined as ReadonlyMap<string, FakeRemote> | undefined,
  backends: undefined as ReadonlyMap<string, RemoteExecutionBackend> | undefined,
}))

vi.mock('../src/remote/broker/attest.ts', async () => {
  const { FakeManager } = await import('./support/fake-remote.ts')
  return {
    attestBroker: async (_config: unknown, manifest: never) => {
      probe.calls += 1
      if (probe.fail || probe.remotes === undefined || probe.backends === undefined) {
        return { status: 'unavailable', code: 'broker-failed', reason: 'the test broker refused' }
      }
      return { status: 'attested', connection: {}, manager: new FakeManager(manifest, probe.remotes, probe.backends) }
    },
  }
})

// Personal custody builds its manager directly (no broker); the fake manager
// stands in so admission runs end-to-end without touching ssh(1).
vi.mock('../src/remote/ssh-environment.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/remote/ssh-environment.ts')>()
  const { FakeManager } = await import('./support/fake-remote.ts')
  class TestManager {
    constructor(options: { manifest: never }) {
      if (probe.remotes === undefined || probe.backends === undefined) throw new Error('test fake remotes not installed')
      return new FakeManager(options.manifest, probe.remotes, probe.backends) as never
    }
  }
  return { ...original, SshEnvironmentManager: TestManager }
})

/**
 * The gate tools.ts evaluates with the REAL installation report: on a lane
 * below the SSH floor the gated subtree never mounts, so the specs asserting
 * attestation/tools skip with the gate's reason instead of failing. The two
 * "mounts nothing" specs below keep running on every lane — the plane opens
 * and nothing model-visible exists on either side of the floor.
 */
const realGate = classifySshCapability({
  platform: process.platform,
  local: classifyInstallation(),
  readVersion: sshPackageVersion,
  privateCopy: sshPrivateCopy,
})
const gated = it.skipIf(realGate.status !== 'eligible')
const gateSkipped = realGate.status === 'eligible' ? '' : ` (skipped: ${realGate.status === 'absent' ? realGate.reason : 'n/a'})`

let fixture: FixtureWorkspace
let world: RemoteToolsWorld | undefined
beforeEach(() => { fixture = createFixtureWorkspace('remote-tools-switch') })
afterEach(async () => {
  await world?.dispose(); world = undefined; fixture.dispose()
  probe.calls = 0; probe.fail = false; probe.remotes = undefined; probe.backends = undefined
})

interface SwitchHooks {
  setSource(source: () => { enabled?: unknown }): void
  onChange(): void
  validate(value: { enabled?: unknown }): void
}

/** A minimal Settings host: the persisted value is `live`, flipped by the test. */
function installSettings(ctx: Context, live: { enabled: boolean }, seeds?: unknown[]): () => SwitchHooks | undefined {
  let hooks: SwitchHooks | undefined
  ctx.provide('settings', {
    installSection: (_owner: Context, ns: string, _schema: unknown, value: unknown, callbacks: SwitchHooks) => {
      if (ns !== 'multi-root-remote-tools') return
      seeds?.push(value)
      hooks = callbacks
      callbacks.setSource(() => live)
    },
  } as never)
  return () => hooks
}

/** A valid local→local copy: the registered tool refuses it without admission. */
const localToLocal = {
  from: { environmentId: 'local', rootId: 'primary', relativePath: 'a' },
  to: { environmentId: 'local', rootId: 'primary', relativePath: 'b' },
}

const BROKER = { socketPath: '/broker/broker.sock', brokerUid: 999, credentialRoot: '/broker/credentials' }

async function mountRow(
  options: { remote?: { enabled?: boolean; personalPath?: string; credentialRoot?: string }; config?: { enabled?: boolean; broker?: boolean; mode?: 'personal' | 'team' | 'hardened' }; persisted?: boolean } = {},
): Promise<{ hooks: () => SwitchHooks | undefined; live: { enabled: boolean } }> {
  world = await mountRemoteTools(fixture, { withTools: false, ...(options.remote === undefined ? {} : { remote: options.remote }) })
  probe.remotes = world.remotes
  probe.backends = new Map([['build', fakeExecBackend(world.remotes.get('build')!, FAKE_EXEC)]])
  // `persisted` is what the bound Settings source reports; an absent override
  // reports the row's own initial value, so dedicated profiles seed it true.
  const live = { enabled: options.persisted ?? options.config?.enabled ?? false }
  const hooks = installSettings(world.ctx, live)
  const config = {
    ...(options.config?.enabled === undefined ? {} : { enabled: options.config.enabled }),
    ...(options.config?.mode === undefined ? {} : { mode: options.config.mode }),
    ...(options.config?.broker === false ? {} : { broker: { config: BROKER } }),
  }
  await world.ctx.plugin({ name: 'remote-tools-switch', inject, apply: (ctx: Context) => applyRemoteTools(ctx, config) })
  return { hooks, live }
}

describe.skipIf(process.platform === 'win32')('the remote-tools live switch', () => {
  it('stays inert while the switch is off: nothing registers and the plane is disabled', async () => {
    const { hooks } = await mountRow({ remote: {}, config: { enabled: false } })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    expect(world!.stack.registry.remoteEnabled).toBe(false)
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')
    expect(probe.calls).toBe(0)
    expect(await world!.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
    await expect(registerRemote(world!, 'build', 'app')).rejects.toMatchObject({ code: 'remote-unavailable' })
  })

  it('unwraps the Schemastery volatile row config before configuring the plane', async () => {
    const seeds: unknown[] = []
    world = await mountRemoteTools(fixture, {
      withTools: false,
      remote: { enabled: false, personalPath: join(fixture.base, 'personal.json'), credentialRoot: join(fixture.base, 'cred') },
    })
    installSettings(world.ctx, { enabled: false }, seeds)
    // The real row config a loader hands to apply(): Schemastery wraps the
    // volatile `enabled`/`mode` fields, so passing it through unchanged used to
    // make the plane's mode the wrapper object and the panel's custodyMode
    // unreadable.
    const validated = (RemoteToolsConfig as unknown as (value: unknown) => Record<string, unknown>)({ enabled: true, mode: 'personal' })
    await world.ctx.plugin({
      name: 'remote-tools-volatile-config',
      inject,
      apply: (ctx: Context) => applyRemoteTools(ctx, { ...validated, broker: { config: BROKER } } as never),
    })
    await expect.poll(() => seeds[0], { timeout: 2_000 }).toMatchObject({ enabled: true, mode: 'personal' })
    await expect.poll(() => world!.stack.registry.remoteMode, { timeout: 2_000 }).toBe('personal')
    // The bound Settings source still says off; the seed only fixes the initial
    // value the Settings UI starts from.
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')
  })

  gated(`drives configureRemote and mounts the gated subtree when the switch turns on${gateSkipped}`, async () => {
    const { hooks, live } = await mountRow({ remote: {}, config: { enabled: false } })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')

    live.enabled = true
    hooks()!.onChange()
    await expect.poll(() => world!.stack.registry.remoteStatus.state, { timeout: 5_000 }).toBe('ready')
    expect(world!.stack.registry.remoteEnabled).toBe(true)
    await expect.poll(async () => await world!.call('remote_copy', localToLocal), { timeout: 5_000 })
      .toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    expect(probe.calls).toBe(1)
    // The verifier mounted with the tools: the real registration path works.
    await registerRemote(world!, 'build', 'app')
  })

  gated(`unmounts the subtree and restores the exact disabled state when the switch turns off${gateSkipped}`, async () => {
    const { hooks, live } = await mountRow({ remote: {}, config: { enabled: false } })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    live.enabled = true
    hooks()!.onChange()
    await expect.poll(async () => await world!.call('remote_copy', localToLocal), { timeout: 5_000 })
      .toMatchObject({ status: 'failed', code: 'direction-unsupported' })

    live.enabled = false
    hooks()!.onChange()
    await expect.poll(() => world!.stack.registry.remoteStatus.state, { timeout: 5_000 }).toBe('disabled')
    expect(world!.stack.registry.remoteEnabled).toBe(false)
    await expect.poll(async () => await world!.call('remote_copy', localToLocal), { timeout: 5_000 })
      .toMatchObject({ isError: true })
    await expect(registerRemote(world!, 'build', 'app')).rejects.toMatchObject({ code: 'remote-unavailable' })
    // The local registry is untouched by the remote switch.
    expect(world!.stack.registry.list(world!.session.header.cwd!)).toEqual([])
  })

  gated(`opens the plane but mounts nothing when the broker fails attestation${gateSkipped}`, async () => {
    const { hooks, live } = await mountRow({ remote: {}, config: { enabled: false } })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    probe.fail = true
    live.enabled = true
    hooks()!.onChange()
    await expect.poll(() => world!.stack.registry.remoteStatus.state, { timeout: 5_000 }).toBe('ready')
    await expect.poll(() => probe.calls, { timeout: 5_000 }).toBe(1)
    expect(await world!.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
  })

  gated(`adopts the registry remoteEnabled as the initial switch for dedicated profiles${gateSkipped}`, async () => {
    // remoteEnvironments.enabled: true is the registry row's INITIAL live
    // value; a tools row without its own `enabled` inherits it, and a source
    // with no persisted override reports that same initial.
    await mountRow({ remote: { enabled: true }, config: { broker: true }, persisted: true })
    expect(world!.stack.registry.remoteStatus.state).toBe('ready')
    await expect.poll(async () => await world!.call('remote_copy', localToLocal), { timeout: 5_000 })
      .toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    expect(probe.calls).toBe(1)
  })

  it('still mounts nothing without a broker block even while the plane opens', async () => {
    const { hooks, live } = await mountRow({ remote: {}, config: { enabled: false, broker: false, mode: 'hardened' } })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    live.enabled = true
    hooks()!.onChange()
    await expect.poll(() => world!.stack.registry.remoteStatus.state, { timeout: 5_000 }).toBe('ready')
    await expect.poll(() => probe.calls, { timeout: 5_000 }).toBe(0)
    expect(await world!.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
  })

  gated(`mounts the personal host manager and admits remote_copy end-to-end${gateSkipped}`, async () => {
    const personalPath = join(fixture.base, 'remote-personal.json')
    const credentialRoot = join(fixture.base, 'cred')
    writeFileSync(personalPath, JSON.stringify({
      schemaVersion: 1, revision: 0,
      environments: [{
        environmentId: 'build', platform: 'linux',
        endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
        credential: { kind: 'ssh-config', alias: 'build-host' },
        hostKey: `SHA256:${'A'.repeat(43)}`, helper: null,
        workspace: '/srv/root',
        transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000 },
      }],
      bindings: [{
        primary: fixture.workspace, environmentId: 'build', rootId: 'app', path: '/srv/root',
        actions: ['read', 'write', 'exec'],
        transfers: [
          { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
          { direction: 'export', peer: { environmentId: 'local', rootId: 'primary' } },
        ],
      }],
    }), { mode: 0o600 })
    const { hooks, live } = await mountRow({
      remote: { enabled: false, personalPath, credentialRoot },
      config: { enabled: false, broker: false, mode: 'personal' },
    })
    await expect.poll(() => hooks(), { timeout: 2_000 }).not.toBeUndefined()
    world!.remotes.get('build')!.seed('/srv/root/src/a.txt', 'personal bytes\n')

    live.enabled = true
    hooks()!.onChange()
    await expect.poll(() => world!.stack.registry.remoteStatus.state, { timeout: 5_000 }).toBe('ready')
    expect(world!.stack.registry.remoteMode).toBe('personal')
    // Personal custody never talks to a broker.
    expect(probe.calls).toBe(0)

    await registerRemote(world!, 'build', 'app')
    const copy = await world!.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'imported.txt' },
    })
    expect(copy, JSON.stringify(copy)).toMatchObject({ status: 'committed' })
  })
})
