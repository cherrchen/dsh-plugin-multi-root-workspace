/** Windows deny-tree preflight (branch-review Phase C1, R4).
 *
 * A deny ACE written through `SetSecurityInfo` lands on the file OBJECT — for
 * a hardlinked file every other link carries the same object, so a partial
 * ACL walk would have already mutated paths outside the denied tree by the
 * time a later hardlink is discovered. This module therefore scans EVERY deny
 * root and descendant — read-only, no ACL edits anywhere — before the runner
 * is allowed to request a token or touch a security descriptor. Any
 * uninspectable node or any plain file with more than one link refuses the
 * whole startup (exit 127 before side effects).
 *
 * The policy is conservative: `links > 1` fails even when every link appears
 * to live inside the same scanned tree, because the snapshot cannot prove
 * that topology (a link may be added or moved between scan and mutation).
 * Reparse points are recorded but never descended — a junction's target is a
 * different tree with its own policy and must not be scanned or mutated.
 *
 * `verifyHandle` re-checks identity on the same live handle about to be
 * ACL-mutated: a path replaced between scan and mutation fails closed rather
 * than writing a deny onto an object the preflight never inspected. This is
 * not transactional — a malicious concurrent mutation can still race between
 * the recheck and the write — but it closes the far cheaper
 * replace-between-scan-and-write window.
 *
 * Primitives are bound through the public `extendWin32ProcessBindings` seam;
 * only Node built-ins and local contract/native modules are imported.
 */
import { readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { canonicalPath } from '../windows-runner-contract.ts'
import { readWindowsPathIdentity } from './windows-path-guard.ts'
import type { WindowsPathIdentity } from './windows-path-guard.ts'
import type { NativeApi, NativeFunction, NativePointer, WindowsNative } from './windows-native.ts'

// Metadata-only access is enough for inspection: the preflight does not pin
// anything (the path guard's pins already hold the tree's spelling).
const FILE_READ_ATTRIBUTES = 0x80
// Read+write+delete sharing: the scan must never block other processes.
const INSPECTION_SHARE = 7
const OPEN_EXISTING = 3
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const OPEN_FLAGS = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const KIND_BITS = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
const FILE_TYPE_DISK = 1
const INVALID_HANDLE = BigInt('0xFFFFFFFFFFFFFFFF')

const invalid = (handle: NativePointer): boolean =>
  handle === null || handle === undefined
  || BigInt(handle as bigint) === INVALID_HANDLE || BigInt(handle as bigint) === -1n

export interface DenyPreflightEntry {
  /** The deny root (canonical spelling) this entry was scanned under. */
  readonly root: string
  /** The entry's full path spelling as walked — the key lowercased. */
  readonly path: string
  readonly identity: WindowsPathIdentity
}

export interface WindowsDenyPreflight {
  /** Every scanned node in depth-first insertion order, keyed `path.toLowerCase()`. */
  readonly entries: ReadonlyMap<string, DenyPreflightEntry>
  /** Refuse if the live handle's identity differs from the snapshot. */
  verifyHandle(api: NativeApi, path: string, handle: NativePointer): void
}

const kindOf = (root: string, protectedHome: string | undefined): string =>
  protectedHome !== undefined && root.toLowerCase() === protectedHome.toLowerCase()
    ? 'protected DSH home'
    : 'registered root'

const hardlinkError = (root: string, path: string, links: number, protectedHome: string | undefined): Error => {
  const kind = kindOf(root, protectedHome)
  const remedy = kind === 'protected DSH home'
    ? 'replace the file with an independent copy — run `/workspace-folders isolate-profiles` to isolate the protected home, then reinstall the profile dependencies (do not skip this file)'
    : 'replace the file with an independent copy (write its contents to a new file and rename that over it, or reinstall the dependency tree as copies)'
  return new Error(
    `hardlinked file inside the ${kind} ${root}: ${path} has links=${links}; ` +
    `a deny ACL written on one link mutates every link's shared object — ${remedy}`)
}

/**
 * Scan every root recursively. The returned snapshot keys every node by its
 * lowercased walked spelling; a later same-key path (shared subtree) keeps
 * the first entry and is not re-scanned.
 */
export function preflightWindowsDenyRoots(
  native: WindowsNative,
  roots: readonly string[],
  protectedHome?: string,
): WindowsDenyPreflight {
  const api = native.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createFileW: bind(kernel32, 'CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']) as NativeFunction,
    getFileInformationByHandle: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void*', 'void*']) as NativeFunction,
    getFileType: bind(kernel32, 'GetFileType', 'uint32', ['void*']) as NativeFunction,
    closeHandle: bind(kernel32, 'CloseHandle', 'int', ['void*']) as NativeFunction,
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []) as NativeFunction,
  }))
  const entries = new Map<string, DenyPreflightEntry>()

  /**
   * Open, identify, record, then close — the handle never outlives the node.
   * Every failure names the root and the path; a close failure is reported on
   * its own when it is the only error and aggregated (never masking) when the
   * inspection itself already failed.
   */
  const inspect = (root: string, path: string): WindowsPathIdentity => {
    const handle = api.createFileW!(path, FILE_READ_ATTRIBUTES, INSPECTION_SHARE, 0, OPEN_EXISTING, OPEN_FLAGS, 0)
    if (invalid(handle)) {
      throw new Error(`deny preflight cannot inspect ${path} under root ${root}: CreateFileW Win32 ${api.getLastError!()}`)
    }
    let primary: Error | undefined
    let identity: WindowsPathIdentity | undefined
    try {
      identity = readWindowsPathIdentity(api, handle)
      if ((identity.attributes & KIND_BITS) === 0) {
        if (api.getFileType!(handle) !== FILE_TYPE_DISK) {
          throw new Error(`deny preflight refuses non-disk file ${path} under root ${root}`)
        }
        // Plain files with more than one name refuse the entire startup: an
        // ACL write mutates the shared object under every link, inside and
        // outside the denied tree alike.
        if (identity.links > 1) throw hardlinkError(root, path, identity.links, protectedHome)
      }
    } catch (error) {
      primary = error instanceof Error ? error : new Error(String(error))
    }
    const closed = api.closeHandle!(handle) !== 0
    if (primary !== undefined) {
      if (!closed) {
        throw new AggregateError([primary, new Error(`CloseHandle failed on the inspection handle: Win32 ${api.getLastError!()}`)],
          `deny preflight failed for ${path} under root ${root} and its cleanup also failed`)
      }
      throw primary
    }
    if (!closed) {
      throw new Error(`deny preflight cannot close the inspection handle for ${path} under root ${root}: Win32 ${api.getLastError!()}`)
    }
    return identity!
  }

  const scanNode = (root: string, path: string): void => {
    const key = path.toLowerCase()
    if (entries.has(key)) return
    const identity = inspect(root, path)
    entries.set(key, { root, path, identity })
    // Files and reparse points are leaves — a reparse point that reports
    // directory attributes still names a different tree and is never
    // descended into.
    if ((identity.attributes & KIND_BITS) !== FILE_ATTRIBUTE_DIRECTORY) return
    // A directory reached only through an alias would descend a different
    // object than its spelling names — refuse rather than guess.
    const canonical = canonicalPath(path)
    if (win32.normalize(canonical).toLowerCase() !== key) {
      throw new Error(`deny preflight refuses aliased directory ${path} under root ${root}: resolves to ${canonical}`)
    }
    let names: string[]
    try { names = readdirSync(path).sort() }
    catch (error) {
      throw new Error(`deny preflight cannot list ${path} under root ${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const name of names) scanNode(root, win32.join(path, name))
  }

  for (const root of roots) {
    const canonicalRoot = win32.normalize(canonicalPath(root))
    const identity = inspect(canonicalRoot, canonicalRoot)
    // The path guard already pins directories-only ancestors; re-assert here
    // so this scan's contract stands on its own.
    if ((identity.attributes & KIND_BITS) !== FILE_ATTRIBUTE_DIRECTORY) {
      throw new Error(`deny preflight refuses root ${canonicalRoot}: it must be a plain directory`)
    }
    entries.set(canonicalRoot.toLowerCase(), { root: canonicalRoot, path: canonicalRoot, identity })
    let names: string[]
    try { names = readdirSync(canonicalRoot).sort() }
    catch (error) {
      throw new Error(`deny preflight cannot list root ${canonicalRoot}: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const name of names) scanNode(canonicalRoot, win32.join(canonicalRoot, name))
  }

  return {
    entries,
    verifyHandle(liveApi: NativeApi, path: string, handle: NativePointer): void {
      const entry = entries.get(path.toLowerCase())
      if (entry === undefined) {
        throw new Error(`deny preflight has no snapshot for ${path} — refusing to mutate an uninspected path`)
      }
      let fresh: WindowsPathIdentity
      try { fresh = readWindowsPathIdentity(liveApi, handle) }
      catch (error) {
        throw new Error(`deny preflight cannot re-verify ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if ((fresh.attributes & KIND_BITS) !== (entry.identity.attributes & KIND_BITS)) {
        throw new Error(`deny preflight refuses ${entry.path}: attributes changed since the scan ` +
          `(was 0x${entry.identity.attributes.toString(16)}, now 0x${fresh.attributes.toString(16)})`)
      }
      if (fresh.volumeSerial !== entry.identity.volumeSerial || fresh.fileIndex !== entry.identity.fileIndex) {
        throw new Error(`deny preflight refuses ${entry.path}: the path was replaced by a different file object since the scan`)
      }
      const plainFile = (entry.identity.attributes & KIND_BITS) === 0
      if (plainFile && fresh.links !== 1) {
        throw hardlinkError(entry.root, entry.path, fresh.links, protectedHome)
      }
    },
  }
}
