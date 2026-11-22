/**
 * `remote_copy`'s LOCAL SOURCE must not follow a registered root that was
 * swapped after registration: `openLocalSource` requires the live
 * `realpathSync` of an admitted (canonical) registered path to equal that
 * path, the same verdict `LocalBinarySink.open` already enforced on the
 * destination side — `local-root-redirected`, no bytes leave the Host.
 */
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { runRemoteCopy, type RemoteCopyDeps, type RemoteCopyRequest } from '../src/remote/transfer.ts'
import { SftpStatusError, SftpConnectionLost, type SftpClient } from '../src/remote/sftp.ts'
import type { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import { environmentDigest, type DeploymentManifest } from '../src/remote/manifest.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import type { LocalDestinationAuthority } from '../src/remote/local-sink.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { mountRegistryStack } from './support/registry-stack.ts'

let fixture: FixtureWorkspace
afterEach(() => fixture?.dispose())

/** Minimal replica of remote-copy.spec.ts's in-memory SFTP endpoint. */
class MemSftp {
  readonly files = new Map<string, { data: Buffer; mtime: number; permissions: number }>()
  private tick = 1_700_000_000
  directory(path: string): void {
    let cursor = ''
    for (const part of path.split('/').filter(part => part !== '')) {
      cursor += `/${part}`
      if (!this.files.has(cursor)) this.files.set(cursor, { data: Buffer.alloc(0), mtime: ++this.tick, permissions: 0o040755 })
    }
  }
  seed(path: string, data: Buffer | string): void {
    this.directory(path.slice(0, path.lastIndexOf('/')) || '/')
    this.files.set(path, { data: Buffer.from(data), mtime: ++this.tick, permissions: 0o100644 })
  }
  async lstat(p: string) {
    const file = this.files.get(p)
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    return { flags: 5, size: file.data.length, permissions: file.permissions, mtime: file.mtime }
  }
  async realpath(p: string) { return p }
  async open(p: string, flags: number) {
    if ((flags & 0x20) !== 0 && this.files.has(p)) throw new SftpStatusError(4, 'Failure')
    if ((flags & 0x08) !== 0 && !this.files.has(p)) this.seed(p, Buffer.alloc(0))
    if (!this.files.has(p)) throw new SftpStatusError(2, 'No such file')
    return Buffer.from(p)
  }
  async write(h: Buffer, off: number, data: Buffer) {
    const p = h.toString(); const cur = this.files.get(p)!
    const grown = Buffer.alloc(Math.max(cur.data.length, off + data.length))
    cur.data.copy(grown); data.copy(grown, off)
    this.files.set(p, { ...cur, data: grown, mtime: ++this.tick })
  }
  async read(h: Buffer, off: number, len: number) {
    if (h.toString() === 'LOSE') throw new SftpConnectionLost('lost')
    const file = this.files.get(h.toString())
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    return file.data.subarray(off, off + len)
  }
  async fsync() {}
  async close() {}
  async remove(p: string) { this.files.delete(p) }
  async hardlink(oldP: string, newP: string) {
    if (this.files.has(newP)) throw new SftpStatusError(4, 'Failure')
    const file = this.files.get(oldP)
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    this.files.set(newP, { ...file })
  }
  asClient() { return this as unknown as SftpClient }
}

const DISPLAY: Record<string, string> = { 'vps-a/import': '/import' }

/** The remote-copy.spec.ts fake registry/manager composition, cut to what these runs use. */
function stack(statuses: { aliasId: string; path: string; state: string; access?: string }[]) {
  const mem = new MemSftp()
  mem.directory('/import')
  const manifest = {
    environments: [{
      environmentId: 'vps-a', platform: 'linux', account: 'a', hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'vps-a',
      transport: 'sftp', helper: null, connection: { host: 'vps-a' }, credentialIsolation: 'unattested',
      transfer: { maxBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
    }],
  } as unknown as DeploymentManifest
  const admittedEndpoint = (ref: { environmentId: string; rootId: string }) => ref.environmentId === 'local'
    ? {
        environmentId: 'local', rootId: ref.rootId, displayPath: ref.rootId, verifiedTarget: null, bindingDigest: null, environmentDigest: null, configVersion: null,
        localRoot: statuses.find(entry => entry.aliasId === ref.rootId) === undefined ? null : {
          rootId: ref.rootId,
          path: statuses.find(entry => entry.aliasId === ref.rootId)!.path,
          access: (statuses.find(entry => entry.aliasId === ref.rootId)!.access ?? 'inherit') as 'inherit',
        },
      }
    : {
        environmentId: ref.environmentId, rootId: ref.rootId, displayPath: DISPLAY[`${ref.environmentId}/${ref.rootId}`] ?? `/${ref.rootId}`,
        verifiedTarget: { kind: 'path', value: DISPLAY[`${ref.environmentId}/${ref.rootId}`] ?? `/${ref.rootId}` },
        bindingDigest: 'd'.repeat(64), configVersion: 'c',
        environmentDigest: environmentDigest(manifest.environments.find(entry => entry.environmentId === ref.environmentId)!),
        localRoot: null,
      }
  const registry = {
    async withRemoteOperation(request: { endpoints: { environmentId: string; rootId: string }[] }, body: (o: unknown) => unknown) {
      return await body({
        identity: { authorityEpoch: 'e1', effectiveMode: 'workspace-write', operationId: 'op-1', sessionId: 's1' },
        endpoints: request.endpoints.map(admittedEndpoint),
      })
    },
    localTransferDestination(_primary: string, rootId: string): LocalDestinationAuthority {
      const status = statuses.find(entry => entry.aliasId === rootId)
      if (status === undefined) { const e = new Error('no root'); (e as { code?: string }).code = 'local-root-unavailable'; throw e }
      return { rootId, root: status.path, access: (status.access ?? 'inherit') as LocalDestinationAuthority['access'], deny: [] }
    },
    list: () => statuses,
  } as unknown as MultiRootRegistry
  const manager = {
    deployment: manifest,
    openSftp: async () => ({ client: mem.asClient(), generation: 'g1' }),
    sftpGenerationOf: () => 'g1',
  } as unknown as SshEnvironmentManager
  const deps: RemoteCopyDeps = {
    manager,
    sftpFor: () => ({ client: mem.asClient(), generation: 'g1' }),
    generationFor: () => 'g1',
  }
  return { registry, deps, mem }
}

const session = () => ({ header: { cwd: fixture.workspace }, id: 's1' }) as never
const run = (s: ReturnType<typeof stack>, request: RemoteCopyRequest) =>
  runRemoteCopy(s.registry, s.deps, request, 'remote_copy', new AbortController().signal)

/** Register-shaped dir swapped for a symlink to a directory outside every root. */
function redirect() {
  const data = join(fixture.base, 'data')
  const other = join(fixture.base, 'other')
  mkdirSync(data)
  mkdirSync(other)
  writeFileSync(join(other, 'secret.txt'), 'outside-secret')
  // The path the registry recorded: the canonical form of the dir AS REGISTERED.
  const canonical = realpathSync(data)
  renameSync(data, `${data}.moved`)
  symlinkSync(other, data)
  return { data, other, canonical }
}

describe('remote_copy refuses a redirected local source root', () => {
  it('the real registry still reports the redirected root as available in list()', async () => {
    fixture = createFixtureWorkspace('source-list')
    const stack = await mountRegistryStack(join(fixture.base, 'store'))
    try {
      const data = join(fixture.base, 'data')
      mkdirSync(data)
      const added = await stack.registry.add(fixture.workspace, { path: data })
      const status = added.find(entry => entry.path === canonicalPath(data))
      expect(status).toBeDefined()
      expect(status!.state).toBe('available')
      await stack.registry.setAliasId(fixture.workspace, { kind: 'id', id: status!.id }, 'data')
      const other = join(fixture.base, 'other')
      mkdirSync(other)
      writeFileSync(join(other, 'secret.txt'), 'outside-secret')
      renameSync(data, `${data}.moved`)
      symlinkSync(other, data)

      // list() is a read of the in-memory state — the swap is invisible until refresh.
      const cached = stack.registry.list(fixture.workspace).find(entry => entry.aliasId === 'data')!
      expect(cached.state).toBe('available')
      expect(cached.path).toBe(status!.path)

      const refreshed = await stack.registry.refresh(fixture.workspace)
      expect(refreshed.find(entry => entry.aliasId === 'data')?.state).toBe('redirected')
    } finally {
      await stack.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('local→remote refuses local-root-redirected and writes nothing remotely', async () => {
    fixture = createFixtureWorkspace('source-copy')
    const { canonical } = redirect()
    const s = stack([{ aliasId: 'data', path: canonical, state: 'available', access: 'inherit' }])
    const result = await run(s, {
      session: session(),
      from: { environmentId: 'local', rootId: 'data', relativePath: 'secret.txt' },
      to: { environmentId: 'vps-a', rootId: 'import', relativePath: 'copied.txt' },
    })
    // The registered path now resolves to a different directory: the source
    // binds nothing and no staging ever reaches the remote.
    expect(result).toMatchObject({ status: 'failed', code: 'local-root-redirected', stage: 'source' })
    expect(s.mem.files.get('/import/copied.txt')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('remote→local into the same redirected root IS refused', async () => {
    fixture = createFixtureWorkspace('source-sink')
    const { canonical } = redirect()
    const s = stack([{ aliasId: 'data', path: canonical, state: 'available', access: 'inherit' }])
    s.mem.seed('/import/source.txt', 'from-the-vps')
    const result = await run(s, {
      session: session(),
      from: { environmentId: 'vps-a', rootId: 'import', relativePath: 'source.txt' },
      to: { environmentId: 'local', rootId: 'data', relativePath: 'written.txt' },
    })
    expect(result).toMatchObject({ status: 'failed', code: 'local-root-redirected', stage: 'preflight' })
  })
})
