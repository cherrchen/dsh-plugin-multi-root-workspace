/**
 * Metadata I/O that must never follow a link.
 *
 * The rules the plugin enforces before it reads ANY Git metadata (ADR-0039
 * §2.2/§2.4):
 *
 * - the spelling is guarded first, so resolving cannot initiate SMB
 *   authentication on Windows (absolute, no NUL, no UNC / device path);
 * - the target is walked lexically, segment by segment, BEFORE any
 *   `realpath`: every component must be a real directory and none may be a
 *   symlink. A pointer target that is itself a symlink is refused even when
 *   its resolved path would look perfectly valid;
 * - POSIX paths are split on `/` only. A backslash is a legal file-name
 *   character on POSIX and is never treated as a separator;
 * - every directory above the final component is opened with
 *   `O_NOFOLLOW | O_DIRECTORY` (where the platform supports it), and the
 *   opened handle is compared against a fresh `lstat` after the final file is
 *   open. A swap that persists is detected even though the final open itself
 *   is path-based;
 * - the final file is opened with `O_NOFOLLOW | O_NONBLOCK`, `fstat`ed on the
 *   SAME descriptor, required to be a regular file, re-checked against the
 *   pre-open `lstat`, and read under a byte budget — a FIFO cannot block the
 *   open, a swapped symlink cannot be followed, and a replaced file is
 *   refused;
 * - a directory identity is taken through a descriptor when the platform
 *   allows it, and a filesystem that reports no inode yields no identity at
 *   all (the caller then refuses to prompt).
 *
 * Node has no public `openat()`, so a path-based final open cannot be made
 * atomic with the segment walk. Holding one `O_NOFOLLOW` directory handle per
 * segment and re-verifying every handle against the live path closes the
 * windows a deterministic test can observe; the remaining kernel-level race is
 * documented rather than papered over.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/fs-safe
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, isAbsolute, parse, resolve } from 'node:path'
import { isWindowsNetworkOrDevicePath } from '../roots.ts'
import type { FileIdentity } from './types.ts'

/** Why a metadata access was refused. */
export type SafeIoReason =
  | 'not-absolute'
  | 'invalid-path'
  | 'network-path'
  | 'symlink'
  | 'not-file'
  | 'not-directory'
  | 'missing'
  | 'inaccessible'
  | 'too-large'
  | 'invalid-encoding'

/** A refused metadata access; `reason` is stable, `message` is diagnostic. */
export class SafeIoError extends Error {
  /**
   * @param reason - stable refusal class.
   * @param message - diagnostic text naming what was refused.
   */
  constructor(readonly reason: SafeIoReason, message: string) {
    super(message)
    this.name = 'SafeIoError'
  }
}

/** The largest pointer/config/HEAD file this feature will ever read. */
export const MAX_POINTER_BYTES = 4096
/** The HEAD grammar budget from the ADR. */
export const MAX_HEAD_BYTES = 1024
/** The index snapshot budget: real indexes are far smaller, huge ones are refused. */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024
/** The alternates file budget. */
export const MAX_ALTERNATES_BYTES = 64 * 1024

/**
 * Refuse a spelling that must never reach the filesystem layer.
 * @param path - the path as computed or as stored in a pointer file.
 */
export function guardSpelling(path: string): void {
  if (path === '' || path.includes('\u0000')) throw new SafeIoError('invalid-path', 'metadata path is empty or contains NUL')
  if (!isAbsolute(path)) throw new SafeIoError('not-absolute', `metadata path "${path}" is not absolute`)
  if (path.length > 1 && (path.startsWith('//') || path.startsWith('\\\\'))) {
    throw new SafeIoError('network-path', `metadata path "${path}" is a network or device path`)
  }
  if (process.platform === 'win32' && isWindowsNetworkOrDevicePath(path)) {
    throw new SafeIoError('network-path', `metadata path "${path}" is a network or device path`)
  }
}

/**
 * Split one absolute path into its components using ONLY the platform's real
 * separator. POSIX keeps a literal backslash inside a component; Windows
 * accepts both slash spellings.
 * @param path - absolute path.
 * @returns the components below the filesystem root.
 */
function pathSegments(path: string): string[] {
  const root = parse(path).root
  const rest = path.slice(root.length)
  const segments = process.platform === 'win32' ? rest.split(/[\\/]+/) : rest.split('/')
  return segments.filter(segment => segment !== '' && segment !== '.')
}

/** Map one filesystem failure to a stable safe-I/O class. */
function mapError(error: unknown, path: string): SafeIoError {
  if (error instanceof SafeIoError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new SafeIoError('missing', `metadata path "${path}" does not exist`)
  // O_NOFOLLOW on a symlink reports ELOOP (POSIX) or EINVAL/EPERM on some
  // platforms; all of them mean "this path is a link", never "missing".
  if (code === 'ELOOP') return new SafeIoError('symlink', `metadata path "${path}" is a symlink`)
  return new SafeIoError('inaccessible', `metadata path "${path}" is not accessible (${String(code ?? error)})`)
}

/**
 * `lstat` one path without following a final symlink.
 * @param path - absolute path.
 * @returns the entry, or `undefined` when it is absent.
 */
export function lstatEntry(path: string) {
  try {
    return lstatSync(path, { bigint: true, throwIfNoEntry: false })
  } catch (error) {
    throw mapError(error, path)
  }
}

/**
 * Walk every component of `path` and require real directories. The final
 * component is included, so this is the directory-shaped spelling guard.
 * @param path - absolute path whose full chain is checked.
 */
export function assertDirectoryChain(path: string): void {
  const root = parse(path).root
  let current = root
  for (const segment of pathSegments(path)) {
    current = join(current, segment)
    const entry = lstatEntry(current)
    if (entry === undefined) throw new SafeIoError('missing', `metadata path "${current}" does not exist`)
    if (entry.isSymbolicLink()) throw new SafeIoError('symlink', `metadata path "${current}" is a symlink`)
    if (!entry.isDirectory()) throw new SafeIoError('not-directory', `metadata path "${current}" is not a directory`)
  }
}

/**
 * Canonicalize an existing path WITHOUT following a link in its literal
 * spelling. Every parent component must be a real directory; the final
 * component may be a directory or a file (pointer targets name both). The
 * lexical chain is proven first, `realpath` is only used to normalize
 * case/mount spelling afterwards, and its result must still be the same
 * file-system object.
 * @param path - absolute path that must exist.
 * @returns the canonical path.
 */
export function canonicalExisting(path: string): string {
  guardSpelling(path)
  const normalized = resolve(path)
  guardSpelling(normalized)
  const parent = dirname(normalized)
  if (parent !== normalized) assertDirectoryChain(parent)
  const before = lstatEntry(normalized)
  if (before === undefined) throw new SafeIoError('missing', `metadata path "${normalized}" does not exist`)
  if (before.isSymbolicLink()) throw new SafeIoError('symlink', `metadata path "${normalized}" is a symlink`)
  let canonical: string
  try {
    canonical = realpathSync.native(normalized)
  } catch (error) {
    throw mapError(error, normalized)
  }
  guardSpelling(canonical)
  const after = lstatEntry(canonical)
  if (after === undefined) throw new SafeIoError('missing', `metadata path "${canonical}" does not exist`)
  if (after.isSymbolicLink()) throw new SafeIoError('symlink', `metadata path "${canonical}" is a symlink`)
  // `realpath` only normalizes spelling when the literal chain had no link;
  // a different inode means a component was swapped while we looked.
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new SafeIoError('symlink', `metadata path "${normalized}" changed while it was being resolved`)
  }
  assertParentChain(canonical)
  return canonical
}

/** Check every component ABOVE the final one. */
function assertParentChain(path: string): void {
  const parent = dirname(path)
  if (parent === path) return
  assertDirectoryChain(parent)
}

/** One directory handle held while the final file is opened. */
interface DirectoryHandle {
  readonly path: string
  readonly fd: number
  readonly dev: bigint
  readonly ino: bigint
}

/**
 * Open every component of one parent chain with `O_NOFOLLOW | O_DIRECTORY`.
 * The handles are held until the caller finished opening and checking the
 * final file, so a replaced component can be detected instead of silently
 * traversed. Platforms where directories cannot be opened (Windows) fall back
 * to the lstat walk; the final `O_NOFOLLOW` and the post-open checks still
 * apply there.
 * @param directory - absolute directory path.
 * @returns the open handles, outermost first.
 */
function openDirectoryChain(directory: string): DirectoryHandle[] {
  if (process.platform === 'win32') {
    assertDirectoryChain(directory)
    return []
  }
  const root = parse(directory).root
  let current = root
  const handles: DirectoryHandle[] = []
  try {
    for (const segment of pathSegments(directory)) {
      current = join(current, segment)
      const fd = openSync(current, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const stats = fstatSync(fd, { bigint: true })
      if (!stats.isDirectory()) {
        closeSync(fd)
        throw new SafeIoError('not-directory', `metadata path "${current}" is not a directory`)
      }
      handles.push({ path: current, fd, dev: stats.dev, ino: stats.ino })
    }
  } catch (error) {
    for (const handle of handles) closeSync(handle.fd)
    if (error instanceof SafeIoError) throw error
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ELOOP') throw new SafeIoError('symlink', `metadata path "${current}" is a symlink`)
    // Some hosts refuse opening an ancestor without read permission; keep the
    // conservative lstat walk (which will also refuse a symlink) rather than
    // turning a metadata read into an unconditional failure.
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP') {
      assertDirectoryChain(directory)
      return []
    }
    throw mapError(error, current)
  }
  return handles
}

/** Close every held directory handle. */
function closeDirectoryChain(handles: readonly DirectoryHandle[]): void {
  for (const handle of handles) {
    try { closeSync(handle.fd) } catch { /* best effort */ }
  }
}

/**
 * Re-check every held directory handle against the live path. A component
 * that was replaced by a link after it was opened is refused here.
 * @param handles - handles returned by {@link openDirectoryChain}.
 */
function assertChainUnchanged(handles: readonly DirectoryHandle[]): void {
  for (const handle of handles) {
    const live = lstatSync(handle.path, { bigint: true, throwIfNoEntry: false })
    if (live === undefined || live.isSymbolicLink() || !live.isDirectory()
      || live.dev !== handle.dev || live.ino !== handle.ino) {
      throw new SafeIoError('symlink', `metadata path "${handle.path}" changed while it was being read`)
    }
  }
}

/**
 * Read one regular file under a byte budget, refusing symlinks, FIFOs and
 * devices. The parent chain is opened without following links, the final
 * descriptor is opened with `O_NOFOLLOW | O_NONBLOCK`, `fstat`ed on the same
 * handle, compared with the pre-open entry, and read exactly once into one
 * bounded buffer.
 * @param path - absolute path of the file.
 * @param maxBytes - hard byte budget.
 * @returns the file contents.
 */
export function readRegularFile(path: string, maxBytes: number): Buffer {
  guardSpelling(path)
  const entry = lstatEntry(path)
  if (entry === undefined) throw new SafeIoError('missing', `metadata file "${path}" does not exist`)
  if (entry.isSymbolicLink()) throw new SafeIoError('symlink', `metadata file "${path}" is a symlink`)
  if (!entry.isFile()) throw new SafeIoError('not-file', `metadata file "${path}" is not a regular file`)
  if (entry.size > BigInt(maxBytes)) throw new SafeIoError('too-large', `metadata file "${path}" exceeds ${maxBytes} bytes`)
  const handles = openDirectoryChain(dirname(path))
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stats = fstatSync(fd, { bigint: true })
    if (!stats.isFile()) throw new SafeIoError('not-file', `metadata file "${path}" changed into a non-file`)
    if (stats.dev !== entry.dev || stats.ino !== entry.ino) {
      throw new SafeIoError('symlink', `metadata file "${path}" changed while it was being opened`)
    }
    if (stats.size > BigInt(maxBytes)) throw new SafeIoError('too-large', `metadata file "${path}" exceeds ${maxBytes} bytes`)
    assertChainUnchanged(handles)
    const size = Number(stats.size)
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset)
      if (read <= 0) throw new SafeIoError('inaccessible', `metadata file "${path}" ended early`)
      offset += read
    }
    return buffer
  } finally {
    if (fd !== undefined) closeSync(fd)
    closeDirectoryChain(handles)
  }
}

/**
 * Decode a bounded UTF-8 metadata file strictly.
 * @param path - absolute path.
 * @param maxBytes - hard byte budget.
 * @returns the decoded text.
 */
export function readUtf8File(path: string, maxBytes: number): string {
  const buffer = readRegularFile(path, maxBytes)
  if (buffer.includes(0)) throw new SafeIoError('invalid-encoding', `metadata file "${path}" contains NUL`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new SafeIoError('invalid-encoding', `metadata file "${path}" is not valid UTF-8`)
  }
}

/** Normalize one bigint stat record into a comparable identity. */
function identityOfStats(stats: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeMs?: bigint | number }): FileIdentity | undefined {
  // A filesystem that reports inode 0 cannot distinguish a rebuilt directory
  // from the original one; the ADR forbids falling back to path comparison.
  if (stats.ino === 0n) return undefined
  const birthtimeMs = stats.birthtimeMs === undefined ? 0 : Number(stats.birthtimeMs)
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    ...(birthtimeMs > 0 ? { birthtimeMs } : {}),
  }
}

/**
 * Observe the stable identity of one existing directory.
 * @param path - canonical absolute directory.
 * @returns the identity, or `undefined` when the platform/file system does not provide one.
 */
export function directoryIdentity(path: string): FileIdentity | undefined {
  guardSpelling(path)
  const entry = lstatEntry(path)
  if (entry === undefined) throw new SafeIoError('missing', `directory "${path}" does not exist`)
  if (entry.isSymbolicLink()) throw new SafeIoError('symlink', `directory "${path}" is a symlink`)
  if (!entry.isDirectory()) throw new SafeIoError('not-directory', `directory "${path}" is not a directory`)
  const handles = openDirectoryChain(dirname(path))
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const stats = fstatSync(fd, { bigint: true })
    if (!stats.isDirectory()) throw new SafeIoError('not-directory', `directory "${path}" changed during observation`)
    if (stats.dev !== entry.dev || stats.ino !== entry.ino) {
      throw new SafeIoError('symlink', `directory "${path}" changed during observation`)
    }
    assertChainUnchanged(handles)
    return identityOfStats(stats)
  } catch (error) {
    if (error instanceof SafeIoError) throw error
    // Opening a directory is not portable (Windows refuses it); a fresh
    // lstat is the only remaining evidence, and inode 0 above keeps that
    // evidence honest.
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SafeIoError('not-directory', `directory "${path}" changed during observation`)
    }
    if (stats.dev !== entry.dev || stats.ino !== entry.ino) {
      throw new SafeIoError('symlink', `directory "${path}" changed during observation`)
    }
    assertChainUnchanged(handles)
    return identityOfStats(stats)
  } finally {
    if (fd !== undefined) closeSync(fd)
    closeDirectoryChain(handles)
  }
}

/**
 * Compare two identities. Birth time is compared only when BOTH sides have one:
 * some filesystems report it for one call and not another.
 * @param left - recorded identity.
 * @param right - fresh identity.
 * @returns whether they still name the same directory.
 */
export function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return false
  if (left.dev !== right.dev || left.ino !== right.ino) return false
  if (left.birthtimeMs !== undefined && right.birthtimeMs !== undefined && left.birthtimeMs !== right.birthtimeMs) return false
  return true
}

/**
 * Resolve a pointer target written inside a pointer file.
 *
 * Version-0 pointers may be relative (hand-written or legacy); the ADR fixes
 * the resolution base to the directory containing the pointer's FILE, which
 * the caller passes explicitly. The resolved spelling is checked component by
 * component BEFORE any `realpath`, so a pointer that names a symlink is
 * refused even when the link's target is a perfectly valid directory.
 * @param base - the directory relative pointers resolve against.
 * @param raw - the pointer value.
 * @returns the canonical target path.
 */
export function resolvePointerTarget(base: string, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new SafeIoError('invalid-path', 'pointer target is empty')
  const joined = isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed)
  guardSpelling(joined)
  return canonicalExisting(joined)
}
