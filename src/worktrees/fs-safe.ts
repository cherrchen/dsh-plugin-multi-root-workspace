/**
 * Metadata I/O that must never follow a link.
 *
 * The rules the plugin enforces before it reads ANY Git metadata (ADR-0039
 * §2.2/§2.4):
 *
 * - the spelling is guarded first, so resolving cannot initiate SMB
 *   authentication on Windows (absolute, no NUL, no UNC / device path);
 * - every directory above the final component is `lstat`ed and must be a
 *   real directory, never a symlink;
 * - the final file is opened with `O_NOFOLLOW | O_NONBLOCK`, `fstat`ed on the
 *   SAME descriptor, required to be a regular file, and read under a byte
 *   budget — a FIFO cannot block the open and a swapped symlink cannot be
 *   followed;
 * - a directory identity is taken through a descriptor when the platform
 *   allows it, and a filesystem that reports no inode yields no identity at
 *   all (the caller then refuses to prompt).
 *
 * Node has no public `openat()`, so the intermediate-directory check and the
 * final `open` are two steps. The window is bounded by re-checking on every
 * metadata read (each read re-walks the chain); the static symlink cases the
 * ADR requires to fail are caught deterministically.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/fs-safe
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
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

/** Map one filesystem failure to a stable safe-I/O class. */
function mapError(error: unknown, path: string): SafeIoError {
  if (error instanceof SafeIoError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new SafeIoError('missing', `metadata path "${path}" does not exist`)
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
 * Walk every component above `path` and require real directories.
 * @param path - absolute path whose parent chain is checked.
 */
export function assertDirectoryChain(path: string): void {
  const root = parse(path).root
  const rest = path.slice(root.length)
  const segments = rest.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const entry = lstatEntry(current)
    if (entry === undefined) throw new SafeIoError('missing', `metadata path "${current}" does not exist`)
    if (entry.isSymbolicLink()) throw new SafeIoError('symlink', `metadata path "${current}" is a symlink`)
    if (!entry.isDirectory()) throw new SafeIoError('not-directory', `metadata path "${current}" is not a directory`)
  }
}

/**
 * Canonicalize an existing path, then prove its canonical spelling has no
 * symlinked components. The canonical value is what all later comparisons use.
 * @param path - absolute path that must exist.
 * @returns the canonical path.
 */
export function canonicalExisting(path: string): string {
  guardSpelling(path)
  let canonical: string
  try {
    canonical = realpathSync.native(path)
  } catch (error) {
    throw mapError(error, path)
  }
  guardSpelling(canonical)
  // The canonical spelling comes out of the kernel already resolved; the walk
  // keeps a later mount/rename from turning one of its components into a link.
  const entry = lstatEntry(canonical)
  if (entry === undefined) throw new SafeIoError('missing', `metadata path "${canonical}" does not exist`)
  if (entry.isSymbolicLink()) throw new SafeIoError('symlink', `metadata path "${canonical}" is a symlink`)
  assertParentChain(canonical)
  return canonical
}

/** Check every component ABOVE the final one. */
function assertParentChain(path: string): void {
  const parent = dirname(path)
  if (parent === path) return
  assertDirectoryChain(parent)
}

/**
 * Read one regular file under a byte budget, refusing symlinks, FIFOs and
 * devices. The descriptor is opened with `O_NOFOLLOW | O_NONBLOCK`, `fstat`ed
 * on the same handle, and read exactly once into one bounded buffer.
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
  assertParentChain(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = fstatSync(fd, { bigint: true })
    if (!stats.isFile()) throw new SafeIoError('not-file', `metadata file "${path}" changed into a non-file`)
    if (stats.size > BigInt(maxBytes)) throw new SafeIoError('too-large', `metadata file "${path}" exceeds ${maxBytes} bytes`)
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
    closeSync(fd)
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
  assertParentChain(path)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    return identityOfStats(fstatSync(fd, { bigint: true }))
  } catch {
    // Opening a directory is not portable (Windows refuses it); a fresh
    // lstat is the only remaining evidence, and inode 0 above keeps that
    // evidence honest.
    const stats = lstatSync(path, { bigint: true })
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SafeIoError('not-directory', `directory "${path}" changed during observation`)
    return identityOfStats(stats)
  } finally {
    if (fd !== undefined) closeSync(fd)
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
 * the caller passes explicitly.
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
