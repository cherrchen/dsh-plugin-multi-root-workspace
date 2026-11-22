/** The personal-only SSH row and its live, default-off switch. */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyRemoteTools, Config as RemoteToolsConfig, inject } from '../src/remote/tools.ts'
import { classifyInstallation, classifySshCapability, sshPackageVersion, sshPrivateCopy } from '../src/compat/dsh-version.ts'
import { loadPersonalConfig, savePersonalConfig } from '../src/remote/personal/config.ts'
import type { RemoteExecutionBackend } from '../src/remote/exec.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import { fakeExecBackend, FAKE_EXEC, type FakeRemote } from './support/fake-remote.ts'

const probe = vi.hoisted(() => ({
  attest: vi.fn(),
  personalMounts: 0,
  remotes: undefined as ReadonlyMap<string, FakeRemote> | undefined,
  backends: undefined as ReadonlyMap<string, RemoteExecutionBackend> | undefined,
}))

vi.mock('../src/remote/broker/attest.ts', () => ({ attestBroker: probe.attest }))

// Personal custody builds its manager directly (no broker); the fake manager
// stands in so admission runs end-to-end without touching ssh(1).
vi.mock('../src/remote/ssh-environment.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/remote/ssh-environment.ts')>()
  const { FakeManager } = await import('./support/fake-remote.ts')
  class TestManager extends FakeManager {
    constructor(options: { manifest: never }) {
      if (probe.remotes === undefined || probe.backends === undefined) throw new Error('test fake remotes not installed')
      super(options.manifest, probe.remotes, probe.backends)
      probe.personalMounts++
    }
    rebind(manifest: unknown) {
      Object.assign(this, { deployment: manifest })
    }
  }
  return { ...original, SshEnvironmentManager: TestManager }
})

// Tool-mount assertions require an installation eligible for personal SSH.
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
  probe.attest.mockClear(); probe.personalMounts = 0; probe.remotes = undefined; probe.backends = undefined
})

interface SwitchHooks {
  setSource(source: () => { enabled?: unknown }): void
  onChange(): void
  validate(value: { enabled?: unknown; mode?: unknown; team?: unknown }): void
}

/** A minimal Settings host: the persisted value is `live`, flipped by the test. */
function installSettings(ctx: Context, live: { enabled: boolean; mode?: string; team?: Record<string, unknown> }, seeds?: unknown[]): () => SwitchHooks | undefined {
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
  options: {
    remote?: { enabled?: boolean; personalPath?: string; credentialRoot?: string }
    config?: { enabled?: boolean; broker?: boolean; mode?: 'personal' | 'team' | 'hardened' }
  } = {},
): Promise<{ hooks: () => SwitchHooks | undefined; live: { enabled: boolean; mode?: string; team?: Record<string, unknown> } }> {
  world = await mountRemoteTools(fixture, {
    withTools: false,
    remote: { personalPath: join(fixture.base, 'personal.json'), credentialRoot: join(fixture.base, 'cred'), ...options.remote },
  })
  probe.remotes = world.remotes
  probe.backends = new Map([['build', fakeExecBackend(world.remotes.get('build')!, FAKE_EXEC)]])
  const live: { enabled: boolean; mode?: string; team?: Record<string, unknown> } = {
    enabled: options.config?.enabled ?? options.remote?.enabled ?? false,
  }
  const hooks = installSettings(world.ctx, live)
  const config = {
    ...(options.config?.enabled === undefined ? {} : { enabled: options.config.enabled }),
    ...(options.config?.mode === undefined ? {} : { mode: options.config.mode }),
    ...(options.config?.broker === true ? { broker: { config: BROKER } } : {}),
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
    expect(probe.attest).not.toHaveBeenCalled()
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
    await expect.poll(() => seeds[0], { timeout: 2_000 }).toEqual({ enabled: true })
    await expect.poll(() => world!.stack.registry.remoteMode, { timeout: 2_000 }).toBe('personal')
    // The bound Settings source still says off; the seed only fixes the initial
    // value the Settings UI starts from.
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')
  })

  it('exposes only the enable switch as a volatile setting', async (ctx) => {
    let spec: string | undefined
    try {
      const anchor = createRequire(require.resolve('@deepseek-ai/dsh-client-locale/package.json'))
      spec = anchor.resolve('@deepseek-ai/dsh-settings/src/schema.ts')
    } catch { spec = undefined }
    if (spec === undefined) return ctx.skip()
    const { isVolatilePath } = (await import(spec)) as {
      isVolatilePath(schema: unknown, path: readonly string[]): boolean
    }
    expect(isVolatilePath(RemoteToolsConfig, ['enabled'])).toBe(true)
    for (const path of [['mode'], ['team'], ['team', 'socketPath'], ['broker']]) {
      expect(isVolatilePath(RemoteToolsConfig, path), path.join('.')).toBe(false)
    }
  })

  it.each(['team', 'hardened'] as const)('refuses a loader profile requesting %s custody', async mode => {
    const { hooks } = await mountRow({ config: { enabled: true, broker: true, mode } })
    await expect.poll(() => hooks()).not.toBeUndefined()
    // An old host may still deliver a non-personal Settings document.
    expect(() => hooks()!.validate({ enabled: true, mode })).toThrow(/fixed to personal/)
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')
    expect(await world!.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
    expect(probe.attest).not.toHaveBeenCalled()
    expect(probe.personalMounts).toBe(0)
  })

  it('refuses an implicit legacy broker profile', async () => {
    const { hooks } = await mountRow({ config: { enabled: true, broker: true } })
    await expect.poll(() => hooks()).not.toBeUndefined()
    expect(world!.stack.registry.remoteStatus.state).toBe('disabled')
    expect(probe.attest).not.toHaveBeenCalled()
    expect(probe.personalMounts).toBe(0)
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

  gated(`adopts the registry remoteEnabled as the initial personal switch${gateSkipped}`, async () => {
    await mountRow({ remote: { enabled: true } })
    expect(world!.stack.registry.remoteStatus.state).toBe('ready')
    await expect.poll(() => world!.call('remote_copy', localToLocal))
      .toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    expect(probe.personalMounts).toBe(1)
  })

  gated(`keeps a running personal copy through unrelated binding and connection saves${gateSkipped}`, async () => {
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
    // The plane becomes ready before the personal manager installs the verifier and tools.
    await expect.poll(() => world!.call('remote_copy', localToLocal), { timeout: 5_000 })
      .toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    // Personal custody never talks to a broker.
    expect(probe.attest).not.toHaveBeenCalled()

    await registerRemote(world!, 'build', 'app')
    const remote = world!.remotes.get('build')!
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const read = remote.sftp.read
    vi.spyOn(remote.sftp, 'read').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await resume.promise
      return await read(...args)
    })
    const pending = world!.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'imported.txt' },
    })
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error(JSON.stringify(result)) })])
      const registry = world!.stack.registry
      const config = loadPersonalConfig(personalPath)
      await savePersonalConfig(personalPath, { ...config, revision: 1, bindings: [
        ...config.bindings, { primary: fixture.outside, environmentId: 'build', rootId: 'logs', path: '/srv/logs', actions: ['read'] },
      ] }, 0)
      await registry.refreshRemotePersonal()
      const bound = loadPersonalConfig(personalPath)
      await savePersonalConfig(personalPath, { ...bound, revision: 2, environments: [
        ...bound.environments,
        { ...config.environments[0]!, environmentId: 'different', endpoint: { hostname: 'different.internal', port: 22, user: 'ci' } },
      ] }, 1)
      await registry.refreshRemotePersonal()
      expect(probe.personalMounts).toBe(1)
    } finally { resume.resolve() }
    const copy = await pending
    expect(copy, JSON.stringify(copy)).toMatchObject({ status: 'committed' })
    expect(probe.personalMounts).toBe(1)
  })

  for (const mode of ['team', 'hardened'] as const) {
    gated(`tears down personal tools on a legacy ${mode} settings write${gateSkipped}`, async () => {
      const { hooks, live } = await mountRow({ config: { enabled: true } })
      await expect.poll(() => world!.call('remote_copy', localToLocal))
        .toMatchObject({ status: 'failed', code: 'direction-unsupported' })

      live.mode = mode
      hooks()!.onChange()
      await expect.poll(() => world!.stack.registry.remoteStatus.state).toBe('disabled')
      expect(await world!.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
      await expect(registerRemote(world!, 'build', 'app')).rejects.toMatchObject({ code: 'remote-unavailable' })
      expect(probe.attest).not.toHaveBeenCalled()
      expect(probe.personalMounts).toBe(1)
    })
  }
})
