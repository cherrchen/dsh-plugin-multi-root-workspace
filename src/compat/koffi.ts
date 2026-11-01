/**
 * Koffi must be the host's own copy, not this package's `dependencies` entry:
 * `dsh plugin add` installs a private koffi beside the one the host already
 * loaded, and two `koffi.node` images in one process SIGBUS on darwin-arm64
 * pointer authentication (packed-install smoke, 2026-11-01). `dsh-fs-local`
 * carries koffi on every supported release, so anchoring at it yields the
 * single binary the host itself loaded; the package-local copy stays as the
 * standalone fallback for contexts without a host tree.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type Koffi = (typeof import('koffi'))['default']

export async function loadHostKoffi(): Promise<Koffi> {
  try {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-fs-local/package.json')
    const resolved = createRequire(anchor).resolve('koffi')
    return (await import(pathToFileURL(resolved).href)).default as Koffi
  } catch {
    return (await import('koffi')).default as Koffi
  }
}
