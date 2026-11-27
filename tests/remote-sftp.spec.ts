/** F19: the SFTP frame parser refuses malformed wire data before it reaches a resolve callback. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SftpClient, SftpConnectionLost, SftpInvalidContent, P_CREAT, P_EXCL, P_WRITE } from '../src/remote/sftp.ts'

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
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ForwardAgent=no')
    expect(argv).toContain('UpdateHostKeys=no')
    const config = join(dir, 'ssh_config')
    writeFileSync(config, 'Host fake-alias\n  StrictHostKeyChecking no\n  ForwardAgent yes\n  UpdateHostKeys yes\n')
    const effective = execFileSync('ssh', ['-G', '-F', config, ...argv.trim().split('\n')], { encoding: 'utf8' })
    expect(effective).toMatch(/^stricthostkeychecking true$/m)
    expect(effective).toMatch(/^forwardagent no$/m)
    expect(effective).toMatch(/^updatehostkeys false$/m)
  })
})

const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(path => existsSync(path))
it.skipIf(process.platform === 'win32' || sftpServer === undefined)('creates private staging files on a real OpenSSH server', async () => {
  const wrapper = join(dir, 'real-sftp.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${sftpServer}" -u 022\n`, { mode: 0o700 })
  const client = SftpClient.connect('unused', { ssh: wrapper })
  clients.push(client)
  await client.init()
  for (const permissions of [0o600, 0o640, undefined]) {
    const path = join(dir, `created-${permissions}`)
    const handle = await client.open(path, P_CREAT | P_EXCL | P_WRITE, permissions)
    await client.close(handle)
    expect(statSync(path).mode & 0o777).toBe(permissions ?? 0o644)
  }
})

/** P3: `readdirBounded` — strict reply types, name validation, and the three budgets. */
describe.skipIf(process.platform === 'win32')('SFTP bounded readdir', () => {
  const utf8 = (text: string) => [...Buffer.from(text, 'utf8')]
  const handle = (id: number, bytes: number[] = [1]) => frame([102, ...be32(id), ...be32(bytes.length), ...bytes])
  const statusCode = (id: number, code: number) => frame([101, ...be32(id), ...be32(code), ...be32(0), ...be32(0)])
  const attrs = (perms: number) => [...be32(4), ...be32(perms)]
  const entry = (name: string, perms: number, longname = '') =>
    [...be32(name.length), ...utf8(name), ...be32(longname.length), ...utf8(longname), ...attrs(perms)]
  const nameReply = (id: number, entries: number[][]) => frame([104, ...be32(id), ...be32(entries.length), ...entries.flat()])
  const signal = () => new AbortController().signal

  /** A fake `ssh` answering each complete request with the next queued reply frame. */
  async function scriptedSsh(replies: number[][]) {
    const script = join(dir, 'emit.mjs')
    writeFileSync(script, `
      const replies = ${JSON.stringify(replies.map(r => Buffer.from(r).toString('base64')))}
      let input = Buffer.alloc(0); let next = 0
      process.stdin.on('data', chunk => {
        input = Buffer.concat([input, chunk])
        while (input.length >= 4 && input.length >= input.readUInt32BE(0) + 4) {
          input = input.subarray(input.readUInt32BE(0) + 4)
          if (next < replies.length) process.stdout.write(Buffer.from(replies[next++], 'base64'))
        }
      })
    `)
    const wrapper = join(dir, 'fake-ssh.sh')
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    const client = SftpClient.connect('fake-alias', { ssh: wrapper })
    clients.push(client)
    return client
  }
  const listing = (names: number[][]) => scriptedSsh([version(), handle(1), nameReply(2, names), statusCode(3, 1), statusCode(4, 0)])

  it('lists entries with mode-derived types and skips . and ..', async () => {
    const client = await listing([
      entry('.', 0o040755), entry('..', 0o040755),
      entry('dir', 0o040755), entry('file.txt', 0o100644), entry('link', 0o120777), entry('fifo', 0o010644),
    ])
    await client.init()
    const result = await client.readdirBounded('/root', signal())
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { name: 'dir', type: 'directory' }, { name: 'file.txt', type: 'file' },
      { name: 'link', type: 'symlink' }, { name: 'fifo', type: 'other' },
    ])
  })

  it('keeps literal backslashes and JSON-escapable names verbatim', async () => {
    const client = await listing([entry('a\\b', 0o100644), entry('q"q', 0o100644), entry('with space', 0o040755)])
    await client.init()
    const result = await client.readdirBounded('/root', signal())
    expect(result.entries.map(e => e.name)).toEqual(['a\\b', 'q"q', 'with space'])
  })

  it('rejects a slash-carrying name, an empty NAME frame, and wrong reply types', async () => {
    for (const reply of [
      nameReply(2, [entry('a/b', 0o100644)]),
      nameReply(2, []),
      statusCode(2, 0),
      frame([105, ...be32(2), ...attrs(0o100644)]),
    ]) {
      const client = await scriptedSsh([version(), handle(1), reply, statusCode(3, 0)])
      await client.init()
      await expect(client.readdirBounded('/root', signal())).rejects.toMatchObject({ name: 'SftpStatusError', message: 'invalid-listing' })
    }
  })

  it('rejects duplicate names and undecodable names as invalid-listing', async () => {
    const dup = await scriptedSsh([version(), handle(1), nameReply(2, [entry('x', 0o100644), entry('x', 0o100644)]), statusCode(3, 0)])
    await dup.init()
    await expect(dup.readdirBounded('/root', signal())).rejects.toMatchObject({ message: 'invalid-listing' })
    const badUtf8 = [...be32(1), 0xff, ...be32(0), ...attrs(0o100644)]
    const client = await scriptedSsh([version(), handle(1), nameReply(2, [badUtf8]), statusCode(3, 0)])
    await client.init()
    await expect(client.readdirBounded('/root', signal())).rejects.toMatchObject({ message: 'invalid-listing' })
  })

  it('marks a listing truncated when the incoming wire budget is exceeded', async () => {
    // Three ~260KB NAME frames: the third pushes cumulative wire bytes over 512KiB.
    const big = 'x'.repeat(260_000)
    const client = await scriptedSsh([
      version(), handle(1),
      nameReply(2, [entry('a', 0o100644, big)]),
      nameReply(3, [entry('b', 0o100644, big)]),
      nameReply(4, [entry('c', 0o100644, big)]),
      statusCode(5, 0),
    ])
    await client.init()
    const result = await client.readdirBounded('/root', signal())
    expect(result.truncated).toBe(true)
    expect(result.entries.length).toBeLessThanOrEqual(2)
  })

  it('enforces strict reply types on realpath and lstat', async () => {
    const client = await scriptedSsh([version(), frame([105, ...be32(1), ...attrs(0o100644)])])
    await client.init()
    await expect(client.realpath('/root')).rejects.toMatchObject({ name: 'SftpStatusError' })
    const second = await scriptedSsh([version(), nameReply(1, [entry('/root', 0o040755)])])
    await second.init()
    await expect(second.lstat('/root')).rejects.toMatchObject({ name: 'SftpStatusError' })
  })
})

/** P3: the preview read port — strict reply types, malformed handles, EOF shape. */
describe.skipIf(process.platform === 'win32')('SFTP preview read port', () => {
  const handle = (id: number, bytes: number[] = [1]) => frame([102, ...be32(id), ...be32(bytes.length), ...bytes])
  const data = (id: number, bytes: number[]) => frame([103, ...be32(id), ...be32(bytes.length), ...bytes])
  const statusCode = (id: number, code: number) => frame([101, ...be32(id), ...be32(code), ...be32(0), ...be32(0)])

  /** A fake `ssh` answering each complete request; request bodies are dumped to req-N.bin. */
  async function scriptedSsh(replies: number[][]) {
    const script = join(dir, 'emit.mjs')
    writeFileSync(script, `
      import { writeFileSync } from 'node:fs'
      const replies = ${JSON.stringify(replies.map(r => Buffer.from(r).toString('base64')))}
      let input = Buffer.alloc(0); let next = 0
      process.stdin.on('data', chunk => {
        input = Buffer.concat([input, chunk])
        while (input.length >= 4 && input.length >= input.readUInt32BE(0) + 4) {
          const request = input.subarray(0, input.readUInt32BE(0) + 4)
          input = input.subarray(request.length)
          writeFileSync(${JSON.stringify(dir)} + '/req-' + next + '.bin', request)
          if (next < replies.length) process.stdout.write(Buffer.from(replies[next++], 'base64'))
        }
      })
    `)
    const wrapper = join(dir, 'fake-ssh.sh')
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    const client = SftpClient.connect('fake-alias', { ssh: wrapper })
    clients.push(client)
    return client
  }

  it('opens read-only: the wire request carries OPEN opcode 3, P_READ and empty attrs', async () => {
    const client = await scriptedSsh([version(), handle(1, [9, 9, 9]), statusCode(2, 0)])
    await client.init()
    const got = await client.openPreview('/srv/root/a.txt')
    expect(got).toEqual(Buffer.from([9, 9, 9]))
    await client.closePreview(got)
    // req-0 is the INIT handshake; req-1 is the OPEN.
    const request = readFileSync(join(dir, 'req-1.bin'))
    // [len][type=3][id][path-string][pflags=1][attrs=0]
    expect(request.readUInt8(4)).toBe(3)
    const pathLength = request.readUInt32BE(9)
    const tail = request.subarray(13 + pathLength)
    expect(tail.readUInt32BE(0)).toBe(1) // P_READ only
    expect(tail.readUInt32BE(4)).toBe(0) // no attrs
  })

  it('rejects a wrong OPEN reply type, an oversized handle and a truncated handle', async () => {
    for (const reply of [
      data(1, [1]),                                                  // DATA instead of HANDLE
      frame([102, ...be32(1), ...be32(300), ...new Array(300).fill(0)]), // handle > 256
      frame([102, ...be32(1), ...be32(0)]),                          // zero-length handle
    ]) {
      const client = await scriptedSsh([version(), reply])
      await client.init()
      await expect(client.openPreview('/x')).rejects.toBeInstanceOf(SftpInvalidContent)
    }
  })

  it('rejects a wrong FSTAT type and a STATUS OK on READ; EOF is undefined', async () => {
    const client = await scriptedSsh([
      version(), handle(1),
      data(2, [1]),        // FSTAT answered with DATA
    ])
    await client.init()
    const h = await client.openPreview('/x')
    await expect(client.fstatPreview(h)).rejects.toBeInstanceOf(SftpInvalidContent)

    const second = await scriptedSsh([version(), handle(1), statusCode(2, 0)])
    await second.init()
    const h2 = await second.openPreview('/x')
    await expect(second.readPreview(h2, 0, 10)).rejects.toBeInstanceOf(SftpInvalidContent)

    const third = await scriptedSsh([version(), handle(1), statusCode(2, 1)])
    await third.init()
    const h3 = await third.openPreview('/x')
    await expect(third.readPreview(h3, 0, 10)).resolves.toBeUndefined()
  })

  it('accepts a short DATA and rejects an over-length or empty DATA', async () => {
    const client = await scriptedSsh([version(), handle(1), data(2, [65, 66])])
    await client.init()
    const h = await client.openPreview('/x')
    await expect(client.readPreview(h, 0, 10)).resolves.toEqual(Buffer.from([65, 66]))

    const over = await scriptedSsh([version(), handle(1), data(2, [1, 2, 3, 4, 5])])
    await over.init()
    const oh = await over.openPreview('/x')
    await expect(over.readPreview(oh, 0, 3)).rejects.toBeInstanceOf(SftpInvalidContent)

    const empty = await scriptedSsh([version(), handle(1), data(2, [])])
    await empty.init()
    const eh = await empty.openPreview('/x')
    await expect(empty.readPreview(eh, 0, 3)).rejects.toBeInstanceOf(SftpInvalidContent)
  })

  it('rejects out-of-contract read offsets and a wrong CLOSE reply', async () => {
    const client = await scriptedSsh([version(), handle(1)])
    await client.init()
    const h = await client.openPreview('/x')
    for (const [offset, length] of [[-1, 1], [0, 0], [0, 200_000], [3 * 1024 * 1024, 1]] as const) {
      await expect(client.readPreview(h, offset, length)).rejects.toBeInstanceOf(SftpInvalidContent)
    }
    const closer = await scriptedSsh([version(), handle(1), data(2, [1])])
    await closer.init()
    const ch = await closer.openPreview('/x')
    await expect(closer.closePreview(ch)).rejects.toBeInstanceOf(SftpInvalidContent)
  })
})
