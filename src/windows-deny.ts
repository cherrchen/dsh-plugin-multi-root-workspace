/** Ambient ACL writes minus registered read-only roots (Windows B9).
 *
 * The restricting list mirrors the caller's enabled identities. Inherited
 * deny-only NORMAL groups identify denied roots to ordinary deny ACEs in
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
import { closeSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { loadWindowsNative, readWindowsWideString, spawnWindowsDeniedChild, terminateWindowsJobAndWait } from './compat/windows-native.ts'
import type { NativeApi, NativePointer } from './compat/windows-native.ts'
import { preflightWindowsDenyRoots } from './compat/windows-deny-preflight.ts'
import { pinWindowsDenyPaths } from './compat/windows-path-guard.ts'
import type { WindowsPathGuard } from './compat/windows-path-guard.ts'
import { assertWindowsDenyCapacity, canonicalPath, isWindowsNetworkOrDevicePath, rootDenySid } from './windows-runner-contract.ts'
import { assignDenyToken, requestDenyToken } from './windows-broker.ts'

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
  protectedHome?: string,
): Promise<number> {
  assertWindowsDenyCapacity(roots.length)
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
      setTokenInformation: [advapi32, 'int', ['void*', 'int', 'void*', 'uint32']],
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
      getFileInformationByHandle: [kernel32, 'int', ['void*', 'void*']],
      convertStringSecurityDescriptorToSecurityDescriptorW: [advapi32, 'int', ['str16', 'uint32', 'void*', 'void*']],
      getSecurityDescriptorDacl: [advapi32, 'int', ['void*', 'void*', 'void*', 'void*']],
      initializeAcl: [advapi32, 'int', ['void*', 'uint32', 'uint32']],
      getAce: [advapi32, 'int', ['void*', 'uint32', 'void*']],
      addAce: [advapi32, 'int', ['void*', 'uint32', 'uint32', 'void*', 'uint32']],
      getTempPathW: [kernel32, 'uint32', ['uint32', 'void*']],
      getPackageFullName: [kernel32, 'int32', ['void*', 'void*', 'void*']],
      writeFile: [kernel32, 'int', ['void*', 'void*', 'uint32', 'void*', 'void*']],
      readFile: [kernel32, 'int', ['void*', 'void*', 'uint32', 'void*', 'void*']],
      peekNamedPipe: [kernel32, 'int', ['void*', 'void*', 'uint32', 'void*', 'void*', 'void*']],
      sleep: [kernel32, 'void', ['uint32']],
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
  let pathGuard: WindowsPathGuard | undefined
  let primary: unknown
  let threw = false
  let exitCode = 0
  try {
    // Pin every ancestor of every deny root BEFORE any token request or ACL
    // edit. The deny ACEs follow each file object through a rename — but the
    // registered boundary does not: a restricted child that renames an
    // ancestor moves the protected tree to a NEW path the recorded deny set
    // does not name, and the host fs fence (which matches recorded spellings)
    // then no longer covers the moved objects. The pins stay held until the
    // Job has drained (below).
    pathGuard = pinWindowsDenyPaths(native, roots)
    // Scan EVERY deny root and descendant before any token request, ACL edit,
    // or lock work: a deny ACE lands on the file object, so a hardlinked file
    // would mutate under every link — discovering it mid-walk would already
    // have rewritten paths outside the tree. The scan is read-only; any
    // uninspectable node or multi-link file refuses the launch here, before
    // the first side effect. This is NOT transactional: a malicious
    // concurrent external mutation can still race between the scan (and the
    // per-handle recheck in `protect`) and each write — the zero-side-effect
    // guarantee covers preflight failures, not every possible race.
    const preflight = preflightWindowsDenyRoots(native, roots, protectedHome)
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
    const sidOut = Buffer.alloc(8)
    check(api.convertSidToStringSidW!(userSid, sidOut), 'ConvertSidToStringSidW')
    const text = pointer(sidOut)
    let minted: NativePointer
    let brokerUser: string
    try {
      brokerUser = readWindowsWideString(native.koffi, text)
      const handle = await requestDenyToken(brokerUser, native.koffi.address(currentToken), denies)
      const bytes = Buffer.alloc(8)
      bytes.writeBigUInt64LE(handle)
      minted = pointer(bytes)
    } finally { api.localFree!(text) }
    const restrictedOut = Buffer.alloc(8)
    try {
      // Preserve ambient identities, remove bypass privileges, and mark this as
      // a restricted token whose normal deny groups can be checked before ACL edits.
      check(api.createRestrictedToken!(minted, 1, 0, null, 0, null, identities.length, list, restrictedOut), 'CreateRestrictedToken')
    } finally { api.closeHandle!(minted) }
    restrictedToken = pointer(restrictedOut)
    // Verify the kernel NORMAL group list, never trust a broker ACK alone.
    const verifyDenyGroups = (token: NativePointer): void => {
      const denyGroups = info(token, 2)
      const denyCount = denyGroups.readUInt32LE()
      if (denyCount > (denyGroups.length - 8) / 16) throw new Error('truncated deny TokenGroups')
      const verified = new Set<string>()
      for (let i = 0; i < denyCount; i++) {
        const offset = 8 + i * 16
        const flags = denyGroups.readUInt32LE(offset + 8)
        if ((flags & 0x10) === 0 || (flags & 6) !== 0) continue
        const valueOut = Buffer.alloc(8)
        check(api.convertSidToStringSidW!(pointer(denyGroups, offset), valueOut), 'ConvertSidToStringSidW(group)')
        const value = pointer(valueOut)
        try { verified.add(readWindowsWideString(native.koffi, value)) } finally { api.localFree!(value) }
      }
      if (denies.some(id => !verified.has(id))) throw new Error('broker did not install the deny-only normal groups')
    }
    verifyDenyGroups(restrictedToken)

    const entry = (trustee: NativePointer, mode: number, mask: number, inheritance: number): Buffer => {
      const data = Buffer.alloc(48)
      data.writeUInt32LE(mask, 0)
      data.writeUInt32LE(mode, 4)
      data.writeUInt32LE(inheritance, 8)
      // TRUSTEE_IS_SID = 0; TRUSTEE_IS_UNKNOWN = 0.
      writePointer(data, 40, trustee)
      return data
    }
    const tokenAclOut = Buffer.alloc(8)
    status(api.setEntriesInAclW!(3, Buffer.concat([
      entry(userSid, 3, 0x20 | 0x40 | 0x80 | WRITE_DAC | WRITE_OWNER, 0),
      // Permit identity duplication and activation; only group/privilege/default
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
      // the deny-only groups.
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
    const protect = (path: string, denyId: string, mask: number, inheritance: number, verifyContent = true): void => {
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
        // The live handle must still be the object the preflight inspected:
        // same volume serial and file index, same directory/reparse kind, and
        // still a single link for plain files. A path replaced since the scan
        // fails closed rather than denying an uninspected object. The parent
        // guard outside the denied trees is exempt — it has no snapshot.
        if (verifyContent) {
          try { preflight.verifyHandle(api, path, handle) }
          catch (error) { api.closeHandle!(handle); throw error }
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
          check(api.convertStringSecurityDescriptorToSecurityDescriptorW!(
            `D:(D;${flags};0x${mask.toString(16)};;;${denyId})`, 1, descriptorOut, null,
          ), 'ConvertStringSecurityDescriptorToSecurityDescriptorW(normal-group deny)')
          const conditionalDescriptor = pointer(descriptorOut)
          try {
            const present = Buffer.alloc(4), acl = Buffer.alloc(8), defaulted = Buffer.alloc(4)
            check(api.getSecurityDescriptorDacl!(conditionalDescriptor, present, acl, defaulted), 'GetSecurityDescriptorDacl')
            const first = Buffer.alloc(8)
            check(api.getAce!(pointer(acl), 0, first), 'GetAce(normal-group deny)')
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
            if (verifyContent) preflight.verifyHandle(api, path, handle)
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
    // Direct-child names per scanned directory — the check below compares a
    // fresh listing against these before writing inheritable denies, because
    // an object-inherit ACE reaches whatever children exist at write time.
    const expectedChildren = new Map<string, Set<string>>()
    for (const scanned of preflight.entries.values()) {
      const parent = dirname(scanned.path).toLowerCase()
      if (parent === scanned.path.toLowerCase()) continue
      const names = expectedChildren.get(parent) ?? new Set<string>()
      names.add(basename(scanned.path))
      expectedChildren.set(parent, names)
    }
    const denyIdFor = new Map(roots.map((root, i) => [root.toLowerCase(), denies[i]!]))
    // Mutate exactly the inspected tree: the snapshot, not a fresh lstat,
    // decides what is a directory (and therefore which entries carry the
    // object-inherit deny), and no path outside it is ever opened for
    // mutation — a reparse point is denied on itself, never descended into.
    for (const scanned of preflight.entries.values()) {
      const isPlainDirectory = (scanned.identity.attributes & (0x10 | 0x400)) === 0x10
      if (isPlainDirectory) {
        let names: string[]
        try { names = readdirSync(scanned.path).sort() }
        catch (error) {
          throw new Error(`deny tree changed during ACL writes: cannot list ${scanned.path} (${error instanceof Error ? error.message : String(error)})`)
        }
        const expected = expectedChildren.get(scanned.path.toLowerCase()) ?? new Set<string>()
        if (names.length !== expected.size || names.some(name => !expected.has(name))) {
          throw new Error(`deny tree changed since the preflight scan: ${scanned.path}`)
        }
      }
      protect(scanned.path, denyIdFor.get(scanned.root.toLowerCase())!, MUTATION, isPlainDirectory ? 3 : 0)
    }
    roots.forEach((root, i) => {
      // Delete can be authorized by the parent rather than the target. Its
      // security edits are guarded too, so the child cannot remove this ACE.
      // The parent lives OUTSIDE the denied tree — no preflight snapshot, no
      // verifyHandle, and no OICI inheritance.
      protect(dirname(root), denies[i]!, FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER, 0, false)
    })
    verifyRoots()
    // No temporary directory or environment rewrite: ambient temp semantics.
    process.on('SIGINT', () => {})
    const control = process.env.DSH_SUBPROCESS_CONTROL === 'pipe'
    const child = spawnWindowsDeniedChild(native, api, {
      token: restrictedToken, command: argv[0]!, args: argv.slice(1), cwd: process.cwd(),
      ...(control ? { controlFileDescriptor: 7 as const } : {}),
    }, {
      sourceToken: currentToken,
      assign(child, thread) {
        // A packaged (MSIX / Store) child carries a package identity the minted
        // deny token cannot preserve; refuse with an actionable diagnosis rather
        // than the broker's opaque NtCompareTokens mismatch.
        const packageNameLength = Buffer.alloc(4)
        const packageProbe = api.getPackageFullName!(child, packageNameLength, null)
        if (packageProbe === 122) { // ERROR_INSUFFICIENT_BUFFER: the child IS packaged
          const nameBuffer = Buffer.alloc(packageNameLength.readUInt32LE() * 2)
          const read = api.getPackageFullName!(child, packageNameLength, nameBuffer)
          const fullName = read === 0
            ? nameBuffer.subarray(0, (packageNameLength.readUInt32LE() - 1) * 2).toString('utf16le')
            : `<unreadable, Win32 ${read}>`
          throw new Error(
            `deny launch refused: ${argv[0]} started as packaged (MSIX/Microsoft Store) application ${fullName}; `
            + 'a packaged process carries a package identity the deny token cannot preserve. '
            + 'Install the MSI or ZIP build of PowerShell (or use a non-packaged executable) '
            + 'and put it ahead of the WindowsApps alias on PATH',
          )
        }
        if (packageProbe !== 15700) { // APPMODEL_ERROR_NO_PACKAGE: ordinary non-packaged child
          throw new Error(`GetPackageFullName(child) failed (Win32 ${packageProbe})`)
        }
        assignDenyToken(brokerUser, native.koffi.address(child), native.koffi.address(thread), denies, {
          open(pipe) {
            const handle = api.createFileW!(pipe, 0xc0000000, 0, null, 3, 0, null)
            if (handle === null || BigInt(handle) === -1n || BigInt(handle) === 0xffffffffffffffffn) {
              throw new Error(`Open broker assignment pipe failed (Win32 ${api.getLastError!()})`)
            }
            return handle
          },
          write(pipe, bytes) {
            const count = Buffer.alloc(4)
            check(api.writeFile!(pipe, bytes, bytes.length, count, null), 'WriteFile(broker)')
            if (count.readUInt32LE() !== bytes.length) throw new Error('incomplete broker assignment write')
          },
          available(pipe) {
            const count = Buffer.alloc(4)
            check(api.peekNamedPipe!(pipe, null, 0, null, count, null), 'PeekNamedPipe(broker)')
            return count.readUInt32LE()
          },
          read(pipe, length) {
            const data = Buffer.alloc(length), count = Buffer.alloc(4)
            check(api.readFile!(pipe, data, length, count, null), 'ReadFile(broker)')
            if (count.readUInt32LE() === 0) throw new Error('broker assignment disconnected')
            return data.subarray(0, count.readUInt32LE())
          },
          pause() { api.sleep!(10) },
          close(pipe) { api.closeHandle!(pipe) },
        })
        const out = Buffer.alloc(8)
        check(api.openProcessToken!(child, 8, out), 'OpenProcessToken(assigned child)')
        const token = pointer(out)
        try { verifyDenyGroups(token) } finally { api.closeHandle!(token) }
      },
    })
    let waitError: unknown
    let waitThrew = false
    // `waitForProcessExit` owns and closes the process handle once called;
    // before that call the handle is still ours to close on teardown.
    let waited = false
    try {
      // Even a control-pipe close failure must drain the Job below.
      if (control) closeSync(7)
      waited = true
      exitCode = native.waitForProcessExit(api, child.process)
    } catch (error) {
      waitError = error
      waitThrew = true
    }
    // `waitForProcessExit` covered the direct child only; the kill-on-close
    // Job may still host descendants it spawned before exiting. Terminate
    // and drain the Job while the ancestor pins are still held — a surviving
    // descendant must never see a window where a rename is unblocked but its
    // restricted token still runs. Both teardown steps run even when the
    // first fails, and a drain error never erases a wait error.
    const drainErrors: Error[] = []
    try { terminateWindowsJobAndWait(native, api, child.job) }
    catch (error) { drainErrors.push(error instanceof Error ? error : new Error(String(error))) }
    try { check(api.closeHandle!(child.job), 'CloseHandle(job)') }
    catch (error) { drainErrors.push(error instanceof Error ? error : new Error(String(error))) }
    if (!waited) {
      // The wait helper never took ownership — the direct-child handle is
      // still open and must not leak.
      try { check(api.closeHandle!(child.process), 'CloseHandle(child process)') }
      catch (error) { drainErrors.push(error instanceof Error ? error : new Error(String(error))) }
    }
    if (waitThrew || drainErrors.length > 0) {
      const all = [
        ...(waitThrew ? [waitError instanceof Error ? waitError : new Error(String(waitError))] : []),
        ...drainErrors,
      ]
      if (all.length === 1) throw all[0]
      throw new AggregateError(all, all[0]!.message)
    }
  } catch (error) {
    primary = error
    threw = true
  }
  // Cleanup runs every resource, even when earlier steps fail: a close error
  // must never skip a later handle, and a secondary failure must not erase
  // the primary one.
  const cleanupErrors: Error[] = []
  const attempt = (operation: () => void): void => {
    try { operation() }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))) }
  }
  attempt(() => { if (restrictedToken !== undefined) check(api.closeHandle!(restrictedToken), 'CloseHandle(restricted token)') })
  attempt(() => { if (currentToken !== undefined) check(api.closeHandle!(currentToken), 'CloseHandle(token)') })
  for (const value of parsedSids) attempt(() => api.localFree!(value))
  // Buffers must stay reachable through the last native use of their SIDs.
  retained.length = 0
  // Last release: the ancestor pins outlive the Job drain and the token
  // closes. Forced termination of this runner is the abnormal boundary — the
  // handles die with the process, and only the Job's kill-on-close flag (not
  // this ordering) bounds the descendants then.
  attempt(() => pathGuard?.close())
  if (threw) {
    if (cleanupErrors.length === 0) throw primary
    throw new AggregateError(
      [primary instanceof Error ? primary : new Error(String(primary)), ...cleanupErrors],
      primary instanceof Error ? primary.message : String(primary),
    )
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Windows ambient deny cleanup failed')
  return exitCode
}
