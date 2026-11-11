/**
 * Koffi must be the host's own copy, not this package's `dependencies` entry:
 * `dsh plugin add` installs a private koffi beside the one the host already
 * loaded, and two `koffi.node` images in one process SIGBUS on darwin-arm64
 * pointer authentication (packed-install smoke, 2026-11-01). `dsh-fs-local`
 * carries koffi on every supported release, so anchoring at it yields the
 * single binary the host itself loaded.
 *
 * Two ways to reach that same binary, in order:
 * 1. `require('koffi')` from the host anchor — the live CJS `module.exports`.
 *    The host occasionally exposes a partial `{}` exports object for koffi's
 *    CJS entry (mid-evaluation or an intercepted require in the addon loader),
 *    so the result is validated instead of trusted.
 * 2. The host koffi's own ESM entry (`index.js` beside the resolved CJS
 *    entry) — a separate module instance over the same `koffi.node`, immune
 *    to a broken CJS cache entry and never a second native image.
 * Only when no host tree resolves at all does the package-local copy load.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Koffi = (typeof import('koffi'))['default']

const pick = (candidate: unknown): Koffi | undefined => {
  let cur = candidate as { load?: unknown; default?: unknown } | null | undefined
  for (let i = 0; i < 3; i++) {
    if (typeof cur?.load === 'function') return cur as unknown as Koffi
    cur = cur?.default as typeof cur
  }
  return undefined
}

/** Synchronous access for bounded metadata reads. Node's require(esm) can
 * load the host ESM entry, which is synchronous, if its CJS facade is partial. */
export function loadHostKoffiSync(): Koffi {
  const ownRequire = createRequire(import.meta.url)
  let anchor: string
  try {
    anchor = ownRequire.resolve('@deepseek-ai/dsh-fs-local/package.json')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    const own = pick(ownRequire('koffi'))
    if (own !== undefined) return own
    throw new Error('Koffi is unavailable')
  }
  const hostRequire = createRequire(anchor)
  const entry = hostRequire.resolve('koffi')
  const host = pick(hostRequire(entry)) ?? pick(hostRequire(join(dirname(entry), 'index.js')))
  if (host === undefined) throw new Error('the host Koffi entry is unavailable')
  return host
}

export async function loadHostKoffi(): Promise<Koffi> {
  try {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-fs-local/package.json')
    const hostRequire = createRequire(anchor)
    const cjs = pick(hostRequire('koffi'))
    if (cjs !== undefined) return cjs
    const esm = pick(await import(pathToFileURL(join(dirname(hostRequire.resolve('koffi')), 'index.js')).href))
    if (esm !== undefined) return esm
  } catch { /* no host tree — fall through to the package-local copy */ }
  const own = pick(await import('koffi'))
  if (own !== undefined) return own
  return (await import('koffi')).default as Koffi
}
