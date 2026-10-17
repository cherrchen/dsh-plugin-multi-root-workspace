/**
 * Spawn argv under a UAC-shaped filtered token: TokenHasRestrictions=1 without
 * restricting SIDs (CreateRestrictedToken DISABLE_MAX_PRIVILEGE), the same
 * shape a non-elevated UAC admin token has. Used by windows-native.e2e.ts to
 * prove the deny broker accepts filtered callers.
 *
 * Usage: node windows-filtered-spawn.mjs <upstreamRunner> <cwd> -- <argv...>
 * The child's stdio is inherited, so its output reaches the caller's pipes.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [upstreamRunner, cwd, separator, ...argv] = process.argv.slice(2)
if (separator !== '--' || argv.length === 0) throw new Error('usage: <upstreamRunner> <cwd> -- <argv...>')

const fromRunner = createRequire(upstreamRunner)
const aclEntry = fromRunner.resolve('@deepseek-ai/dsh-sandbox-windows-acl')
const fromAcl = createRequire(aclEntry)
const processApi = await import(pathToFileURL(fromAcl.resolve('@deepseek-ai/dsh-win32-process')).href)
const koffi = (await import(pathToFileURL(fromAcl.resolve('koffi')).href)).default

const api = processApi.extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
  getCurrentProcess: bind(kernel32, 'GetCurrentProcess', 'void*', []),
  openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', ['void*', 'uint32', 'void*']),
  getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', ['void*', 'int', 'void*', 'uint32', 'void*']),
  createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', ['void*', 'uint32', 'uint32', 'void*', 'uint32', 'void*', 'uint32', 'void*', 'void*']),
  convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', 'void*']),
  equalSid: bind(advapi32, 'EqualSid', 'int', ['void*', 'void*']),
  setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', 'void*', 'void*', 'void*']),
  setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', ['void*', 'int', 'void*', 'uint32']),
  localFree: bind(kernel32, 'LocalFree', 'void*', ['void*']),
}))

const check = (ok, name) => { if (ok === 0) throw new Error(`${name} failed (Win32 ${api.getLastError()})`) }
const pointer = buffer => koffi.decode(buffer, 'void*')

const tokenOut = Buffer.alloc(8)
// TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY (CreateProcessAsUserW
// requires ASSIGN_PRIMARY on the token handle) | TOKEN_ADJUST_DEFAULT (to set
// the default DACL the derived token inherits) on our own pseudo handle.
check(api.openProcessToken(api.getCurrentProcess(), 0x8 | 0x2 | 0x1 | 0x80, tokenOut), 'OpenProcessToken(self)')
const source = pointer(tokenOut)
try {
  // A UAC filtered token still lists Administrators as deny-only. When the
  // caller's Administrators group is enabled (elevated host), list it in
  // SidsToDisable so the derived token takes that same deny-only shape.
  const size = Buffer.alloc(4)
  api.getTokenInformation(source, 2, null, 0, size)
  const groups = Buffer.alloc(size.readUInt32LE())
  check(api.getTokenInformation(source, 2, groups, groups.length, size), 'GetTokenInformation(groups)')
  const sidOut = Buffer.alloc(8)
  check(api.convertStringSidToSidW('S-1-5-32-544', sidOut), 'ConvertStringSidToSidW(Administrators)')
  const administrators = pointer(sidOut)
  let toDisable = null
  try {
    const count = groups.readUInt32LE()
    for (let i = 0; i < count; i++) {
      const entry = groups.subarray(8 + i * 16, 24 + i * 16)
      const attributes = entry.readUInt32LE(8)
      if ((attributes & 4) !== 0 && api.equalSid(pointer(entry), administrators) !== 0) {
        toDisable = Buffer.from(entry)
        break
      }
    }
  } finally { api.localFree(administrators) }
  // A token minted by CreateRestrictedToken gets its DACL from the parent's
  // TokenDefaultDacl, which can omit WRITE_DAC; a real UAC filtered token
  // grants it to the user. Widen our default DACL so the derived token lets
  // the runner OpenProcessToken(WRITE_DAC) its own process token.
  const everyoneOut = Buffer.alloc(8)
  check(api.convertStringSidToSidW('S-1-1-0', everyoneOut), 'ConvertStringSidToSidW(Everyone)')
  const everyone = pointer(everyoneOut)
  try {
    const access = Buffer.alloc(48)
    access.writeUInt32LE(0x10000000, 0)
    access.writeUInt32LE(1, 4)
    access.writeUInt32LE(0, 8)
    access.writeBigUInt64LE(koffi.address(everyone), 40)
    const aclOut = Buffer.alloc(8)
    const aclResult = api.setEntriesInAclW(1, access, null, aclOut)
    if (aclResult !== 0) throw new Error(`SetEntriesInAclW failed (Win32 ${aclResult})`)
    const acl = pointer(aclOut)
    try {
      const defaultDacl = Buffer.alloc(8)
      defaultDacl.writeBigUInt64LE(koffi.address(acl), 0)
      check(api.setTokenInformation(source, 6, defaultDacl, 8), 'SetTokenInformation(TokenDefaultDacl)')
      const filteredOut = Buffer.alloc(8)
      // DISABLE_MAX_PRIVILEGE keeps every group but strips all privileges except
      // SeChangeNotify, exactly the UAC filtered-token privilege shape.
      check(api.createRestrictedToken(source, 1, toDisable === null ? 0 : 1, toDisable, 0, null, 0, null, filteredOut),
        'CreateRestrictedToken(filtered)')
      const filtered = pointer(filteredOut)
      try {
        const child = processApi.spawnInheritedJobProcess(api, { token: filtered, command: argv[0], args: argv.slice(1), cwd })
        try { process.exitCode = processApi.waitForProcessExit(api, child.process) }
        finally { api.closeHandle(child.job); api.closeHandle(child.process) }
      } finally { api.closeHandle(filtered) }
    } finally { api.localFree(acl) }
  } finally { api.localFree(everyone) }
} finally { api.closeHandle(source) }
