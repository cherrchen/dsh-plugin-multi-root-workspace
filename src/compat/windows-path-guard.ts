/** Windows deny-path pinning (branch-review Phase B).
 *
 * The ACL writer's deny ACEs follow the file OBJECT, not the registered
 * spelling: a restricted process that renames a deny root's ancestor moves
 * the protected tree to a NEW path the recorded deny set does not name — the
 * kernel still refuses that token's writes through the moved ACEs, but the
 * host fs fence, which matches the recorded spellings, no longer covers the
 * moved objects (the shell → host new-path gap, R1). This guard pins every
 * ancestor directory of every deny root with an open handle that shares read
 * and write but NOT delete — so a rename or delete of the registered tree
 * fails for the lifetime of the restricted child, without writing a single
 * persistent ACL on `C:\`, user directories, or anywhere else.
 *
 * `windows-deny.ts` owns the lifetime contract: handles are held until the
 * confined child AND its drained Job descendants have exited.
 *
 * Primitives are bound through the public `extendWin32ProcessBindings` seam —
 * no upstream private file, no new native dependency. Every verification uses
 * the same handle that pins the directory, so the checked object and the
 * pinned object are always the same one.
 */

import { win32 } from 'node:path'
import { isWindowsNetworkOrDevicePath } from '../windows-runner-contract.ts'
import type { NativeApi, NativeFunction, NativePointer, WindowsNative } from './windows-native.ts'

/** The access an ancestor pin needs to PARTICIPATE in the delete-sharing
 * gate. Verified on Windows 11: a metadata-only open (FILE_READ_ATTRIBUTES
 * alone, even with share mode 0) is transparent to the gate — it neither
 * blocks a rename of the directory nor is blocked by a conflicting handle —
 * while verified data-read access (GENERIC_READ here) does block it: the pin
 * then holds renames while still sharing read and write.
 * A consequence, not a bug: an ancestor the caller cannot READ cannot be
 * pinned, and the pin fails closed instead of pretending. */
const PIN_ACCESS = 0x80000000
/** READ|WRITE sharing, deliberately WITHOUT FILE_SHARE_DELETE: that is the
 * whole mechanism — a rename or delete of a pinned directory needs delete
 * sharing on it, which nothing gets while a pin is held. */
const SHARE_READ_WRITE = 0x3
const OPEN_EXISTING = 3
/** Directory handles need BACKUP_SEMANTICS; OPEN_REPARSE_POINT makes the pin
 * land on the reparse point itself so the attribute check can refuse it. */
const PIN_FLAGS = 0x02000000 | 0x00200000
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const HANDLE_FLAG_INHERIT = 0x1
/** `\\?\` extended-length prefix on a normalized DOS volume name; a `UNC`
 * continuation means the handle resolved onto a network share. */
const DOS_PREFIX = '\\\\?\\'

/** What `GetFileInformationByHandle` reports for one pinned object. */
export interface WindowsPathIdentity {
  readonly attributes: number
  readonly volumeSerial: number
  readonly fileIndex: bigint
  readonly links: number
}

/** Held ancestor pins. {@link WindowsPathGuard.close} releases every handle. */
export interface WindowsPathGuard {
  close(): void
}

/** Bind the file/handle primitives the guard needs through the public seam. */
function pathGuardBindings(native: WindowsNative): NativeApi {
  return native.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createFileW: bind(kernel32, 'CreateFileW', 'void*',
      ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']) as NativeFunction,
    getFileInformationByHandle: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void*', 'void*']) as NativeFunction,
    getFinalPathNameByHandleW: bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32',
      ['void*', 'void*', 'uint32', 'uint32']) as NativeFunction,
    getHandleInformation: bind(kernel32, 'GetHandleInformation', 'int', ['void*', 'void*']) as NativeFunction,
    closeHandle: bind(kernel32, 'CloseHandle', 'int', ['void*']) as NativeFunction,
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []) as NativeFunction,
  }))
}

const isInvalidHandle = (handle: NativePointer): boolean =>
  handle === null || handle === undefined
    || BigInt(handle as bigint) === -1n || BigInt(handle as bigint) === 0n
    || BigInt(handle as bigint) === 0xffffffffffffffffn

/** BY_HANDLE_FILE_INFORMATION is 52 bytes (FILETIME members are DWORD-pairs):
 * attributes @0, volume serial @28, link count @40, file index high @44 /
 * low @48. Read back on the same handle that pins the path, so the identity
 * cannot drift between check and pin.
 */
export function readWindowsPathIdentity(api: NativeApi, handle: NativePointer): WindowsPathIdentity {
  const info = Buffer.alloc(52)
  if (api.getFileInformationByHandle!(handle, info) === 0) {
    throw new Error(`GetFileInformationByHandle failed (Win32 ${api.getLastError!()})`)
  }
  return {
    attributes: info.readUInt32LE(0),
    volumeSerial: info.readUInt32LE(28),
    links: info.readUInt32LE(40),
    fileIndex: (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)),
  }
}

/**
 * The kernel's normalized DOS name for an open handle, compared against the
 * spelling the caller expected. Anything else — a junction-resolved target, a
 * UNC share, a device path — is a refusal, never an assumption.
 */
function readFinalPathName(api: NativeApi, handle: NativePointer, expected: string): void {
  let capacity = 260
  for (;;) {
    const buffer = Buffer.alloc(capacity * 2)
    const written = api.getFinalPathNameByHandleW!(handle, buffer, capacity, 0)
    if (written === 0) throw new Error(`GetFinalPathNameByHandleW(${expected}) failed (Win32 ${api.getLastError!()})`)
    if (written >= capacity) {
      capacity = written + 1
      continue
    }
    const name = buffer.subarray(0, written * 2).toString('utf16le')
    const finalPath = name.startsWith(DOS_PREFIX) ? name.slice(DOS_PREFIX.length) : name
    if (finalPath.startsWith('UNC\\') || finalPath.startsWith('\\\\')) {
      throw new Error(`deny path ancestor resolves to a non-local device: ${expected}`)
    }
    if (finalPath.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`deny path ancestor resolves to "${finalPath}" instead of "${expected}"`)
    }
    return
  }
}

/**
 * Every directory that must not move for `roots` to keep their registered
 * meaning: the full chain from the drive root down to each deny root,
 * deduplicated and ordered shallow-first so a shared prefix is pinned once
 * and parents are held before their children.
 *
 * Roots must be canonical absolute local-drive spellings: relative input,
 * UNC, and device paths are rejected lexically before any filesystem touch.
 */
function denyPathChain(roots: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const root of roots) {
    const normalized = win32.normalize(root)
    if (!/^[a-zA-Z]:[\\/]/.test(normalized) || isWindowsNetworkOrDevicePath(normalized)) {
      throw new Error(`deny root is not a canonical local-drive path: ${root}`)
    }
    // Drop the optional trailing separator a canonical spelling never carries;
    // the drive root itself keeps its own.
    let cursor = normalized.length > 3 ? normalized.replace(/[\\/]+$/, '') : normalized
    for (;;) {
      if (!seen.has(cursor.toLowerCase())) seen.set(cursor.toLowerCase(), cursor)
      const parent = win32.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  const depth = (path: string): number => path.split('\\').length - 1
  return [...seen.values()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/** Close every handle, deepest first; collect rather than lose failures. */
function closeAll(api: NativeApi, handles: readonly NativePointer[]): Error[] {
  const errors: Error[] = []
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      if (api.closeHandle!(handles[index]) === 0) {
        errors.push(new Error(`CloseHandle failed (Win32 ${api.getLastError!()})`))
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return errors
}

/**
 * Open a pin handle on every ancestor of every deny root — including the deny
 * root itself — and hold them all until {@link WindowsPathGuard.close}. Each
 * handle is opened with GENERIC_READ, read+write sharing, and a null security
 * descriptor so it is non-inheritable; the missing DELETE sharing is what
 * blocks renames, while ordinary reads and writes (and creating sibling files
 * inside a pinned directory) keep working.
 *
 * Every pin is verified on the same handle: the object must be a directory,
 * must not be a reparse point, must not carry the inherit flag (so a confined
 * child cannot simply `CloseHandle` the pin away), and its kernel-reported
 * final DOS path must equal the expected canonical spelling.
 * Any failure — open, verification, or a sharing conflict with a handle some
 * other component already holds — closes every earlier pin in reverse order
 * and refuses, keeping the launch fail-closed before spawn.
 */
export function pinWindowsDenyPaths(native: WindowsNative, roots: readonly string[]): WindowsPathGuard {
  const api = pathGuardBindings(native)
  const chain = denyPathChain(roots)
  const handles: NativePointer[] = []
  try {
    for (const path of chain) {
      const handle = api.createFileW!(
        path, PIN_ACCESS, SHARE_READ_WRITE, null, OPEN_EXISTING, PIN_FLAGS, null)
      if (isInvalidHandle(handle)) {
        throw new Error(`CreateFileW(${path}) failed (Win32 ${api.getLastError!()})`)
      }
      handles.push(handle)
      const identity = readWindowsPathIdentity(api, handle)
      if ((identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new Error(`deny path ancestor is a reparse point: ${path}`)
      }
      if ((identity.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) {
        throw new Error(`deny path ancestor is not a directory: ${path}`)
      }
      const flags = Buffer.alloc(4)
      if (api.getHandleInformation!(handle, flags) === 0) {
        throw new Error(`GetHandleInformation(${path}) failed (Win32 ${api.getLastError!()})`)
      }
      if ((flags.readUInt32LE() & HANDLE_FLAG_INHERIT) !== 0) {
        throw new Error(`deny path handle is inheritable: ${path}`)
      }
      readFinalPathName(api, handle, path)
    }
  } catch (primary) {
    const cleanup = closeAll(api, handles)
    if (cleanup.length > 0) {
      throw new AggregateError(
        [primary instanceof Error ? primary : new Error(String(primary)), ...cleanup],
        primary instanceof Error ? primary.message : String(primary),
      )
    }
    throw primary
  }
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      const errors = closeAll(api, handles)
      if (errors.length > 0) throw new AggregateError(errors, 'WindowsPathGuard close failed')
    },
  }
}
