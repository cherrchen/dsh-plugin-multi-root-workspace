/**
 * The PSK cipher fallback for BoringSSL Hosts. Electron cannot create the
 * GCM-PSK suite upstream pins; these tests pin the exact-shape client
 * rewrite, the Helper-side widening, the fixed entry template, and a real
 * fallback handshake.
 */
import { createHash } from 'node:crypto'
import { createServer, connect, type TLSSocket } from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  clientPskPlan,
  helperServerShimSource,
  installClientPskFallback,
  PSK_FALLBACK_CIPHER,
  PSK_FALLBACK_CIPHERS,
  rewritePskConnectOptions,
  SERVER_PSK_FUNCTION_SOURCE,
  UPSTREAM_PSK_CIPHER,
  type PskTlsModule,
} from '../src/compat/ssh-stream-ciphers.ts'
import { renderHelperEntry, renderLegacyHelperEntry } from '../src/remote/personal/operations.ts'

const BORINGSSL_PSK = ['ecdhe-psk-chacha20-poly1305', 'psk-aes256-cbc-sha', 'psk-aes128-cbc-sha']
const OPENSSL_PSK = [...BORINGSSL_PSK, 'psk-aes256-gcm-sha384', 'dhe-psk-aes256-gcm-sha384']

const key = Buffer.alloc(32, 0xab)

/** Exactly the upstream stream layer's `tls.connect` options. */
const upstreamOptions = (over: Record<string, unknown> = {}) => ({
  ciphers: UPSTREAM_PSK_CIPHER,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  rejectUnauthorized: true,
  pskCallback: () => ({ psk: key, identity: 'dsh-stream' }),
  checkServerIdentity: () => undefined,
  socket: {},
  ...over,
})

/** Evaluate the fixed server function source the entry embeds. */
const serverPskCiphers = new Function(
  `${SERVER_PSK_FUNCTION_SOURCE}; return serverPskCiphers`,
)() as (ciphers: string, getCiphers: () => readonly string[]) => string

describe('clientPskPlan', () => {
  it('leaves a runtime that implements the upstream suite untouched', () => {
    expect(clientPskPlan(() => OPENSSL_PSK)).toEqual({ kind: 'native' })
  })

  it('selects the AEAD ChaCha20-PSK suite when the upstream suite is missing', () => {
    expect(clientPskPlan(() => BORINGSSL_PSK)).toEqual({ kind: 'fallback', ciphers: PSK_FALLBACK_CIPHER })
  })

  it('refuses rather than falling back to a CBC-only PSK runtime', () => {
    expect(clientPskPlan(() => ['psk-aes256-cbc-sha', 'psk-aes128-cbc-sha']))
      .toEqual({ kind: 'unsupported', reported: ['PSK-AES256-CBC-SHA', 'PSK-AES128-CBC-SHA'] })
  })
})

describe('rewritePskConnectOptions', () => {
  const plan = { kind: 'fallback' as const, ciphers: PSK_FALLBACK_CIPHERS.join(':') }

  it('rewrites exactly the upstream forwarded-stream options', () => {
    const options = upstreamOptions()
    expect(rewritePskConnectOptions(options, plan)).toEqual({ ...options, ciphers: PSK_FALLBACK_CIPHER })
    expect(options.ciphers).toBe(UPSTREAM_PSK_CIPHER)
  })

  it('leaves a caller own cipher exclusions and every other shape unchanged', () => {
    const excluded = upstreamOptions({ ciphers: `${UPSTREAM_PSK_CIPHER}:!PSK-AES256-CBC-SHA` })
    const { socket: _socket, ...noSocket } = upstreamOptions()
    const noPsk = upstreamOptions({ pskCallback: undefined })
    const extraCipher = upstreamOptions({ ciphers: `${UPSTREAM_PSK_CIPHER}:PSK-AES128-CBC-SHA` })
    expect(rewritePskConnectOptions(excluded, plan)).toBe(excluded)
    expect(rewritePskConnectOptions(noSocket, plan)).toBe(noSocket)
    expect(rewritePskConnectOptions(noPsk, plan)).toBe(noPsk)
    expect(rewritePskConnectOptions(extraCipher, plan)).toBe(extraCipher)
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
    expect(installed.plan).toEqual({ kind: 'fallback', ciphers: PSK_FALLBACK_CIPHER })
    expect(installed.installed).toBe(true)
    expect(syncs).toBe(1)

    expect(tls.connect(upstreamOptions())).toBe('socket')
    expect(seen[0]![0]).toMatchObject({ ciphers: PSK_FALLBACK_CIPHER })
    const excluded = upstreamOptions({ ciphers: `${UPSTREAM_PSK_CIPHER}:!PSK-AES256-CBC-SHA` })
    tls.connect(excluded)
    expect(seen[1]![0]).toBe(excluded)
    tls.connect(443, 'example.test', upstreamOptions())
    expect(seen[2]![0]).toBe(443)

    expect(installClientPskFallback({ tls, sync: () => { syncs += 1 } }).installed).toBe(false)
    expect(syncs).toBe(1)

    installed.restore()
    tls.connect(upstreamOptions())
    expect(seen[3]![0]).toMatchObject({ ciphers: UPSTREAM_PSK_CIPHER })
  })

  it('does not patch a native or unsupported runtime', () => {
    const native: PskTlsModule = { getCiphers: () => OPENSSL_PSK, connect: () => 'native' }
    const unsupported: PskTlsModule = { getCiphers: () => ['psk-aes256-cbc-sha'], connect: () => 'none' }
    expect(installClientPskFallback({ tls: native })).toMatchObject({ installed: false, plan: { kind: 'native' } })
    expect(installClientPskFallback({ tls: unsupported })).toMatchObject({ installed: false, plan: { kind: 'unsupported' } })
    expect(native.connect(upstreamOptions())).toBe('native')
    expect(unsupported.connect(upstreamOptions())).toBe('none')
  })
})

describe('serverPskCiphers source', () => {
  it('appends the AEAD fallback only when the remote Node reports it', () => {
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => OPENSSL_PSK)).toBe(`${UPSTREAM_PSK_CIPHER}:${PSK_FALLBACK_CIPHER}`)
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => ['PSK-AES256-GCM-SHA384'])).toBe(UPSTREAM_PSK_CIPHER)
    expect(serverPskCiphers(UPSTREAM_PSK_CIPHER, () => ['PSK-AES256-CBC-SHA'])).toBe(UPSTREAM_PSK_CIPHER)
  })

  it('leaves a caller custom or exclusion list alone', () => {
    const excluded = `${UPSTREAM_PSK_CIPHER}:!${PSK_FALLBACK_CIPHER}`
    expect(serverPskCiphers(excluded, () => OPENSSL_PSK)).toBe(excluded)
    expect(serverPskCiphers('ECDHE-RSA-AES256-GCM-SHA384', () => OPENSSL_PSK)).toBe('ECDHE-RSA-AES256-GCM-SHA384')
  })
})

describe('generated Helper entry', () => {
  it('renders the fixed shim into a separate additive entry', () => {
    const legacy = renderLegacyHelperEntry('a'.repeat(64))
    const current = renderHelperEntry('a'.repeat(64))
    expect(legacy).not.toContain(PSK_FALLBACK_CIPHER)
    expect(current).toContain(SERVER_PSK_FUNCTION_SOURCE)
    expect(current).toContain(helperServerShimSource())
    expect(current).toContain('syncTlsExports()')
    expect(current.indexOf('syncTlsExports()')).toBeLessThan(current.indexOf('await import("./node_modules/@deepseek-ai/dsh-ssh/lib/helper.js")'))
  })

  it('renders byte-stable entry text from the fixed templates', () => {
    // A release build must render the same bytes as the source tests: both
    // entries are fixed templates, never a function's runtime text. The
    // legacy digest must match the entry released in v0.1.24-beta.2 so a
    // rollback Host can still verify and launch the recorded file.
    expect(createHash('sha256').update(renderLegacyHelperEntry('a'.repeat(64))).digest('hex'))
      .toBe('2469c9986b798f1517466320cbfc70e0998298093b6beae9ece27045c033d7a8')
    expect(createHash('sha256').update(renderHelperEntry('a'.repeat(64))).digest('hex'))
      .toBe('20ee26802331476d65cf66b4dd8749209ceca62ac6f52fd5c6238f6f208b3931')
  })
})

describe('fallback handshake', () => {
  it('negotiates ECDHE-PSK-CHACHA20-POLY1305 with a client limited to that suite', { timeout: 10_000 }, async () => {
    const serverCiphers = serverPskCiphers(UPSTREAM_PSK_CIPHER, () => OPENSSL_PSK)
    const client = clientPskPlan(() => [PSK_FALLBACK_CIPHER])
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
        host: '127.0.0.1', port, ciphers: client.kind === 'fallback' ? client.ciphers : '', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        rejectUnauthorized: true, checkServerIdentity: () => undefined,
        pskCallback: () => ({ psk: key, identity: 'dsh-stream' }),
      })
      await new Promise<void>((resolve, reject) => {
        socket!.once('secureConnect', resolve)
        socket!.once('error', reject)
      })
      expect(socket.getCipher().name).toBe(PSK_FALLBACK_CIPHER)
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
