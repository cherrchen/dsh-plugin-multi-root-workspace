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
): ReturnType<WindowsNative['spawnInheritedJobProcess']> {
  if (options.controlFileDescriptor === undefined) return native.spawnInheritedJobProcess(api, options)
  const handle = api.uvGetOsfhandle!(7)
  if (api.getFileType!(handle) !== 3) throw new Error('subprocess control descriptor is not a Windows pipe')
  if (api.setHandleInformation!(handle, 1, 1) === 0) throw new Error(`SetHandleInformation(control) failed (Win32 ${api.getLastError!()})`)
  const adapted = { ...api, createProcessAsUserW: (...args: readonly unknown[]): number => {
    const original = Buffer.from(native.koffi.decode(args[9], 'uint8', 104) as Uint8Array)
    if (original.readUInt32LE(0) !== 104) throw new Error('unrecognized Windows STARTUPINFO layout')
    if (original.readUInt16LE(66) !== 0) return api.createProcessAsUserW!(...args)
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
      return api.createProcessAsUserW!(...args.slice(0, 9), original, ...args.slice(10))
    } finally { native.koffi.free(reserved) }
  } }
  try { return native.spawnInheritedJobProcess(adapted, options) }
  finally { api.setHandleInformation!(handle, 1, 0) }
}
