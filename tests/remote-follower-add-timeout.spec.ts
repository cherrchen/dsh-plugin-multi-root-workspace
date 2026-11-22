/**
 * The remote-1 client budgets requests per method: `remote-add`/`remote-remove`
 * wait out the owner's endpoint verification (~60 s vs. the ~30 s probe
 * budget), so a follower add no longer dies on the old uniform 5 s timer.
 * A request that DOES time out rejects alone — `authority-timeout`, the result
 * unknown — while the channel stays usable for whatever follows; only a
 * handshake miss still destroys it.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeHostAvailability, storeIdentity } from '../src/authority/native.ts'
import { RemoteClient, RemoteServer } from '../src/remote/protocol.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
const REF = { environmentId: 'build-01', rootId: 'app' }

beforeEach(() => { fixture = createFixtureWorkspace('follower-add-timeout'); stacks = [] })
afterEach(async () => { vi.restoreAllMocks(); for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })

function manifestFile() {
  const path = join(fixture.base, 'deploy.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, configVersion: 'cfg-1',
    environments: [{
      environmentId: 'build-01', platform: 'linux', account: 'ci',
      hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'ns-build', transport: 'sftp', helper: null,
      connection: { host: 'vps' }, credentialIsolation: 'unattested',
    }],
    bindings: [{ primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] }],
  }))
  chmodSync(path, 0o600)
  return path
}

async function mount(manifestPath: string): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath },
  }, { allowUserOwnedRemoteManifestForTesting: true })
  stacks.push(stack)
  await stack.registry.refresh(fixture.workspace)
  return stack
}

describe.skipIf(process.platform === 'win32')('follower remote-add outlives the remote-1 request budget', () => {
  it('a ~6 s owner verification still commits the follower add', { timeout: 20_000 }, async () => {
    const owner = await mount(manifestFile())
    expect(owner.registry.remoteStatus.state).toBe('ready')
    // The owner-side verifier takes ~6 s — well under its ~30 s probe budget,
    // and under the mutation budget the remote-1 client now grants it.
    owner.registry.setRemoteEndpointVerifier({
      verify: async () => {
        await delay(6_000)
        return { platform: 'linux' as const, target: { kind: 'path' as const, value: '/work/app' } }
      },
    })

    const follower = await mount(manifestFile())
    expect(follower.registry.authority.kind).toBe('follower')
    expect(follower.registry.remoteStatus.state).toBe('ready')

    const started = Date.now()
    const snapshot = await follower.registry.addRemote(fixture.workspace, REF)
    const elapsed = Date.now() - started

    // Past the old uniform 5 s timer, yet the request completed normally.
    expect(elapsed).toBeGreaterThanOrEqual(5_500)
    expect(snapshot.grants).toHaveLength(1)
    expect(snapshot.grants[0]).toMatchObject({
      environmentId: 'build-01', rootId: 'app', state: 'registered',
      verifiedTarget: { kind: 'path', value: '/work/app' },
    })
    // The channel survived: the plane stays ready and keeps answering.
    expect(follower.registry.remoteStatus.state).toBe('ready')
    await expect(follower.registry.remoteList(fixture.workspace)).resolves.toMatchObject({ grants: [{ state: 'registered' }] })
  })
})

const availability = await nativeHostAvailability()

describe('a timed-out remote-1 request fails alone', () => {
  const dirs: string[] = [], servers: RemoteServer[] = []
  afterEach(() => { while (servers.length) servers.pop()!.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
  function endpoint() {
    const root = mkdtempSync(join(tmpdir(), 'mrw-timeout-')); dirs.push(root)
    return storeIdentity(root)
  }

  it.skipIf(!availability.available || process.platform === 'win32')('rejects authority-timeout and the channel stays usable', async () => {
    const id = endpoint()
    let calls = 0
    servers.push(await RemoteServer.listen(id.remoteEndpoint!, { store: id.id, epoch: 'ep-1', manifestDigest: 'd'.repeat(64) }, async () => {
      if (++calls === 1) await new Promise(() => {})
      return { ok: true }
    }))
    const client = await RemoteClient.connect(id.remoteEndpoint!, id.id, 'd'.repeat(64), () => {}, { 'remote-snapshot': 50 })
    await expect(client.request('remote-snapshot', ['/p'])).rejects.toMatchObject({
      code: 'authority-timeout',
      message: 'remote request result is unknown; resynchronize before another mutation',
    })
    // The pending entry is gone (its late reply is ignored) and the channel
    // still serves the next request.
    await expect(client.request('remote-snapshot', ['/p'])).resolves.toEqual({ ok: true })
    client.close()
  })
})
