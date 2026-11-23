/**
 * TLS-PSK compatibility for the SSH Helper's authenticated stream layer.
 *
 * `@deepseek-ai/dsh-ssh` pins `PSK-AES256-GCM-SHA384` for every forwarded
 * stream. Electron is linked against BoringSSL, which implements the earlier
 * PSK family (`ECDHE-PSK-CHACHA20-POLY1305`, `PSK-AES256-CBC-SHA`) but not
 * the GCM suite: creating the local TLS context fails with
 * `ERR_SSL_NO_CIPHER_MATCH` before the remote Helper sees a handshake. The
 * Helper itself runs on plain Node/OpenSSL, which implements both.
 *
 * The upstream constant cannot be edited out of tree, so this module makes
 * two structural adaptations:
 *
 * - before the Host evaluates `@deepseek-ai/dsh-ssh`,
 *   {@link installClientPskFallback} rewrites only `tls.connect` calls whose
 *   cipher list names the upstream suite, and only on a runtime that cannot
 *   create it. Every other TLS connection is untouched;
 * - the generated remote Helper entry embeds {@link helperServerShimSource},
 *   which widens the Helper's TLS server list with the same fallbacks. A
 *   plain-Node Host keeps offering the upstream suite first, so the
 *   OpenSSL-to-OpenSSL path still negotiates the original suite.
 *
 * `TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256` is AEAD with forward secrecy
 * and the per-stream PSK remains mandatory: the fallback changes neither the
 * authentication story nor admits a certificate suite. See ADR-0051.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/ssh-stream-ciphers
 */

import { createRequire, syncBuiltinESMExports } from 'node:module'

/** The exact suite `@deepseek-ai/dsh-ssh` requests; never edited upstream. */
export const UPSTREAM_PSK_CIPHER = 'PSK-AES256-GCM-SHA384'

/**
 * PSK suites BoringSSL implements, strongest first.
 * `ECDHE-PSK-CHACHA20-POLY1305` is AEAD and gives forward secrecy;
 * `PSK-AES256-CBC-SHA` is the last resort for a runtime that omits ChaCha.
 */
export const PSK_FALLBACK_CIPHERS = ['ECDHE-PSK-CHACHA20-POLY1305', 'PSK-AES256-CBC-SHA'] as const

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
 * that does not gets the first supported fallback list; an `unsupported`
 * verdict means neither the upstream suite nor a fallback exists, and SSH must
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
 * Rewrite a `tls.connect` options object only when it names the upstream
 * suite. The object is returned unchanged (same identity) otherwise, so the
 * wrapper can forward it untouched.
 * @param options - the first argument of a `tls.connect` call.
 * @param plan - a `fallback` decision for this runtime.
 * @returns the original object or a copy with the fallback cipher list.
 */
export function rewritePskConnectOptions<T extends object>(
  options: T,
  plan: Extract<ClientPskPlan, { kind: 'fallback' }>,
): T {
  const ciphers = (options as { ciphers?: unknown }).ciphers
  if (typeof ciphers !== 'string') return options
  const requested = ciphers.split(':').map(name => name.trim().toUpperCase())
  if (!requested.includes(UPSTREAM_PSK_CIPHER)) return options
  return { ...options, ciphers: plan.ciphers }
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
 * The Helper-side cipher widening.
 *
 * Self-contained on purpose: {@link helperServerShimSource} embeds its source
 * text into the generated remote entry, so it must not reference module
 * scope. The upstream server list stays first, preserving the original suite
 * for plain-Node Hosts; fallbacks are appended only when the remote Node
 * reports them.
 * @param ciphers - the server's configured cipher list.
 * @param getCiphers - the remote Node's cipher report.
 * @returns the original list or one widened with supported fallbacks.
 */
export function serverPskCiphers(ciphers: string, getCiphers: () => readonly string[]): string {
  const upstream = 'PSK-AES256-GCM-SHA384'
  const fallbacks = ['ECDHE-PSK-CHACHA20-POLY1305', 'PSK-AES256-CBC-SHA']
  const requested = ciphers.split(':').map(name => name.trim().toUpperCase())
  if (!requested.includes(upstream)) return ciphers
  const available = new Set(getCiphers().map(name => name.toLowerCase()))
  const added = fallbacks.filter(name => available.has(name.toLowerCase()) && !requested.includes(name.toUpperCase()))
  return added.length === 0 ? ciphers : `${ciphers}:${added.join(':')}`
}

/**
 * The executable preamble for the generated Helper entry: widen
 * `tls.createServer` cipher lists, then re-sync the core-module ESM bindings
 * so the Helper's own `import { createServer } from 'node:tls'` resolves to
 * the wrapper. The entry evaluates this before importing the upstream Helper.
 * @returns JavaScript source for the remote entry.
 */
export function helperServerShimSource(): string {
  return `const { syncBuiltinESMExports: syncTlsExports } = require("node:module")
const tls = require("node:tls")
const serverPskCiphers = ${serverPskCiphers.toString()}
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
