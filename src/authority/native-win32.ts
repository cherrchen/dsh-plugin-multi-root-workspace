/** Windows local pipes: tokens, never a caller-supplied PID or a bearer file. */
import { EventEmitter } from 'node:events'
import type { Channel, Listener } from './native.ts'

let apiPromise: Promise<Awaited<ReturnType<typeof load>>> | undefined
async function load() {
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll'), advapi = koffi.load('advapi32.dll')
  type Fn = (...args: unknown[]) => number
  const k = (name: string, ret: string, args: string[]) => kernel.func('__stdcall', name, ret, args) as unknown as Fn
  const a = (name: string, ret: string, args: string[]) => advapi.func('__stdcall', name, ret, args) as unknown as Fn
  const close = k('CloseHandle', 'int', ['intptr'])
  const createPipe = k('CreateNamedPipeW', 'intptr', ['str16', 'uint', 'uint', 'uint', 'uint', 'uint', 'uint', 'void *'])
  const connect = k('ConnectNamedPipe', 'int', ['intptr', 'void *'])
  const open = k('CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'intptr'])
  const state = k('SetNamedPipeHandleState', 'int', ['intptr', 'void *', 'void *', 'void *'])
  const peek = k('PeekNamedPipe', 'int', ['intptr', 'void *', 'uint', 'void *', 'void *', 'void *'])
  const read = k('ReadFile', 'int', ['intptr', 'void *', 'uint', 'void *', 'void *'])
  const write = k('WriteFile', 'int', ['intptr', 'void *', 'uint', 'void *', 'void *'])
  const error = k('GetLastError', 'uint', [])
  const serverPid = k('GetNamedPipeServerProcessId', 'int', ['intptr', 'void *'])
  const openProcess = k('OpenProcess', 'intptr', ['uint', 'int', 'uint'])
  const openToken = a('OpenProcessToken', 'int', ['intptr', 'uint', 'void *'])
  const openThreadToken = a('OpenThreadToken', 'int', ['intptr', 'uint', 'int', 'void *'])
  const impersonate = a('ImpersonateNamedPipeClient', 'int', ['intptr'])
  const revert = a('RevertToSelf', 'int', [])
  const restricted = a('IsTokenRestricted', 'int', ['intptr'])
  const info = a('GetTokenInformation', 'int', ['intptr', 'int', 'void *', 'uint', 'void *'])
  const sidString = a('ConvertSidToStringSidW', 'int', ['void *', 'void *'])
  const free = k('LocalFree', 'intptr', ['intptr'])
  function tokenInfo(token: number, kind: number): Buffer {
    const data = Buffer.alloc(64 * 1024), length = Buffer.alloc(4)
    if (info(token, kind, data, data.length, length) === 0) throw new Error('cannot attest registry pipe token')
    return data
  }
  function sid(pointer: unknown): string {
    const output = Buffer.alloc(8)
    if (sidString(pointer, output) === 0) throw new Error('cannot read registry peer SID')
    const address = output.readBigUInt64LE()
    try { return String(koffi.decode(address, 'char16_t', -1)) } finally { free(Number(address)) }
  }
  function user(token: number): string { return sid(koffi.decode(tokenInfo(token, 1), 'void *')) }
  const self = Buffer.alloc(8)
  if (openToken(-1, 8, self) === 0) throw new Error('cannot identify registry Host user')
  let ownUser: string
  try { ownUser = user(Number(self.readBigUInt64LE())) } finally { close(Number(self.readBigUInt64LE())) }
  function attest(token: number): void {
    if (user(token) !== ownUser || restricted(token) !== 0 || tokenInfo(token, 29).readUInt32LE() !== 0) throw new Error('registry pipe refuses restricted or foreign-user token')
    const groups = tokenInfo(token, 2), count = groups.readUInt32LE()
    if (count > 2048) throw new Error('registry token has too many groups')
    for (let i = 0; i < count; i++) {
      const group = sid(koffi.decode(groups.subarray(8 + i * 16), 'void *'))
      if (/^S-1-4-(?:\d+-){4}3$/.test(group)) throw new Error('registry pipe refuses an ambient deny token')
    }
    const integrity = sid(koffi.decode(tokenInfo(token, 25), 'void *'))
    if (!/^S-1-16-\d+$/.test(integrity) || Number(integrity.split('-').at(-1)) < 8192) throw new Error('registry pipe refuses low-integrity peer')
  }
  function clientToken(handle: number): void {
    if (impersonate(handle) === 0) throw new Error('cannot attest registry client')
    const token = Buffer.alloc(8)
    let opened = false, reverted = false
    try { opened = openThreadToken(-2, 8, 1, token) !== 0 }
    finally { reverted = revert() !== 0 }
    if (!reverted) process.abort() // never continue Host work under an unconfirmed impersonation token
    if (!opened) throw new Error('cannot read registry client token')
    const value = Number(token.readBigUInt64LE())
    try { attest(value) } finally { close(value) }
  }
  function attestServer(handle: number): void {
    const pid = Buffer.alloc(4)
    if (serverPid(handle, pid) === 0) throw new Error('cannot identify registry server')
    const process = openProcess(0x1000, 0, pid.readUInt32LE())
    if (!process) throw new Error('registry server has exited')
    const token = Buffer.alloc(8)
    try {
      if (openToken(process, 8, token) === 0) throw new Error('cannot attest registry server')
      const value = Number(token.readBigUInt64LE())
      try { attest(value) } finally { close(value) }
    } finally { close(process) }
  }
  class Pipe extends EventEmitter implements Channel {
    private closed = false
    private attested: boolean
    private readonly timer: ReturnType<typeof setInterval>
    constructor(private readonly handle: number, server: boolean) {
      super(); this.attested = !server
      this.on('error', () => {})
      this.timer = setInterval(() => this.receive(), 20); this.timer.unref()
    }
    private receive() {
      if (this.closed) return
      const available = Buffer.alloc(4)
      if (peek(this.handle, null, 0, null, available, null) === 0) { this.destroy(); return }
      if (available.readUInt32LE() === 0) return
      const data = Buffer.alloc(Math.min(available.readUInt32LE(), 64 * 1024)), got = Buffer.alloc(4)
      if (read(this.handle, data, data.length, got, null) === 0) { this.destroy(); return }
      try {
        if (!this.attested) { clientToken(this.handle); this.attested = true }
        this.emit('data', data.subarray(0, got.readUInt32LE()))
      } catch { this.destroy() }
    }
    write(text: string): boolean {
      if (this.closed) return false
      const data = Buffer.from(text), wrote = Buffer.alloc(4)
      if (data.length > 1024 * 1024 || write(this.handle, data, data.length, wrote, null) === 0 || wrote.readUInt32LE() !== data.length) {
        this.destroy(); return false
      }
      return true
    }
    destroy() {
      if (this.closed) return
      this.closed = true; clearInterval(this.timer); close(this.handle); this.emit('close')
    }
  }
  function create(endpoint: string, first: boolean): number {
    const value = createPipe(endpoint, 3 | (first ? 0x80000 : 0), 1 | 8, 255, 1024 * 1024, 1024 * 1024, 0, null)
    if (value === -1 || value === 0) throw new Error('cannot create registry pipe')
    return value
  }
  const attestSelf = () => {
    const token = Buffer.alloc(8)
    if (openToken(-1, 8, token) === 0) throw new Error('cannot attest registry Host')
    const value = Number(token.readBigUInt64LE())
    try { attest(value) } finally { close(value) }
  }
  return { close, connect, open, state, error, attestServer, attestSelf, Pipe, create }
}
function api() { return apiPromise ??= load() }
export async function connectWindows(endpoint: string): Promise<Channel> {
  const native = await api()
  const handle = native.open(endpoint, 0xc0000000, 0, null, 3, 0, 0)
  if (handle === -1 || handle === 0) throw new Error('registry authority pipe is not ready')
  try {
    const mode = Buffer.alloc(4); mode.writeUInt32LE(1)
    if (native.state(handle, mode, null, null) === 0) throw new Error('cannot set nonblocking registry pipe')
    native.attestServer(handle)
    return new native.Pipe(handle, false)
  } catch (error) { native.close(handle); throw error }
}
export async function listenWindows(endpoint: string, accepted: (channel: Channel) => void): Promise<Listener> {
  const native = await api()
  let handle = native.create(endpoint, true), closed = false
  const timer = setInterval(() => {
    if (closed) return
    const result = native.connect(handle, null), error = result ? 0 : native.error()
    if (!result && error !== 535) {
      if (error === 232) { // client disconnected before ConnectNamedPipe
        native.close(handle)
        try { handle = native.create(endpoint, false) } catch { closed = true; clearInterval(timer) }
      }
      return
    }
    const ready = handle
    try { handle = native.create(endpoint, false) } catch { native.close(ready); closed = true; clearInterval(timer); return }
    accepted(new native.Pipe(ready, true))
  }, 20)
  timer.unref()
  return { close() { if (closed) return; closed = true; clearInterval(timer); native.close(handle) } }
}

export async function windowsHostAvailability(): Promise<{ available: boolean; reason?: string }> {
  // Connecting is still attested on both ends. A normal desktop Host is
  // supported; restricted-token native test runners should run outside it.
  try { (await api()).attestSelf(); return { available: true } }
  catch (error) { return { available: false, reason: String(error) } }
}
