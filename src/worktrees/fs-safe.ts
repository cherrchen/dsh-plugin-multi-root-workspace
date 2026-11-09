/** Bounded Git metadata snapshots. All lookups start at a local root handle. */
import { isAbsolute, parse, sep } from 'node:path'
import { openMetadataRoot, type EntryKind, type NativeHandle } from './native-io.ts'
import type { FileIdentity } from './types.ts'

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

export class SafeIoError extends Error {
  constructor(readonly reason: SafeIoReason, message: string) {
    super(message)
    this.name = 'SafeIoError'
  }
}

export const MAX_POINTER_BYTES = 4096
export const MAX_HEAD_BYTES = 1024
export const MAX_INDEX_BYTES = 64 * 1024 * 1024
export const MAX_ALTERNATES_BYTES = 64 * 1024

/** Validate raw spelling before Node can normalize network or device paths. */
export function guardSpelling(path: string): void {
  if (path === '' || path.includes('\u0000')) throw new SafeIoError('invalid-path', 'metadata path is empty or contains NUL')
  if (path.startsWith('//') || (process.platform === 'win32' && /^[\\/]{2}/.test(path))) {
    throw new SafeIoError('network-path', 'metadata path is a network or device path')
  }
  if (!isAbsolute(path) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(path))) {
    throw new SafeIoError('not-absolute', 'metadata path is not a fully qualified local path')
  }
}

function mapError(error: unknown, path: string): SafeIoError {
  if (error instanceof SafeIoError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new SafeIoError('missing', `metadata path "${path}" does not exist`)
  if (code === 'ELOOP') return new SafeIoError('symlink', `metadata path "${path}" is a symlink`)
  return new SafeIoError('inaccessible', `cannot inspect metadata path "${path}": ${String(error)}`)
}

function segmentsOf(path: string, root: string): string[] {
  const rest = path.slice(root.length)
  const parts = (process.platform === 'win32' ? rest.split(/[\\/]+/) : rest.split('/')).filter(Boolean)
  // A trailing separator requires the preceding component to be a directory.
  if (parts.length > 0 && (path.endsWith(sep) || path.endsWith('/'))) parts.push('.')
  if (process.platform === 'win32' && parts.some(part => part !== '.' && part !== '..' &&
    (/[:<>|?*"]|[. ]$/.test(part) || [...part].some(character => character.charCodeAt(0) < 32) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) {
    throw new SafeIoError('invalid-path', 'metadata path contains an ambiguous Windows component')
  }
  return parts
}

/** Walk the original components, including those later cancelled by '..'. */
function atEntry<T>(path: string, visit: (parent: NativeHandle, name: string) => T): T {
  guardSpelling(path)
  const root = parse(path).root
  const segments = segmentsOf(path, root)
  const leaf = segments.pop() ?? '.'
  const chain: NativeHandle[] = []
  function walk(name: string) {
    if (name === '..') {
      if (chain.length > 1) chain.pop()!.close()
    } else if (name !== '.') {
      const parent = chain.at(-1)!
      const kind = parent.directory().inspect(name)
      if (kind === 'symlink') throw new SafeIoError('symlink', `metadata path "${path}" contains a symlink`)
      if (kind !== 'directory') throw new SafeIoError('not-directory', `metadata path "${path}" contains a non-directory`)
      const child = parent.directory().child(name)
      chain.push(child)
      const openedKind = child.info().kind
      if (openedKind === 'symlink') throw new SafeIoError('symlink', `metadata path "${path}" contains a symlink`)
      if (openedKind !== 'directory') throw new SafeIoError('not-directory', `metadata path "${path}" changed during traversal`)
    }
  }
  try {
    const rootHandle = openMetadataRoot(root)
    chain.push(rootHandle)
    if (rootHandle.info().kind !== 'directory') throw new SafeIoError('not-directory', 'metadata root is not a local directory')
    for (const part of segments) walk(part)
    if (leaf === '..') walk(leaf)
    return visit(chain.at(-1)!, leaf === '..' ? '.' : leaf)
  } catch (error) {
    throw mapError(error, path)
  } finally {
    for (const handle of chain.reverse()) handle.close()
  }
}

function withHandle<T>(path: string, visit: (handle: NativeHandle) => T): T {
  return atEntry(path, (parent, name) => {
    if (name === '.') return visit(parent)
    const handle = parent.directory().child(name)
    try {
      if (handle.info().kind === 'symlink') throw new SafeIoError('symlink', `metadata path "${path}" is a symlink`)
      return visit(handle)
    } finally { handle.close() }
  })
}

/** Inspect an entry without opening its content or following its last segment. */
export function lstatEntry(path: string): EntryKind | undefined {
  try {
    return atEntry(path, (parent, name) => name === '.' ? 'directory' : parent.directory().inspect(name))
  } catch (error) {
    if (error instanceof SafeIoError && error.reason === 'missing') return undefined
    throw error
  }
}

export function canonicalExisting(path: string): string {
  return withHandle(path, handle => {
    const canonical = handle.canonical()
    guardSpelling(canonical)
    const original = handle.info()
    // A pinned object may be renamed on POSIX. Prove the original spelling
    // still reaches that object, with a fresh no-follow walk.
    return withHandle(path, current => {
      const now = current.info()
      if (now.dev !== original.dev || now.ino !== original.ino || now.birthtimeMs !== original.birthtimeMs) {
        throw new SafeIoError('inaccessible', `metadata path "${path}" changed while it was resolved`)
      }
      return canonical
    })
  })
}

export function readDirectory(path: string): string[] {
  return withHandle(path, handle => {
    if (handle.info().kind !== 'directory') throw new SafeIoError('not-directory', `"${path}" is not a directory`)
    return handle.list()
  })
}

export function readRegularFile(path: string, maxBytes: number): Buffer {
  return withHandle(path, handle => {
    const info = handle.info()
    if (info.kind !== 'file') throw new SafeIoError('not-file', `"${path}" is not a regular file`)
    if (info.size > BigInt(maxBytes)) throw new SafeIoError('too-large', `"${path}" exceeds ${maxBytes} bytes`)
    const buffer = Buffer.alloc(Number(info.size))
    let offset = 0
    while (offset < buffer.length) {
      const count = handle.read(buffer.subarray(offset))
      if (count <= 0) throw new SafeIoError('inaccessible', `"${path}" ended early`)
      offset += count
    }
    return buffer
  })
}

export function readUtf8File(path: string, maxBytes: number): string {
  const buffer = readRegularFile(path, maxBytes)
  if (buffer.includes(0)) throw new SafeIoError('invalid-encoding', `"${path}" contains NUL`)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    throw new SafeIoError('invalid-encoding', `"${path}" is not valid UTF-8`)
  }
}

export function directoryIdentity(path: string): FileIdentity | undefined {
  return withHandle(path, handle => {
    const info = handle.info()
    if (info.kind !== 'directory') throw new SafeIoError('not-directory', `"${path}" is not a directory`)
    if (info.ino === 0n) return undefined
    const birthtimeMs = Number(info.birthtimeMs)
    return { dev: info.dev.toString(), ino: info.ino.toString(), ...(birthtimeMs > 0 ? { birthtimeMs } : {}) }
  })
}

export function readPointerLine(path: string): string {
  const line = readUtf8File(path, MAX_POINTER_BYTES).replace(/(?:\r?\n)+$/, '')
  if (line === '' || /[\r\n]/.test(line)) {
    throw new SafeIoError('invalid-encoding', `metadata pointer "${path}" is not a single line`)
  }
  return line
}

export function resolvePointerTarget(base: string, raw: string): string {
  const target = raw
  if (target === '' || (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(target))) {
    throw new SafeIoError('invalid-path', 'pointer target is empty or drive-relative')
  }
  return canonicalExisting(isAbsolute(target) ? target : base + sep + target)
}
