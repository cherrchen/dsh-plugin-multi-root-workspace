import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWindowsWideString, spawnWindowsDeniedChild, terminateWindowsJobAndWait } from '../src/compat/windows-native.ts'
import { pinWindowsDenyPaths, readWindowsPathIdentity } from '../src/compat/windows-path-guard.ts'
import { preflightWindowsDenyRoots } from '../src/compat/windows-deny-preflight.ts'
import { canonicalPath } from '../src/windows-runner-contract.ts'
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
  it('binds missing file-type support through an older helper public extension seam', () => {
    const f = fixture()
    const getFileType = f.api.getFileType!
    delete f.api.getFileType
    f.native.extendWin32ProcessBindings = create => create({ kernel32: 'kernel32', advapi32: 'advapi32', bind(library, name, result, args) {
      expect([library, name, result, args]).toEqual(['kernel32', 'GetFileType', 'uint32', ['void*']])
      return getFileType
    } })
    spawnWindowsDeniedChild(f.native, f.api, f.options)
    expect(f.descriptor().readBigUInt64LE(12 + 7 * 8)).toBe(17n)
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


describe('Windows deny path guard (mocked binding seam)', () => {
  interface Opened {
    path: string
    access: number
    share: number
    sa: unknown
    disposition: number
    flags: number
    handle: bigint
  }
  interface GuardHarness {
    native: WindowsNative
    api: NativeApi
    opened: Opened[]
    closed: bigint[]
    finalNameCalls: Map<bigint, number>
  }
  /** Fake the public `extendWin32ProcessBindings` seam: every Win32 result is
   * scripted, and the opened/closed log records pin acquisition and release. */
  function harness(overrides: {
    attributes?: Record<string, number>
    openFails?: readonly string[]
    finalNames?: Record<string, string>
    handleFlags?: number
    failInfo?: boolean
    failFinalName?: boolean
    closeFails?: boolean
    lastError?: number
  } = {}): GuardHarness {
    let next = 0x1000n
    const opened: Opened[] = []
    const closed: bigint[] = []
    const byHandle = new Map<bigint, string>()
    const finalNameCalls = new Map<bigint, number>()
    const api: NativeApi = {
      createFileW: (path, access, share, sa, disposition, flags) => {
        const name = String(path)
        if ((overrides.openFails ?? []).includes(name)) return -1n
        const handle = next++
        opened.push({
          path: name, access: access as number, share: share as number, sa,
          disposition: disposition as number, flags: flags as number, handle,
        })
        byHandle.set(handle, name)
        return handle
      },
      getFileInformationByHandle: (handle, out: Buffer) => {
        if (overrides.failInfo) return 0
        const attributes = overrides.attributes?.[byHandle.get(handle as bigint)!] ?? 0x10
        out.writeUInt32LE(attributes, 0)
        out.writeUInt32LE(0xa1b2c3d4, 28)
        out.writeUInt32LE(1, 40)
        out.writeUInt32LE(0x11223344, 44)
        out.writeUInt32LE(0x55667788, 48)
        return 1
      },
      getFinalPathNameByHandleW: (handle, out: Buffer, capacity) => {
        if (overrides.failFinalName) return 0
        finalNameCalls.set(handle as bigint, (finalNameCalls.get(handle as bigint) ?? 0) + 1)
        const path = byHandle.get(handle as bigint)!
        const name = overrides.finalNames?.[path] ?? `\\\\?\\${path}`
        if (name.length >= (capacity as number)) return name.length + 1
        out.write(name, 0, 'utf16le')
        return name.length
      },
      getHandleInformation: (_handle, out: Buffer) => {
        out.writeUInt32LE(overrides.handleFlags ?? 0)
        return 1
      },
      closeHandle: (handle) => {
        closed.push(handle as bigint)
        return overrides.closeFails ? 0 : 1
      },
      getLastError: () => overrides.lastError ?? 5,
    }
    const native = {
      extendWin32ProcessBindings: (create: (context: {
        kernel32: unknown
        advapi32: unknown
        bind(library: unknown, name: string, result: string, args: string[]): unknown
      }) => NativeApi) => create({
        kernel32: 'kernel32', advapi32: 'advapi32',
        bind: (_library, name) => api[name[0]!.toLowerCase() + name.slice(1)],
      }),
    } as unknown as WindowsNative
    return { native, api, opened, closed, finalNameCalls }
  }

  it('pins every deduplicated ancestor shallow-first with read+write-only sharing', () => {
    const h = harness()
    const guard = pinWindowsDenyPaths(h.native, ['C:\\root\\parent\\denied', 'C:\\root\\other', 'C:\\root\\other\\'])
    expect(h.opened.map(open => open.path)).toEqual([
      'C:\\', 'C:\\root', 'C:\\root\\other', 'C:\\root\\parent', 'C:\\root\\parent\\denied',
    ])
    for (const open of h.opened) {
      // GENERIC_READ (a data access — attribute-only opens are transparent to
      // the delete-sharing gate and cannot pin), READ|WRITE sharing without
      // DELETE, null security, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
      expect([open.access, open.share, open.sa, open.disposition, open.flags])
        .toEqual([0x80000000, 3, null, 3, 0x02200000])
    }
    guard.close()
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
    guard.close()
    expect(h.closed).toHaveLength(h.opened.length)
  })

  it('unwinds earlier pins deepest first when a mid-chain open fails', () => {
    const h = harness({ openFails: ['C:\\root\\parent'], lastError: 32 })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\parent\\denied']))
      .toThrow('CreateFileW(C:\\root\\parent) failed (Win32 32)')
    expect(h.opened.map(open => open.path)).toEqual(['C:\\', 'C:\\root'])
    expect(h.closed).toEqual([h.opened[1]!.handle, h.opened[0]!.handle])
  })

  it('refuses a reparse-point ancestor without following it', () => {
    const h = harness({ attributes: { 'C:\\root': 0x10 | 0x400 } })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])).toThrow('reparse point')
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
  })

  it('refuses a non-directory ancestor', () => {
    const h = harness({ attributes: { 'C:\\root': 0x20 } })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])).toThrow('not a directory')
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
  })

  it('refuses when the kernel-resolved name differs from the expected spelling', () => {
    const h = harness({ finalNames: { 'C:\\root': '\\\\?\\C:\\elsewhere\\root' } })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied']))
      .toThrow('resolves to "C:\\elsewhere\\root" instead of "C:\\root"')
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
  })

  it('refuses a handle whose final name lands on a UNC share', () => {
    const h = harness({ finalNames: { 'C:\\root': '\\\\?\\UNC\\server\\share' } })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])).toThrow('non-local device')
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
  })

  it('refuses an inheritable handle rather than leaking the pin into children', () => {
    const h = harness({ handleFlags: 1 })
    expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])).toThrow('inheritable')
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
  })

  it('surfaces identity and final-name failures with the same unwind', () => {
    for (const overrides of [{ failInfo: true }, { failFinalName: true }] as const) {
      const h = harness(overrides)
      expect(() => pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])).toThrow('Win32 5')
      expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
    }
  })

  it('rejects UNC, device, and relative roots before touching the filesystem', () => {
    const h = harness()
    for (const root of ['\\\\server\\share\\x', '\\\\?\\C:\\x', 'relative\\x', 'C:x']) {
      expect(() => pinWindowsDenyPaths(h.native, [root]), root).toThrow('not a canonical local-drive path')
    }
    expect(h.opened).toEqual([])
  })

  it('grows the final-name buffer until the kernel name fits', () => {
    const h = harness()
    const deep = `C:\\root\\${'segment-'.repeat(40)}denied`
    const guard = pinWindowsDenyPaths(h.native, [deep])
    const leaf = h.opened.at(-1)!
    expect(leaf.path.length).toBeGreaterThan(260)
    expect(h.finalNameCalls.get(leaf.handle) ?? 0).toBeGreaterThan(1)
    guard.close()
  })

  it('attempts every close and reports failures, and never closes twice', () => {
    const h = harness({ closeFails: true })
    const guard = pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])
    expect(() => guard.close()).toThrow(AggregateError)
    expect(h.closed).toEqual([...h.opened.map(open => open.handle)].reverse())
    guard.close()
    expect(h.closed).toHaveLength(h.opened.length)
  })

  it('retains the primary failure alongside cleanup errors', () => {
    const h = harness({ openFails: ['C:\\root\\denied'], closeFails: true, lastError: 5 })
    try {
      pinWindowsDenyPaths(h.native, ['C:\\root\\denied'])
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const errors = (error as AggregateError).errors as Error[]
      expect(errors[0]!.message).toContain('CreateFileW(C:\\root\\denied) failed (Win32 5)')
      expect(errors.slice(1).every(cleanup => cleanup.message.includes('CloseHandle'))).toBe(true)
      expect(errors.length).toBe(h.opened.length + 1)
    }
  })
})

describe('readWindowsPathIdentity', () => {
  it('decodes the BY_HANDLE_FILE_INFORMATION layout', () => {
    const api: NativeApi = {
      getFileInformationByHandle: (_handle, out: Buffer) => {
        out.writeUInt32LE(0x10, 0)
        out.writeUInt32LE(0xfeedface, 28)
        out.writeUInt32LE(3, 40)
        out.writeUInt32LE(0xaabbccdd, 44)
        out.writeUInt32LE(0x11223344, 48)
        return 1
      },
      getLastError: () => 0,
    }
    expect(readWindowsPathIdentity(api, 42n)).toEqual({
      attributes: 0x10,
      volumeSerial: 0xfeedface,
      links: 3,
      fileIndex: 0xaabbccdd11223344n,
    })
  })

  it('fails loudly when the identity read fails', () => {
    const api: NativeApi = {
      getFileInformationByHandle: () => 0,
      getLastError: () => 87,
    }
    expect(() => readWindowsPathIdentity(api, 42n)).toThrow('Win32 87')
  })
})

describe('terminateWindowsJobAndWait (mocked binding seam)', () => {
  /** Fake `extendWin32ProcessBindings`: resolve each bound name to the
   * scripted field on `api`, so call order is observable end to end. */
  function harness(overrides: {
    active?: number[]
    terminateOk?: boolean
    queryFailsAfter?: number
    lastError?: number
  } = {}) {
    const events: string[] = []
    const active = [...(overrides.active ?? [0])]
    let queries = 0
    const api: NativeApi = {
      terminateJobObject: (job, code) => {
        events.push(`terminate:${String(job)}:${String(code)}`)
        return overrides.terminateOk === false ? 0 : 1
      },
      queryInformationJobObject: (job, cls, out: Buffer) => {
        queries += 1
        events.push(`query:${String(cls)}`)
        out.writeUInt32LE(active.shift() ?? 0, 40)
        if (overrides.queryFailsAfter !== undefined && queries > overrides.queryFailsAfter) return 0
        return 1
      },
      sleep: ms => { events.push(`sleep:${String(ms)}`); return 0 },
      getLastError: () => overrides.lastError ?? 5,
    }
    const native = {
      extendWin32ProcessBindings: (create: (context: {
        kernel32: unknown
        advapi32: unknown
        bind(library: unknown, name: string, result: string, args: string[]): unknown
      }) => NativeApi) => create({
        kernel32: 'kernel32', advapi32: 'advapi32',
        bind: (_library, name) => api[name[0]!.toLowerCase() + name.slice(1)],
      }),
    } as unknown as WindowsNative
    return { native, api, events }
  }

  it('terminates the Job with 127 first, then polls ActiveProcesses until zero with Sleep(10) between', () => {
    const h = harness({ active: [2, 1, 0] })
    terminateWindowsJobAndWait(h.native, h.api, 99n)
    expect(h.events).toEqual([
      'terminate:99:127',
      'query:1', 'sleep:10',
      'query:1', 'sleep:10',
      'query:1',
    ])
  })

  it('returns after the first query when the Job is already empty', () => {
    const h = harness({ active: [0] })
    terminateWindowsJobAndWait(h.native, h.api, 7n)
    expect(h.events).toEqual(['terminate:7:127', 'query:1'])
  })

  it('does not silently pass a TerminateJobObject failure — and never queries', () => {
    const h = harness({ terminateOk: false, lastError: 87 })
    expect(() => terminateWindowsJobAndWait(h.native, h.api, 99n)).toThrow('TerminateJobObject failed (Win32 87)')
    expect(h.events).toEqual(['terminate:99:127'])
  })

  it('does not silently pass a QueryInformationJobObject failure mid-poll', () => {
    const h = harness({ active: [3, 3], queryFailsAfter: 2, lastError: 6 })
    expect(() => terminateWindowsJobAndWait(h.native, h.api, 99n)).toThrow('QueryInformationJobObject failed (Win32 6)')
    expect(h.events).toEqual([
      'terminate:99:127',
      'query:1', 'sleep:10',
      'query:1', 'sleep:10',
      'query:1',
    ])
  })
})



describe('Windows deny preflight (mocked binding seam)', () => {
  // The scan walks real directory listings while every Win32 call is scripted.
  const onWindows = process.platform === 'win32'
  interface ScriptedNode {
    attributes?: number
    links?: number
    volume?: number
    index?: bigint
    fileType?: number
    openFails?: boolean
    infoFails?: boolean
  }
  interface Harness {
    native: WindowsNative
    api: NativeApi
    events: string[]
    closed: string[]
  }
  /** Script per-path identities through the public binding seam; defaults are
   * an ordinary single-linked disk file. Keys are lowercased path spellings. */
  function harness(script: Record<string, ScriptedNode>, overrides: { closeFailsOn?: readonly string[]; lastError?: number } = {}): Harness {
    let next = 0x6000n
    const events: string[] = []
    const closed: string[] = []
    const byHandle = new Map<bigint, string>()
    const indices = new Map<string, bigint>()
    const nodeOf = (path: string): ScriptedNode => script[path.toLowerCase()] ?? {}
    const indexOf = (path: string): bigint => {
      let index = indices.get(path.toLowerCase())
      if (index === undefined) { index = BigInt(indices.size + 1) * 0x111n; indices.set(path.toLowerCase(), index) }
      return index
    }
    const api: NativeApi = {
      createFileW: (path, access, share, _sa, disposition, flags) => {
        const name = String(path)
        events.push(`open:${name}:${String(access)}:${String(share)}:${String(disposition)}:${String(flags)}`)
        if (nodeOf(name).openFails) return -1n
        const handle = next++
        byHandle.set(handle, name)
        return handle
      },
      getFileInformationByHandle: (handle, out: Buffer) => {
        const name = byHandle.get(handle as bigint)!
        const node = nodeOf(name)
        if (node.infoFails) return 0
        out.writeUInt32LE(node.attributes ?? 0x20, 0)
        out.writeUInt32LE(node.volume ?? 0xa1b2c3d4, 28)
        out.writeUInt32LE(node.links ?? 1, 40)
        const index = node.index ?? indexOf(name)
        out.writeUInt32LE(Number(index >> 32n), 44)
        out.writeUInt32LE(Number(index & 0xffffffffn), 48)
        return 1
      },
      getFileType: (handle) => nodeOf(byHandle.get(handle as bigint)!).fileType ?? 1,
      closeHandle: (handle) => {
        const name = byHandle.get(handle as bigint)!
        closed.push(name)
        events.push(`close:${name}`)
        return (overrides.closeFailsOn ?? []).includes(name) ? 0 : 1
      },
      getLastError: () => overrides.lastError ?? 5,
    }
    const native = {
      extendWin32ProcessBindings: (create: (context: {
        kernel32: unknown
        advapi32: unknown
        bind(library: unknown, name: string, result: string, args: string[]): unknown
      }) => NativeApi) => create({
        kernel32: 'kernel32', advapi32: 'advapi32',
        bind: (_library, name) => api[name[0]!.toLowerCase() + name.slice(1)],
      }),
    } as unknown as WindowsNative
    return { native, api, events, closed }
  }

  /** A real directory tree; only the Win32 answers are scripted. The base is
   * canonicalized: a host whose temp path is an 8.3 alias (`RUNNER~1`) would
   * otherwise script the mock under a spelling the scanned tree never uses. */
  function tree() {
    const base = canonicalPath(mkdtempSync(join(tmpdir(), 'dsh-mr-preflight-')))
    const root = join(base, 'denied')
    mkdirSync(root)
    const file = join(root, 'file.txt')
    writeFileSync(file, 'x')
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const deep = join(sub, 'deep.txt')
    writeFileSync(deep, 'y')
    const junc = join(root, 'junc')
    mkdirSync(junc)
    const inner = join(junc, 'inside.txt')
    writeFileSync(inner, 'z')
    return { base, root, file, sub, deep, junc, inner, dispose: () => rmSync(base, { recursive: true, force: true }) }
  }
  const dirScript = (t: ReturnType<typeof tree>): Record<string, ScriptedNode> => ({
    [t.root.toLowerCase()]: { attributes: 0x10 },
    [t.sub.toLowerCase()]: { attributes: 0x10 },
    [t.junc.toLowerCase()]: { attributes: 0x10 | 0x400 },
  })

  it.skipIf(!onWindows)('opens every node metadata-only with full sharing and closes each handle before descending', () => {
    const t = tree()
    try {
      const h = harness(dirScript(t))
      const preflight = preflightWindowsDenyRoots(h.native, [t.root])
      const keys = [...preflight.entries.keys()]
      expect(keys).toEqual([t.root, t.file, t.junc, t.sub, t.deep].map(path => path.toLowerCase()))
      for (const event of h.events.filter(e => e.startsWith('open:'))) {
        // FILE_READ_ATTRIBUTES, share 7, OPEN_EXISTING, BACKUP|REPARSE_POINT.
        expect(event.split(':').slice(-4)).toEqual(['128', '7', '3', '35651584'])
      }
      // Every inspection handle is closed before the next node opens.
      expect(h.closed).toHaveLength(preflight.entries.size)
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('refuses a multi-link plain file before any mutation, naming root, path, links, and remediation', () => {
    const t = tree()
    try {
      const h = harness({ ...dirScript(t), [t.file.toLowerCase()]: { links: 2 } })
      expect(() => preflightWindowsDenyRoots(h.native, [t.root]))
        .toThrow(/hardlinked file inside the registered root .*links=2.*independent copy/s)
      expect(h.events.some(event => event.startsWith('open:'))).toBe(true)
      // The protected-home label selects the isolation remediation instead.
      const h2 = harness({ ...dirScript(t), [t.file.toLowerCase()]: { links: 3 } })
      expect(() => preflightWindowsDenyRoots(h2.native, [t.root], t.root))
        .toThrow(/protected DSH home.*links=3.*isolate-profiles/s)
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('records a reparse point without descending into or inspecting its target', () => {
    const t = tree()
    try {
      const h = harness(dirScript(t))
      const preflight = preflightWindowsDenyRoots(h.native, [t.root])
      expect(preflight.entries.get(t.junc.toLowerCase())?.identity.attributes).toBe(0x10 | 0x400)
      expect(h.events.some(event => event.startsWith(`open:${t.inner}`))).toBe(false)
      expect(preflight.entries.has(t.inner.toLowerCase())).toBe(false)
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('fails startup on open, read, and non-disk failures — each naming the root and the path', () => {
    const t = tree()
    try {
      const h1 = harness({ ...dirScript(t), [t.file.toLowerCase()]: { openFails: true } }, { lastError: 5 })
      expect(() => preflightWindowsDenyRoots(h1.native, [t.root]))
        .toThrow(`deny preflight cannot inspect ${t.file} under root ${t.root}: CreateFileW Win32 5`)
      const h2 = harness({ ...dirScript(t), [t.file.toLowerCase()]: { infoFails: true } }, { lastError: 6 })
      expect(() => preflightWindowsDenyRoots(h2.native, [t.root]))
        .toThrow('GetFileInformationByHandle failed (Win32 6)')
      const h3 = harness({ ...dirScript(t), [t.file.toLowerCase()]: { fileType: 0 } })
      expect(() => preflightWindowsDenyRoots(h3.native, [t.root]))
        .toThrow(`deny preflight refuses non-disk file ${t.file} under root ${t.root}`)
      // A scripted directory attribute over a real file makes the listing fail.
      const h4 = harness({ ...dirScript(t), [t.file.toLowerCase()]: { attributes: 0x10 } })
      expect(() => preflightWindowsDenyRoots(h4.native, [t.root]))
        .toThrow(`deny preflight cannot list ${t.file} under root ${t.root}`)
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('refuses a root that is not a plain directory', () => {
    const t = tree()
    try {
      const h = harness({ [t.root.toLowerCase()]: { attributes: 0x20 } })
      expect(() => preflightWindowsDenyRoots(h.native, [t.root])).toThrow('must be a plain directory')
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('reports close failures, aggregating them behind the primary error without masking', () => {
    const t = tree()
    try {
      const alone = harness(dirScript(t), { closeFailsOn: [t.root], lastError: 6 })
      expect(() => preflightWindowsDenyRoots(alone.native, [t.root]))
        .toThrow(`deny preflight cannot close the inspection handle for ${t.root} under root ${t.root}`)
      const both = harness({ ...dirScript(t), [t.file.toLowerCase()]: { infoFails: true } }, { closeFailsOn: [t.file] })
      try {
        preflightWindowsDenyRoots(both.native, [t.root])
        expect.unreachable('the scan must fail')
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError)
        const aggregate = error as AggregateError
        expect((aggregate.errors[0] as Error).message).toContain('GetFileInformationByHandle')
        expect((aggregate.errors[1] as Error).message).toContain('CloseHandle')
      }
    } finally { t.dispose() }
  })

  it.skipIf(!onWindows)('verifyHandle refuses a missing snapshot, an attribute change, a replaced object, and a new link', () => {
    const t = tree()
    try {
      const h = harness(dirScript(t))
      const preflight = preflightWindowsDenyRoots(h.native, [t.root])
      const snapshot = preflight.entries.get(t.file.toLowerCase())!.identity
      const live = (overrides: Partial<ScriptedNode> = {}): NativeApi => ({
        getFileInformationByHandle: (_handle, out: Buffer) => {
          const node = { attributes: 0x20, volume: 0xa1b2c3d4, links: 1, index: snapshot.fileIndex, ...overrides }
          out.writeUInt32LE(node.attributes, 0)
          out.writeUInt32LE(node.volume, 28)
          out.writeUInt32LE(node.links, 40)
          out.writeUInt32LE(Number(node.index >> 32n), 44)
          out.writeUInt32LE(Number(node.index & 0xffffffffn), 48)
          return 1
        },
        getLastError: () => 5,
      })
      expect(() => preflight.verifyHandle(live(), join(t.root, 'phantom.txt'), 1n)).toThrow('no snapshot')
      expect(() => preflight.verifyHandle(live(), t.file, 1n)).not.toThrow()
      expect(() => preflight.verifyHandle(live({ attributes: 0x10 }), t.file, 1n)).toThrow('attributes changed')
      expect(() => preflight.verifyHandle(live({ index: 0x999n }), t.file, 1n)).toThrow('replaced by a different file object')
      expect(() => preflight.verifyHandle(live({ links: 2 }), t.file, 1n)).toThrow(/links=2.*independent copy/)
      expect(() => preflight.verifyHandle(live({ volume: 0xdeadbeef }), t.file, 1n)).toThrow('replaced by a different file object')
    } finally { t.dispose() }
  })
})
