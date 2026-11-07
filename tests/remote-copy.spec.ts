/** runRemoteCopy stage ordering and refusal codes across all three directions — in-memory SFTP, no network. */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRemoteCopy, type RemoteCopyDeps, type RemoteCopyRequest } from '../src/remote/transfer.ts'
import { SftpStatusError, SftpConnectionLost, type SftpClient } from '../src/remote/sftp.ts'
import type { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import type { LocalDestinationAuthority } from '../src/remote/local-sink.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

interface MemFile { data: Buffer; mtime: number; permissions: number }

class MemSftp {
  readonly files = new Map<string, MemFile>()
  readonly calls: string[] = []
  loseOnHardlink = false
  loseOnRead = false
  failWrites = false
  hardlinkCalls = 0
  readCalls = 0
  private tick = 1_700_000_000

  seed(path: string, data: Buffer | string, permissions = 0o100644): void {
    this.files.set(path, { data: Buffer.from(data), mtime: ++this.tick, permissions })
  }

  touch(path: string, data: Buffer | string): void {
    const file = this.files.get(path)
    if (file === undefined) throw new Error(`touch: no ${path}`)
    this.files.set(path, { data: Buffer.from(data), mtime: ++this.tick, permissions: file.permissions })
  }

  async lstat(p: string) {
    this.calls.push(`lstat ${p}`)
    const file = this.files.get(p)
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    return { flags: 5, size: file.data.length, permissions: file.permissions, mtime: file.mtime }
  }
  async realpath(p: string) { return p }
  async open(p: string, flags: number, _perm?: number) {
    this.calls.push(`open ${p} ${flags}`)
    if ((flags & 0x20) !== 0 && this.files.has(p)) throw new SftpStatusError(4, 'Failure')
    if ((flags & 0x08) !== 0 && !this.files.has(p)) this.seed(p, Buffer.alloc(0))
    if (!this.files.has(p)) throw new SftpStatusError(2, 'No such file')
    return Buffer.from(p)
  }
  async write(h: Buffer, off: number, data: Buffer) {
    if (this.failWrites) throw new SftpStatusError(4, 'Failure')
    const p = h.toString()
    const cur = this.files.get(p)!
    const grown = Buffer.alloc(Math.max(cur.data.length, off + data.length))
    cur.data.copy(grown); data.copy(grown, off)
    this.files.set(p, { ...cur, data: grown, mtime: ++this.tick })
  }
  async read(h: Buffer, off: number, len: number) {
    this.readCalls++
    if (this.loseOnRead) throw new SftpConnectionLost('transport lost while reading')
    const file = this.files.get(h.toString())
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    return file.data.subarray(off, off + len)
  }
  async fsync() { this.calls.push('fsync') }
  async close() {}
  async remove(p: string) { this.calls.push(`remove ${p}`); this.files.delete(p) }
  async hardlink(oldP: string, newP: string) {
    this.calls.push(`hardlink ${oldP} ${newP}`)
    this.hardlinkCalls++
    if (this.loseOnHardlink) throw new SftpConnectionLost('transport lost')
    if (this.files.has(newP)) throw new SftpStatusError(4, 'Failure')
    const file = this.files.get(oldP)
    if (file === undefined) throw new SftpStatusError(2, 'No such file')
    this.files.set(newP, { ...file })
  }
  asClient() { return this as unknown as SftpClient }
}

let fixture: FixtureWorkspace
afterEach(() => fixture.dispose())
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

const DISPLAY: Record<string, string> = {
  'vps-a/import': '/import',
  'vps-a/export': '/export',
  'vps-b/import': '/import-b',
  'vps-b/export': '/export-b',
}
const displayPathOf = (environmentId: string, rootId: string) => DISPLAY[`${environmentId}/${rootId}`] ?? `/${rootId}`

interface StackOptions {
  epoch?: string
  deny?: string
  transfer?: { maxBytes: number; timeoutMs: number } | undefined
  mems?: Record<string, MemSftp>
  statuses?: { aliasId: string; path: string; state: string; access?: string }[]
  localDeny?: string
  localAuthority?: (call: number) => LocalDestinationAuthority
}

function stack(opts: StackOptions = {}) {
  const mems = opts.mems ?? { 'vps-a': new MemSftp(), 'vps-b': new MemSftp() }
  const manifest = {
    environments: ['vps-a', 'vps-b'].map(environmentId => ({
      environmentId, platform: 'linux', account: 'a', hostKey: `SHA256:${'A'.repeat(43)}`, namespace: environmentId,
      transport: 'sftp', helper: null, connection: { host: environmentId }, credentialIsolation: 'unattested',
      transfer: opts.transfer === undefined ? { maxBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } : opts.transfer,
    })),
  } as unknown as DeploymentManifest
  const generations: Record<string, string> = { 'vps-a': 'g1', 'vps-b': 'g1' }
  const admittedEndpoint = (ref: { environmentId: string; rootId: string }) => ref.environmentId === 'local'
    ? { environmentId: 'local', rootId: ref.rootId, displayPath: ref.rootId, verifiedTarget: null, bindingDigest: null, configVersion: null }
    : {
        environmentId: ref.environmentId, rootId: ref.rootId, displayPath: displayPathOf(ref.environmentId, ref.rootId),
        verifiedTarget: { kind: 'path', value: displayPathOf(ref.environmentId, ref.rootId) },
        bindingDigest: 'd'.repeat(64), configVersion: 'c',
      }
  let admitCount = 0
  let authorityCount = 0
  const registry = {
    async withRemoteOperation(request: { endpoints: { environmentId: string; rootId: string }[] }, body: (o: unknown) => unknown) {
      admitCount++
      if (opts.deny !== undefined) { const e = new Error('denied'); (e as { code?: string }).code = opts.deny; throw e }
      return await body({
        identity: { authorityEpoch: opts.epoch ?? 'e1', effectiveMode: 'workspace-write', operationId: 'op-1', sessionId: 's1' },
        endpoints: request.endpoints.map(admittedEndpoint),
      })
    },
    localTransferDestination(_primary: string, rootId: string, _mode: string, _toolName: string): LocalDestinationAuthority {
      authorityCount++
      if (opts.localDeny !== undefined) { const e = new Error('local denied'); (e as { code?: string }).code = opts.localDeny; throw e }
      if (opts.localAuthority !== undefined) return opts.localAuthority(authorityCount)
      if (rootId === 'primary') return { rootId, root: fixture.workspace, access: 'primary', deny: [] }
      const status = (opts.statuses ?? []).find(entry => entry.aliasId === rootId)
      if (status === undefined) { const e = new Error('no root'); (e as { code?: string }).code = 'local-root-unavailable'; throw e }
      return { rootId, root: status.path, access: (status.access ?? 'inherit') as LocalDestinationAuthority['access'], deny: [] }
    },
    list: () => opts.statuses ?? [],
    admitCount: () => admitCount,
    authorityCount: () => authorityCount,
  } as unknown as MultiRootRegistry & { admitCount(): number; authorityCount(): number }
  const manager = {
    deployment: manifest,
    openSftp: async (id: string) => ({ client: mems[id]!.asClient(), generation: generations[id]! }),
    sftpGenerationOf: (id: string) => generations[id] ?? 'stale',
  } as unknown as SshEnvironmentManager
  const deps: RemoteCopyDeps = {
    manager,
    sftpFor: environment => ({ client: mems[environment.environmentId]!.asClient(), generation: generations[environment.environmentId]! }),
    generationFor: id => generations[id] ?? 'stale',
  }
  return {
    registry, manager, deps, mems, mem: mems['vps-a']!, memB: mems['vps-b']!,
    setGeneration: (id: string, g: string) => { generations[id] = g },
  }
}

const session = () => ({ header: { cwd: fixture.workspace }, id: 's1' }) as never
const request = (over: Partial<RemoteCopyRequest> = {}): RemoteCopyRequest => ({
  session: session(),
  from: { environmentId: 'local', rootId: 'primary', relativePath: 'source.txt' },
  to: { environmentId: 'vps-a', rootId: 'import', relativePath: 'dest.txt' },
  ...over,
})
const localToRemote = (over: Partial<RemoteCopyRequest> = {}) => request(over)
const remoteToLocal = (over: Partial<RemoteCopyRequest> = {}) => request({
  from: { environmentId: 'vps-a', rootId: 'import', relativePath: 'source.txt' },
  to: { environmentId: 'local', rootId: 'primary', relativePath: 'downloaded.bin' },
  ...over,
})
const remoteToRemote = (over: Partial<RemoteCopyRequest> = {}) => request({
  from: { environmentId: 'vps-a', rootId: 'export', relativePath: 'artifact.bin' },
  to: { environmentId: 'vps-b', rootId: 'import', relativePath: 'artifact.bin' },
  ...over,
})
const run = (s: ReturnType<typeof stack>, req: RemoteCopyRequest, deps: RemoteCopyDeps = s.deps) =>
  runRemoteCopy(s.registry, deps, req, 'remote_copy', new AbortController().signal)

describe('runRemoteCopy local → remote(sftp)', () => {
  it('commits a staged copy end to end', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'hello-remote')
    const s = stack()
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'committed', bytes: 12, sha256: sha('hello-remote'), stage: 'cleanup', staging: 'removed' })
    expect(s.mem.files.get('/import/dest.txt')!.data.toString()).toBe('hello-remote')
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
    expect(s.mem.calls).toContain('fsync')
  })

  it('refuses an existing target before staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const mem = new MemSftp()
    mem.seed('/import/dest.txt', 'existing')
    const s = stack({ mems: { 'vps-a': mem, 'vps-b': new MemSftp() } })
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect(s.mem.calls.filter(c => c.startsWith('open /import/.dsh-staging'))).toHaveLength(0)
    expect(s.mem.files.get('/import/dest.txt')!.data.toString()).toBe('existing')
  })

  it('refuses symlink and multilinked sources at the bound open', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'real.txt'), 'x')
    symlinkSync('real.txt', join(fixture.workspace, 'source.txt'))
    const s = stack()
    const sym = await run(s, localToRemote())
    expect(sym.status).toBe('failed'); expect(sym.stage).toBe('source')
    fixture.dispose(); fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'hard.txt'), 'x'); linkSync(join(fixture.workspace, 'hard.txt'), join(fixture.workspace, 'source.txt'))
    const multi = await run(s, localToRemote())
    expect(multi).toMatchObject({ status: 'failed', code: 'source-multilinked' })
  })

  it('reports source-changed when the file mutates during staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'before')
    const s = stack()
    const deps = { ...s.deps, onStage: async (stage: string) => { if (stage === 'staging') writeFileSync(join(fixture.workspace, 'source.txt'), 'after!!') } }
    const result = await run(s, localToRemote(), deps as RemoteCopyDeps)
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed', stage: 'staging' })
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('cancels when admission B returns a different epoch and removes staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const s = stack()
    let calls = 0
    s.registry.withRemoteOperation = async (req: { endpoints: { environmentId: string; rootId: string }[] }, b: (o: unknown) => unknown) => {
      calls++
      return await b({
        identity: { authorityEpoch: calls >= 2 ? 'e2' : 'e1', effectiveMode: 'workspace-write', operationId: 'op-1', sessionId: 's1' },
        endpoints: req.endpoints.map(ref => ref.environmentId === 'local'
          ? { environmentId: 'local', rootId: ref.rootId, displayPath: ref.rootId, verifiedTarget: null, bindingDigest: null, configVersion: null }
          : { environmentId: ref.environmentId, rootId: ref.rootId, displayPath: displayPathOf(ref.environmentId, ref.rootId), verifiedTarget: { kind: 'path', value: displayPathOf(ref.environmentId, ref.rootId) }, bindingDigest: 'd'.repeat(64), configVersion: 'c' }),
      })
    }
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'cancelled', code: 'admission-changed' })
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('reports unknown on loss after the hardlink is sent, never retrying', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const mem = new MemSftp(); mem.loseOnHardlink = true
    const s = stack({ mems: { 'vps-a': mem, 'vps-b': new MemSftp() } })
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'unknown', code: 'connection-lost', staging: 'unknown' })
    expect(result.reconcileId).toBeTruthy()
    expect(s.mem.hardlinkCalls).toBe(1)
  })

  it('reports residual staging when the generation changed before cleanup', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const s = stack()
    const mem = s.mem
    const realHardlink = mem.hardlink.bind(mem)
    mem.hardlink = async (a: string, b: string) => { await realHardlink(a, b); s.setGeneration('vps-a', 'g2') }
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'committed', staging: 'residual' })
    expect(s.mem.calls.filter(c => c.startsWith('remove /import/.dsh-staging'))).toHaveLength(0)
  })

  it('refuses before opening any session when admission denies', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    let opens = 0
    const s = stack({ deny: 'mode-denies' })
    s.manager.openSftp = async () => { opens++; return { client: s.mem.asClient(), generation: 'g1' } }
    const result = await run(s, localToRemote())
    expect(result).toMatchObject({ status: 'failed', code: 'mode-denies', stage: 'admission' })
    expect(opens).toBe(0)
  })
})

describe('runRemoteCopy remote(sftp) → local', () => {
  it('commits into the primary root and leaves no staging', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const s = stack()
    s.mem.seed('/import/source.txt', 'from-the-vps')
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'committed', bytes: 12, sha256: sha('from-the-vps'), stage: 'cleanup', staging: 'removed' })
    expect(readFileSync(join(fixture.workspace, 'downloaded.bin'), 'utf8')).toBe('from-the-vps')
    expect(existsSync(join(fixture.workspace, '.dsh-staging-op-1'))).toBe(false)
  })

  it('refuses an existing local target before any staging', async () => {
    fixture = createFixtureWorkspace('remote-download')
    writeFileSync(join(fixture.workspace, 'downloaded.bin'), 'keep-me')
    const s = stack()
    s.mem.seed('/import/source.txt', 'new')
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect(readFileSync(join(fixture.workspace, 'downloaded.bin'), 'utf8')).toBe('keep-me')
    expect(s.mem.calls.filter(c => c.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('refuses a read-only local destination at admission, before the SFTP session opens', async () => {
    fixture = createFixtureWorkspace('remote-download')
    let opens = 0
    const s = stack({ localDeny: 'local-destination-read-only' })
    s.manager.openSftp = async () => { opens++; return { client: s.mem.asClient(), generation: 'g1' } }
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'failed', code: 'local-destination-read-only', stage: 'admission' })
    expect(opens).toBe(0)
  })

  it('refuses a symlinked destination parent and a symlinked target', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const s = stack()
    s.mem.seed('/import/source.txt', 'x')
    mkdirSync(join(fixture.workspace, 'real'))
    symlinkSync(join(fixture.workspace, 'real'), join(fixture.workspace, 'link'))
    const throughLink = await run(s, remoteToLocal({ to: { environmentId: 'local', rootId: 'primary', relativePath: 'link/f.bin' } }))
    expect(throughLink).toMatchObject({ status: 'failed', code: 'destination-symlinked' })
    symlinkSync(join(fixture.workspace, 'real'), join(fixture.workspace, 'target-link'))
    const onLink = await run(s, remoteToLocal({ to: { environmentId: 'local', rootId: 'primary', relativePath: 'target-link' } }))
    expect(onLink).toMatchObject({ status: 'failed', code: 'target-exists' })
  })

  it('refuses a destination inside a protected DSH boundary', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const s = stack({ localAuthority: () => ({ rootId: 'primary', root: fixture.workspace, access: 'primary', deny: [fixture.workspace] }) })
    s.mem.seed('/import/source.txt', 'x')
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'failed', code: 'protected-path', stage: 'preflight' })
  })

  it('reports source-changed when the remote file mutates during the stream', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const s = stack()
    s.mem.seed('/import/source.txt', 'before')
    const deps = { ...s.deps, onStage: async (stage: string) => { if (stage === 'staging') s.mem.touch('/import/source.txt', 'after!!') } }
    const result = await run(s, remoteToLocal(), deps as RemoteCopyDeps)
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed', stage: 'staging' })
    expect(existsSync(join(fixture.workspace, '.dsh-staging-op-1'))).toBe(false)
  })

  it('reports verify-mismatch and removes staging when the staged bytes were replaced', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const s = stack()
    s.mem.seed('/import/source.txt', 'payload')
    const deps = {
      ...s.deps,
      onStage: async (stage: string) => {
        if (stage === 'staging') writeFileSync(join(fixture.workspace, '.dsh-staging-op-1'), 'tampered')
      },
    }
    const result = await run(s, remoteToLocal(), deps as RemoteCopyDeps)
    expect(result).toMatchObject({ status: 'failed', code: 'verify-mismatch', stage: 'verify', staging: 'removed' })
    expect(existsSync(join(fixture.workspace, 'downloaded.bin'))).toBe(false)
  })

  it('refuses when the destination parent is replaced after staging', async () => {
    fixture = createFixtureWorkspace('remote-download')
    mkdirSync(join(fixture.workspace, 'sub'))
    const s = stack()
    s.mem.seed('/import/source.txt', 'payload')
    const deps = {
      ...s.deps,
      onStage: async (stage: string) => {
        if (stage === 'staging') { renameSync(join(fixture.workspace, 'sub'), join(fixture.workspace, 'sub-moved')); mkdirSync(join(fixture.workspace, 'sub')) }
      },
    }
    const result = await run(s, remoteToLocal({ to: { environmentId: 'local', rootId: 'primary', relativePath: 'sub/out.bin' } }), deps as RemoteCopyDeps)
    expect(result).toMatchObject({ status: 'failed', code: 'destination-changed', stage: 'publish', staging: 'residual' })
    expect(existsSync(join(fixture.workspace, 'sub', 'out.bin'))).toBe(false)
  })

  it('cancels when the local authority changes between admission A and B', async () => {
    fixture = createFixtureWorkspace('remote-download')
    // The second registry check names a different root: the copy must not
    // publish into an authority it did not stage under.
    const s = stack({ localAuthority: call => ({ rootId: 'primary', root: call >= 2 ? fixture.outside : fixture.workspace, access: 'primary', deny: [] }) })
    s.mem.seed('/import/source.txt', 'payload')
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'cancelled', code: 'admission-changed' })
    expect(existsSync(join(fixture.workspace, 'downloaded.bin'))).toBe(false)
    expect(existsSync(join(fixture.outside, 'downloaded.bin'))).toBe(false)
  })

  it('reports source-connection-lost and removes local staging when the source link dies mid-stream', async () => {
    fixture = createFixtureWorkspace('remote-download')
    const mem = new MemSftp()
    mem.seed('/import/source.txt', 'payload')
    mem.loseOnRead = true
    const s = stack({ mems: { 'vps-a': mem, 'vps-b': new MemSftp() } })
    const result = await run(s, remoteToLocal())
    expect(result).toMatchObject({ status: 'failed', code: 'source-connection-lost', staging: 'removed' })
    expect(existsSync(join(fixture.workspace, 'downloaded.bin'))).toBe(false)
  })
})

describe('runRemoteCopy remote(sftp) → remote(sftp)', () => {
  it('relays the source bytes into the destination staging and publishes', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    const payload = Buffer.from('relayed-artifact-'.repeat(20))
    s.mem.seed('/export/artifact.bin', payload)
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'committed', bytes: payload.length, sha256: sha(payload), staging: 'removed' })
    expect(s.memB.files.get('/import-b/artifact.bin')!.data.equals(payload)).toBe(true)
    expect(s.mem.files.get('/export/artifact.bin')!.data.equals(payload)).toBe(true)
    expect([...s.memB.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('carries a zero-byte and a multi-chunk file', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/empty.bin', '')
    const empty = await run(s, remoteToRemote({ from: { environmentId: 'vps-a', rootId: 'export', relativePath: 'empty.bin' }, to: { environmentId: 'vps-b', rootId: 'import', relativePath: 'empty.bin' } }))
    expect(empty).toMatchObject({ status: 'committed', bytes: 0, sha256: sha('') })
    const big = Buffer.alloc(300 * 1024, 7)
    s.mem.seed('/export/big.bin', big)
    const large = await run(s, remoteToRemote({ from: { environmentId: 'vps-a', rootId: 'export', relativePath: 'big.bin' }, to: { environmentId: 'vps-b', rootId: 'import', relativePath: 'big.bin' } }))
    expect(large).toMatchObject({ status: 'committed', bytes: big.length })
    expect(s.memB.files.get('/import-b/big.bin')!.data.equals(big)).toBe(true)
  })

  it('refuses an existing destination before staging', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'new')
    s.memB.seed('/import-b/artifact.bin', 'existing')
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect(s.memB.files.get('/import-b/artifact.bin')!.data.toString()).toBe('existing')
  })

  it('refuses a non-regular remote source', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'x', 0o120777)
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'failed', code: 'source-not-regular', stage: 'source' })
  })

  it('reports source-changed and removes destination staging', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'before')
    const deps = { ...s.deps, onStage: async (stage: string) => { if (stage === 'staging') s.mem.touch('/export/artifact.bin', 'after!!') } }
    const result = await run(s, remoteToRemote(), deps as RemoteCopyDeps)
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed' })
    expect([...s.memB.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('reports source-connection-lost and cleans the destination staging', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'payload')
    s.mem.loseOnRead = true
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'failed', code: 'source-connection-lost', staging: 'removed' })
    expect([...s.memB.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('reports a clean destination write failure and the lost destination separately', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'payload')
    s.memB.failWrites = true
    // A status error is a clean failure with staging cleaned up.
    const failed = await run(s, remoteToRemote())
    expect(failed).toMatchObject({ status: 'failed', staging: 'removed' })
    const lost = stack()
    lost.mem.seed('/export/artifact.bin', 'payload')
    lost.memB.write = async () => { throw new SftpConnectionLost('destination lost') }
    const unknown = await run(lost, remoteToRemote())
    expect(unknown).toMatchObject({ status: 'unknown', code: 'destination-connection-lost', staging: 'unknown' })
  })

  it('reports unknown when the hardlink reply is lost', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'payload')
    s.memB.loseOnHardlink = true
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'unknown', code: 'connection-lost', staging: 'unknown' })
    expect(s.memB.hardlinkCalls).toBe(1)
  })

  it('cancels when the destination generation changes between staging and publish', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'payload')
    const realFsync = s.memB.fsync.bind(s.memB)
    s.memB.fsync = async () => { await realFsync(); s.setGeneration('vps-b', 'g2') }
    const result = await run(s, remoteToRemote())
    expect(result).toMatchObject({ status: 'cancelled', code: 'admission-changed', staging: 'residual' })
    expect(s.memB.files.has('/import-b/artifact.bin')).toBe(false)
  })

  it('refuses the transfer staging namespace as a destination name', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    s.mem.seed('/export/artifact.bin', 'payload')
    const result = await run(s, remoteToRemote({ to: { environmentId: 'vps-b', rootId: 'import', relativePath: '.dsh-staging-op-1' } }))
    expect(result).toMatchObject({ status: 'failed', code: 'reserved-name' })
    expect(s.memB.hardlinkCalls).toBe(0)
  })

  it('refuses local → local as direction-unsupported before any admission', async () => {
    fixture = createFixtureWorkspace('remote-relay')
    const s = stack()
    const result = await run(s, request({ from: { environmentId: 'local', rootId: 'primary', relativePath: 'a' }, to: { environmentId: 'local', rootId: 'primary', relativePath: 'b' } }))
    expect(result).toMatchObject({ status: 'failed', code: 'direction-unsupported' })
    expect(s.registry.admitCount()).toBe(0)
  })
})
