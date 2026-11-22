/**
 * A `local` endpoint of a `remote_copy` transfer is authorized at the owner's
 * ordered admission, like every remote end: `plane.admit` resolves the root
 * through the owner's live registry state and the reply carries that record
 * (`localRoot`). A follower never mints a local destination authority off its
 * stale projection — `localTransferDestination` requires the owner-admitted
 * record, and the projection must still agree.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import type { AdmittedLocalRoot } from '../src/remote/contract.ts'
import type { RemoteControlPlane } from '../src/remote/plane.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
const REF = { environmentId: 'build-01', rootId: 'app' }
const ALIAS = 'extra'

beforeEach(() => { fixture = createFixtureWorkspace('local-transfer-admit'); stacks = [] })
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
    // The destination binding imports from the local root the transfer reads.
    bindings: [{
      primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app',
      actions: ['read', 'write', 'exec'],
      transfers: [{ direction: 'import', peer: { environmentId: 'local', rootId: ALIAS } }],
    }],
  }))
  chmodSync(path, 0o600)
  return path
}

async function mount(): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: manifestFile() },
  }, {
    allowUserOwnedRemoteManifestForTesting: true,
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  stacks.push(stack)
  await stack.registry.refresh(fixture.workspace)
  return stack
}

const plane = (stack: RegistryStack) => (stack.registry as unknown as { remotePlane: RemoteControlPlane }).remotePlane

describe.skipIf(process.platform === 'win32')('local transfer endpoints are admitted at the owner', () => {
  it('admits the local root, refuses once the owner removes it, and mints authority only from the record', async () => {
    const dir = join(fixture.base, 'extra')
    mkdirSync(dir)

    const owner = await mount()
    owner.registry.setRemoteEndpointVerifier({
      verify: async () => ({ platform: 'linux' as const, target: { kind: 'path' as const, value: '/work/app' } }),
    })
    await owner.registry.addRemote(fixture.workspace, REF)
    const added = await owner.registry.add(fixture.workspace, { path: dir })
    const status = added.find(entry => entry.path === canonicalPath(dir))
    expect(status).toBeDefined()
    await owner.registry.setAliasId(fixture.workspace, { kind: 'id', id: status!.id }, ALIAS)

    const follower = await mount()
    expect(follower.registry.authority.kind).toBe('follower')
    expect(follower.registry.list(fixture.workspace).map(entry => entry.aliasId)).toContain(ALIAS)

    const remoteRequest = vi.spyOn(plane(follower), 'remoteRequest')
    const session = follower.ctx.sessions.create(SessionId('s1'), { meta: { cwd: fixture.workspace } })
    const request = {
      session, toolName: 'remote_copy', purpose: 'transfer' as const,
      endpoints: [{ environmentId: 'local', rootId: ALIAS }, REF],
    }

    // The follower's remote_copy admission round-trips the owner; the local
    // endpoint comes back carrying the owner's live record for the root.
    let admitted: AdmittedLocalRoot | null | undefined
    await follower.registry.withRemoteOperation(request, operation => {
      admitted = operation.endpoints.find(entry => entry.environmentId === 'local')?.localRoot
    })
    expect(remoteRequest).toHaveBeenCalledWith('remote-admit', expect.anything())
    expect(admitted).toEqual({ rootId: ALIAS, path: status!.path, access: status!.access, incarnation: status!.id })

    // The issued authority comes from the owner-admitted record; the local
    // projection agrees — same path, same access, state available.
    expect(follower.registry.localTransferDestination(fixture.workspace, ALIAS, 'workspace-write', 'remote_copy', admitted))
      .toMatchObject({ rootId: ALIAS, root: status!.path, access: status!.access })
    // A record the owner never issued cannot mint an authority, and neither
    // can the stale projection on its own.
    expect(() => follower.registry.localTransferDestination(fixture.workspace, ALIAS, 'workspace-write', 'remote_copy', { ...admitted!, path: join(fixture.base, 'elsewhere') }))
      .toThrowError(expect.objectContaining({ code: 'admission-changed' }))
    expect(() => follower.registry.localTransferDestination(fixture.workspace, ALIAS, 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'local-authority-unavailable' }))

    // The owner removes the root: the next ordered admission refuses — the
    // follower's stale projection is never the authority.
    await owner.registry.remove(fixture.workspace, { kind: 'id', id: status!.id })
    remoteRequest.mockClear()
    await expect(follower.registry.withRemoteOperation(request, () => {}))
      .rejects.toMatchObject({ code: 'local-root-unavailable' })
    expect(remoteRequest).toHaveBeenCalledWith('remote-admit', expect.anything())

    // Once the projection resynchronizes, replaying the old record fails too.
    await follower.registry.refresh(fixture.workspace)
    expect(() => follower.registry.localTransferDestination(fixture.workspace, ALIAS, 'workspace-write', 'remote_copy', admitted))
      .toThrowError(expect.objectContaining({ code: 'local-root-unavailable' }))
  })
})
