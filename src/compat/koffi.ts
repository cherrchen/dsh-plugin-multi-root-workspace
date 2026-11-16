/**
 * Koffi is supplied by the host, never by this package.
 *
 * A shipped `dependencies` entry installs a profile copy beside the one the
 * host already loaded, and two `koffi.node` images in one process SIGBUS on
 * darwin-arm64 pointer authentication (packed-install smoke, 2026-11-01). That
 * dependency also stops the first `dsh plugin add` at pnpm's build approval,
 * because koffi carries an install script. DSH itself treats koffi as an
 * ordinary host dependency: `dsh-fs-local`, `dsh-subprocess-local`,
 * `dsh-win32-process` and `dsh-sandbox-windows-acl` load it lazily through
 * `createLazyRequire`, and the native code arrives in `@koromix/koffi-*`
 * platform packages. This module mirrors that lazy access, anchored at the
 * host installation.
 *
 * Resolution order; the first copy that exposes a callable `load` wins:
 * 1. `DSH_KOFFI_PATH` — a koffi package directory or entry file, for a
 *    relocated runtime;
 * 2. `@deepseek-ai/dsh-fs-local`'s own resolution — a required peer on every
 *    supported release, and the package whose koffi the host itself loads;
 * 3. the host entry (`process.argv[1]`) — the `dsh` CLI, or Desktop's
 *    `dsh-desktop-host/lib/cli.js` inside `app.asar`;
 * 4. Desktop's packaged runtime directories under `process.resourcesPath`,
 *    including `app.asar` (Electron's asar hook), `app.asar.unpacked` and an
 *    unpacked `app` tree.
 *
 * There is deliberately no package-local fallback: a koffi installed beside
 * this one is exactly the second native image this module exists to prevent.
 * A missing host copy is reported, not papered over.
 *
 * The synchronous variant exists for bounded Git-metadata reads in Worktrees;
 * both variants walk the same candidate list.
 */
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Koffi = (typeof import('koffi'))['default']

interface Candidate {
  /** Resolution route, for the failure diagnostic. */
  readonly source: string
  /** Absolute path of the koffi JavaScript entry. */
  readonly entry: string
}

const ownRequire = createRequire(import.meta.url)

/**
 * Accept koffi's module object, its `default` chain, or a partially evaluated
 * CJS exports object; only a callable `load` proves a usable copy.
 */
const pick = (candidate: unknown): Koffi | undefined => {
  let cur = candidate as { load?: unknown; default?: unknown } | null | undefined
  for (let i = 0; i < 3; i++) {
    if (typeof cur?.load === 'function') return cur as unknown as Koffi
    cur = cur?.default as typeof cur
  }
  return undefined
}

/** Resolve a specifier from a file or package manifest, or report no copy there. */
function resolveFrom(parent: string, specifier: string): string | undefined {
  try {
    return createRequire(parent).resolve(specifier)
  } catch {
    return undefined
  }
}

/** Desktop's packaged runtime roots, including layouts without Electron's `resourcesPath`. */
function resourcesRoots(): string[] {
  const roots: string[] = []
  const resources = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
  if (typeof resources === 'string' && resources !== '') roots.push(resources)
  const executable = dirname(process.execPath)
  roots.push(join(executable, '..', 'Resources'), join(executable, '..', 'resources'), join(executable, 'resources'))
  return [...new Set(roots)]
}

/** Every host copy this process can address, in priority order. */
function candidates(): Candidate[] {
  const list: Candidate[] = []
  const seen = new Set<string>()
  const add = (source: string, entry: string | undefined): void => {
    if (entry === undefined || entry === '' || seen.has(entry)) return
    seen.add(entry)
    list.push({ source, entry })
  }
  const override = process.env.DSH_KOFFI_PATH?.trim()
  if (override !== undefined && override !== '') {
    const path = isAbsolute(override) ? override : resolve(override)
    add('DSH_KOFFI_PATH', path)
    add('DSH_KOFFI_PATH/index.cjs', join(path, 'index.cjs'))
    add('DSH_KOFFI_PATH/index.js', join(path, 'index.js'))
  }
  const anchor = resolveFrom(import.meta.url, '@deepseek-ai/dsh-fs-local/package.json')
  if (anchor !== undefined) add('dsh-fs-local anchor', resolveFrom(anchor, 'koffi'))
  const hostEntry = process.argv[1]
  if (hostEntry !== undefined && hostEntry !== '') add('host entry', resolveFrom(pathToFileURL(hostEntry).href, 'koffi'))
  for (const root of resourcesRoots()) {
    add('dsh runtime', join(root, 'dsh', 'node_modules', 'koffi', 'index.cjs'))
    for (const tree of ['app.asar', 'app.asar.unpacked', 'app']) {
      add(`${tree} runtime`, join(root, tree, 'dsh', 'node_modules', 'koffi', 'index.cjs'))
    }
  }
  return list
}

/**
 * Load one candidate synchronously, trying the sibling ESM entry when the CJS
 * facade is partial. Node's `require(esm)` handles that entry without a second
 * native image.
 */
function loadSyncFrom(candidate: Candidate): Koffi | undefined {
  let failure: unknown
  try {
    const cjs = pick(ownRequire(candidate.entry))
    if (cjs !== undefined) return cjs
  } catch (error) {
    failure = error
  }
  const esm = join(dirname(candidate.entry), 'index.js')
  if (esm !== candidate.entry) {
    try {
      const loaded = pick(ownRequire(esm))
      if (loaded !== undefined) return loaded
    } catch (error) {
      failure = error
    }
  }
  if (failure !== undefined) throw failure
  return undefined
}

/** Asynchronous twin of {@link loadSyncFrom}. */
async function loadAsyncFrom(candidate: Candidate): Promise<Koffi | undefined> {
  let failure: unknown
  try {
    const cjs = pick(await import(pathToFileURL(candidate.entry).href))
    if (cjs !== undefined) return cjs
  } catch (error) {
    failure = error
  }
  const esm = join(dirname(candidate.entry), 'index.js')
  if (esm !== candidate.entry) {
    try {
      const loaded = pick(await import(pathToFileURL(esm).href))
      if (loaded !== undefined) return loaded
    } catch (error) {
      failure = error
    }
  }
  if (failure !== undefined) throw failure
  return undefined
}

/** Explain every route that was tried, retaining the last real load failure. */
function unavailable(tried: readonly Candidate[], lastError: unknown): Error {
  const routes = tried.length === 0 ? 'no route' : tried.map(candidate => candidate.source).join(', ')
  const cause = lastError instanceof Error ? `: ${lastError.message}` : ''
  return new Error(`the host's Koffi copy is unavailable (tried ${routes})${cause}. `
    + 'Koffi is an optional peer provided by DSH; reinstall the runtime, or set DSH_KOFFI_PATH to a koffi package directory.')
}

/**
 * Cache the first successful copy, keyed by the override (a test or a
 * relocated runtime may change it). A failed lookup is never cached, matching
 * DSH's own `createLazyRequire`: a corrected installation can be retried.
 */
let cached: { readonly override: string; readonly koffi: Koffi } | undefined

function cachedKoffi(override: string): Koffi | undefined {
  return cached?.override === override ? cached.koffi : undefined
}

/** The current `DSH_KOFFI_PATH` spelling, which keys the cache. */
function overrideKey(): string {
  return process.env.DSH_KOFFI_PATH?.trim() ?? ''
}

/** Synchronous host Koffi access for bounded metadata reads. */
export function loadHostKoffiSync(): Koffi {
  const override = overrideKey()
  const known = cachedKoffi(override)
  if (known !== undefined) return known
  const tried = candidates()
  let lastError: unknown
  for (const candidate of tried) {
    try {
      const koffi = loadSyncFrom(candidate)
      if (koffi !== undefined) {
        cached = { override, koffi }
        return koffi
      }
    } catch (error) {
      lastError = error
    }
  }
  throw unavailable(tried, lastError)
}

/** Asynchronous host Koffi access for FFI call sites. */
export async function loadHostKoffi(): Promise<Koffi> {
  const override = overrideKey()
  const known = cachedKoffi(override)
  if (known !== undefined) return known
  const tried = candidates()
  let lastError: unknown
  // `require` first: it returns the CJS module object the host itself loaded.
  // An ESM import of the same entry would be a second module instance over the
  // same native image (still one image, but not the identity the host holds).
  for (const candidate of tried) {
    try {
      const koffi = loadSyncFrom(candidate)
      if (koffi !== undefined) {
        cached = { override, koffi }
        return koffi
      }
    } catch (error) {
      lastError = error
    }
  }
  for (const candidate of tried) {
    try {
      const koffi = await loadAsyncFrom(candidate)
      if (koffi !== undefined) {
        cached = { override, koffi }
        return koffi
      }
    } catch (error) {
      lastError = error
    }
  }
  throw unavailable(tried, lastError)
}
