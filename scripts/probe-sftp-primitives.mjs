/**
 * probe-sftp-primitives — G2 evidence for Issue #32: a minimal SFTP v3 client
 * speaking over `ssh -s <alias> sftp` stdio. It answers the primitives a
 * staging/publish transfer needs WITHOUT a shell: EXCL create semantics,
 * multi-WRITE round trips, hardlink/publish/no-replace behavior, posix-rename
 * replace semantics, fsync availability, and link-count via READDIR longnames.
 * Usage: node scripts/probe-sftp-primitives.mjs --alias dsh-vps-xfer --dir /import
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const alias = args[args.indexOf('--alias') + 1] ?? 'dsh-vps-xfer'
const dir = args[args.indexOf('--dir') + 1] ?? '/import'
const sha256 = data => createHash('sha256').update(data).digest('hex')

// Minimal SFTP v3 codec — only the messages this probe needs.
const SSH_FX_OK = 0
class Sftp {
  constructor(stdin, stdout) {
    this.nextId = 1
    this.pending = new Map()
    this.buf = Buffer.alloc(0)
    this.stdin = stdin
    stdout.on('data', chunk => this.#feed(chunk))
  }
  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (this.buf.length < 4 + len) return
      const msg = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      const type = msg.readUInt8(0)
      if (type === 2) { // VERSION: version + extension pairs
        this.version = msg.readUInt32BE(1)
        this.extensions = {}
        for (let o = 5; o + 8 <= msg.length;) {
          const nl = msg.readUInt32BE(o); const name = msg.toString('utf8', o + 4, o + 4 + nl); o += 4 + nl
          const dl = msg.readUInt32BE(o); const data = msg.toString('utf8', o + 4, o + 4 + dl); o += 4 + dl
          this.extensions[name] = data
        }
        this.versionWaiter?.()
        continue
      }
      const id = msg.readUInt32BE(1)
      const resolve = this.pending.get(id)
      if (resolve === undefined) continue
      this.pending.delete(id)
      resolve({ type, body: msg.subarray(5) })
    }
  }
  #send(type, ...parts) {
    const id = this.nextId++
    const body = Buffer.concat([Buffer.from([type]), be32(id), ...parts])
    this.stdin.write(Buffer.concat([be32(body.length), body]))
    return new Promise((resolve, reject) => { this.pending.set(id, resolve); setTimeout(() => reject(new Error('sftp timeout')), 15_000) })
  }

  #expectStatus(reply) {
    if (reply.type === 101) {
      const code = reply.body.readUInt32BE(0)
      const message = reply.body.readUInt32BE(4) <= reply.body.length - 4 ? reply.body.toString('utf8', 8, 8 + reply.body.readUInt32BE(4)) : ''
      return { ok: code === SSH_FX_OK, code, message }
    }
    return { ok: true, reply }
  }
  async init() {
    const body = Buffer.concat([Buffer.from([1]), be32(3)])
    this.stdin.write(Buffer.concat([be32(body.length), body]))
    await new Promise(resolve => { this.versionWaiter = resolve })
    return { version: this.version, extensions: this.extensions }
  }
  async open(path, pflags, attrs = 0) { // OPEN(3)
    const reply = await this.#send(3, sfStr(path), be32(pflags), be32(attrs))
    if (reply.type === 101) return { fail: this.#expectStatus(reply) }
    const hl = reply.body.readUInt32BE(0)
    return { handle: reply.body.subarray(4, 4 + hl) }
  }
  async write(handle, offset, data) { return this.#expectStatus(await this.#send(6, sfData(handle), be64(offset), sfData(data))) }
  async read(handle, offset, length) { // READ(5)
    const reply = await this.#send(5, sfData(handle), be64(offset), be32(length))
    if (reply.type === 101) return { eof: this.#expectStatus(reply).code === 1, data: Buffer.alloc(0) }
    return { data: reply.body.subarray(4, 4 + reply.body.readUInt32BE(0)) }
  }
  async close(handle) { return this.#expectStatus(await this.#send(4, sfData(handle))) }
  async lstat(path) { // LSTAT(7)
    const reply = await this.#send(7, sfStr(path))
    if (reply.type === 101) return { fail: this.#expectStatus(reply) }
    return { attrs: decodeAttrs(reply.body).attrs }
  }
  async remove(path) { return this.#expectStatus(await this.#send(13, sfStr(path))) }
  async readdir(path) { // OPENDIR(11)+READDIR(12)+CLOSE
    const opened = await this.#send(11, sfStr(path))
    if (opened.type === 101) return { fail: this.#expectStatus(opened) }
    const hl = opened.body.readUInt32BE(0)
    opened.handle = opened.body.subarray(4, 4 + hl)
    const entries = []
    for (;;) {
      const reply = await this.#send(12, sfData(opened.handle))
      if (reply.type === 101) break
      const count = reply.body.readUInt32BE(0)
      let o = 4
      for (let i = 0; i < count; i++) {
        const nl = reply.body.readUInt32BE(o); const name = reply.body.toString('utf8', o + 4, o + 4 + nl); o += 4 + nl
        const ll = reply.body.readUInt32BE(o); const longname = reply.body.toString('utf8', o + 4, o + 4 + ll); o += 4 + ll
        const parsed = decodeAttrs(reply.body.subarray(o))
        entries.push({ name, longname, attrs: parsed.attrs }); o += parsed.end
      }
    }
    await this.close(opened.handle)
    return { entries }
  }
  async extended(name, ...parts) { // EXTENDED(200): a STATUS reply IS the result — code 0 means success.
    const reply = await this.#send(200, sfStr(name), ...parts)
    if (reply.type === 101) { const st = this.#expectStatus(reply); return { ok: st.ok, code: st.code, message: st.message } }
    return { ok: true, reply }
  }
}

function sfStr(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([be32(b.length), b]) }
function sfData(b) { return Buffer.concat([be32(b.length), b]) }
function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
function be64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
function decodeAttrs(body) { // ATTRS is self-describing via flags — return the consumed length too.
  let o = 0
  const flags = body.readUInt32BE(o); o += 4
  const attrs = { flags }
  if (flags & 1) { attrs.size = Number(body.readBigUInt64BE(o)); o += 8 }
  if (flags & 2) { attrs.uid = body.readUInt32BE(o); attrs.gid = body.readUInt32BE(o + 4); o += 8 }
  if (flags & 4) { attrs.permissions = body.readUInt32BE(o); o += 4 }
  if (flags & 8) { attrs.atime = body.readUInt32BE(o); attrs.mtime = body.readUInt32BE(o + 4); o += 8 }
  if (flags & 0x80000000) {
    const count = body.readUInt32BE(o); o += 4; attrs.extended = count
    for (let i = 0; i < count; i++) { o += 4 + body.readUInt32BE(o); o += 4 + body.readUInt32BE(o) }
  }
  return { attrs, end: o }
}
const nlinkOf = async (sftp, dir, name) => {
  const { entries } = await sftp.readdir(dir)
  const hit = entries.find(e => e.name === name)
  return hit === undefined ? undefined : Number(hit.longname.trim().split(/\s+/)[1])
}

const sshBin = process.env.SSH_BIN ?? `${process.env.HOME}/.dsh-ssh-test/bin/ssh`
const child = spawn(sshBin, ['-s', alias, 'sftp'], { stdio: ['pipe', 'pipe', 'inherit'] })
const sftp = new Sftp(child.stdin, child.stdout)
const out = { alias, dir, steps: [] }
const record = (name, result) => { out.steps.push({ name, ...result }); console.log(JSON.stringify({ name, ...result }).slice(0, 220)) }

const version = await sftp.init()
record('init', { version: version.version, extensions: version.extensions })

const staging = `${dir}/stage-${Date.now()}.tmp`
const final = `${dir}/published-${Date.now()}.bin`
const READ = 0x01, WRITE = 0x02, CREAT = 0x08, EXCL = 0x20

// (a) EXCL create semantics: first open wins, second fails, bytes untouched.
{
  const first = await sftp.open(staging, WRITE | CREAT | EXCL)
  record('excl-first-open', { ok: first.fail === undefined, fail: first.fail })
  const payload = Buffer.from('original-staging-bytes')
  await sftp.write(first.handle, 0, payload)
  const second = await sftp.open(staging, WRITE | CREAT | EXCL)
  record('excl-second-open', { refused: second.fail !== undefined, status: second.fail })
  await sftp.close(first.handle)
  const back = await sftp.open(staging, READ)
  const read = await sftp.read(back.handle, 0, 1 << 20)
  await sftp.close(back.handle)
  record('excl-original-intact', { ok: read.data.equals(payload), sha256: sha256(read.data) })
}
// (b) 0-byte and >64 KiB writes, read back sha256.
for (const [label, size] of [['empty', 0], ['large', 96 * 1024]]) {
  const path = `${dir}/roundtrip-${label}-${Date.now()}.bin`
  const opened = await sftp.open(path, WRITE | CREAT | EXCL)
  const payload = createHash('sha256').update(label).digest().subarray(0, size % 32 === 0 ? 32 : size % 32 || 32)
  const full = size === 0 ? Buffer.alloc(0) : Buffer.concat(Array(Math.ceil(size / payload.length)).fill(payload)).subarray(0, size)
  for (let offset = 0; offset < full.length; offset += 32 * 1024) {
    const r = await sftp.write(opened.handle, offset, full.subarray(offset, offset + 32 * 1024))
    if (!r.ok) record(`write-${label}@${offset}`, r)
  }
  await sftp.close(opened.handle)
  const back = await sftp.open(path, READ)
  const chunks = []
  for (let offset = 0;;) { const r = await sftp.read(back.handle, offset, 64 * 1024); chunks.push(r.data); if (r.data.length < 64 * 1024) break; offset += r.data.length }
  await sftp.close(back.handle)
  const read = Buffer.concat(chunks)
  record(`roundtrip-${label}`, { ok: sha256(read) === sha256(full), bytes: size, read: read.length, sha256: sha256(read), expected: sha256(full) })
  await sftp.remove(path)
}
// (c)+(e) hardlink publish: staging -> missing final succeeds; onto existing final fails; nlink tracked.
{
  const payload = Buffer.from('hardlink-payload')
  const s1 = await sftp.open(staging, WRITE | 0x10) // TRUNC: staging may still hold earlier bytes
  await sftp.write(s1.handle, 0, payload)
  await sftp.close(s1.handle)
  const nlinkBefore = await nlinkOf(sftp, dir, staging.split('/').pop())
  const missing = await sftp.extended('hardlink@openssh.com', sfStr(staging), sfStr(final))
  record('hardlink-new-final', missing)
  const nlinkAfter = await nlinkOf(sftp, dir, staging.split('/').pop())
  const existing = await sftp.extended('hardlink@openssh.com', sfStr(staging), sfStr(final))
  record('hardlink-existing-final', existing)
  const back = await sftp.open(final, READ)
  const read = await sftp.read(back.handle, 0, 1 << 20)
  await sftp.close(back.handle)
  record('hardlink-final-unchanged', { ok: read.data.equals(payload), sha256: sha256(read.data), nlinkBefore, nlinkAfter })
}
// (e-first) remove the staging half of the publish pair once final exists.
record('remove-staging', await sftp.remove(staging))
// (d) posix-rename replace semantics: fresh source -> existing name.
{
  const victim = `${dir}/victim-${Date.now()}.bin`
  const v = await sftp.open(victim, WRITE | CREAT | EXCL)
  const original = Buffer.from('victim-original')
  await sftp.write(v.handle, 0, original)
  await sftp.close(v.handle)
  const src = `${dir}/rename-src-${Date.now()}.tmp`
  const r = await sftp.open(src, WRITE | CREAT | EXCL)
  const replaced = Buffer.from('rename-source-bytes')
  await sftp.write(r.handle, 0, replaced)
  await sftp.close(r.handle)
  const renamed = await sftp.extended('posix-rename@openssh.com', sfStr(src), sfStr(victim))
  record('posix-rename-onto-existing', { ...renamed, note: 'OK means it OVERWROTE — posix-rename is NOT a no-replace primitive' })
  const back = await sftp.open(victim, READ)
  const read = await sftp.read(back.handle, 0, 1 << 20)
  await sftp.close(back.handle)
  record('posix-rename-content', { content: read.data.toString('utf8'), replaced: read.data.equals(Buffer.from('rename-source-bytes')) })
  if ('fsync@openssh.com' in version.extensions) {
    const f = await sftp.open(final, READ)
    record('fsync-advertised', await sftp.extended('fsync@openssh.com', sfData(f.handle)))
    await sftp.close(f.handle)
  } else record('fsync-advertised', { advertised: false })
}
writeFileSync(process.env.SFTP_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2))
child.stdin.end()
process.exit(0)
