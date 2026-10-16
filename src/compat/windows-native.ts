/** Public Win32 process primitives, resolved from the upstream ACL installation.
 * The standalone runner has no host module resolver. No upstream private file
 * or load-time optional dependency is used here; unfamiliar exports fail closed.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type NativePointer = unknown
export type NativeFunction = (...args: readonly unknown[]) => number
export interface NativeApi {
  [name: string]: NativeFunction
}
export interface KoffiApi {
  decode(pointer: NativePointer, type: string, length?: number): unknown
  address(pointer: NativePointer): bigint
  load(name: string): unknown
  alloc(type: string, length: number): NativePointer
  free(pointer: NativePointer): void
  encode(pointer: NativePointer, type: string, value: unknown, length?: number): void
}
export interface WindowsNative {
  koffi: KoffiApi
  extendWin32ProcessBindings(create: (context: {
    kernel32: unknown
    advapi32: unknown
    bind(library: unknown, name: string, result: string, args: string[]): unknown
  }) => NativeApi): NativeApi
  spawnInheritedJobProcess(api: NativeApi, options: {
    token: NativePointer
    command: string
    args: readonly string[]
    cwd: string
    controlFileDescriptor?: 7
  }): { process: NativePointer; job: NativePointer }
  waitForProcessExit(api: NativeApi, process: NativePointer): number
}

/** Decode the UTF-16 pointee, not a second string pointer stored at its first
 * code units. `decode(ptr, 'str16')` would dereference those units as an address.
 */
export function readWindowsWideString(koffi: KoffiApi, pointer: NativePointer): string {
  return String(koffi.decode(pointer, 'char16_t', -1))
}

export async function loadWindowsNative(upstreamRunner: string): Promise<WindowsNative> {
  const fromRunner = createRequire(upstreamRunner)
  const aclEntry = fromRunner.resolve('@deepseek-ai/dsh-sandbox-windows-acl')
  const fromAcl = createRequire(aclEntry)
  const processApi = await import(pathToFileURL(fromAcl.resolve('@deepseek-ai/dsh-win32-process')).href)
  const koffi = (await import(pathToFileURL(fromAcl.resolve('koffi')).href)).default
  for (const name of ['extendWin32ProcessBindings', 'spawnInheritedJobProcess', 'waitForProcessExit']) {
    if (typeof processApi[name] !== 'function') throw new Error(`Windows ambient restriction requires public Win32 export ${name}`)
  }
  for (const name of ['decode', 'address', 'load', 'alloc', 'free', 'encode']) {
    if (typeof koffi?.[name] !== 'function') throw new Error(`Windows ambient restriction requires Koffi ${name}`)
  }
  return { ...processApi, koffi } as WindowsNative
}

/** Older public process helpers predate fd-7 CRT forwarding. Adapt the Win32
 * STARTUPINFO structure at the public binding seam, preserving argv and Job
 * ownership. New helpers already populate cbReserved2 and pass through.
 */
export function spawnWindowsDeniedChild(
  native: WindowsNative,
  api: NativeApi,
  options: Parameters<WindowsNative['spawnInheritedJobProcess']>[1],
  activation?: { sourceToken: NativePointer; assign(process: NativePointer, thread: NativePointer): void },
): ReturnType<WindowsNative['spawnInheritedJobProcess']> {
  // The oldest supported public table has uv_get_osfhandle and inheritance,
  // but predates GetFileType. Bind that operation through its public seam.
  if (options.controlFileDescriptor !== undefined && typeof api.getFileType !== 'function') {
    api = { ...api, ...native.extendWin32ProcessBindings(({ kernel32, bind }) => ({
      getFileType: bind(kernel32, 'GetFileType', 'uint32', ['void*']) as NativeFunction,
    })) }
  }
  let launchApi = api
  if (activation !== undefined) {
    launchApi = { ...api, createProcessAsUserW: (...args: readonly unknown[]): number => {
      if ((Number(args[6]) & 4) === 0) throw new Error('Windows deny activation requires a suspended child')
      const result = api.createProcessAsUserW!(activation.sourceToken, ...args.slice(1))
      if (result === 0) return result
      const processInfo = Buffer.from(native.koffi.decode(args[10], 'uint8', 24) as Uint8Array)
      const process = native.koffi.decode(processInfo, 'void*')
      const thread = native.koffi.decode(processInfo.subarray(8), 'void*')
      try { activation.assign(process, thread) }
      catch (error) {
        api.terminateProcess!(process, 127)
        api.closeHandle!(thread)
        api.closeHandle!(process)
        throw error
      }
      return result
    } }
  }
  if (options.controlFileDescriptor === undefined) return native.spawnInheritedJobProcess(launchApi, options)
  const handle = api.uvGetOsfhandle!(7)
  if (api.getFileType!(handle) !== 3) throw new Error('subprocess control descriptor is not a Windows pipe')
  if (api.setHandleInformation!(handle, 1, 1) === 0) throw new Error(`SetHandleInformation(control) failed (Win32 ${api.getLastError!()})`)
  const adapted = { ...launchApi, createProcessAsUserW: (...args: readonly unknown[]): number => {
    const original = Buffer.from(native.koffi.decode(args[9], 'uint8', 104) as Uint8Array)
    if (original.readUInt32LE(0) !== 104) throw new Error('unrecognized Windows STARTUPINFO layout')
    if (original.readUInt16LE(66) !== 0) return launchApi.createProcessAsUserW!(...args)
    const count = 8
    const data = Buffer.alloc(4 + count + count * 8)
    data.writeUInt32LE(count)
    for (let fd = 0; fd < count; fd++) data.writeBigUInt64LE(0xffffffffffffffffn, 4 + count + fd * 8)
    for (const [fd, value] of [[0, original.readBigUInt64LE(80)], [1, original.readBigUInt64LE(88)], [2, original.readBigUInt64LE(96)], [7, handle]] as const) {
      const kind = api.getFileType!(value)
      data[4 + fd] = 1 | (kind === 3 ? 8 : kind === 2 ? 64 : 0)
      data.writeBigUInt64LE(BigInt(value), 4 + count + fd * 8)
    }
    const reserved = native.koffi.alloc('uint8', data.length)
    try {
      native.koffi.encode(reserved, 'uint8', data, data.length)
      original.writeUInt16LE(data.length, 66)
      original.writeBigUInt64LE(native.koffi.address(reserved), 72)
      return launchApi.createProcessAsUserW!(...args.slice(0, 9), original, ...args.slice(10))
    } finally { native.koffi.free(reserved) }
  } }
  try { return native.spawnInheritedJobProcess(adapted, options) }
  finally { api.setHandleInformation!(handle, 1, 0) }
}

/**
 * Terminate a kill-on-close Job and wait until the kernel reports it drained.
 *
 * The public `waitForProcessExit` covers the direct child only: a descendant
 * the child spawned before exiting stays in the Job and could otherwise keep
 * running — with its restricted token — after the runner has released its
 * ancestor pins. `TerminateJobObject(job, 127)` kills every member; the
 * subsequent `QueryInformationJobObject` polling loop (class 1,
 * JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, `ActiveProcesses` at byte 40) only
 * returns once the kernel reports none left. There is deliberately no
 * timeout: releasing pins while a live descendant remains is exactly the gap
 * this wait exists to close. The caller still owns and closes the Job handle
 * afterwards.
 *
 * Abnormal-error boundary: a TerminateJobObject or QueryInformationJobObject
 * API failure throws into the caller's teardown — the Job handle is still
 * closed there and its kill-on-close flag is the residual bound, same as the
 * forced-termination case: if the runner process itself is killed, no
 * in-process guarantee can survive, the Job flag takes the descendants down
 * with it, and the pin handles die with the process. Protection is promised
 * only through this orderly path.
 */
export function terminateWindowsJobAndWait(native: WindowsNative, api: NativeApi, job: NativePointer): void {
  const jobApi = { ...api, ...native.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    terminateJobObject: bind(kernel32, 'TerminateJobObject', 'int', ['void*', 'uint32']) as NativeFunction,
    queryInformationJobObject: bind(kernel32, 'QueryInformationJobObject', 'int', ['void*', 'int', 'void*', 'uint32', 'void*']) as NativeFunction,
    sleep: bind(kernel32, 'Sleep', 'void', ['uint32']) as NativeFunction,
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []) as NativeFunction,
  })) }
  if (jobApi.terminateJobObject!(job, 127) === 0) {
    throw new Error(`TerminateJobObject failed (Win32 ${jobApi.getLastError!()})`)
  }
  // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (JobObjectBasicAccountingInformation,
  // class 1) is 48 bytes; ActiveProcesses is the DWORD at offset 40.
  const info = Buffer.alloc(48)
  for (;;) {
    if (jobApi.queryInformationJobObject!(job, 1, info, info.length, null) === 0) {
      throw new Error(`QueryInformationJobObject failed (Win32 ${jobApi.getLastError!()})`)
    }
    if (info.readUInt32LE(40) === 0) return
    jobApi.sleep!(10)
  }
}
