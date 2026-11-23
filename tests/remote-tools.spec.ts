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
import { mountRemoteTools, registerLocalPeer, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
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

  it('stops new calls and reports interrupted staging before the tools row is removed', async () => {
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
    expect([...remote.files.keys()].some(path => path.includes('.dsh-staging-'))).toBe(false)
    await unloaded
    expect(remote.read('/srv/root/rollback.txt')).toBeUndefined()
    expect(remote.sftpCalls.some(call => call.startsWith('hardlink '))).toBe(false)
    await expect(registerRemote(mounted, 'build', 'app')).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    expect(await mounted.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
  })

  it('refuses an enabled hardened profile before opening the plane', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    const directConfig = { enabled: true, mode: 'hardened' as const, broker: undefined }
    await world.ctx.plugin({ name: 'g5-direct-refused', inject, apply: ctx => applyRemoteTools(ctx, directConfig) })
    expect(await world.call('remote_copy', localToLocal)).toMatchObject({ isError: true })
    await expect(registerRemote(world, 'build', 'app')).rejects.toMatchObject({ code: 'remote-unavailable' })
  })

  it('refuses an implicit broker profile even when the registry fixture was enabled', async () => {
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

  it('stays disabled in a deployment-manifest fixture', async () => {
    world = await mountRemoteTools(fixture, { withTools: false })
    await world.ctx.plugin({ name: 'g5-remote-tools-off', inject, apply: (ctx: typeof world.ctx) => applyRemoteTools(ctx, {}) })
    // The switch is off: the row loads and registers nothing.
    const missing = await world.call('remote_copy', localToLocal) as Failure
    expect(missing.isError).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('remote tool arguments and endpoint correction', () => {
  interface CopyValue {
    readonly status: string
    readonly code?: string
    readonly from?: string
    readonly to?: string
    readonly message?: string
    readonly hint?: string
    readonly stage?: string
    readonly staging?: string
  }
  interface ExecValue {
    readonly status: string
    readonly code?: string
    readonly message?: string
    readonly hint?: string
  }

  const copy = (result: unknown): CopyValue => result as CopyValue
  const exec = (result: unknown): ExecValue => result as ExecValue

  it('copies both directions when environmentId is omitted, and explicit local means the same endpoint', async () => {
    world = await mountRemoteTools(fixture)
    await registerRemote(world, 'build', 'app')
    const remote = world.remotes.get('build')!
    writeFileSync(join(fixture.workspace, 'up.txt'), 'upload-bytes')
    writeFileSync(join(fixture.workspace, 'explicit.txt'), 'explicit-bytes')

    const upload = copy(await world.call('remote_copy', {
      from: { rootId: 'primary', relativePath: 'up.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'dist/up.txt' },
    }))
    expect(upload, JSON.stringify(upload)).toMatchObject({ status: 'committed', from: 'primary:up.txt', to: 'build/app:dist/up.txt' })
    expect(remote.read('/srv/root/dist/up.txt')!.toString()).toBe('upload-bytes')

    remote.seed('/srv/root/dist/down.bin', 'download-bytes')
    const download = copy(await world.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'dist/down.bin' },
      to: { rootId: 'primary', relativePath: 'down.bin' },
    }))
    expect(download, JSON.stringify(download)).toMatchObject({ status: 'committed' })
    expect(readFileSync(join(fixture.workspace, 'down.bin'), 'utf8')).toBe('download-bytes')

    const explicitUpload = copy(await world.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'explicit.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'dist/explicit.txt' },
    }))
    expect(explicitUpload.status).toBe('committed')
    const explicitDownload = copy(await world.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'dist/explicit.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'explicit-back.txt' },
    }))
    expect(explicitDownload.status).toBe('committed')
    expect(readFileSync(join(fixture.workspace, 'explicit-back.txt'), 'utf8')).toBe('explicit-bytes')
  })

  it('uses an additional root aliasId on either copy side', async () => {
    world = await mountRemoteTools(fixture, { localRootIds: ['primary', 'docs'] })
    await registerRemote(world, 'build', 'app')
    await registerLocalPeer(world, fixture.outside, 'docs')
    const remote = world.remotes.get('build')!
    writeFileSync(join(fixture.outside, 'from-docs.txt'), 'docs-bytes')

    const up = copy(await world.call('remote_copy', {
      from: { rootId: 'docs', relativePath: 'from-docs.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'dist/from-docs.txt' },
    }))
    expect(up, JSON.stringify(up)).toMatchObject({ status: 'committed' })
    expect(remote.read('/srv/root/dist/from-docs.txt')!.toString()).toBe('docs-bytes')

    const down = copy(await world.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'dist/from-docs.txt' },
      to: { rootId: 'docs', relativePath: 'back.txt' },
    }))
    expect(down, JSON.stringify(down)).toMatchObject({ status: 'committed' })
    expect(readFileSync(join(fixture.outside, 'back.txt'), 'utf8')).toBe('docs-bytes')
  })

  it('refuses malformed copy arguments before admission or SFTP I/O', async () => {
    world = await mountRemoteTools(fixture)
    const remote = world.remotes.get('build')!
    const admission = vi.spyOn(world.stack.registry, 'withRemoteOperation')
    const valid = { rootId: 'primary', relativePath: 'a.txt' }
    const cases: readonly { args: unknown; located: string }[] = [
      { args: { from: valid }, located: '"to" is required' },
      { args: { from: { rootId: 5, relativePath: 'a.txt' }, to: valid }, located: '"from.rootId" must be a string' },
      { args: { from: valid, to: valid, extra: true }, located: '"extra" is not an accepted field' },
      { args: { from: { ...valid, sessionId: 'forged' }, to: valid }, located: '"from.sessionId" is not an accepted field' },
      { args: { from: { environmentId: null, ...valid }, to: valid }, located: '"from.environmentId" must be a string' },
      { args: { from: { environmentId: '', ...valid }, to: valid }, located: '"from.environmentId" must not be empty' },
      { args: null, located: 'arguments must be an object' },
    ]
    for (const entry of cases) {
      const result = copy(await world.call('remote_copy', entry.args))
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', code: 'invalid-arguments', stage: 'admission' })
      expect(result.message).toContain(entry.located)
      expect(result.hint).toBeTruthy()
    }
    expect(admission).not.toHaveBeenCalled()
    expect(remote.sftpCalls).toHaveLength(0)
  })

  it('refuses malformed bash arguments before admission, confine or spawn', async () => {
    world = await mountRemoteTools(fixture)
    const remote = world.remotes.get('build')!
    const admission = vi.spyOn(world.stack.registry, 'withRemoteOperation')
    const valid = { environmentId: 'build', rootId: 'app', command: 'true', timeoutMs: 10 }
    const cases: readonly { args: unknown; located: string }[] = [
      { args: { ...valid, sessionId: 'forged', toolName: 'other_tool' }, located: '"sessionId" is not an accepted field' },
      { args: { ...valid, command: undefined }, located: '"command" is required' },
      { args: { ...valid, environmentId: null }, located: '"environmentId" must be a string' },
      { args: { ...valid, environmentId: '' }, located: '"environmentId" must not be empty' },
      { args: { ...valid, environmentId: 'local' }, located: '"environmentId" must name a remote environment' },
      { args: { ...valid, timeoutMs: 0 }, located: '"timeoutMs" must be at least 1' },
      { args: { ...valid, maxOutputBytes: 0 }, located: '"maxOutputBytes" must be at least 1' },
    ]
    for (const entry of cases) {
      const result = exec(await world.call('remote_bash', entry.args))
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'not-started', code: 'invalid-arguments' })
      expect(result.message).toContain(entry.located)
      expect(result.hint).toBeTruthy()
    }
    expect(admission).not.toHaveBeenCalled()
    expect(remote.execCalls).toHaveLength(0)
    expect(remote.sftpCalls).toHaveLength(0)
  })

  it('offers registered candidates filtered by direction and action', async () => {
    world = await mountRemoteTools(fixture)
    await registerRemote(world, 'build', 'app')
    writeFileSync(join(fixture.workspace, 'candidate.txt'), 'x')
    const refused = copy(await world.call('remote_copy', {
      from: { rootId: 'primary', relativePath: 'candidate.txt' },
      to: { environmentId: 'device', rootId: 'out', relativePath: 'out.txt' },
    }))
    expect(refused).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    expect(refused.hint).toContain('build:app')
    expect(refused.hint).toContain('source direction')
    expect(refused.hint).toContain('destination direction')

    await registerRemote(world, 'device', 'out')
    const bash = exec(await world.call('remote_bash', { environmentId: 'device', rootId: 'out', command: 'true', timeoutMs: 10 }))
    expect(bash).toMatchObject({ status: 'not-started', code: 'action-not-allowed' })
    expect(bash.hint).toContain('build:app')
    expect(bash.hint).not.toContain('device:out')
  })

  it('keeps the original exec refusal when the snapshot is unavailable', async () => {
    world = await mountRemoteTools(fixture)
    await registerRemote(world, 'build', 'app')
    vi.spyOn(world.stack.registry, 'remoteList').mockRejectedValue(new Error('registry ipc unavailable'))
    const refused = exec(await world.call('remote_bash', { environmentId: 'device', rootId: 'out', command: 'true', timeoutMs: 10 }))
    expect(refused).toMatchObject({ status: 'not-started', code: 'endpoint-not-registered' })
    expect(refused.hint).toContain('workspace topology')
  })

  it('suggests the paired local alias when the requested local destination is wrong', async () => {
    world = await mountRemoteTools(fixture, { localRootIds: ['docs'] })
    await registerRemote(world, 'build', 'app')
    await registerLocalPeer(world, fixture.outside, 'docs')
    const remote = world.remotes.get('build')!
    remote.seed('/srv/root/dist/down.bin', 'download-bytes')
    const from = { environmentId: 'build', rootId: 'app', relativePath: 'dist/down.bin' }
    const calls = remote.sftpCalls.length
    const refused = copy(await world.call('remote_copy', { from, to: { rootId: 'primary', relativePath: 'down.bin' } }))
    expect(refused).toMatchObject({ status: 'failed', code: 'transfer-pair-not-allowed' })
    expect(refused.hint).toContain('destination direction: local:docs')
    expect(refused.hint).not.toContain('local:primary')
    expect(remote.sftpCalls).toHaveLength(calls)

    const answer = copy(await world.call('remote_copy', { from, to: { rootId: 'docs', relativePath: 'down.bin' } }))
    expect(answer).toMatchObject({ status: 'committed' })
    expect(readFileSync(join(fixture.outside, 'down.bin'), 'utf8')).toBe('download-bytes')
  })

  it('keeps the original refusal with a generic hint when the snapshot is unavailable', async () => {
    world = await mountRemoteTools(fixture)
    await registerRemote(world, 'build', 'app')
    vi.spyOn(world.stack.registry, 'remoteList').mockRejectedValue(new Error('registry ipc unavailable'))
    writeFileSync(join(fixture.workspace, 'snapshot.txt'), 'x')
    const refused = copy(await world.call('remote_copy', {
      from: { rootId: 'primary', relativePath: 'snapshot.txt' },
      to: { environmentId: 'device', rootId: 'out', relativePath: 'out.txt' },
    }))
    expect(refused).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    expect(refused.hint).toContain('workspace topology')
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
    expect(degraded).toContain('config-invalid')
    expect(degraded).not.toContain('bad manifest')
    const readOnly = renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'read-only', status: { state: 'ready' } })
    expect(readOnly).toContain('This session is read-only')
    expect(renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } }))
      .toBe(renderRemoteCapabilities({ bindings, environments: manifest.environments, mode: 'workspace-write', status: { state: 'ready' } }))
  })

  it('ships in the default patch behind the default-off live switch', () => {
    const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    // The row is mounted so the plugin-detail switch exists, but the shipped
    // config keeps it inert.
    expect(patch).toMatch(/id: multi-root-remote-tools\n\s+name: '@dsh-electron\/dsh-plugin-multi-root-workspace\/remote-tools'\n\s+config:\n(?:\s+#.*\n)*\s+enabled: false/)
    expect(patch).toMatch(/remoteEnvironments:\n\s+personalPath:/)
    expect(patch).not.toMatch(/remoteEnvironments:\n(?:\s+#.*\n)*\s+.*enabled/)
  })
})
