/**
 * The PSK cipher fallback for BoringSSL Hosts. Electron cannot create the
 * GCM-PSK suite upstream pins; these tests pin the client rewrite, the
 * Helper-side widening, and a real fallback handshake.
 */
import { createServer, connect, type TLSSocket } from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  clientPskPlan,
  helperServerShimSource,
  installClientPskFallback,
  PSK_FALLBACK_CIPHERS,
  rewritePskConnectOptions,
  serverPskCiphers,
  UPSTREAM_PSK_CIPHER,
  type PskTlsModule,
} from '../src/compat/ssh-stream-ciphers.ts'
import { renderHelperEntry } from '../src/remote/personal/operations.ts'

const BORINGSSL_PSK = ['ecdhe-psk-chacha20-poly1305', 'psk-aes256-cbc-sha', 'psk-aes128-cbc-sha']
const OPENSSL_PSK = [...BORINGSSL_PSK, 'psk-aes256-gcm-sha384', 'dhe-psk-aes256-gcm-sha384']

const key = Buffer.alloc(32, 0xab)

describe('clientPskPlan', () => {
  it('leaves a runtime that implements the upstream suite untouched', () => {
    expect(clientPskPlan(() => OPENSSL_PSK)).toEqual({ kind: 'native' })
  })

  it('selects the strongest suite the runtime implements', () => {
    expect(clientPskPlan(() => BORINGSSL_PSK)).toEqual({
      kind: 'fallback', ciphers: 'ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-CBC-SHA',
    })
    expect(clientPskPlan(() => ['PSK-AES256-CBC-SHA'])).toEqual({ kind: 'fallback', ciphers: 'PSK-AES256-CBC-SHA' })
  })

  it('reports the PSK suites it saw when neither the upstream nor a fallback exists', () => {
    expect(clientPskPlan(() => ['TLS_AES_256_GCM_SHA384', 'psk-aes128-cbc-sha']))
      .toEqual({ kind: 'unsupported', reported: ['PSK-AES128-CBC-SHA'] })
  })
})

describe('rewritePskConnectOptions', () => {
  const plan = { kind: 'fallback' as const, ciphers: PSK_FALLBACK_CIPHERS.join(':') }

  it('rewrites only a cipher list that names the upstream suite', () => {
    const options = { ciphers: `PSK-AES256-GCM-SHA384:PSK-AES128-CBC-SHA`, socket: {} }
    expect(rewritePskConnectOptions(options, plan)).toEqual({ ciphers: plan.ciphers, socket: {} })
    expect(options.ciphers).toBe('PSK-AES256-GCM-SHA384:PSK-AES128-CBC-SHA')
  })

  it('returns every other options object unchanged by identity', () => {
    const nonPsk = { ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' }
    const noCiphers = { host: 'example.test' }
    const arrayCiphers = { ciphers: [UPSTREAM_PSK_CIPHER] }
    expect(rewritePskConnectOptions(nonPsk, plan)).toBe(nonPsk)
    expect(rewritePskConnectOptions(noCiphers, plan)).toBe(noCiphers)
    expect(rewritePskConnectOptions(arrayCiphers, plan)).toBe(arrayCiphers)
  })
})

describe('installClientPskFallback', () => {
  it('patches a BoringSSL-like connect and forwards unrelated calls untouched', () => {
    const seen: unknown[][] = []
    let syncs = 0
    const tls: PskTlsModule = {
      getCiphers: () => BORINGSSL_PSK,
      connect: (...args: unknown[]) => { seen.push(args); return 'socket' },
    }
    const installed = installClientPskFallback({ tls, sync: () => { syncs += 1 } })
    expect(installed.plan).toEqual({ kind: 'fallback', ciphers: 'ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-CBC-SHA' })
    expect(installed.installed).toBe(true)
    expect(syncs).toBe(1)

    expect(tls.connect({ ciphers: UPSTREAM_PSK_CIPHER, pskCallback: () => undefined })).toBe('socket')
    expect(seen[0]![0]).toMatchObject({ ciphers: 'ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-CBC-SHA' })
    tls.connect({ ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' })
    expect(seen[1]![0]).toMatchObject({ ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' })
    tls.connect(443, 'example.test', { ciphers: UPSTREAM_PSK_CIPHER })
    expect(seen[2]![0]).toBe(443)

    expect(installClientPskFallback({ tls, sync: () => { syncs += 1 } }).installed).toBe(false)
    expect(syncs).toBe(1)

    installed.restore()
    tls.connect({ ciphers: UPSTREAM_PSK_CIPHER })
    expect(seen[3]![0]).toMatchObject({ ciphers: UPSTREAM_PSK_CIPHER })
  })

  it('does not patch a native or unsupported runtime', () => {
    const native: PskTlsModule = { getCiphers: () => OPENSSL_PSK, connect: () => 'native' }
    const unsupported: PskTlsModule = { getCiphers: () => ['TLS_AES_256_GCM_SHA384'], connect: () => 'none' }
    expect(installClientPskFallback({ tls: native })).toMatchObject({ installed: false, plan: { kind: 'native' } })
    expect(installClientPskFallback({ tls: unsupported })).toMatchObject({ installed: false, plan: { kind: 'unsupported' } })
    expect(native.connect({ ciphers: UPSTREAM_PSK_CIPHER })).toBe('native')
    expect(unsupported.connect({ ciphers: UPSTREAM_PSK_CIPHER })).toBe('none')
  })
})

describe('serverPskCiphers', () => {
  it('appends every fallback the remote Node reports, keeping the upstream suite first', () => {
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => OPENSSL_PSK))
      .toBe(`${UPSTREAM_PSK_CIPHER}:${PSK_FALLBACK_CIPHERS.join(':')}`)
  })

  it('leaves the list unchanged when the remote lacks a fallback or the list is not the upstream one', () => {
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => ['PSK-AES256-GCM-SHA384'])).toBe(UPSTREAM_PSK_CIPHER)
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => ['PSK-AES256-CBC-SHA']))
      .toBe(`${UPSTREAM_PSK_CIPHER}:PSK-AES256-CBC-SHA`)
    expect(serverPskCiphers('ECDHE-RSA-AES256-GCM-SHA384', () => OPENSSL_PSK)).toBe('ECDHE-RSA-AES256-GCM-SHA384')
    expect(serverPskCiphers(`${UPSTREAM_PSK_CIPHER}:PSK-AES256-CBC-SHA`, () => OPENSSL_PSK))
      .toBe(`${UPSTREAM_PSK_CIPHER}:PSK-AES256-CBC-SHA:ECDHE-PSK-CHACHA20-POLY1305`)
  })
})

describe('generated Helper entry', () => {
  it('embeds the server shim before loading the upstream Helper', () => {
    const entry = renderHelperEntry('a'.repeat(64))
    expect(entry).toContain(helperServerShimSource())
    expect(entry).toContain(PSK_FALLBACK_CIPHERS[0])
    expect(entry).toContain('syncTlsExports()')
    expect(entry.indexOf('syncTlsExports()')).toBeLessThan(entry.indexOf('await import("./node_modules/@deepseek-ai/dsh-ssh/lib/helper.js")'))
  })
})

describe('fallback handshake', () => {
  it('negotiates ECDHE-PSK-CHACHA20-POLY1305 with a client limited to the BoringSSL suite', { timeout: 10_000 }, async () => {
    const serverCiphers = serverPskCiphers(UPSTREAM_PSK_CIPHER, () => OPENSSL_PSK)
    const client = clientPskPlan(() => ['ECDHE-PSK-CHACHA20-POLY1305'])
    expect(client.kind).toBe('fallback')
    const server = createServer({
      ciphers: serverCiphers, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      pskCallback: (_socket, identity) => identity === 'dsh-stream' ? key : null,
    }, socket => {
      socket.once('data', data => { socket.end(Buffer.concat([Buffer.from('echo:'), data])) })
      socket.on('error', () => {})
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') reject(new Error('no TCP port'))
        else resolve(address.port)
      })
    })
    let socket: TLSSocket | undefined
    try {
      socket = connect({
        host: '127.0.0.1', port, ciphers: client.ciphers, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        rejectUnauthorized: true, checkServerIdentity: () => undefined,
        pskCallback: () => ({ psk: key, identity: 'dsh-stream' }),
      })
      await new Promise<void>((resolve, reject) => {
        socket!.once('secureConnect', resolve)
        socket!.once('error', reject)
      })
      expect(socket.getCipher().name).toBe('ECDHE-PSK-CHACHA20-POLY1305')
      socket.write('ping')
      const reply = await new Promise<string>((resolve, reject) => {
        socket!.once('data', data => resolve(data.toString()))
        socket!.once('error', reject)
      })
      expect(reply).toBe('echo:ping')
    } finally {
      socket?.destroy()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
})
