/**
 * probe-sftp-primitives — G2 evidence for Issue #32: a minimal SFTP v3 client
 * speaking over `ssh -s <alias> sftp` stdio. It answers the primitives a
 * staging/publish transfer needs WITHOUT a shell: EXCL create semantics,
 * multi-WRITE round trips, hardlink/publish/no-replace behavior, posix-rename
 * replace semantics, fsync availability, and link-count via READDIR longnames.
 * Usage: node scripts/probe-sftp-primitives.mjs --alias dsh-vps-xfer --dir /import
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const alias = args[args.indexOf('--alias') + 1] ?? 'dsh-vps-xfer'
const dir = args[args.indexOf('--dir') + 1] ?? '/import'
const sha256 = data => createHash('sha256').update(data).digest('hex')

// The client now lives in src/remote/sftp.ts — run with --experimental-transform-types.
import { SftpClient } from '../src/remote/sftp.ts'

const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const sfStr = t => { const b = Buffer.from(t, 'utf8'); return Buffer.concat([be32(b.length), b]) }
const sfData = b => Buffer.concat([be32(b.length), b])

const nlinkOf = async (sftp, dir, name) => {
  const entries = await sftp.readdir(dir)
  const hit = entries.find(e => e.name === name)
  return hit === undefined ? undefined : Number(hit.longname.trim().split(/\s+/)[1])
}

const sshBin = process.env.SSH_BIN ?? `${process.env.HOME}/.dsh-ssh-test/bin/ssh`
const sftp = SftpClient.connect(alias, { ssh: sshBin })
const out = { alias, dir, steps: [] }
const record = (name, result) => { out.steps.push({ name, ...result }); console.log(JSON.stringify({ name, ...result }).slice(0, 220)) }

const version = await sftp.init()
record('init', { version: version.version, extensions: version.extensions })

const staging = `${dir}/stage-${Date.now()}.tmp`
const final = `${dir}/published-${Date.now()}.bin`
const READ = 0x01, WRITE = 0x02, CREAT = 0x08, EXCL = 0x20

// (a) EXCL create semantics: first open wins, second fails, bytes untouched.
{
  let first
  try { first = await sftp.open(staging, WRITE | CREAT | EXCL) } catch (e) { first = { fail: { ok: false, code: e.code, message: e.message } } }
  record('excl-first-open', { ok: first.fail === undefined, fail: first.fail })
  const payload = Buffer.from('original-staging-bytes')
  await sftp.write(first, 0, payload)
  let second
  try { await sftp.open(staging, WRITE | CREAT | EXCL); second = {} } catch (e) { second = { fail: { ok: false, code: e.code, message: e.message } } }
  record('excl-second-open', { refused: second.fail !== undefined, status: second.fail })
  await sftp.close(first)
  const back = await sftp.open(staging, READ)
  const read = { data: await sftp.read(back, 0, 1 << 20) }
  await sftp.close(back)
  record('excl-original-intact', { ok: read.data.equals(payload), sha256: sha256(read.data) })
}
// (b) 0-byte and >64 KiB writes, read back sha256.
for (const [label, size] of [['empty', 0], ['large', 96 * 1024]]) {
  const path = `${dir}/roundtrip-${label}-${Date.now()}.bin`
  const opened = await sftp.open(path, WRITE | CREAT | EXCL)
  const payload = createHash('sha256').update(label).digest().subarray(0, size % 32 === 0 ? 32 : size % 32 || 32)
  const full = size === 0 ? Buffer.alloc(0) : Buffer.concat(Array(Math.ceil(size / payload.length)).fill(payload)).subarray(0, size)
  for (let offset = 0; offset < full.length; offset += 32 * 1024) {
    await sftp.write(opened, offset, full.subarray(offset, offset + 32 * 1024))
    const r = { ok: true }
    if (!r.ok) record(`write-${label}@${offset}`, r)
  }
  await sftp.close(opened)
  const back = await sftp.open(path, READ)
  const chunks = []
  for (let offset = 0;;) { const r = await sftp.read(back, offset, 64 * 1024); chunks.push(r); if (r.length < 64 * 1024) break; offset += r.length }
  await sftp.close(back)
  const read = Buffer.concat(chunks)
  record(`roundtrip-${label}`, { ok: sha256(read) === sha256(full), bytes: size, read: read.length, sha256: sha256(read), expected: sha256(full) })
  await sftp.remove(path)
}
// (c)+(e) hardlink publish: staging -> missing final succeeds; onto existing final fails; nlink tracked.
{
  const payload = Buffer.from('hardlink-payload')
  const s1 = await sftp.open(staging, WRITE | 0x10) // TRUNC: staging may still hold earlier bytes
  await sftp.write(s1, 0, payload)
  await sftp.close(s1)
  const nlinkBefore = await nlinkOf(sftp, dir, staging.split('/').pop())
  record('hardlink-new-final', await sftp.extended('hardlink@openssh.com', sfStr(staging), sfStr(final)).then(() => ({ ok: true, code: 0 }), e => ({ ok: false, code: e.code, message: e.message })))
  const nlinkAfter = await nlinkOf(sftp, dir, staging.split('/').pop())
  record('hardlink-existing-final', await sftp.extended('hardlink@openssh.com', sfStr(staging), sfStr(final)).then(() => ({ ok: true, code: 0 }), e => ({ ok: false, code: e.code, message: e.message })))
  const back = await sftp.open(final, READ)
  const read = { data: await sftp.read(back, 0, 1 << 20) }
  await sftp.close(back)
  record('hardlink-final-unchanged', { ok: read.data.equals(payload), sha256: sha256(read.data), nlinkBefore, nlinkAfter })
}
// (e-first) remove the staging half of the publish pair once final exists.
record('remove-staging', await sftp.remove(staging).then(() => ({ ok: true, code: 0 }), e => ({ ok: false, code: e.code, message: e.message })))
// (d) posix-rename replace semantics: fresh source -> existing name.
{
  const victim = `${dir}/victim-${Date.now()}.bin`
  const v = await sftp.open(victim, WRITE | CREAT | EXCL)
  const original = Buffer.from('victim-original')
  await sftp.write(v, 0, original)
  await sftp.close(v)
  const src = `${dir}/rename-src-${Date.now()}.tmp`
  const r = await sftp.open(src, WRITE | CREAT | EXCL)
  const replaced = Buffer.from('rename-source-bytes')
  await sftp.write(r, 0, replaced)
  await sftp.close(r)
  const renamed = await sftp.extended('posix-rename@openssh.com', sfStr(src), sfStr(victim)).then(() => ({ ok: true, code: 0 }), e => ({ ok: false, code: e.code, message: e.message }))
  record('posix-rename-onto-existing', { ...renamed, note: 'OK means it OVERWROTE — posix-rename is NOT a no-replace primitive' })
  const back = await sftp.open(victim, READ)
  const read = { data: await sftp.read(back, 0, 1 << 20) }
  await sftp.close(back)
  record('posix-rename-content', { content: read.data.toString('utf8'), replaced: read.data.equals(Buffer.from('rename-source-bytes')) })
  if ('fsync@openssh.com' in version.extensions) {
    const f = await sftp.open(final, READ)
    record('fsync-advertised', await sftp.extended('fsync@openssh.com', sfData(f)).then(() => ({ ok: true, code: 0 }), e => ({ ok: false, code: e.code, message: e.message })))
    await sftp.close(f)
  } else record('fsync-advertised', { advertised: false })
}
sftp.dispose()
writeFileSync(process.env.SFTP_OUT ?? '/dev/stdout', JSON.stringify(out, null, 2))
process.exit(0)
