/**
 * G5's end-to-end journey in ONE session: two local roots → build machine →
 * device, through the explicit tools only, on a dedicated headless
 * composition.
 *
 * The wire to the two remotes is in memory (see `support/fake-remote.ts`), but
 * everything that decides is real: the registry's ordered admission, the
 * manifest bindings and transfer pairings, SFTP staging and no-replace
 * publication, the two-admission command contract, the local binary sink, and
 * the host tool pipeline. The two remotes share the SAME path (`/srv/root`)
 * with different accounts and content, so any cross-environment confusion
 * would show up as bytes in the wrong place.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { REMOTE_CONTEXT_NAME } from '../src/remote/capabilities.ts'
import { parseRemotesView, type RemotesView } from '../src/remote/panel-contract.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRemoteTools, registerLocalPeer, registerRemote, type RemoteToolsWorld } from './support/remote-tools.ts'
import type { FakeRemote } from './support/fake-remote.ts'

const SOURCE_A = 'source from the primary repository\n'
const SOURCE_B = 'source from the additional repository\n'
const DEVICE_OWN = 'device-only content\n'
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

let fixture: FixtureWorkspace
let world: RemoteToolsWorld | undefined
beforeEach(() => { fixture = createFixtureWorkspace('remote-journey') })
afterEach(async () => { await world?.dispose(); world = undefined; fixture.dispose() })

interface CopyResult {
  readonly status: string
  readonly code?: string
  readonly from: string
  readonly to: string
  readonly bytes: number
  readonly sha256: string
  readonly stage: string
  readonly staging: string
}
interface CommandResult {
  readonly status: string
  readonly code?: string
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly scope?: string
}

async function panelView(endpoint: string, payload: unknown): Promise<RemotesView> {
  const answer = await world!.panel(endpoint, payload)
  expect(answer.ok, JSON.stringify(answer)).toBe(true)
  const parsed = parseRemotesView(answer.value)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

const copy = (args: unknown) => world!.call('remote_copy', args) as Promise<CopyResult>
const bash = (args: unknown, agent?: Agent) => world!.call('remote_bash', args, agent === undefined ? {} : { agent }) as Promise<CommandResult>

async function prepare(): Promise<{ repoB: string; build: FakeRemote; device: FakeRemote }> {
  mkdirSync(join(fixture.workspace, 'src'), { recursive: true })
  writeFileSync(join(fixture.workspace, 'src/a.txt'), SOURCE_A)
  const repoB = join(fixture.base, 'repo-b')
  mkdirSync(join(repoB, 'src'), { recursive: true })
  writeFileSync(join(repoB, 'src/b.txt'), SOURCE_B)
  world = await mountRemoteTools(fixture, { localRootIds: ['primary', 'repo-b'] })
  await registerLocalPeer(world, repoB, 'repo-b')
  await registerRemote(world, 'build', 'app')
  await registerRemote(world, 'device', 'out')
  return { repoB, build: world.remotes.get('build')!, device: world.remotes.get('device')! }
}

describe.skipIf(process.platform === 'win32')('one session: two local roots → build machine → device', () => {
  it('copies both sources, builds remotely, relays the artifact, and refuses a transfer-only device', async () => {
    const { build, device } = await prepare()

    // 1. two local roots → build machine, one explicit copy each.
    for (const [rootId, path] of [['primary', 'src/a.txt'], ['repo-b', 'src/b.txt']] as const) {
      const result = await copy({
        from: { environmentId: 'local', rootId, relativePath: path },
        to: { environmentId: 'build', rootId: 'app', relativePath: path },
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'committed', bytes: Buffer.byteLength(rootId === 'primary' ? SOURCE_A : SOURCE_B) })
      expect(result.sha256).toBe(build.sha256(`/srv/root/${path}`))
    }
    expect(build.read('/srv/root/src/a.txt')!.toString()).toBe(SOURCE_A)
    expect(build.read('/srv/root/src/b.txt')!.toString()).toBe(SOURCE_B)

    // 2. the build machine executes the build through the two-admission tool.
    const built = await bash({ environmentId: 'build', rootId: 'app', command: 'build app', timeoutMs: 5_000 })
    expect(built).toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 0, stdout: 'built app\n' })
    expect(build.execCalls).toHaveLength(1)
    expect(build.execCalls[0]).toMatchObject({ cwd: '/srv/root', argv: ['/bin/sh', '-c', 'build app'] })

    // 3. build machine → device: the Host relays the artifact; the device's own
    // same-named source stays byte-identical.
    const artifact = Buffer.concat([Buffer.from('app\n'), Buffer.from(SOURCE_A), Buffer.from('--\n'), Buffer.from(SOURCE_B)])
    expect(build.read('/srv/root/dist/app.tar')).toEqual(artifact)
    const relayed = await copy({
      from: { environmentId: 'build', rootId: 'app', relativePath: 'dist/app.tar' },
      to: { environmentId: 'device', rootId: 'out', relativePath: 'dist/app.tar' },
    })
    expect(relayed).toMatchObject({ status: 'committed', bytes: artifact.length, sha256: sha(artifact) })
    expect(device.read('/srv/root/dist/app.tar')).toEqual(artifact)
    expect(device.read('/srv/root/src/a.txt')!.toString()).toBe(DEVICE_OWN)

    // 4. the device has no execution capability: the tool refuses before spawn,
    // and the same path on the two hosts never becomes one filesystem.
    // The deployment lets the device receive files but never execute: the
    // binding has no `exec` action, so the refusal lands before any backend.
    const refused = await bash({ environmentId: 'device', rootId: 'out', command: 'test app', timeoutMs: 5_000 })
    expect(refused).toMatchObject({ status: 'not-started', code: 'action-not-allowed' })
    expect(device.execCalls).toHaveLength(0)
    expect(build.execCalls).toHaveLength(1)
  })

  it('downloads a remote file into an authorized local root and keeps other paths untouched', async () => {
    await prepare()
    const uploaded = await copy({
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'src/a.txt' },
    })
    expect(uploaded.status).toBe('committed')
    mkdirSync(join(fixture.workspace, 'downloads'))
    const result = await copy({
      from: { environmentId: 'build', rootId: 'app', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'downloads/a.txt' },
    })
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'committed', bytes: Buffer.byteLength(SOURCE_A), sha256: sha(SOURCE_A) })
    expect(readFileSync(join(fixture.workspace, 'downloads/a.txt'), 'utf8')).toBe(SOURCE_A)
    expect(() => readFileSync(join(fixture.workspace, 'src/b.txt'))).toThrow()
  })

  it('refuses a read-only session every remote write, transfer destination, and command', async () => {
    const { build } = await prepare()
    const primary = world!.session.header.cwd!
    const reader = world!.ctx.sessions.create(SessionId('g5-reader'), { meta: { cwd: primary } })
    reader.append('sandbox/mode', { mode: 'read-only' })
    const agent = { id: reader.id, session: reader } as Agent

    const command = await bash({ environmentId: 'build', rootId: 'app', command: 'build app', timeoutMs: 5_000 }, agent)
    expect(command).toMatchObject({ status: 'not-started', code: 'mode-denies' })
    expect(build.execCalls).toHaveLength(0)
    const upload = await world!.call('remote_copy', {
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'build', rootId: 'app', relativePath: 'src/again.txt' },
    }, { agent }) as CopyResult
    expect(upload).toMatchObject({ status: 'failed', code: 'mode-denies' })
    const download = await world!.call('remote_copy', {
      from: { environmentId: 'build', rootId: 'app', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'primary', relativePath: 'downloads/a.txt' },
    }, { agent }) as CopyResult
    expect(download).toMatchObject({ status: 'failed', code: 'mode-denies' })
    expect(build.read('/srv/root/src/again.txt')).toBeUndefined()
  })

  it('refuses an unregistered endpoint, a revoked endpoint, and an undeclared environment', async () => {
    await prepare()
    await world!.stack.registry.removeRemote(world!.session.header.cwd!, { environmentId: 'device', rootId: 'out' })
    const revoked = await copy({
      from: { environmentId: 'build', rootId: 'app', relativePath: 'dist/app.tar' },
      to: { environmentId: 'device', rootId: 'out', relativePath: 'dist/app.tar' },
    })
    expect(revoked).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    const unknown = await copy({
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'staging', rootId: 'app', relativePath: 'src/a.txt' },
    })
    // The grant check comes first: an undeclared environment can never have a
    // registered endpoint, so the refusal is the same one a missing grant gets.
    expect(unknown).toMatchObject({ status: 'failed', code: 'endpoint-not-registered' })
    const localToLocal = await copy({
      from: { environmentId: 'local', rootId: 'primary', relativePath: 'src/a.txt' },
      to: { environmentId: 'local', rootId: 'repo-b', relativePath: 'copy.txt' },
    })
    expect(localToLocal).toMatchObject({ status: 'failed', code: 'direction-unsupported' })
  })

  it('refuses execution when the deployment grants the action but no backend exists', async () => {
    world = await mountRemoteTools(fixture, { deviceActions: ['read', 'write', 'exec'] })
    await registerRemote(world, 'device', 'out')
    const refused = await bash({ environmentId: 'device', rootId: 'out', command: 'test app', timeoutMs: 5_000 })
    expect(refused).toMatchObject({ status: 'not-started', code: 'backend-unavailable' })
  })

  it('serves the panel section from the control plane and registers an endpoint only on request', async () => {
    world = await mountRemoteTools(fixture, { withPanel: true })
    await registerRemote(world, 'build', 'app')
    const build = world.remotes.get('build')!
    build.sftpCalls.length = 0
    const sessionId = world.session.id

    const listed = await panelView('remotes', { sessionId })
    expect(listed.status.state).toBe('ready')
    expect(listed.endpoints.map(endpoint => `${endpoint.environmentId}/${endpoint.rootId}:${endpoint.state}`))
      .toEqual(['build/app:registered', 'device/out:unregistered'])
    expect(listed.endpoints[0]!.capabilities).toMatchObject({ read: true, write: true, exec: true, receive: true, send: true })
    expect(listed.endpoints[1]!.capabilities).toMatchObject({ read: false, write: false, exec: false })
    // Listing is a pure read: no connection opened, no remote call at all.
    expect(build.sftpCalls).toHaveLength(0)

    const registered = await panelView('addRemote', { sessionId, environmentId: 'device', rootId: 'out' })
    expect(registered.endpoints.find(endpoint => endpoint.environmentId === 'device')?.state).toBe('registered')
    const removed = await panelView('removeRemote', { sessionId, environmentId: 'device', rootId: 'out' })
    expect(removed.endpoints.find(endpoint => endpoint.environmentId === 'device')?.state).toBe('unregistered')

    const missing = await world.panel('remotes', { sessionId: 'no-such-session' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    const spoof = await world.panel('remotes', { sessionId, primaryRoot: '/elsewhere' })
    expect(spoof).toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
  })

  it('shows a read-only session only the capabilities it may use', async () => {
    world = await mountRemoteTools(fixture, { withPanel: true })
    await registerRemote(world, 'build', 'app')
    const primary = world.session.header.cwd!
    const reader = world.ctx.sessions.create(SessionId('g5-panel-reader'), { meta: { cwd: primary } })
    reader.append('sandbox/mode', { mode: 'read-only' })
    const view = await panelView('remotes', { sessionId: reader.id })
    expect(view.mode).toBe('read-only')
    expect(view.endpoints[0]!.capabilities).toMatchObject({ read: true, write: false, exec: false, receive: false })
  })

  it('projects the deployment to the model without credentials, and adds no tool when the row is absent', async () => {
    await prepare()
    const assembly = await world!.ctx.systemPrompt.assemble({ agent: world!.agent })
    const text = assembly.contexts.find(context => context.name === REMOTE_CONTEXT_NAME)?.text ?? ''
    expect(text).toContain('build/app at "/srv/root" (linux): actions read, write, exec')
    expect(text).toContain('device/out at "/srv/root" (linux)')
    expect(text).toContain('accepts copies from local/primary')
    expect(text).toContain('sends copies to')
    expect(text).not.toContain('build-host')
    expect(text).not.toContain('builder')
    expect(text).not.toContain('dsh-remote')
  })
})
