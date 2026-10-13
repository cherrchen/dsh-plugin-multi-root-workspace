/** Ambient ACL writes minus registered read-only roots (Windows B9).
 *
 * The restricting list mirrors the caller's enabled identities. An inherited
 * mandatory token attribute identifies denied roots to conditional ACEs in
 * the NORMAL access check, so narrowing the SID list cannot discard the deny.
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
import { requestDenyAttribute } from './windows-broker.ts'

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
  const ntdll = native.koffi.load('ntdll.dll')
  const api = native.extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => {
    const definitions: Record<string, [unknown, string, string[]]> = {
      openProcess: [kernel32, 'void*', ['uint32', 'int', 'uint32']],
      openProcessToken: [advapi32, 'int', ['void*', 'uint32', 'void*']],
      getTokenInformation: [advapi32, 'int', ['void*', 'int', 'void*', 'uint32', 'void*']],
      setTokenInformation: [advapi32, 'int', ['void*', 'int', 'void*', 'uint32']],
      ntQuerySecurityAttributesToken: [ntdll, 'int32', ['void*', 'void*', 'uint32', 'void*', 'uint32', 'void*']],
      createRestrictedToken: [advapi32, 'int', ['void*', 'uint32', 'uint32', 'void*', 'uint32', 'void*', 'uint32', 'void*', 'void*']],
      createFileW: [kernel32, 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']],
      convertStringSidToSidW: [advapi32, 'int', ['str16', 'void*']],
      localFree: [kernel32, 'void*', ['void*']],
      getLengthSid: [advapi32, 'uint32', ['void*']],
      equalSid: [advapi32, 'int', ['void*', 'void*']],
      convertSidToStringSidW: [advapi32, 'int', ['void*', 'void*']],
      getSecurityInfo: [advapi32, 'uint32', ['void*', 'int', 'uint32', 'void*', 'void*', 'void*', 'void*', 'void*']],
      setSecurityInfo: [advapi32, 'uint32', ['void*', 'int', 'uint32', 'void*', 'void*', 'void*', 'void*']],
      setEntriesInAclW: [advapi32, 'uint32', ['uint32', 'void*', 'void*', 'void*']],
      convertStringSecurityDescriptorToSecurityDescriptorW: [advapi32, 'int', ['str16', 'uint32', 'void*', 'void*']],
      getSecurityDescriptorDacl: [advapi32, 'int', ['void*', 'void*', 'void*', 'void*']],
      initializeAcl: [advapi32, 'int', ['void*', 'uint32', 'uint32']],
      getAce: [advapi32, 'int', ['void*', 'uint32', 'void*']],
      addAce: [advapi32, 'int', ['void*', 'uint32', 'uint32', 'void*', 'uint32']],
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
    const denies = roots.map(rootDenySid)
    const list = Buffer.alloc(identities.length * 16)
    identities.forEach((value, i) => writePointer(list, i * 16, value))
    const restrictedOut = Buffer.alloc(8)
    // DISABLE_MAX_PRIVILEGE, with a FULL restricting access check. The
    // WRITE_RESTRICTED shortcut does not cover directory rename/delete's
    // parent-access path. Mirroring every ambient enabled identity preserves
    // reads too, so checking every access does not turn this into a read fence.
    check(api.createRestrictedToken!(currentToken, 1, 0, null, 0, null, identities.length, list, restrictedOut), 'CreateRestrictedToken')
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
    // Conditional ACEs inspect an inheritable mandatory LOCAL token attribute,
    // not the removable restricting-SID list. Protected token adjustment keeps
    // the attribute on copied and narrowed tokens while .NET identity queries
    // and impersonation continue to work.
    const allocations: NativePointer[] = []
    const allocate = (data: Buffer): NativePointer => {
      const value = native.koffi.alloc('uint8', data.length)
      allocations.push(value)
      native.koffi.encode(value, 'uint8', data, data.length)
      return value
    }
    const unicode = (value: string): Buffer => {
      const text = Buffer.from(value + '\0', 'utf16le')
      const record = Buffer.alloc(16)
      record.writeUInt16LE(text.length - 2)
      record.writeUInt16LE(text.length, 2)
      writePointer(record, 8, allocate(text))
      return record
    }
    try {
      const attribute = Buffer.alloc(40)
      unicode('DshMultiRootDeniedRoots').copy(attribute)
      attribute.writeUInt16LE(3, 16) // TOKEN_SECURITY_ATTRIBUTE_TYPE_STRING
      attribute.writeUInt32LE(0x20, 20) // MANDATORY; inheritable (no NON_INHERITABLE)
      attribute.writeUInt32LE(denies.length, 24)
      writePointer(attribute, 32, allocate(Buffer.concat(denies.map(unicode))))
      const attributes = Buffer.alloc(16)
      attributes.writeUInt16LE(1)
      attributes.writeUInt32LE(1, 4)
      writePointer(attributes, 8, allocate(attribute))
      const operation = Buffer.alloc(4)
      operation.writeUInt32LE(2) // TOKEN_SECURITY_ATTRIBUTE_OPERATION_ADD
      const input = Buffer.alloc(16)
      writePointer(input, 0, allocate(attributes))
      writePointer(input, 8, allocate(operation))
      if (api.setTokenInformation!(restrictedToken, 39, input, input.length) === 0) {
        const code = api.getLastError!()
        if (code !== 1314) throw new Error(`SetTokenInformation(TokenSecurityAttributes) failed (Win32 ${code})`)
        const sidOut = Buffer.alloc(8)
        check(api.convertSidToStringSidW!(userSid, sidOut), 'ConvertSidToStringSidW')
        const text = pointer(sidOut)
        try {
          await requestDenyAttribute(String(native.koffi.decode(text, 'str16')), native.koffi.address(restrictedToken), denies)
        } finally { api.localFree!(text) }
      }
    } finally { for (const value of allocations) native.koffi.free(value) }
    // Do not trust a pipe ACK alone: verify the mandatory, inheritable kernel
    // attribute before installing any conditional ACE or launching a child.
    // NtQuery returns native UNICODE_STRING records. GetTokenInformation's
    // Win32 claim conversion uses PWSTR records and cannot be decoded with
    // that layout (doing so dereferences flag bits as a pointer).
    const queryName = native.koffi.alloc('uint8', 64)
    let claims: Buffer
    try {
      const nameBytes = Buffer.from('DshMultiRootDeniedRoots\0', 'utf16le')
      native.koffi.encode(queryName, 'uint8', nameBytes, nameBytes.length)
      const name = Buffer.alloc(16)
      name.writeUInt16LE(nameBytes.length - 2)
      name.writeUInt16LE(nameBytes.length, 2)
      writePointer(name, 8, queryName)
      const size = Buffer.alloc(4)
      api.ntQuerySecurityAttributesToken!(restrictedToken, name, 1, null, 0, size)
      const length = size.readUInt32LE()
      if (length < 16 || length > 1024 * 1024) throw new Error('invalid security attribute query size')
      claims = Buffer.alloc(length)
      const code = api.ntQuerySecurityAttributesToken!(restrictedToken, name, 1, claims, length, size)
      if (code !== 0) throw new Error(`NtQuerySecurityAttributesToken failed (NTSTATUS ${code})`)
    } finally { native.koffi.free(queryName) }
    if (claims.readUInt16LE(0) !== 1 || claims.readUInt32LE(4) > 128) throw new Error('invalid token security attributes')
    const claimCount = claims.readUInt32LE(4)
    const claimBytes = Buffer.from(native.koffi.decode(pointer(claims, 8), 'uint8', claimCount * 40) as Uint8Array)
    const readUnicode = (record: Buffer): string => {
      const length = record.readUInt16LE(0)
      if (length > 1024 || length % 2 !== 0) throw new Error('invalid token attribute string')
      return Buffer.from(native.koffi.decode(pointer(record, 8), 'uint8', length) as Uint8Array).toString('utf16le')
    }
    let verified = false
    for (let i = 0; i < claimCount; i++) {
      const claim = claimBytes.subarray(i * 40, (i + 1) * 40)
      if (readUnicode(claim) !== 'DshMultiRootDeniedRoots') continue
      const flags = claim.readUInt32LE(20)
      if (claim.readUInt16LE(16) !== 3 || (flags & 0x20) === 0 || (flags & 0x19) !== 0 || claim.readUInt32LE(24) !== denies.length) {
        throw new Error('deny token attribute is not mandatory and inheritable')
      }
      const values = Buffer.from(native.koffi.decode(pointer(claim, 32), 'uint8', denies.length * 16) as Uint8Array)
      const actual = Array.from({ length: denies.length }, (_, index) => readUnicode(values.subarray(index * 16))).sort()
      if (JSON.stringify(actual) !== JSON.stringify([...denies].sort())) throw new Error('deny token attribute does not match the root set')
      verified = true
    }
    if (!verified) throw new Error('broker did not install the mandatory deny token attribute')
    const tokenAclOut = Buffer.alloc(8)
    status(api.setEntriesInAclW!(3, Buffer.concat([
      entry(userSid, 3, 0x80 | WRITE_DAC | WRITE_OWNER, 0),
      // Permit identity duplication and activation; only attribute/default
      // adjustment and security-descriptor changes must be unavailable.
      entry(userSid, 1, 0x10000000, 0),
      entry(ownerRights, 1, 0x20000, 0),
    ]), null, tokenAclOut), 'SetEntriesInAclW(token)')
    const tokenAcl = pointer(tokenAclOut)
    try {
      status(api.setSecurityInfo!(restrictedToken, 6, 4, null, null, tokenAcl, null), 'SetSecurityInfo(token)')
      // CreateProcess derives a NEW primary-token object. Its security comes
      // from the token's default DACL, not the source token object's DACL.
      // Set both so descendants cannot reopen a freshly cloned token to strip
      // the mandatory deny attribute.
      const defaultDacl = Buffer.alloc(8)
      writePointer(defaultDacl, 0, tokenAcl)
      check(api.setTokenInformation!(restrictedToken, 6, defaultDacl, 8), 'SetTokenInformation(TokenDefaultDacl)')
    }
    finally { api.localFree!(tokenAcl) }
    const tempPath = Buffer.alloc(32768 * 2)
    const tempLength = api.getTempPathW!(32768, tempPath)
    if (tempLength === 0 || tempLength >= 32768) throw new Error('GetTempPathW failed')
    const lockDirectory = join(tempPath.subarray(0, tempLength * 2).toString('utf16le'), 'dsh-acl-locks')
    mkdirSync(lockDirectory, { recursive: true })
    const protect = (path: string, denyId: string, mask: number, inheritance: number): void => {
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
            entry(ownerRights, 1, 0x20000, inheritance),
            entry(owner, 1, WRITE_DAC, inheritance),
          ])
          const mergedOut = Buffer.alloc(8)
          status(api.setEntriesInAclW!(2, edits, oldAcl, mergedOut), `SetEntriesInAclW(${path})`)
          merged = pointer(mergedOut)
          // Keep existing protection/inheritance and every unrelated ACE.
          const descriptorOut = Buffer.alloc(8)
          const flags = inheritance === 3 ? 'OICI' : ''
          const condition = `(Exists DshMultiRootDeniedRoots && DshMultiRootDeniedRoots Contains "${denyId}")`
          check(api.convertStringSecurityDescriptorToSecurityDescriptorW!(
            `D:(XD;${flags};0x${mask.toString(16)};;;WD;${condition})`, 1, descriptorOut, null,
          ), 'ConvertStringSecurityDescriptorToSecurityDescriptorW(conditional deny)')
          const conditionalDescriptor = pointer(descriptorOut)
          try {
            const present = Buffer.alloc(4), acl = Buffer.alloc(8), defaulted = Buffer.alloc(4)
            check(api.getSecurityDescriptorDacl!(conditionalDescriptor, present, acl, defaulted), 'GetSecurityDescriptorDacl')
            const first = Buffer.alloc(8)
            check(api.getAce!(pointer(acl), 0, first), 'GetAce(conditional deny)')
            const header = Buffer.from(native.koffi.decode(pointer(first), 'uint8', 4) as Uint8Array)
            const denyBytes = Buffer.from(native.koffi.decode(pointer(first), 'uint8', header.readUInt16LE(2)) as Uint8Array)
            const existingHeader = Buffer.from(native.koffi.decode(merged, 'uint8', 8) as Uint8Array)
            const count = existingHeader.readUInt16LE(4)
            const others: Buffer[] = []
            for (let index = 0; index < count; index++) {
              const ace = Buffer.alloc(8)
              check(api.getAce!(merged, index, ace), 'GetAce(existing)')
              const h = Buffer.from(native.koffi.decode(pointer(ace), 'uint8', 4) as Uint8Array)
              const bytes = Buffer.from(native.koffi.decode(pointer(ace), 'uint8', h.readUInt16LE(2)) as Uint8Array)
              if (!bytes.equals(denyBytes)) others.push(bytes)
            }
            const size = 8 + denyBytes.length + others.reduce((total, bytes) => total + bytes.length, 0)
            if (size > 65535) throw new Error(`deny ACL exceeds the Windows ACL size limit: ${path}`)
            const combined = Buffer.alloc(size)
            check(api.initializeAcl!(combined, size, 4), 'InitializeAcl')
            for (const bytes of [denyBytes, ...others]) check(api.addAce!(combined, 4, 0xffffffff, bytes, bytes.length), 'AddAce')
            status(api.setSecurityInfo!(handle, 1, 4, null, null, combined, null), `SetSecurityInfo(${path})`)
          } finally { api.localFree!(conditionalDescriptor) }
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
    const walk = (path: string, denyId: string): void => {
      const before = lstatSync(path)
      // Refuse canonical redirection; do not alter another root through a
      // junction or mount point. A successful external target is ambient.
      if (!before.isSymbolicLink() && canonicalPath(path).toLowerCase() !== path.toLowerCase()) throw new Error(`deny subtree redirected: ${path}`)
      protect(path, denyId, MUTATION, before.isDirectory() ? 3 : 0)
      if (!before.isSymbolicLink() && before.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), denyId)
    }
    roots.forEach((root, i) => {
      const denyId = denies[i]!
      walk(root, denyId)
      // Delete can be authorized by the parent rather than the target. Its
      // security edits are guarded too, so the child cannot remove this ACE.
      protect(dirname(root), denyId, FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER, 0)
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
