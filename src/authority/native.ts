/** Kernel-authenticated local IPC. No credential file and no inherited capability. */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Socket } from 'node:net'
import type { EventEmitter } from 'node:events'

export interface Channel {
  on: EventEmitter['on']
  readonly writableLength?: number
  write(data: string): boolean
  destroy(): unknown
}
export interface Listener { close(): void }

export function storeIdentity(root: string): { root: string; id: string; endpoint: string } {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const physical = realpathSync.native(root)
  const info = statSync(physical, { bigint: true })
  const id = createHash('sha256').update(`${info.dev}:${info.ino}:${process.platform === 'win32' ? physical.toLowerCase() : physical}`).digest('hex')
  if (process.platform === 'win32') return { root: physical, id, endpoint: `\\\\.\\pipe\\LOCAL\\dsh-registry-${id}` }
  // A fixed, short path independent of arbitrarily long store paths.
  const directory = `/tmp/dsh-registry-${process.getuid!()}`
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const entry = lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0) throw new Error('unsafe registry IPC directory')
  return { root: physical, id, endpoint: join(directory, `${id.slice(0, 48)}.sock`) }
}

type Call = ((...args: unknown[]) => number) & { async: (...args: unknown[]) => void }
let posixPromise: Promise<Awaited<ReturnType<typeof loadPosix>>> | undefined
async function loadPosix() {
  const koffi = (await import('koffi')).default
  const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6')
  const bind = (name: string, ret: string, args: string[]) => libc.func(name, ret, args) as unknown as Call
  const socketpair = bind('socketpair', 'int', ['int', 'int', 'int', 'void *'])
  const socket = bind('socket', 'int', ['int', 'int', 'int'])
  const connect = bind('connect', 'int', ['int', 'void *', 'uint'])
  const bindSocket = bind('bind', 'int', ['int', 'void *', 'uint'])
  const listen = bind('listen', 'int', ['int', 'int'])
  const accept = bind('accept', 'int', ['int', 'void *', 'void *'])
  // Darwin arm64 passes variadic arguments on the stack. A fixed-arity
  // declaration silently fails to set O_NONBLOCK and makes accept block.
  const fcntlCall = libc.func('int fcntl(int fd, int command, ...)')
  const fcntl = (fd: number, command: number, value: number) => fcntlCall(fd, command, 'int', value)
  const getsockopt = bind('getsockopt', 'int', ['int', 'int', 'int', 'void *', 'void *'])
  const poll = bind('poll', 'int', ['void *', 'uint', 'int'])
  let auditCheck: ((token: unknown, op: null, filter: number) => number) | undefined
  if (process.platform === 'darwin') {
    const tokenType = koffi.struct({ val: koffi.array('uint32', 8) })
    auditCheck = koffi.load('/usr/lib/libsandbox.dylib').func('sandbox_check_by_audit_token', 'int', [tokenType, 'void *', 'int']) as unknown as typeof auditCheck
  }
  function option(fd: number, level: number, name: number, size: number): Buffer {
    const bytes = Buffer.alloc(size), length = Buffer.alloc(4)
    length.writeUInt32LE(size)
    if (getsockopt(fd, level, name, bytes, length) !== 0 || length.readUInt32LE() !== size) throw new Error('kernel peer attestation is unavailable')
    return bytes
  }
  function authenticate(fd: number): () => void {
    const uid = process.getuid!()
    if (process.platform === 'darwin') {
      const token = option(fd, 0, 6, 32) // LOCAL_PEERTOKEN, contains pidversion
      if (token.readUInt32LE(4) !== uid || auditCheck!({ val: [...new Uint32Array(token.buffer, token.byteOffset, 8)] }, null, 0) !== 0) {
        throw new Error('registry IPC refuses a different user or sandboxed peer')
      }
      return () => {}
    }
    const cred = option(fd, 1, 17, 12) // SO_PEERCRED
    // SO_PEERPIDFD pins the socket's actual peer, rather than a reusable PID.
    // Kernels without it fail closed; there is no PID-only fallback.
    const pidfd = option(fd, 1, 77, 4).readInt32LE()
    try {
      const pfd = Buffer.alloc(8); pfd.writeInt32LE(pidfd); pfd.writeInt16LE(1, 4)
      const status = readFileSync(`/proc/${cred.readInt32LE()}/status`, 'utf8')
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)
      if (cred.readUInt32LE(4) !== uid || ids === null || ids.slice(1).some(value => Number(value) !== uid)
        || !/^NoNewPrivs:\s+0$/m.test(status) || poll(pfd, 1, 0) !== 0) throw new Error('registry IPC refuses a different user, exited or restricted peer')
      // Keep the pidfd until this connection closes. It is close-on-exec.
      return () => closeSync(pidfd)
    } catch (error) { closeSync(pidfd); throw error }
  }
  function address(path: string): Buffer {
    const data = Buffer.from(path)
    if (data.length >= (process.platform === 'darwin' ? 104 : 108)) throw new Error('registry IPC path is too long')
    const bytes = Buffer.alloc(data.length + 3)
    if (process.platform === 'darwin') { bytes[0] = bytes.length; bytes[1] = 1 } else bytes.writeUInt16LE(1)
    data.copy(bytes, 2)
    return bytes
  }
  function open(): number {
    const fd = socket(1, 1, 0)
    if (fd < 0) throw new Error('cannot create registry IPC socket')
    if (fcntl(fd, 2, 1) !== 0 || fcntl(fd, 4, process.platform === 'darwin' ? 4 : 2048) !== 0) {
      closeSync(fd); throw new Error('cannot make registry socket non-inheritable/non-blocking')
    }
    return fd
  }
  function channel(fd: number): Channel {
    let cleanup: (() => void) | undefined
    try {
      if (fcntl(fd, 2, 1) !== 0 || fcntl(fd, 4, process.platform === 'darwin' ? 4 : 2048) !== 0) throw new Error('cannot make registry connection non-inheritable/non-blocking')
      cleanup = authenticate(fd)
      const result = new Socket({ fd, readable: true, writable: true })
      result.on('close', cleanup)
      result.on('error', () => {})
      return result
    } catch (error) { cleanup?.(); closeSync(fd); throw error }
  }
  return { open, channel, address, connect, bindSocket, listen, accept, authenticate, socketpair }
}
function posix() { return posixPromise ??= loadPosix() }

export async function connectNative(endpoint: string): Promise<Channel> {
  if (process.platform === 'win32') return (await import('./native-win32.ts')).connectWindows(endpoint)
  const api = await posix(), address = api.address(endpoint), fd = api.open()
  if (api.connect(fd, address, address.length) !== 0) { closeSync(fd); throw new Error('registry authority is not ready') }
  return api.channel(fd)
}

/** Called only by the kernel lease holder. Never removes another epoch's socket. */
export async function listenNative(endpoint: string, accepted: (channel: Channel) => void): Promise<Listener> {
  if (process.platform === 'win32') return (await import('./native-win32.ts')).listenWindows(endpoint, accepted)
  const api = await posix(), address = api.address(endpoint), fd = api.open()
  try { unlinkSync(endpoint) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { closeSync(fd); throw error } }
  if (api.bindSocket(fd, address, address.length) !== 0 || api.listen(fd, 32) !== 0) { closeSync(fd); throw new Error('cannot listen for registry Hosts') }
  const inode = lstatSync(endpoint).ino
  let closed = false
  const timer = setInterval(() => {
    for (let i = 0; i < 8 && !closed; i++) {
      const client = api.accept(fd, null, null)
      if (client < 0) break
      let channel: Channel | undefined
      try {
        // accept does not inherit FD_CLOEXEC from the listening descriptor.
        // channel owns the descriptor after attestation.
        channel = api.channel(client)
        accepted(channel)
      } catch { channel?.destroy() /* authenticate closes rejected descriptors */ }
    }
  }, 20)
  timer.unref()
  return { close() {
    if (closed) return
    closed = true; clearInterval(timer); closeSync(fd)
    try { if (lstatSync(endpoint).ino === inode) unlinkSync(endpoint) } catch {}
  } }
}

/** Capability probe for native tests and diagnostics; not an authorization bypass. */
export async function nativeHostAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform === 'win32') return (await import('./native-win32.ts')).windowsHostAvailability()
  if (process.platform === 'linux') {
    if (!/^NoNewPrivs:\s+0$/m.test(readFileSync('/proc/self/status', 'utf8'))) return { available: false, reason: 'the Host itself has NoNewPrivs; shared IPC refuses restricted peers' }
  } else if (process.platform === 'darwin') {
    const koffi = (await import('koffi')).default
    const check = koffi.load('/usr/lib/libsandbox.dylib').func('int sandbox_check(int pid, const char *operation, int filter)')
    if (check(process.pid, null, 0) !== 0) return { available: false, reason: 'the Host itself is sandboxed; shared IPC refuses sandboxed peers' }
  }
  const api = await posix(), pair = Buffer.alloc(8)
  if (api.socketpair(1, 1, 0, pair) !== 0) throw new Error('cannot probe registry IPC credentials')
  try { api.authenticate(pair.readInt32LE())() }
  catch (error) {
    if (process.platform === 'linux' && String(error).includes('kernel peer attestation is unavailable')) return { available: false, reason: 'the kernel lacks SO_PEERPIDFD; shared IPC requires a pinned peer identity' }
    throw error
  } finally { closeSync(pair.readInt32LE()); closeSync(pair.readInt32LE(4)) }
  return { available: true }
}
