/** G1a multi-Host matrix over real processes and attested remote-1 IPC. */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import { RemoteHost } from './support/remote-host.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`remote native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available && process.platform !== 'win32')
const REF = { environmentId: 'build-01', rootId: 'app' }

let fixture: FixtureWorkspace, hosts: RemoteHost[]
beforeEach(() => { fixture = createFixtureWorkspace('remote-multiprocess'); hosts = [] })
afterEach(async () => { await Promise.allSettled(hosts.map(host => host.kill())); fixture.dispose() })
function manifestFile(name = 'deploy.json', mutate = (doc: Record<string, unknown>) => doc) {
  const path = join(fixture.base, name)
  writeFileSync(path, JSON.stringify(mutate({
    schemaVersion: 1, configVersion: 'cfg-1',
    environments: [{ environmentId: 'build-01', platform: 'linux', account: 'ci', hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'ns-build', transport: 'sftp', helper: null }],
    bindings: [{ primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] }],
  })))
  chmodSync(path, 0o600)
  return path
}
async function mount(manifest?: string) {
  const host = new RemoteHost(join(fixture.base, 'store'), fixture.workspace, manifest === undefined ? {} : { manifest })
  hosts.push(host)
  await host.ready
  return host
}

nativeTest('new owner + new follower: remote admit and forwarded add work', async () => {
  const manifest = manifestFile()
  const owner = await mount(manifest), follower = await mount(manifest)
  expect(await owner.request('remote-status')).toMatchObject({ state: 'ready' })
  expect(await follower.request('remote-status')).toMatchObject({ state: 'ready' })
  await follower.request('remote-add', [REF]) // forwarded over remote-1; the owner verifies
  const list = await follower.request<{ grants: unknown[] }>('remote-list')
  expect(list.grants).toHaveLength(1)
  const op = await follower.request<{ identity: { authorityEpoch: string }; endpoints: unknown[] }>('remote-op', ['write', [REF]])
  expect(op.endpoints).toHaveLength(1)
  await owner.request('add', [fixture.outside])
  expect(await follower.request('list')).toHaveLength(1) // v1 unaffected
})

nativeTest('new owner + old follower (remote disabled): v1 works, no remote connect', async () => {
  const manifest = manifestFile()
  const owner = await mount(manifest), old = await mount()
  expect(await old.request('remote-status')).toMatchObject({ state: 'disabled' })
  await owner.request('add', [fixture.outside])
  expect(await old.request('list')).toHaveLength(1)
  await expect(old.request('remote-op', ['read', [REF]])).rejects.toThrow(/remote-unavailable|disabled/)
})

nativeTest('old owner + new follower: owner-without-remote-protocol, v1 unaffected', async () => {
  const manifest = manifestFile()
  const owner = await mount(), follower = await mount(manifest)
  expect(await follower.request('remote-status')).toMatchObject({ state: 'owner-without-remote-protocol' })
  await expect(follower.request('remote-op', ['read', [REF]])).rejects.toMatchObject({ code: 'remote-unavailable' })
  await owner.request('add', [fixture.outside])
  expect(await follower.request('list')).toHaveLength(1)
})

nativeTest('digest mismatch between Hosts fails remote only', async () => {
  const owner = await mount(manifestFile('owner.json'))
  const follower = await mount(manifestFile('follower.json', doc => ({ ...doc, configVersion: 'cfg-2' })))
  expect(await follower.request('remote-status')).toMatchObject({ state: 'config-digest-mismatch' })
  await owner.request('add', [fixture.outside])
  expect(await follower.request('list')).toHaveLength(1)
})

nativeTest('owner exit → takeover → new epoch → remote re-hello and a stale request rejected', async () => {
  const manifest = manifestFile()
  const owner = await mount(manifest), follower = await mount(manifest)
  await follower.request('remote-add', [REF])
  const oldEpoch = (await follower.request<{ identity: { authorityEpoch: string } }>('remote-op', ['read', [REF]])).identity.authorityEpoch
  const inFlight = follower.request('remote-op', ['read', [REF]])
  await owner.kill()
  await expect(inFlight).rejects.toThrow()
  for (let i = 0; i < 200; i++) {
    const state = await follower.request<{ authorityState: { kind: string } }>('diagnostics')
    if (state?.authorityState.kind === 'active') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(await follower.request('authority')).toMatchObject({ kind: 'active' })
  expect(await follower.request('remote-status')).toMatchObject({ state: 'ready' })
  const op = await follower.request<{ identity: { authorityEpoch: string; revision: number } }>('remote-op', ['read', [REF]])
  expect(op.identity.authorityEpoch).not.toBe(oldEpoch)
  const probe = await follower.request<{ remote: { state: string } }>('probe')
  expect(probe.remote.state).toBe('ready')
}, 60_000)
