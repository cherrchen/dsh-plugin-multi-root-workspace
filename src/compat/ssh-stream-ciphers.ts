/**
 * TLS-PSK compatibility for the SSH Helper's authenticated stream layer.
 *
 * `@deepseek-ai/dsh-ssh` pins `PSK-AES256-GCM-SHA384` for every forwarded
 * stream. Electron is linked against BoringSSL, which implements the earlier
 * PSK family (`ECDHE-PSK-CHACHA20-POLY1305`) but not the GCM suite: creating
 * the local TLS context fails with `ERR_SSL_NO_CIPHER_MATCH` before the
 * remote Helper sees a handshake. The Helper itself runs on plain
 * Node/OpenSSL, which implements both.
 *
 * The upstream constant cannot be edited out of tree, so this module makes
 * two structural adaptations:
 *
 * - before the Host evaluates `@deepseek-ai/dsh-ssh`,
 *   {@link installClientPskFallback} rewrites the one `tls.connect` call the
 *   upstream stream layer makes (exact option shape), and only on a runtime
 *   that cannot create the suite. Every other TLS connection is untouched;
 * - the generated remote Helper entry embeds {@link helperServerShimSource},
 *   which widens the Helper's TLS server list with the same fallback. A
 *   plain-Node Host keeps offering the upstream suite, so the
 *   OpenSSL-to-OpenSSL path still negotiates the original suite.
 *
 * The fallback is `TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256`: AEAD with
 * forward secrecy. The per-stream PSK remains mandatory and no certificate
 * suite is admitted; a runtime without this suite gets an explicit refusal
 * rather than a weaker CBC cipher.
 *
 * The server shim is a fixed JavaScript template, never
 * `Function.prototype.toString()`: the entry bytes are verified against a
 * Host-computed digest, so they must not depend on the bundler's output.
 * See ADR-0051.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/ssh-stream-ciphers
 */

import { createRequire, syncBuiltinESMExports } from 'node:module'

/** The exact suite `@deepseek-ai/dsh-ssh` requests; never edited upstream. */
export const UPSTREAM_PSK_CIPHER = 'PSK-AES256-GCM-SHA384'

/**
 * The only fallback: AEAD and forward secrecy, so the upstream security
 * properties survive the runtime substitution. CBC PSK suites are
 * deliberately not considered.
 */
export const PSK_FALLBACK_CIPHER = 'ECDHE-PSK-CHACHA20-POLY1305'

/** The fallback list in preference order (one entry today). */
export const PSK_FALLBACK_CIPHERS = [PSK_FALLBACK_CIPHER] as const

/** The cipher decision for one Host runtime. */
export type ClientPskPlan =
  | { readonly kind: 'native' }
  | { readonly kind: 'fallback'; readonly ciphers: string }
  | { readonly kind: 'unsupported'; readonly reported: readonly string[] }

/** The mutable slice of `node:tls` this module needs; injectable for tests. */
export interface PskTlsModule {
  connect: (...args: unknown[]) => unknown
  getCiphers(): readonly string[]
}

/** One installed client patch. */
export interface ClientPskInstall {
  readonly plan: ClientPskPlan
  /** Whether this call replaced `connect`; an already patched module reports false. */
  readonly installed: boolean
  /** Restore the original `connect`; production never calls this. */
  restore(): void
}

const patchedModules = new WeakSet<object>()

const requireHost = createRequire(import.meta.url)

function hostTls(): PskTlsModule {
  return requireHost('node:tls') as PskTlsModule
}

/**
 * Pick the client cipher list for the current runtime.
 *
 * A runtime that implements the upstream suite keeps it unchanged. A runtime
 * that does not gets the supported fallback list; an `unsupported` verdict
 * means neither the upstream suite nor the AEAD fallback exists, and SSH must
 * refuse before opening a stream.
 * @param getCiphers - the runtime's cipher report; injectable for tests.
 * @returns the client plan.
 */
export function clientPskPlan(getCiphers: () => readonly string[] = () => hostTls().getCiphers()): ClientPskPlan {
  const available = new Set(getCiphers().map(name => name.toLowerCase()))
  if (available.has(UPSTREAM_PSK_CIPHER.toLowerCase())) return { kind: 'native' }
  const supported = PSK_FALLBACK_CIPHERS.filter(name => available.has(name.toLowerCase()))
  if (supported.length > 0) return { kind: 'fallback', ciphers: supported.join(':') }
  const reported = [...available].filter(name => name.includes('psk')).map(name => name.toUpperCase())
  return { kind: 'unsupported', reported }
}

/**
 * Whether these options are exactly the upstream stream layer's
 * `tls.connect` call: the pinned suite, TLS 1.2 only, a connected socket,
 * PSK, and the upstream's certificate-free identity check. Matching the
 * whole shape keeps a caller's own cipher exclusions or unrelated TLS
 * options out of the rewrite.
 * @param options - the first argument of a `tls.connect` call.
 * @returns true only for the upstream forwarded-stream call.
 */
export function isUpstreamStreamConnectOptions(options: object): boolean {
  const candidate = options as Record<string, unknown>
  return candidate.ciphers === UPSTREAM_PSK_CIPHER
    && candidate.minVersion === 'TLSv1.2'
    && candidate.maxVersion === 'TLSv1.2'
    && candidate.rejectUnauthorized === true
    && typeof candidate.pskCallback === 'function'
    && typeof candidate.checkServerIdentity === 'function'
    && 'socket' in candidate
}

/**
 * Rewrite the upstream stream options only when they match that exact shape.
 * The object is returned unchanged (same identity) otherwise, so the
 * wrapper can forward it untouched.
 * @param options - the first argument of a `tls.connect` call.
 * @param plan - a `fallback` decision for this runtime.
 * @returns the original object or a copy with the fallback cipher list.
 */
export function rewritePskConnectOptions<T extends object>(
  options: T,
  plan: Extract<ClientPskPlan, { kind: 'fallback' }>,
): T {
  return isUpstreamStreamConnectOptions(options) ? { ...options, ciphers: plan.ciphers } : options
}

/**
 * Install the client-side cipher fallback before `@deepseek-ai/dsh-ssh` is
 * evaluated.
 *
 * Named ESM imports of a core module are bound when the module is linked
 * (`import { connect } from 'node:tls'`), so the replacement is followed by
 * `syncBuiltinESMExports()`; this also updates imports that were linked
 * earlier in the process.
 * @param options - dependency injection for tests; production passes nothing.
 * @returns the plan and whether this call installed the patch.
 */
export function installClientPskFallback(options: {
  readonly tls?: PskTlsModule
  readonly sync?: () => void
} = {}): ClientPskInstall {
  const tls = options.tls ?? hostTls()
  const plan = clientPskPlan(() => tls.getCiphers())
  if (plan.kind !== 'fallback') return { plan, installed: false, restore: () => {} }
  if (patchedModules.has(tls)) return { plan, installed: false, restore: () => {} }
  const original = tls.connect
  const sync = options.sync ?? (options.tls === undefined ? syncBuiltinESMExports : () => {})
  tls.connect = function patchedPskConnect(this: unknown, ...args: unknown[]): unknown {
    const first = args[0]
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const rewritten = rewritePskConnectOptions(first, plan)
      if (rewritten !== first) args[0] = rewritten
    }
    return original.apply(this, args)
  }
  patchedModules.add(tls)
  sync()
  return {
    plan,
    installed: true,
    restore: () => {
      if (!patchedModules.has(tls)) return
      tls.connect = original
      patchedModules.delete(tls)
      sync()
    },
  }
}

/**
 * The Helper-side cipher widening, as fixed JavaScript source.
 *
 * Embedded verbatim into the generated remote entry: the entry's digest is
 * verified against Host-computed bytes, so it must not vary with the
 * bundler or with a function's `toString()` output. The upstream server list
 * stays first, preserving the original suite for plain-Node Hosts; the
 * fallback is appended only when the remote Node reports it.
 */
export const SERVER_PSK_FUNCTION_SOURCE = `function serverPskCiphers(ciphers, getCiphers) {
  const upstream = ${JSON.stringify(UPSTREAM_PSK_CIPHER)}
  const fallback = ${JSON.stringify(PSK_FALLBACK_CIPHER)}
  if (ciphers !== upstream) return ciphers
  const available = new Set(getCiphers().map((name) => name.toLowerCase()))
  return available.has(fallback.toLowerCase()) ? upstream + ":" + fallback : ciphers
}`

/**
 * The executable preamble for the generated Helper entry: widen
 * `tls.createServer` cipher lists, then re-sync the core-module ESM bindings
 * so the Helper's own `import { createServer } from "node:tls"` resolves to
 * the wrapper. The entry evaluates this before importing the upstream Helper.
 * @returns JavaScript source for the remote entry.
 */
export function helperServerShimSource(): string {
  return `const { syncBuiltinESMExports: syncTlsExports } = require("node:module")
const tls = require("node:tls")
${SERVER_PSK_FUNCTION_SOURCE}
const createTlsServer = tls.createServer
tls.createServer = function (...args) {
  const options = args[0]
  if (options !== null && typeof options === "object" && typeof options.ciphers === "string") {
    const widened = serverPskCiphers(options.ciphers, () => tls.getCiphers())
    if (widened !== options.ciphers) args[0] = { ...options, ciphers: widened }
  }
  return createTlsServer.apply(this, args)
}
syncTlsExports()`
}
