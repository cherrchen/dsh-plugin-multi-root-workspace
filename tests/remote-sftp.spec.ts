/** F19: the SFTP frame parser refuses malformed wire data before it reaches a resolve callback. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SftpClient, SftpConnectionLost } from '../src/remote/sftp.ts'

let dir = ''
const clients: SftpClient[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-sftp-')) })
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const be32 = (n: number) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const frame = (body: number[]) => [...be32(body.length), ...body]
const version = (exts: number[] = []) => frame([2, 0, 0, 0, 3, ...exts])
const status = (id: number, body: number[]) => frame([101, ...be32(id), ...body])

/** A fake `ssh` that emits `bytes` on stdout, then idles or exits. */
async function fakeSsh(bytes: number[], opts: { chunks?: number; exit?: boolean } = {}) {
  const script = join(dir, 'emit.mjs')
  const chunks = opts.chunks ?? bytes.length
  writeFileSync(script, `
    const bytes = Buffer.from(${JSON.stringify(bytes)})
    const chunks = ${chunks}
    const step = Math.ceil(bytes.length / chunks)
    const firstLength = bytes.length >= 4 ? bytes.readUInt32BE(0) + 4 : bytes.length
    let input = Buffer.alloc(0)
    let first = true
    const emit = data => {
      let offset = 0
      const write = () => {
        if (offset >= data.length) {
          if (${opts.exit === true}) process.exit(0)
          return
        }
        process.stdout.write(data.subarray(offset, offset + step), () => {
          offset += step
          setImmediate(write)
        })
      }
      write()
    }
    process.stdin.on('data', chunk => {
      input = Buffer.concat([input, chunk])
      while (input.length >= 4 && input.length >= input.readUInt32BE(0) + 4) {
        const length = input.readUInt32BE(0) + 4
        input = input.subarray(length)
        emit(first ? bytes.subarray(0, firstLength) : bytes.subarray(firstLength))
        first = false
      }
    })
  `)
  const wrapper = join(dir, 'fake-ssh.sh')
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.log"\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(wrapper, 0o755)
  const client = SftpClient.connect('fake-alias', { ssh: wrapper })
  clients.push(client)
  return client
}

describe.skipIf(process.platform === 'win32')('SFTP wire validation', () => {
  it('rejects init when the frame length is 1-4 bytes or the connection dies before VERSION', async () => {
    for (const body of [[2], [2, 0], [2, 0, 0], [2, 0, 0, 0]]) {
      const client = await fakeSsh(frame(body))
      await expect(client.init()).rejects.toBeInstanceOf(SftpConnectionLost)
    }
    const ended = await fakeSsh(frame([2, 0, 0]), { exit: true })
    await expect(ended.init()).rejects.toBeInstanceOf(SftpConnectionLost)
  })

  it('rejects a VERSION frame whose extension lengths overread the payload', async () => {
    const client = await fakeSsh(version([0, 0, 0, 250]))
    await expect(client.init()).rejects.toBeInstanceOf(SftpConnectionLost)
    const trailing = await fakeSsh(version([0, 0]))
    await expect(trailing.init()).rejects.toBeInstanceOf(SftpConnectionLost)
  })

  it('rejects a truncated STATUS and a truncated ATTRS instead of delivering out-of-bounds data', async () => {
    const client = await fakeSsh([...version(), ...status(1, [0, 0, 0, 2])])
    await client.init()
    await expect(client.realpath('/x')).rejects.toBeInstanceOf(SftpConnectionLost)
    const attrsReply = frame([105, ...be32(1), 0, 0, 0, 0x0f, 0, 0])
    const second = await fakeSsh([...version(), ...attrsReply])
    await second.init()
    await expect(second.lstat('/x')).rejects.toBeInstanceOf(SftpConnectionLost)
  })

  it('accepts well-formed NAME (104) and ATTRS (105) replies', async () => {
    // NAME: count=1, name "/real", empty longname, empty attrs — realpath's wire shape.
    const name = [...be32(1), ...be32(5), ...'/real'.split('').map(c => c.charCodeAt(0)), ...be32(0), ...be32(0)]
    const first = await fakeSsh([...version(), ...frame([104, ...be32(1), ...name])])
    await first.init()
    await expect(first.realpath('/x')).resolves.toBe('/real')
    // ATTRS: flags=0 — lstat's wire shape.
    const second = await fakeSsh([...version(), ...frame([105, ...be32(1), 0, 0, 0, 0])])
    await second.init()
    await expect(second.lstat('/x')).resolves.toEqual({ flags: 0 })
  })

  it('accepts a valid fragmented handshake and reply', async () => {
    const reply = [...version(), ...status(1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
    const client = await fakeSsh(reply, { chunks: 7 })
    const negotiated = await client.init()
    expect(negotiated.version).toBe(3)
    await expect(client.close(Buffer.from('handle'))).resolves.toBeUndefined()
  })

  it('settles waiting requests as lost on EOF', async () => {
    const client = await fakeSsh(version(), { exit: true })
    await client.init()
    await expect(client.realpath('/x')).rejects.toBeInstanceOf(SftpConnectionLost)
  })

  it('spawns ssh with ControlMaster disabled so sessions never share fate', async () => {
    const client = await fakeSsh(version())
    await client.init()
    const argv = readFileSync(join(dir, 'argv.log'), 'utf8')
    expect(argv).toContain('ControlMaster=no')
    expect(argv).toContain('ControlPath=none')
    expect(argv).toContain('BatchMode=yes')
  })
})
