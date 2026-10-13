/**
 * The standalone Windows runner's contract — shared between the widened
 * profile (`windows-profile.ts`, in-process) and `windows-runner.ts` (a
 * separate Node process).
 *
 * ZERO bare-specifier imports: `lib/windows-runner.js` executes outside the
 * host's plugin package resolution, so every module it statically reaches may
 * import `node:` builtins only. tests/windows-multi-root.spec.ts and
 * scripts/check-pack.mjs both walk the built runner's module graph and fail on
 * any non-`node:` specifier.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/windows-runner-contract
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * Raised when a confined argv or a runner profile cannot be recognized or
 * widened. The provider converts this into the fail-closed
 * `SandboxUnavailableError`: an unrecognized dialect must never degrade into
 * "the primary root was granted after all". Re-exported from `dialects.ts`.
 */
export class DialectUnrecognizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DialectUnrecognizedError'
  }
}

/**
 * The canonical spelling of `path`, or `path` itself when it does not exist.
 *
 * Mirrors `canonicalPath` from `@deepseek-ai/dsh-sandbox`: the published
 * package ships only its entry point, and this module may not import it at
 * all (the runner resolves upstream packages from the upstream runner's own
 * location, never from its own directory). Same precedent and justification
 * as `src/containment.ts` (ADR-0002).
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether a path names a Windows network or device location: two leading
 * slashes or backslashes in any mix (`\\server\share`, `//server/share`,
 * `\\?\…`, `\\.\…`). Windows ACL confinement cannot be shown to cover these —
 * the restricted token's capability SID and Low label are not what an SMB
 * server evaluates, and merely resolving an attacker-chosen UNC path triggers
 * SMB authentication — so they are refused lexically, before any filesystem
 * access. Because `canonicalPath` resolves a mapped drive letter to its
 * `\\server\share` form, checking the canonical spelling also catches mapped
 * network drives.
 * @param path - the path spelling to test.
 * @returns whether it is a network or device path.
 */
export function isWindowsNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

/** A root-set capability: removing or adding a root changes the token's identity. */
export function workspaceScopeSid(roots: readonly string[]): string {
  const paths = [...new Set(roots.map(root => root.toLowerCase()))].sort()
  const hash = createHash('sha256').update('dsh-multi-root-workspace\0').update(JSON.stringify(paths)).digest()
  const words = [0, 4, 8, 12].map(offset => (hash.readUInt32LE(offset) % (2 ** 30 - 1)) + 1)
  return `S-1-4-${words.join('-')}-2`
}

/** A standing deny identity, deliberately disjoint from all write capabilities. */
export function rootDenySid(root: string): string {
  const hash = createHash('sha256').update('dsh-multi-root-deny\0').update(root.toLowerCase()).digest()
  const words = [0, 4, 8, 12].map(offset => (hash.readUInt32LE(offset) % (2 ** 30 - 1)) + 1)
  return `S-1-4-${words.join('-')}-3`
}

export interface WindowsProfile {
  workspace: string
  temp: string
  /**
   * `workspace-write` grants the workspace, the private temp, and every
   * `--additional-root`. `read-only` is legal only on the widened form (the
   * standalone runner): the runner then grants the additional roots ALONE — a
   * workspace-write token over just those directories — which is how a fixed
   * `read-write` additional root stays writable inside a read-only session
   * (B9). An upstream `read-only` profile carries no `--additional-root`, so
   * the mode only ever reaches the runner with grants attached.
   */
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  additionalRoots: string[]
  deniedRoots: string[]
  /**
   * The upstream runner's own file (`--upstream-runner`). Required when
   * `allowAdditional` parses — our standalone runner resolves
   * `@deepseek-ai/dsh-sandbox-windows-acl` by package self-reference FROM this
   * location, the only place that package is guaranteed importable.
   */
  upstreamRunner?: string
  writeSid?: string
  tempWriteSid?: string
}

/**
 * Strictly recognize the upstream public runner contract, failing closed on
 * new flags. `allowAdditional` is the standalone runner's own mode: it accepts
 * repeated `--additional-root` and requires `--upstream-runner` exactly once
 * naming an absolute, existing file — anything else exits 127 without a child.
 */
export function parseWindowsProfile(args: readonly string[], allowAdditional = false): WindowsProfile {
  const fields = new Map<string, string>()
  const additionalRoots: string[] = []
  const deniedRoots: string[] = []
  let upstreamRunner: string | undefined
  const known = new Set(['--workspace', '--temp', '--mode', '--write-sid', '--temp-write-sid'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key === undefined || value === undefined || value === '') throw new DialectUnrecognizedError('Windows ACL profile has a missing value')
    if (allowAdditional && key === '--additional-root') { additionalRoots.push(value); continue }
    if (allowAdditional && key === '--deny-root') { deniedRoots.push(value); continue }
    if (allowAdditional && key === '--upstream-runner') {
      if (upstreamRunner !== undefined) throw new DialectUnrecognizedError('Windows ACL profile repeats --upstream-runner')
      upstreamRunner = value
      continue
    }
    if (!known.has(key) || fields.has(key)) throw new DialectUnrecognizedError(`Windows ACL profile has unknown or duplicate flag ${key}`)
    fields.set(key, value)
  }
  if (allowAdditional && upstreamRunner === undefined) throw new DialectUnrecognizedError('Windows multi-root runner requires --upstream-runner')
  if (upstreamRunner !== undefined && (!isAbsolute(upstreamRunner) || !existsSync(upstreamRunner) || !statSync(upstreamRunner).isFile())) {
    throw new DialectUnrecognizedError(`--upstream-runner is not an absolute existing file: ${upstreamRunner}`)
  }
  const workspace = fields.get('--workspace')
  const temp = fields.get('--temp')
  const mode = fields.get('--mode')
  if (workspace === undefined || temp === undefined || (mode !== 'workspace-write' && mode !== 'read-only' && !(allowAdditional && mode === 'danger-full-access'))) {
    throw new DialectUnrecognizedError('Windows multi-root requires --workspace, --temp, and --mode read-only or workspace-write')
  }
  if (mode === 'danger-full-access'
    ? deniedRoots.length === 0 || additionalRoots.length > 0 || fields.has('--write-sid') || fields.has('--temp-write-sid')
    : deniedRoots.length > 0) {
    throw new DialectUnrecognizedError('Windows ambient restriction requires deny roots only, without write grants or capability SIDs')
  }
  // On the standalone runner a read-only profile must carry grants — an
  // upstream `read-only` invocation never reaches this process.
  if (allowAdditional && mode === 'read-only' && additionalRoots.length === 0) {
    throw new DialectUnrecognizedError('Windows multi-root read-only requires at least one --additional-root')
  }
  const writeSid = fields.get('--write-sid')
  const tempWriteSid = fields.get('--temp-write-sid')
  if ((writeSid === undefined) !== (tempWriteSid === undefined)) throw new DialectUnrecognizedError('Windows ACL profile requires both capability SIDs or neither')
  return { workspace, temp, mode, additionalRoots, deniedRoots,
    ...(upstreamRunner === undefined ? {} : { upstreamRunner }),
    ...(writeSid === undefined ? {} : { writeSid }), ...(tempWriteSid === undefined ? {} : { tempWriteSid }) }
}
