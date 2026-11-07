/** runRemoteCopy stage ordering and refusal codes — in-memory SFTP, no network. */
import { createHash } from 'node:crypto'
import { linkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRemoteCopy, type RemoteCopyDeps } from '../src/remote/transfer.ts'
import { SftpStatusError, SftpConnectionLost, type SftpClient } from '../src/remote/sftp.ts'
import type { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

class MemSftp {
  readonly files = new Map<string, Buffer>()
  readonly calls: string[] = []
  loseOnHardlink = false
  hardlinkCalls = 0
  async lstat(p: string) { this.calls.push(`lstat ${p}`); if (!this.files.has(p)) throw new SftpStatusError(2, 'No such file'); return { flags: 4, permissions: 0o100644 } }
  async realpath(p: string) { return p }
  async open(p: string, flags: number, _perm?: number) { this.calls.push(`open ${p} ${flags}`); if ((flags & 0x20) !== 0 && this.files.has(p)) throw new SftpStatusError(4, 'Failure'); if ((flags & 0x08) !== 0 && !this.files.has(p)) this.files.set(p, Buffer.alloc(0)); if (!this.files.has(p)) throw new SftpStatusError(2, 'No such file'); return Buffer.from(p) }
  async write(h: Buffer, off: number, data: Buffer) { const p = h.toString(); const cur = this.files.get(p)!; const grown = Buffer.alloc(Math.max(cur.length, off + data.length)); cur.copy(grown); data.copy(grown, off); this.files.set(p, grown) }
  async read(h: Buffer, off: number, len: number) { return this.files.get(h.toString())!.subarray(off, off + len) }
  async fsync() { this.calls.push('fsync') }
  async close() {}
  async remove(p: string) { this.calls.push(`remove ${p}`); this.files.delete(p) }
  async hardlink(oldP: string, newP: string) { this.calls.push(`hardlink ${oldP} ${newP}`); this.hardlinkCalls++; if (this.loseOnHardlink) throw new SftpConnectionLost('transport lost'); if (this.files.has(newP)) throw new SftpStatusError(4, 'Failure'); this.files.set(newP, this.files.get(oldP)!) }
  asClient() { return this as unknown as SftpClient }
}

let fixture: FixtureWorkspace
afterEach(() => fixture.dispose())
const session = () => ({ header: { cwd: fixture.workspace }, id: 's1' }) as never
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

function stack(opts: { epoch?: string; admitCalls?: number[]; deny?: string; mem?: MemSftp; statuses?: { aliasId: string; path: string; state: string }[]; transfer?: { maxBytes: number; timeoutMs: number } | undefined } = {}) {
  const mem = opts.mem ?? new MemSftp()
  const manifest = {
    environments: [{ environmentId: 'vps-xfer', platform: 'linux', account: 'a', hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'n', transport: 'sftp', helper: null, connection: { host: 'vps' }, credentialIsolation: 'unattested', transfer: opts.transfer === undefined ? { maxBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } : opts.transfer }],
  } as unknown as DeploymentManifest
  const operation = {
    identity: { authorityEpoch: opts.epoch ?? 'e1', effectiveMode: 'workspace-write', operationId: 'op-1', sessionId: 's1' },
    endpoints: [
      { environmentId: 'local', rootId: 'primary', displayPath: '', verifiedTarget: null, bindingDigest: null, configVersion: null },
      { environmentId: 'vps-xfer', rootId: 'import', displayPath: '/import', verifiedTarget: { kind: 'path', value: '/import' }, bindingDigest: 'd'.repeat(64), configVersion: 'c' },
    ],
  }
  let admitCount = 0
  const registry = {
    async withRemoteOperation(_req: unknown, body: (o: unknown) => unknown) {
      admitCount++
      if (opts.deny !== undefined) { const e = new Error('denied'); (e as { code?: string }).code = opts.deny; throw e }
      return await body(operation)
    },
    list: () => opts.statuses ?? [],
    admitCount: () => admitCount,
  } as unknown as MultiRootRegistry & { admitCount(): number }
  const manager = {
    deployment: manifest,
    openSftp: async () => ({ client: mem.asClient(), generation: 'g1' }),
    sftpGenerationOf: () => generation,
    manifest,
  } as unknown as SshEnvironmentManager
  let generation = 'g1'
  const deps: RemoteCopyDeps = { manager, generationFor: () => generation }
  return { registry, manager, mem, deps, setGeneration: (g: string) => { generation = g } }
}
const req = (over: object = {}) => ({
  session: session(),
  from: { environmentId: 'local' as const, rootId: 'primary', relativePath: 'source.txt' },
  to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'dest.txt' },
  ...over,
})

describe('runRemoteCopy', () => {
  it('commits a staged copy end to end', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'hello-remote')
    const s = stack()
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'committed', bytes: 12, sha256: sha('hello-remote'), stage: 'cleanup', staging: 'removed' })
    expect(s.mem.files.get('/import/dest.txt')!.toString()).toBe('hello-remote')
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
    expect(s.mem.calls).toContain('fsync')
  })

  it('refuses an existing target before staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const mem = new MemSftp()
    mem.files.set('/import/dest.txt', Buffer.from('existing'))
    const s = stack({ mem })
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', code: 'target-exists', stage: 'preflight', staging: 'none' })
    expect(s.mem.calls.filter(c => c.startsWith('open /import/.dsh-staging'))).toHaveLength(0)
    expect(s.mem.files.get('/import/dest.txt')!.toString()).toBe('existing')
  })

  it('refuses symlink and multilinked sources at the bound open', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'real.txt'), 'x')
    symlinkSync('real.txt', join(fixture.workspace, 'source.txt'))
    const s = stack()
    const sym = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(sym.status).toBe('failed'); expect(sym.stage).toBe('source')
    fixture.dispose(); fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'hard.txt'), 'x'); linkSync(join(fixture.workspace, 'hard.txt'), join(fixture.workspace, 'source.txt'))
    const multi = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(multi).toMatchObject({ status: 'failed', code: 'source-multilinked' })
  })

  it('reports source-changed when the file mutates during staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'before')
    const s = stack()
    s.deps = { ...s.deps, onStage: async stage => { if (stage === 'staging') writeFileSync(join(fixture.workspace, 'source.txt'), 'after!!') } }
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', code: 'source-changed', stage: 'staging' })
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('cancels when admission B returns a different epoch and removes staging', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const s = stack()
    let calls = 0
    s.registry.withRemoteOperation = async (_a: unknown, b: (o: unknown) => unknown) => {
      calls++
      return await b({ identity: { authorityEpoch: calls >= 2 ? 'e2' : 'e1', effectiveMode: 'workspace-write', operationId: 'op-1', sessionId: 's1' }, endpoints: [
        { environmentId: 'local', rootId: 'primary', displayPath: '', verifiedTarget: null, bindingDigest: null, configVersion: null },
        { environmentId: 'vps-xfer', rootId: 'import', displayPath: '/import', verifiedTarget: { kind: 'path', value: '/import' }, bindingDigest: 'd'.repeat(64), configVersion: 'c' },
      ] })
    }
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'cancelled', code: 'admission-changed' })
    expect([...s.mem.files.keys()].filter(k => k.includes('.dsh-staging'))).toHaveLength(0)
  })

  it('reports unknown on loss after the hardlink is sent, never retrying', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const mem = new MemSftp(); mem.loseOnHardlink = true
    const s = stack({ mem })
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'unknown', code: 'connection-lost', staging: 'unknown' })
    expect(result.reconcileId).toBeTruthy()
    expect(s.mem.hardlinkCalls).toBe(1)
  })

  it('reports residual staging when the generation changed before cleanup', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    const s = stack()
    let generation = 'g1'
    const deps = { ...s.deps, generationFor: () => generation }
    s.setGeneration('g1')
    const mem = s.mem
    const realHardlink = mem.hardlink.bind(mem)
    mem.hardlink = async (a: string, b: string) => { await realHardlink(a, b); generation = 'g2' }
    const result = await runRemoteCopy(s.registry, deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'committed', staging: 'residual' })
    expect(s.mem.calls.filter(c => c.startsWith('remove /import/.dsh-staging'))).toHaveLength(0)
  })

  it('refuses before opening any session when admission denies', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    writeFileSync(join(fixture.workspace, 'source.txt'), 'x')
    let opens = 0
    const s = stack({ deny: 'mode-denies' })
    s.manager.openSftp = async () => { opens++; return { client: s.mem.asClient(), generation: 'g1' } }
    const result = await runRemoteCopy(s.registry, s.deps, req(), 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', code: 'mode-denies', stage: 'admission' })
    expect(opens).toBe(0)
  })

  it('rejects remote→local and remote→remote as direction-unsupported', async () => {
    fixture = createFixtureWorkspace('remote-copy')
    const s = stack()
    const result = await runRemoteCopy(s.registry, s.deps, {
      session: session(), from: { environmentId: 'vps-xfer' as never, rootId: 'import', relativePath: 'a' },
      to: { environmentId: 'vps-xfer', rootId: 'import', relativePath: 'b' },
    }, 'remote_copy', new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', code: 'direction-unsupported' })
  })
})
