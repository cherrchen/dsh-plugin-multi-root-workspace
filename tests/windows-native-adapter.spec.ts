import { describe, expect, it } from 'vitest'
import { readWindowsWideString, spawnWindowsDeniedChild } from '../src/compat/windows-native.ts'
import koffi from 'koffi'
import type { NativeApi, WindowsNative } from '../src/compat/windows-native.ts'

/** Exercise the public CreateProcess boundary with actual STARTUPINFO bytes,
 * including the older helpers that do not expose fd-7 CRT support. */
function fixture(reservedLength = 0) {
  const startup = Buffer.alloc(104)
  startup.writeUInt32LE(104)
  startup.writeUInt16LE(reservedLength, 66)
  for (const [offset, handle] of [[80, 10n], [88, 11n], [96, 12n]] as const) startup.writeBigUInt64LE(handle, offset)
  let descriptor = Buffer.alloc(0)
  let launched: Buffer | undefined
  const inheritance: number[] = []
  let freed = false
  const api: NativeApi = {
    uvGetOsfhandle: () => 17,
    getFileType: handle => handle === 10n ? 2 : 3,
    setHandleInformation: (_handle, _mask, flags) => { inheritance.push(flags as number); return 1 },
    getLastError: () => 5,
    createProcessAsUserW: (...args) => { launched = Buffer.from(args[9] as Buffer); return 1 },
  }
  const native = {
    koffi: {
      decode: (pointer: unknown) => pointer,
      address: () => 4096n,
      alloc: (_type: string, length: number) => { descriptor = Buffer.alloc(length); return descriptor },
      encode: (pointer: Buffer, _type: string, value: Buffer) => { value.copy(pointer) },
      free: () => { freed = true },
    },
    spawnInheritedJobProcess: (bindings: NativeApi) => {
      bindings.createProcessAsUserW!(null, null, '', null, null, 1, 4, null, '', startup, null)
      return { process: 1n, job: 2n }
    },
  } as unknown as WindowsNative
  const options = { token: 3n, command: 'node', args: ['-e', ''], cwd: 'C:\\work', controlFileDescriptor: 7 as const }
  return { native, api, options, startup, inheritance, launched: () => launched!, descriptor: () => descriptor, freed: () => freed }
}

describe('Windows native public-process adapter', () => {
  it('reads a real UTF-16 pointee without treating code units as another pointer', () => {
    const bytes = Buffer.from('S-1-5-21-100-200-300-1001\0', 'utf16le')
    const pointer = koffi.alloc('uint8', bytes.length)
    try {
      koffi.encode(pointer, 'uint8', bytes, bytes.length)
      expect(readWindowsWideString(koffi, pointer)).toBe('S-1-5-21-100-200-300-1001')
    } finally { koffi.free(pointer) }
  })
  it('forwards fd 7 for a helper without CRT support, then restores handle inheritance', () => {
    const f = fixture()
    expect(spawnWindowsDeniedChild(f.native, f.api, f.options)).toEqual({ process: 1n, job: 2n })
    expect(f.descriptor().readUInt32LE()).toBe(8)
    expect(f.descriptor().readBigUInt64LE(12 + 7 * 8)).toBe(17n)
    expect(f.descriptor()[4 + 7]).toBe(9)
    expect(f.descriptor().readBigUInt64LE(12 + 3 * 8)).toBe(0xffffffffffffffffn)
    expect(f.launched().readUInt16LE(66)).toBe(76)
    expect(f.launched().readBigUInt64LE(72)).toBe(4096n)
    expect(f.startup.readUInt16LE(66)).toBe(0)
    expect(f.inheritance).toEqual([1, 0])
    expect(f.freed()).toBe(true)
  })
  it('preserves a helper that already supplied CRT startup descriptors', () => {
    const f = fixture(76)
    spawnWindowsDeniedChild(f.native, f.api, f.options)
    expect(f.launched()).toEqual(f.startup)
    expect(f.descriptor()).toHaveLength(0)
    expect(f.inheritance).toEqual([1, 0])
  })
  it('fails closed on an unknown STARTUPINFO layout and still clears inheritance', () => {
    const f = fixture()
    f.startup.writeUInt32LE(80)
    expect(() => spawnWindowsDeniedChild(f.native, f.api, f.options)).toThrow('unrecognized')
    expect(f.inheritance).toEqual([1, 0])
  })
})


describe('Windows suspended token activation seam', () => {
  const fixture = (flags = 4) => {
    const events: string[] = []
    const processInfo = Buffer.alloc(24)
    processInfo.writeBigUInt64LE(101n)
    processInfo.writeBigUInt64LE(102n, 8)
    const api: NativeApi = {
      createProcessAsUserW: (token) => { expect(token).toBe(99n); events.push('create-suspended'); return 1 },
      terminateProcess: (process) => { events.push(`terminate-${process}`); return 1 },
      closeHandle: handle => { events.push(`close-${handle}`); return 1 },
    }
    const native = {
      koffi: { decode: (value: Buffer, type: string) => type === 'void*' ? value.readBigUInt64LE() : value },
      spawnInheritedJobProcess(bindings: NativeApi) {
        bindings.createProcessAsUserW!(3n, null, '', null, null, 1, flags, null, '', Buffer.alloc(104), processInfo)
        events.push('resume')
        return { process: 101n, job: 103n }
      },
    } as unknown as WindowsNative
    const options = { token: 3n, command: 'node', args: [], cwd: 'C:\\work' }
    return { api, native, options, events }
  }
  it('assigns and verifies the suspended child before any resume', () => {
    const f = fixture()
    spawnWindowsDeniedChild(f.native, f.api, f.options, { sourceToken: 99n, assign(process, thread) {
      expect(process).toBe(101n); expect(thread).toBe(102n); f.events.push('verified-assignment')
    } })
    expect(f.events).toEqual(['create-suspended', 'verified-assignment', 'resume'])
  })
  it('terminates and closes a child whose assignment cannot be verified, without resuming it', () => {
    const f = fixture()
    expect(() => spawnWindowsDeniedChild(f.native, f.api, f.options, { sourceToken: 99n, assign() { throw new Error('unverified token') } })).toThrow('unverified')
    expect(f.events).toEqual(['create-suspended', 'terminate-101', 'close-102', 'close-101'])
  })
  it('refuses a helper without a suspended-create flag before it can create a process', () => {
    const f = fixture(0)
    expect(() => spawnWindowsDeniedChild(f.native, f.api, f.options, { sourceToken: 99n, assign() { throw new Error('unreachable') } })).toThrow('suspended child')
    expect(f.events).toEqual([])
  })
})
