/**
 * Real launch proof for the helper integrity entry — no mocks. The spec
 * materializes a real `node_modules` (the resolved `@deepseek-ai/dsh-ssh`
 * package plus its runtime dependency closure, dereferenced to regular
 * files), renders `helper-entry.mjs` through the production
 * `renderHelperEntry`, then speaks the upstream stdio handshake framing
 * (4-byte BE length + JSON frame, `lib/protocol.js`):
 *
 *  1. `hello` answers with `hash` = sha256 of the installed `lib/helper.js`
 *     — the value `helper.sha256` records and the host's `hello.hash`
 *     check compares — plus `kind: "node-script"`.
 *  2. After a single appended byte in a sibling chunk, the entry exits 78
 *     before any handshake.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderHelperEntry, treeDigestSource } from '../src/remote/personal/operations.ts'

const require = createRequire(import.meta.url)
const packageDir = dirname(require.resolve('@deepseek-ai/dsh-ssh/package.json'))
// The directory that holds the package AND its dependency symlinks — pnpm's
// virtual-store node_modules for this package (or the flat root elsewhere).
const vendorModules = dirname(dirname(packageDir))
const hostHelperHash = createHash('sha256').update(readFileSync(join(packageDir, 'lib', 'helper.js'))).digest('hex')

// The same digest function the remote probe and the entry embed.
const treeDigest = new Function(
  'createHash', 'readdirSync', 'readFileSync', 'readlinkSync', 'join',
  `return (${treeDigestSource})`,
)(createHash, readdirSync, readFileSync, readlinkSync, join) as (root: string) => string

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'helper-entry-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('helper-entry.mjs real launch', () => {
  it('handshakes with the helper.js digest and exits 78 on file-set drift', { timeout: 60_000 }, async () => {
    const root = tmp()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    // Real files, no symlinks left dangling: cpSync dereferences the pnpm
    // virtual-store links so every package lands as regular files.
    cpSync(vendorModules, join(root, 'node_modules'), { recursive: true, verbatimSymlinks: false })
    // npm's realistic non-regular dirent: a .bin symlink, pinned by target.
    mkdirSync(join(root, 'node_modules', '.bin'))
    symlinkSync(join('..', '@deepseek-ai', 'dsh-ssh', 'lib', 'helper.js'), join(root, 'node_modules', '.bin', 'dsh-ssh'))

    const tree = treeDigest(join(root, 'node_modules'))
    writeFileSync(join(root, 'helper-entry.mjs'), renderHelperEntry(tree), { mode: 0o700 })

    // Launch + framed hello: the upstream host sends
    // {protocol:3, workspace, leaseMs} and expects hash/kind back.
    const child = spawn(process.execPath, [join(root, 'helper-entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const helloBody = Buffer.from(JSON.stringify({
      type: 'request', id: 'hello-1', method: 'hello',
      params: { protocol: 3, workspace, leaseMs: 5_000 },
    }))
    const helloHeader = Buffer.alloc(4)
    helloHeader.writeUInt32BE(helloBody.length)
    child.stdin.write(Buffer.concat([helloHeader, helloBody]))

    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => reject(new Error(`no handshake reply in time; stderr: ${Buffer.concat(stderr).toString('utf8')}`)), 25_000)
      child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 4) return
        const size = buffer.readUInt32BE(0)
        if (buffer.length < 4 + size) return
        clearTimeout(timer)
        resolve(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')) as Record<string, unknown>)
      })
      child.on('exit', code => reject(new Error(`entry exited ${code} before the handshake; stderr: ${Buffer.concat(stderr).toString('utf8')}`)))
    })
    try {
      expect(reply.type).toBe('result')
      const hello = reply.value as Record<string, unknown>
      // What the host compares against the recorded helper.sha256.
      expect(hello.hash).toBe(hostHelperHash)
      expect(hello.kind).toBe('node-script')
      expect(hello.protocol).toBe(3)
      expect(hello.workspace).toBe(realpathSync(workspace))
    } finally {
      child.kill('SIGKILL')
    }

    // Drift one byte in a sibling chunk the single-file digest never saw:
    // the entry must exit 78 before answering any frame.
    const libDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-ssh', 'lib')
    const sibling = readdirSync(libDir).find(name => name.startsWith('stream-security-')) ?? 'schemas.js'
    appendFileSync(join(libDir, sibling), 'x')
    const drifted = spawn(process.execPath, [join(root, 'helper-entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const driftErr: Buffer[] = []
    const driftOut: Buffer[] = []
    drifted.stderr.on('data', (chunk: Buffer) => driftErr.push(chunk))
    drifted.stdout.on('data', (chunk: Buffer) => driftOut.push(chunk))
    const code = await new Promise<number | null>((resolve, reject) => {
      drifted.on('error', reject)
      drifted.on('exit', resolve)
      setTimeout(() => { drifted.kill('SIGKILL'); reject(new Error('drifted entry did not exit in time')) }, 25_000)
    })
    expect(code).toBe(78)
    expect(Buffer.concat(driftErr).toString('utf8')).toContain('integrity check failed')
    expect(Buffer.concat(driftOut)).toHaveLength(0)
  })
})
