/** Ambient ACL writes minus registered read-only roots (Windows B9).
 *
 * The restricting list mirrors the caller's enabled identities and adds only
 * deny identities. A second access check therefore preserves ambient DACL
 * grants while those identities match explicit deny ACEs in protected trees.
 * Privileges that could bypass the DACL are removed; integrity is not lowered.
 * Standing ACEs retain the restriction for running children and concurrent
 * snapshots. They are never revoked during runner teardown.
 *
 * OWNER RIGHTS suppresses owner-implicit WRITE_DAC; the actual owner receives
 * that right explicitly so the unrestricted host keeps it. Parent guards stop
 * FILE_DELETE_CHILD and ACL rewrites from bypassing a child's DELETE deny.
 * Protected descendants get explicit ACEs (inherited denies can lose to an
 * explicit allow, or fail to reach a protected DACL). Reparse points are not
 * followed: targets have their own canonical policy and must not be mutated.
 */
import { closeSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { loadWindowsNative, spawnWindowsDeniedChild } from './compat/windows-native.ts'
import type { NativeApi, NativePointer } from './compat/windows-native.ts'
import { canonicalPath, isWindowsNetworkOrDevicePath, rootDenySid } from './windows-runner-contract.ts'

const WRITE_DAC = 0x40000
const WRITE_OWNER = 0x80000
const DELETE = 0x10000
const FILE_DELETE_CHILD = 0x40
// Writes, metadata, delete and security edits; neither read nor synchronize.
const MUTATION = 0x116 | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER

export async function runWindowsDenied(
  upstreamRunner: string,
  roots: readonly string[],
  argv: readonly string[],
): Promise<number> {
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Windows ambient restriction requires a 64-bit process')
  const verifyRoots = (): void => {
    for (const root of roots) {
      if (!isAbsolute(root) || isWindowsNetworkOrDevicePath(root)) throw new Error(`unsupported deny root: ${root}`)
      if (!statSync(root).isDirectory() || canonicalPath(root).toLowerCase() !== root.toLowerCase()) {
        throw new Error(`deny root was removed or redirected: ${root}`)
      }
    }
  }
  verifyRoots()
  const native = await loadWindowsNative(upstreamRunner)
  const api = native.extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => {
    const definitions: Record<string, [unknown, string, string[]]> = {
      openProcess: [kernel32, 'void*', ['uint32', 'int', 'uint32']],
      openProcessToken: [advapi32, 'int', ['void*', 'uint32', 'void*']],
      getTokenInformation: [advapi32, 'int', ['void*', 'int', 'void*', 'uint32', 'void*']],
      createRestrictedToken: [advapi32, 'int', ['void*', 'uint32', 'uint32', 'void*', 'uint32', 'void*', 'uint32', 'void*', 'void*']],
      createFileW: [kernel32, 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']],
      convertStringSidToSidW: [advapi32, 'int', ['str16', 'void*']],
      localFree: [kernel32, 'void*', ['void*']],
      getLengthSid: [advapi32, 'uint32', ['void*']],
      equalSid: [advapi32, 'int', ['void*', 'void*']],
      getSecurityInfo: [advapi32, 'uint32', ['void*', 'int', 'uint32', 'void*', 'void*', 'void*', 'void*', 'void*']],
      setSecurityInfo: [advapi32, 'uint32', ['void*', 'int', 'uint32', 'void*', 'void*', 'void*', 'void*']],
      setEntriesInAclW: [advapi32, 'uint32', ['uint32', 'void*', 'void*', 'void*']],
      getTempPathW: [kernel32, 'uint32', ['uint32', 'void*']],
      lockFileEx: [kernel32, 'int', ['void*', 'uint32', 'uint32', 'uint32', 'uint32', 'void*']],
      unlockFileEx: [kernel32, 'int', ['void*', 'uint32', 'uint32', 'uint32', 'void*']],
    }
    return Object.fromEntries(Object.entries(definitions).map(([name, [library, result, args]]) =>
      [name, bind(library, name[0]!.toUpperCase() + name.slice(1), result, args)])) as NativeApi
  })
  const pointer = (buffer: Buffer, offset = 0): NativePointer => native.koffi.decode(buffer.subarray(offset), 'void*')
  const check = (ok: number, name: string): void => {
    if (ok === 0) throw new Error(`${name} failed (Win32 ${api.getLastError!()})`)
  }
  const status = (code: number, name: string): void => {
    if (code !== 0) throw new Error(`${name} failed (Win32 ${code})`)
  }
  const parsedSids: NativePointer[] = []
  const sid = (text: string): NativePointer => {
    const out = Buffer.alloc(8)
    check(api.convertStringSidToSidW!(text, out), 'ConvertStringSidToSidW')
    const value = pointer(out)
    parsedSids.push(value)
    return value
  }
  const writePointer = (buffer: Buffer, offset: number, value: NativePointer): void => {
    buffer.writeBigUInt64LE(native.koffi.address(value), offset)
  }
  const info = (token: NativePointer, cls: number): Buffer => {
    const size = Buffer.alloc(4)
    api.getTokenInformation!(token, cls, null, 0, size)
    const length = size.readUInt32LE()
    if (length < 8 || length > 1024 * 1024) throw new Error(`invalid TokenInformation size: ${length}`)
    const data = Buffer.alloc(length)
    check(api.getTokenInformation!(token, cls, data, length, size), 'GetTokenInformation')
    return data
  }
  // Keep query buffers alive: SID_AND_ATTRIBUTES points into those buffers.
  const retained: Buffer[] = []
  let currentToken: NativePointer
  let restrictedToken: NativePointer
  try {
    const processHandle = api.openProcess!(0x400, 0, process.pid)
    check(Number(processHandle !== null && processHandle !== 0), 'OpenProcess')
    const out = Buffer.alloc(8)
    try { check(api.openProcessToken!(processHandle, WRITE_DAC | 0x8b, out), 'OpenProcessToken') }
    finally { check(api.closeHandle!(processHandle), 'CloseHandle(process)') }
    currentToken = pointer(out)
    const user = info(currentToken, 1)
    const groups = info(currentToken, 2)
    retained.push(user, groups)
    const userSid = pointer(user)
    const identities: NativePointer[] = [userSid]
    const owners: NativePointer[] = [userSid]
    const count = groups.readUInt32LE()
    if (count > (groups.length - 8) / 16) throw new Error('truncated TokenGroups')
    for (let i = 0; i < count; i++) {
      const offset = 8 + i * 16
      const attributes = groups.readUInt32LE(offset + 8)
      // Disabled and deny-only groups must never supply new write authority.
      if ((attributes & 4) === 0 || (attributes & 0x10) !== 0) continue
      const group = pointer(groups, offset)
      identities.push(group)
      if ((attributes & 8) !== 0) owners.push(group)
    }
    const ownerRights = sid('S-1-3-4')
    const denies = roots.map(root => sid(rootDenySid(root)))
    identities.push(...denies)
    const list = Buffer.alloc(identities.length * 16)
    identities.forEach((value, i) => writePointer(list, i * 16, value))
    const restrictedOut = Buffer.alloc(8)
    // DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED. Keep ambient groups and IL;
    // remove backup/restore/take-owner privileges that bypass file DACLs.
    check(api.createRestrictedToken!(currentToken, 9, 0, null, 0, null, identities.length, list, restrictedOut), 'CreateRestrictedToken')
    restrictedToken = pointer(restrictedOut)

    const entry = (trustee: NativePointer, mode: number, mask: number, inheritance: number): Buffer => {
      const data = Buffer.alloc(48)
      data.writeUInt32LE(mask, 0)
      data.writeUInt32LE(mode, 4)
      data.writeUInt32LE(inheritance, 8)
      // TRUSTEE_IS_SID = 0; TRUSTEE_IS_UNKNOWN = 0.
      writePointer(data, 40, trustee)
      return data
    }
    // Restricting SIDs can be intersected away by CreateRestrictedToken. Lock
    // the token object before spawning: children may query it, but cannot
    // duplicate, assign, adjust, or rewrite its security descriptor. The
    // runner keeps its already-open handle for CreateProcessAsUserW.
    const tokenAclOut = Buffer.alloc(8)
    status(api.setEntriesInAclW!(3, Buffer.concat([
      entry(userSid, 3, 0x1e7 | WRITE_DAC | WRITE_OWNER, 0),
      entry(userSid, 1, 0x20018, 0),
      entry(ownerRights, 1, 0x20000, 0),
    ]), null, tokenAclOut), 'SetEntriesInAclW(token)')
    const tokenAcl = pointer(tokenAclOut)
    try { status(api.setSecurityInfo!(restrictedToken, 6, 4, null, null, tokenAcl, null), 'SetSecurityInfo(token)') }
    finally { api.localFree!(tokenAcl) }
    const tempPath = Buffer.alloc(32768 * 2)
    const tempLength = api.getTempPathW!(32768, tempPath)
    if (tempLength === 0 || tempLength >= 32768) throw new Error('GetTempPathW failed')
    const lockDirectory = join(tempPath.subarray(0, tempLength * 2).toString('utf16le'), 'dsh-acl-locks')
    mkdirSync(lockDirectory, { recursive: true })
    const protect = (path: string, denySid: NativePointer, mask: number, inheritance: number): void => {
      // Same path-lock protocol as the upstream ACL writer (local port, no
      // private import), so a concurrent allow grant cannot erase this deny.
      const lockPath = join(lockDirectory, `${createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)}.lock`)
      const lock = api.createFileW!(lockPath, 0xc0000000, 3, null, 4, 0, null)
      if (lock === null || BigInt(lock) === -1n || BigInt(lock) === 0xffffffffffffffffn) throw new Error(`CreateFileW(lock) failed (Win32 ${api.getLastError!()})`)
      const overlapped = native.koffi.alloc('uint8', 32)
      native.koffi.encode(overlapped, 'uint8', Buffer.alloc(32), 32)
      let held = false
      try {
        check(api.lockFileEx!(lock, 2, 0, 1, 0, overlapped), `LockFileEx(${path})`)
        held = true
        const ownerOut = Buffer.alloc(8)
        const aclOut = Buffer.alloc(8)
        const sdOut = Buffer.alloc(8)
        // Edit the reparse point itself, never its target. The handle remains
        // open through the whole ACL merge, even if the lexical path moves.
        const handle = api.createFileW!(path, 0x60000, 7, null, 3, 0x02200000, null)
        if (handle === null || BigInt(handle) === -1n || BigInt(handle) === 0xffffffffffffffffn) {
          throw new Error(`CreateFileW(${path}) failed (Win32 ${api.getLastError!()})`)
        }
        try { status(api.getSecurityInfo!(handle, 1, 5, ownerOut, null, aclOut, null, sdOut), `GetSecurityInfo(${path})`) }
        catch (error) { api.closeHandle!(handle); throw error }
        const descriptor = pointer(sdOut)
        let merged: NativePointer
        try {
          const owner = pointer(ownerOut)
          if (!owners.some(value => api.equalSid!(owner, value) !== 0)) throw new Error(`deny ACL requires caller-owned path: ${path}`)
          // A null DACL allows everyone. Turning it into a finite ACL would
          // change ambient permissions, so refuse rather than approximate it.
          const oldAcl = pointer(aclOut)
          if (oldAcl === null || oldAcl === 0n) throw new Error(`deny ACL cannot preserve a null DACL: ${path}`)
          const edits = Buffer.concat([
            entry(denySid, 3, mask, inheritance),
            entry(ownerRights, 1, 0x20000, inheritance),
            entry(owner, 1, WRITE_DAC, inheritance),
          ])
          const mergedOut = Buffer.alloc(8)
          status(api.setEntriesInAclW!(3, edits, oldAcl, mergedOut), `SetEntriesInAclW(${path})`)
          merged = pointer(mergedOut)
          // Keep existing protection/inheritance and every unrelated ACE.
          status(api.setSecurityInfo!(handle, 1, 4, null, null, merged, null), `SetSecurityInfo(${path})`)
        } finally {
          if (merged !== undefined) api.localFree!(merged)
          api.localFree!(descriptor)
          check(api.closeHandle!(handle), 'CloseHandle(path)')
        }
      } finally {
        try { if (held) check(api.unlockFileEx!(lock, 0, 1, 0, overlapped), 'UnlockFileEx') }
        finally { native.koffi.free(overlapped); check(api.closeHandle!(lock), 'CloseHandle(lock)') }
      }
    }
    const walk = (path: string, denySid: NativePointer): void => {
      const before = lstatSync(path)
      // Refuse canonical redirection; do not alter another root through a
      // junction or mount point. A successful external target is ambient.
      if (!before.isSymbolicLink() && canonicalPath(path).toLowerCase() !== path.toLowerCase()) throw new Error(`deny subtree redirected: ${path}`)
      protect(path, denySid, MUTATION, before.isDirectory() ? 3 : 0)
      if (!before.isSymbolicLink() && before.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), denySid)
    }
    roots.forEach((root, i) => {
      const denySid = denies[i]!
      walk(root, denySid)
      // Delete can be authorized by the parent rather than the target. Its
      // security edits are guarded too, so the child cannot remove this ACE.
      protect(dirname(root), denySid, FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER, 0)
    })
    verifyRoots()
    // No temporary directory or environment rewrite: ambient temp semantics.
    process.on('SIGINT', () => {})
    const control = process.env.DSH_SUBPROCESS_CONTROL === 'pipe'
    const child = spawnWindowsDeniedChild(native, api, {
      token: restrictedToken, command: argv[0]!, args: argv.slice(1), cwd: process.cwd(),
      ...(control ? { controlFileDescriptor: 7 as const } : {}),
    })
    if (control) closeSync(7)
    try { return native.waitForProcessExit(api, child.process) }
    finally { check(api.closeHandle!(child.job), 'CloseHandle(job)') }
  } finally {
    if (restrictedToken !== undefined) check(api.closeHandle!(restrictedToken), 'CloseHandle(restricted token)')
    if (currentToken !== undefined) check(api.closeHandle!(currentToken), 'CloseHandle(token)')
    for (const value of parsedSids) api.localFree!(value)
    // Buffers must stay reachable through the last native use of their SIDs.
    retained.length = 0
  }
}
