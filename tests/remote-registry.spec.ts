/** G1a: the remote control plane on a single Host over the real shared store. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import type { RemoteControlPlane } from '../src/remote/plane.ts'
import type { RemoteOperationRequest } from '../src/remote/contract.ts'
import { REMOTE_DOMAIN_NAME } from '../src/remote/records.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
const REF = { environmentId: 'build-01', rootId: 'app' }

beforeEach(() => { fixture = createFixtureWorkspace('remote-registry'); stacks = [] })
afterEach(async () => { vi.restoreAllMocks(); for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })

function manifestFile(over: { platform?: string; hostKey?: string; bindings?: unknown[] } = {}) {
  const path = join(fixture.base, 'deploy.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, configVersion: 'cfg-1',
    environments: [{
      environmentId: 'build-01', platform: over.platform ?? 'linux', account: 'ci',
      hostKey: over.hostKey ?? `SHA256:${'A'.repeat(43)}`, namespace: 'ns-build', transport: 'sftp', helper: null,
    }],
    bindings: over.bindings ?? [{ primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] }],
  }))
  chmodSync(path, 0o600)
  return path
}

async function mount(remote?: { manifestPath?: string; enabled?: boolean }, toolAccess?: Record<string, 'read-only'>): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: remote === undefined ? undefined : { enabled: remote.enabled ?? true, manifestPath: remote.manifestPath },
  }, {
    scopeConfig: toolAccess === undefined ? {} : { toolAccess },
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

const verifier = (platform: 'linux' | 'darwin' = 'linux') => ({
  verify: async () => ({ platform, target: { kind: 'path' as const, value: '/work/app' } }),
})
let seq = 0
const plane = (stack: RegistryStack) => (stack.registry as unknown as { remotePlane: RemoteControlPlane }).remotePlane
const sessionOf = (stack: RegistryStack, id = 's1') => stack.ctx.sessions.create(SessionId(id), { meta: { cwd: fixture.workspace } })
const op = (stack: RegistryStack, over: Partial<RemoteOperationRequest> = {}): RemoteOperationRequest => ({
  session: sessionOf(stack, `s${++seq}`), toolName: 'remote_probe', purpose: 'read', endpoints: [REF], ...over,
})

describe('remote control plane', () => {
  it('stays byte-identical while disabled', async () => {
    const stack = await mount()
    expect(stack.registry.remoteStatus.state).toBe('disabled')
    await stack.registry.add(fixture.workspace, { path: fixture.outside })
    expect(stack.registry.list(fixture.workspace)).toHaveLength(1)
    expect(existsSync(join(fixture.base, 'store', `${REMOTE_DOMAIN_NAME}.json`))).toBe(false)
    await expect(stack.registry.remoteList(fixture.workspace)).rejects.toMatchObject({ code: 'remote-unavailable' })
    await expect(stack.registry.withRemoteOperation(op(stack), () => {})).rejects.toMatchObject({ code: 'remote-unavailable' })
  })

  it('rejects adds without a verifier, registers with one, and never leaks into local state', async () => {
    const stack = await mount({ manifestPath: manifestFile() })
    expect(stack.registry.remoteStatus.state).toBe('ready')
    await expect(stack.registry.addRemote(fixture.workspace, REF)).rejects.toMatchObject({ code: 'endpoint-unverifiable' })
    stack.registry.setRemoteEndpointVerifier(verifier())
    const snapshot = await stack.registry.addRemote(fixture.workspace, REF)
    expect(snapshot.grants).toHaveLength(1)
    expect(snapshot.grants[0]).toMatchObject({ environmentId: 'build-01', rootId: 'app', state: 'registered', displayPath: '/work/app', verifiedTarget: { kind: 'path', value: '/work/app' } })
    const remoteDoc = JSON.parse(readFileSync(join(fixture.base, 'store', `${REMOTE_DOMAIN_NAME}.json`), 'utf8'))
    expect(JSON.stringify(remoteDoc)).toContain('build-01')
    expect(JSON.stringify(remoteDoc)).not.toContain('"access"')
    expect(existsSync(stack.storeFile) ? readFileSync(stack.storeFile, 'utf8') : '').not.toContain('build-01')
    expect(stack.scope.snapshot({ mode: 'workspace-write', workspaceRoot: fixture.workspace }).additionalRoots).toEqual([])
    await expect(stack.registry.withRemoteOperation(op(stack, { purpose: 'write' }), operation => operation.endpoints[0]!.bindingDigest)).resolves.toBe(snapshot.grants[0]!.bindingDigest)
  })

  it('rejects a rootId bound to a different primary and an access-shaped ref', async () => {
    const stack = await mount({ manifestPath: manifestFile() })
    stack.registry.setRemoteEndpointVerifier(verifier())
    await expect(stack.registry.addRemote(fixture.workspace, { environmentId: 'build-01', rootId: 'other' }))
      .rejects.toMatchObject({ code: 'binding-not-authorized' })
    const other = join(fixture.base, 'other-primary')
    await expect(stack.registry.addRemote(other, REF)).rejects.toMatchObject({ code: 'binding-not-authorized' })
    await expect(stack.registry.addRemote(fixture.workspace, { ...REF, access: 'read-write' } as never))
      .rejects.toMatchObject({ code: 'invalid-arguments' })
  })

  it('withholds on hostKey change, revokes on binding removal, and denies admission accordingly', async () => {
    const manifest = manifestFile()
    const stack = await mount({ manifestPath: manifest })
    stack.registry.setRemoteEndpointVerifier(verifier())
    await stack.registry.addRemote(fixture.workspace, REF)
    const reload = () => { plane(stack).manifest = JSON.parse(readFileSync(manifest, 'utf8')) }
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(`SHA256:${'A'.repeat(43)}`, `SHA256:${'B'.repeat(43)}`))
    reload()
    expect((await stack.registry.remoteList(fixture.workspace)).grants[0]!.state).toBe('withheld')
    await expect(stack.registry.withRemoteOperation(op(stack), () => {})).rejects.toMatchObject({ code: 'endpoint-withheld' })
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"bindings":\[[\s\S]*\]/, '"bindings": []'))
    reload()
    expect((await stack.registry.remoteList(fixture.workspace)).grants[0]!.state).toBe('revoked')
    await expect(stack.registry.withRemoteOperation(op(stack), () => {})).rejects.toMatchObject({ code: 'endpoint-revoked' })
  })

  it('applies the mode table, tool cap, and per-session policies', async () => {
    const stack = await mount({ manifestPath: manifestFile() }, { capped_tool: 'read-only' })
    stack.registry.setRemoteEndpointVerifier(verifier())
    await stack.registry.addRemote(fixture.workspace, REF)
    const session = sessionOf(stack, 'ro')
    session.append('sandbox/mode', { mode: 'read-only' })
    await expect(stack.registry.withRemoteOperation(op(stack, { session, purpose: 'write' }), () => {})).rejects.toMatchObject({ code: 'mode-denies' })
    await expect(stack.registry.withRemoteOperation(op(stack, { session, purpose: 'exec' }), () => {})).rejects.toMatchObject({ code: 'mode-denies' })
    const other = sessionOf(stack, 'full')
    other.append('sandbox/mode', { mode: 'danger-full-access' })
    await expect(stack.registry.withRemoteOperation(op(stack, { session: other, purpose: 'write' }), o => o.identity.effectiveMode)).resolves.toBe('workspace-write')
    await expect(stack.registry.withRemoteOperation(op(stack, { purpose: 'read' }), o => o.identity.effectiveMode)).resolves.toBe('workspace-write')
    await expect(stack.registry.withRemoteOperation(op(stack, { toolName: 'capped_tool', purpose: 'write' }), () => {})).rejects.toMatchObject({ code: 'tool-capped' })
    await expect(stack.registry.withRemoteOperation(op(stack, { session: undefined }), () => {})).rejects.toMatchObject({ code: 'session-policy-unavailable' })
    let held: unknown
    await stack.registry.withRemoteOperation(op(stack, { purpose: 'read' }), operation => { held = operation })
    expect(() => (held as { endpoints: unknown }).endpoints).toThrow('admission has expired')
  })

  it('denies a transfer without declared pairing and admits a paired one', async () => {
    const bindings = [
      { primary: fixture.workspace, environmentId: 'build-01', rootId: 'src', path: '/work/src', actions: ['read'], transfers: [{ direction: 'export', peer: { environmentId: 'build-02', rootId: 'dst' } }] },
      { primary: fixture.workspace, environmentId: 'build-02', rootId: 'dst', path: '/work/dst', actions: ['write'], transfers: [{ direction: 'import', peer: { environmentId: 'build-01', rootId: 'src' } }] },
    ]
    const path = manifestFile({ bindings })
    writeFileSync(path, readFileSync(path, 'utf8').replace('"namespace": "ns-build"', '"namespace": "ns-a"'), )
    // second environment for build-02
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    doc.environments.push({ environmentId: 'build-02', platform: 'linux', account: 'ci', hostKey: `SHA256:${'B'.repeat(43)}`, namespace: 'ns-b', transport: 'sftp', helper: null })
    writeFileSync(path, JSON.stringify(doc))
    const stack = await mount({ manifestPath: path })
    stack.registry.setRemoteEndpointVerifier(verifier())
    await stack.registry.addRemote(fixture.workspace, { environmentId: 'build-01', rootId: 'src' })
    await stack.registry.addRemote(fixture.workspace, { environmentId: 'build-02', rootId: 'dst' })
    await expect(stack.registry.withRemoteOperation(op(stack, {
      purpose: 'transfer', endpoints: [{ environmentId: 'build-01', rootId: 'src' }, { environmentId: 'build-02', rootId: 'nope' }],
    }), () => {})).rejects.toMatchObject({ code: 'endpoint-not-registered' })
    await expect(stack.registry.withRemoteOperation(op(stack, {
      purpose: 'transfer', endpoints: [{ environmentId: 'build-02', rootId: 'dst' }, { environmentId: 'build-01', rootId: 'src' }],
    }), () => {})).rejects.toMatchObject({ code: 'transfer-pair-not-allowed' })
    await expect(stack.registry.withRemoteOperation(op(stack, {
      purpose: 'transfer', endpoints: [{ environmentId: 'build-01', rootId: 'src' }, { environmentId: 'local', rootId: 'scratch' }],
    }), () => {})).rejects.toMatchObject({ code: 'transfer-pair-not-allowed' })
    await expect(stack.registry.withRemoteOperation(op(stack, {
      purpose: 'transfer', endpoints: [{ environmentId: 'build-01', rootId: 'src' }, { environmentId: 'build-02', rootId: 'dst' }],
    }), operation => operation.endpoints)).resolves.toHaveLength(2)
  })

  it('keeps local authority working when the remote domain cannot open', async () => {
    const manifest = manifestFile()
    // A directory where the remote domain document belongs makes its open fail.
    mkdirSync(join(fixture.base, 'store', `${REMOTE_DOMAIN_NAME}.json`), { recursive: true })
    const stack = await mountRegistryStack(join(fixture.base, 'store'), { remoteEnvironments: { enabled: true, manifestPath: manifest } }, {})
    stacks.push(stack)
    expect(stack.registry.remoteStatus.state).toBe('storage-failed')
    await stack.registry.add(fixture.workspace, { path: fixture.outside })
    expect(stack.registry.list(fixture.workspace)).toHaveLength(1)
    await expect(stack.registry.addRemote(fixture.workspace, REF)).rejects.toMatchObject({ code: 'remote-unavailable' })
  })

  it('keeps the v1 file intact across an enable/disable/remote lifecycle', async () => {
    const manifest = manifestFile()
    const stack = await mount()
    await stack.registry.add(fixture.workspace, { path: fixture.outside })
    await stack.dispose()
    stacks.pop()
    const bytes0 = readFileSync(stack.storeFile)
    const enabled = await mount({ manifestPath: manifest })
    enabled.registry.setRemoteEndpointVerifier(verifier())
    await enabled.registry.addRemote(fixture.workspace, REF)
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"bindings":\[[\s\S]*\]/, '"bindings": []'))
    await enabled.dispose()
    stacks.pop()
    const older = await mount()
    expect(older.registry.remoteStatus.state).toBe('disabled')
    expect(older.registry.list(fixture.workspace)).toHaveLength(1)
    expect(readFileSync(older.storeFile)).toEqual(bytes0)
    await older.dispose()
    stacks.pop()
    const back = await mount({ manifestPath: manifest })
    back.registry.setRemoteEndpointVerifier(verifier())
    expect((await back.registry.remoteList(fixture.workspace)).grants[0]!.state).toBe('revoked')
  })

  it('orders a queued revocation ahead of a denied admission, and completes an admitted one', async () => {
    const stack = await mount({ manifestPath: manifestFile() })
    stack.registry.setRemoteEndpointVerifier(verifier())
    await stack.registry.addRemote(fixture.workspace, REF)
    const internal = plane(stack) as unknown as { table: { put(key: string, value: unknown): Promise<void> } }
    const table = internal.table
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let first = true
    const original = table.put.bind(table)
    vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if (first) { first = false; entered.resolve(); await release.promise }
      return original(key, value)
    })
    const removing = stack.registry.removeRemote(fixture.workspace, REF)
    await entered.promise
    const denied = stack.registry.withRemoteOperation(op(stack), () => {})
    release.resolve()
    await removing
    await expect(denied).rejects.toMatchObject({ code: 'endpoint-not-registered' })
    await stack.registry.addRemote(fixture.workspace, REF)
    const gate = Promise.withResolvers<void>()
    const admitted = stack.registry.withRemoteOperation(op(stack), () => gate.promise)
    await stack.registry.removeRemote(fixture.workspace, REF)
    await expect(stack.registry.withRemoteOperation(op(stack), () => {})).rejects.toMatchObject({ code: 'endpoint-not-registered' })
    gate.resolve()
    await admitted
  })

  it('refuses an add whose binding moved while the verifier ran', async () => {
    const manifest = manifestFile()
    const stack = await mount({ manifestPath: manifest })
    const gate = Promise.withResolvers<void>()
    stack.registry.setRemoteEndpointVerifier({ verify: async () => { await gate.promise; return { platform: 'linux' as const, target: { kind: 'path' as const, value: '/work/app' } } } })
    const adding = stack.registry.addRemote(fixture.workspace, REF)
    await new Promise(resolve => setTimeout(resolve, 10))
    plane(stack).manifest = JSON.parse(readFileSync(manifest, 'utf8').replace(`SHA256:${'A'.repeat(43)}`, `SHA256:${'C'.repeat(43)}`))
    gate.resolve()
    await expect(adding).rejects.toMatchObject({ code: 'binding-changed' })
    expect((await stack.registry.remoteList(fixture.workspace)).grants).toHaveLength(0)
  })
})
