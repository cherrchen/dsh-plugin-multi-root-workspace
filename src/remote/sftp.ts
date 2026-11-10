/**
 * Minimal SFTP v3 client over `ssh -s <alias> sftp` stdio — the managed-copy
 * transport for G2 (ADR-0034). Speaks only what staging/publish needs: EXCL
 * create semantics, bounded in-flight WRITEs, hardlink publish, fsync, and
 * loss reporting as `SftpConnectionLost` — every pending request rejects on
 * loss and no request is ever retried.
 */
import { spawn } from 'node:child_process'

export class SftpStatusError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'SftpStatusError'
  }
}

export class SftpConnectionLost extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SftpConnectionLost'
  }
}

export const SSH_FX_OK = 0
export const SSH_FX_EOF = 1
export const SSH_FX_NO_SUCH_FILE = 2
export const SSH_FX_PERMISSION_DENIED = 3
export const SSH_FX_FAILURE = 4

export const P_READ = 0x01
export const P_WRITE = 0x02
export const P_CREAT = 0x08
export const P_TRUNC = 0x10
export const P_EXCL = 0x20

const MAX_FRAME = 256 * 1024
const MAX_PENDING = 4

const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const be64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
const sfStr = (s: string) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([be32(b.length), b]) }
const sfData = (b: Buffer | Uint8Array) => Buffer.concat([be32(b.length), b])

interface Attrs {
  readonly flags: number
  readonly size?: number
  readonly uid?: number
  readonly gid?: number
  readonly permissions?: number
  readonly atime?: number
  readonly mtime?: number
}

function decodeAttrs(body: Buffer): { attrs: Attrs; end: number } {
  let o = 0
  const flags = body.readUInt32BE(o); o += 4
  const attrs: { flags: number; size?: number; uid?: number; gid?: number; permissions?: number; atime?: number; mtime?: number } = { flags }
  if (flags & 1) { attrs.size = Number(body.readBigUInt64BE(o)); o += 8 }
  if (flags & 2) { attrs.uid = body.readUInt32BE(o); attrs.gid = body.readUInt32BE(o + 4); o += 8 }
  if (flags & 4) { attrs.permissions = body.readUInt32BE(o); o += 4 }
  if (flags & 8) { attrs.atime = body.readUInt32BE(o); attrs.mtime = body.readUInt32BE(o + 4); o += 8 }
  if (flags & 0x80000000) {
    const count = body.readUInt32BE(o); o += 4
    for (let i = 0; i < count; i++) { o += 4 + body.readUInt32BE(o); o += 4 + body.readUInt32BE(o) }
  }
  return { attrs, end: o }
}

function attrsBounds(body: Buffer): number {
  let o = 0
  const take = (n: number): boolean => { if (o + n > body.length) return false; o += n; return true }
  const uint32 = (): number | undefined => take(4) ? body.readUInt32BE(o - 4) : undefined
  const flags = uint32()
  if (flags === undefined) return -1
  if (flags & 1 && !take(8)) return -1
  if (flags & 2 && !take(8)) return -1
  if (flags & 4 && !take(4)) return -1
  if (flags & 8 && !take(8)) return -1
  if (flags & 0x80000000) {
    const count = uint32()
    if (count === undefined) return -1
    for (let i = 0; i < count; i++) {
      const nameLength = uint32()
      if (nameLength === undefined || !take(nameLength)) return -1
      const dataLength = uint32()
      if (dataLength === undefined || !take(dataLength)) return -1
    }
  }
  return o
}

function wellFormedReply(type: number, body: Buffer): boolean {
  switch (type) {
    case 101: {
      if (body.length < 12) return false
      const messageLength = body.readUInt32BE(4)
      if (8 + messageLength + 4 > body.length) return false
      const tagLength = body.readUInt32BE(8 + messageLength)
      return 8 + messageLength + 4 + tagLength === body.length
    }
    case 102:
    case 103:
      return body.length >= 4 && 4 + body.readUInt32BE(0) === body.length
    case 104:
      return attrsBounds(body) === body.length
    case 105: {
      if (body.length < 4) return false
      const count = body.readUInt32BE(0)
      let o = 4
      for (let i = 0; i < count; i++) {
        if (o + 4 > body.length) return false
        const nameLength = body.readUInt32BE(o)
        o += 4 + nameLength
        if (o + 4 > body.length) return false
        const longLength = body.readUInt32BE(o)
        o += 4 + longLength
        const end = attrsBounds(body.subarray(o))
        if (end < 0) return false
        o += end
      }
      return o === body.length
    }
    case 201: return true
    default: return false
  }
}

export interface SftpDirEntry { readonly name: string; readonly longname: string; readonly attrs: Attrs }
export interface SftpVersion { readonly version: number; readonly extensions: Readonly<Record<string, string>> }

export class SftpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (reply: { type: number; body: Buffer }) => void; name: string }>()
  private readonly queue: Array<() => void> = []
  private inFlight = 0
  private buf = Buffer.alloc(0)
  private version: { version: number; extensions: Record<string, string> } | undefined
  private versionWaiters: Array<PromiseWithResolvers<SftpVersion>> = []
  private alive = true
  private readonly child
  private readonly onLoss: (error: SftpConnectionLost) => void

  private constructor(ssh: string, alias: string, onLoss: (error: SftpConnectionLost) => void) {
    this.onLoss = onLoss
    // ControlMaster is explicitly off: a multiplexed session shares fate with
    // the master — another session's close would tear this channel down and
    // break the per-session generation isolation the broker relies on.
    this.child = spawn(ssh, [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-s', alias, 'sftp',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout.on('data', (chunk: Buffer) => this.feed(chunk))
    const lose = (why: string) => this.lost(new SftpConnectionLost(why))
    this.child.on('error', error => lose(`sftp transport error: ${error.message}`))
    this.child.on('close', (code, signal) => lose(`sftp transport closed: code ${String(code)} signal ${String(signal)}`))
    this.child.stdout.on('end', () => lose('sftp transport EOF'))
    // Writing to a killed ssh's stdin raises EPIPE on the pipe, not on the
    // child — without this listener the host process dies on 'error' event.
    this.child.stdin.on('error', error => lose(`sftp transport write failed: ${error.message}`))
  }

  static connect(alias: string, options: { ssh?: string; onLoss?: (error: SftpConnectionLost) => void } = {}): SftpClient {
    return new SftpClient(options.ssh ?? 'ssh', alias, options.onLoss ?? (() => {}))
  }

  get negotiated(): SftpVersion | undefined { return this.version }

  private feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME || len < 5) { this.lost(new SftpConnectionLost(`sftp frame length ${len} out of bounds`)); return }
      if (this.buf.length < 4 + len) return
      const msg = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      const type = msg.readUInt8(0)
      if (type === 2) {
        if (this.version !== undefined) { this.lost(new SftpConnectionLost('duplicate SFTP VERSION frame')); return }
        const extensions: Record<string, string> = {}
        let o = 5
        let malformed = false
        while (o < msg.length) {
          if (o + 4 > msg.length) { malformed = true; break }
          const nameLength = msg.readUInt32BE(o)
          if (o + 4 + nameLength + 4 > msg.length) { malformed = true; break }
          const name = msg.toString('utf8', o + 4, o + 4 + nameLength)
          const dataLength = msg.readUInt32BE(o + 4 + nameLength)
          if (o + 4 + nameLength + 4 + dataLength > msg.length) { malformed = true; break }
          extensions[name] = msg.toString('utf8', o + 4 + nameLength + 4, o + 4 + nameLength + 4 + dataLength)
          o += 4 + nameLength + 4 + dataLength
        }
        if (malformed) { this.lost(new SftpConnectionLost('malformed SFTP VERSION frame')); return }
        this.version = { version: msg.readUInt32BE(1), extensions }
        for (const waiter of this.versionWaiters.splice(0)) waiter.resolve(this.version)
        continue
      }
      const id = msg.readUInt32BE(1)
      const entry = this.pending.get(id)
      if (entry === undefined) continue
      if (!wellFormedReply(type, msg.subarray(5))) {
        this.lost(new SftpConnectionLost(`malformed SFTP reply type ${type}`))
        return
      }
      this.pending.delete(id)
      this.inFlight--
      entry.resolve({ type, body: msg.subarray(5) })
      const next = this.queue.shift()
      next?.()
    }
  }

  private lost(error: SftpConnectionLost): void {
    if (!this.alive) return
    this.alive = false
    for (const entry of this.pending.values()) entry.resolve({ type: -1, body: Buffer.alloc(0) })
    this.pending.clear()
    this.inFlight = 0
    for (const waiter of this.versionWaiters.splice(0)) waiter.reject(error)
    for (const wake of this.queue.splice(0)) wake()
    try { this.child.kill() } catch { /* already gone */ }
    this.onLoss(error)
  }

  private send(type: number, name: string, ...parts: Buffer[]): Promise<{ type: number; body: Buffer }> {
    if (!this.alive) return Promise.reject(new SftpConnectionLost('sftp transport already lost'))
    const id = this.nextId++
    const body = Buffer.concat([Buffer.from([type]), be32(id), ...parts])
    return new Promise((resolve, reject) => {
      const launch = () => {
        if (!this.alive) { reject(new SftpConnectionLost('sftp transport lost')); return }
        this.inFlight++
        this.pending.set(id, { resolve: reply => {
          if (reply.type === -1) reject(new SftpConnectionLost('sftp transport lost mid-request'))
          else resolve(reply)
        }, name })
        this.child.stdin.write(Buffer.concat([be32(body.length), body]))
      }
      if (this.inFlight >= MAX_PENDING) this.queue.push(launch)
      else launch()
    })
  }

  private async status(reply: { type: number; body: Buffer }): Promise<void> {
    if (reply.type !== 101) return
    const code = reply.body.readUInt32BE(0)
    if (code === SSH_FX_OK) return
    const ml = reply.body.readUInt32BE(4)
    const message = reply.body.toString('utf8', 8, 8 + Math.min(ml, reply.body.length - 4))
    throw new SftpStatusError(code, message === '' ? `SSH_FX_${code}` : message)
  }

  /** INIT + VERSION; resolves with the server's version and extension table. */
  async init(): Promise<SftpVersion> {
    if (!this.alive) throw new SftpConnectionLost('sftp transport already lost')
    if (this.version !== undefined) return this.version
    const body = Buffer.concat([Buffer.from([1]), be32(3)])
    this.child.stdin.write(Buffer.concat([be32(body.length), body]))
    const waiter = Promise.withResolvers<SftpVersion>()
    this.versionWaiters.push(waiter)
    return await waiter.promise
  }

  async open(path: string, pflags: number, permissions?: number): Promise<Buffer> {
    const reply = await this.send(3, 'open', sfStr(path), be32(pflags), be32(permissions ?? 0))
    if (reply.type === 101) await this.status(reply)
    const hl = reply.body.readUInt32BE(0)
    return reply.body.subarray(4, 4 + hl)
  }

  async write(handle: Buffer, offset: number | bigint, data: Buffer | Uint8Array): Promise<void> {
    await this.status(await this.send(6, 'write', sfData(handle), be64(offset), sfData(data)))
  }

  async read(handle: Buffer, offset: number | bigint, length: number): Promise<Buffer> {
    const reply = await this.send(5, 'read', sfData(handle), be64(offset), be32(length))
    if (reply.type === 101) {
      const code = reply.body.readUInt32BE(0)
      if (code === SSH_FX_EOF) return Buffer.alloc(0)
      await this.status(reply)
    }
    return reply.body.subarray(4, 4 + reply.body.readUInt32BE(0))
  }

  async close(handle: Buffer): Promise<void> { await this.status(await this.send(4, 'close', sfData(handle))) }
  async remove(path: string): Promise<void> { await this.status(await this.send(13, 'remove', sfStr(path))) }
  async realpath(path: string): Promise<string> {
    const reply = await this.send(16, 'realpath', sfStr(path))
    if (reply.type === 101) await this.status(reply)
    const count = reply.body.readUInt32BE(0)
    if (count === 0) throw new SftpStatusError(SSH_FX_FAILURE, 'realpath returned no names')
    return reply.body.toString('utf8', 8, 8 + reply.body.readUInt32BE(4))
  }
  async lstat(path: string): Promise<Attrs> {
    const reply = await this.send(7, 'lstat', sfStr(path))
    if (reply.type === 101) await this.status(reply)
    return decodeAttrs(reply.body).attrs
  }
  async readdir(path: string): Promise<SftpDirEntry[]> {
    const opened = await this.send(11, 'opendir', sfStr(path))
    if (opened.type === 101) await this.status(opened)
    const hl = opened.body.readUInt32BE(0)
    const handle = opened.body.subarray(4, 4 + hl)
    const entries: SftpDirEntry[] = []
    try {
      for (;;) {
        const reply = await this.send(12, 'readdir', sfData(handle))
        if (reply.type === 101) {
          if (reply.body.readUInt32BE(0) === SSH_FX_EOF) break
          await this.status(reply); break
        }
        const count = reply.body.readUInt32BE(0)
        let o = 4
        for (let i = 0; i < count; i++) {
          const nl = reply.body.readUInt32BE(o); const name = reply.body.toString('utf8', o + 4, o + 4 + nl); o += 4 + nl
          const ll = reply.body.readUInt32BE(o); const longname = reply.body.toString('utf8', o + 4, o + 4 + ll); o += 4 + ll
          const parsed = decodeAttrs(reply.body.subarray(o)); o += parsed.end
          entries.push({ name, longname, attrs: parsed.attrs })
        }
      }
    } finally { await this.close(handle).catch(() => {}) }
    return entries
  }
  async extended(name: string, ...parts: Buffer[]): Promise<void> {
    const reply = await this.send(200, `extended:${name}`, sfStr(name), ...parts)
    if (reply.type === 101) await this.status(reply)
  }
  async hardlink(oldPath: string, newPath: string): Promise<void> { await this.extended('hardlink@openssh.com', sfStr(oldPath), sfStr(newPath)) }
  async fsync(handle: Buffer): Promise<void> { await this.extended('fsync@openssh.com', sfData(handle)) }

  /** Close the transport; pending requests reject with connection loss. */
  dispose(): void { this.lost(new SftpConnectionLost('sftp disposed')) }
}
