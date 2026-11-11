/** Kernel-backed metadata access. Neither backend follows a metadata link. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemErrorName } from 'node:util'
import { loadHostKoffiSync } from '../compat/koffi.ts'

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'
export interface NativeEntry {
  readonly kind: EntryKind
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly birthtimeMs: bigint
}

interface NativeDirectory {
  child(name: string): NativeHandle
  inspect(name: string): EntryKind
}
export interface NativeHandle {
  info(): NativeEntry
  directory(): NativeDirectory
  canonical(): string
  read(buffer: Buffer): number
  list(): string[]
  close(): void
}

function posix() {
  const darwin = process.platform === 'darwin'
  if ((!darwin && process.platform !== 'linux') || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('trusted worktree metadata handles are unavailable on this platform')
  }
  const koffi = loadHostKoffiSync()
  const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6')
  const inodeSuffix = darwin && process.arch === 'x64' ? '$INODE64' : ''
  const openat = libc.func('int openat(int dirfd, const char *name, int flags, ...)')
  const fcntl = darwin ? libc.func('int fcntl(int fd, int command, ...)') : undefined
  const fstatat = darwin ? libc.func('fstatat' + inodeSuffix, 'int', ['int', 'str', 'void *', 'int']) : undefined
  const statx = darwin ? undefined : libc.func('statx', 'int', ['int', 'str', 'int', 'uint', 'void *'])
  const fdopendir = libc.func('fdopendir', 'void *', ['int'])
  const readdir = libc.func('readdir' + inodeSuffix, 'void *', ['void *'])
  const closedir = libc.func('closedir', 'int', ['void *'])
  const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const cloexec = darwin ? 0x1000000 : 0x80000
  const noFollowStat = darwin ? 0x20 : 0x100
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

  function failure(operation: string): never {
    const errno = koffi.errno()
    const code = errno > 0 ? getSystemErrorName(-errno) : 'EIO'
    throw Object.assign(new Error(`${operation}: ${code}`), { code })
  }
  function kindOf(mode: number): EntryKind {
    switch (mode & constants.S_IFMT) {
      case constants.S_IFREG: return 'file'
      case constants.S_IFDIR: return 'directory'
      case constants.S_IFLNK: return 'symlink'
      default: return 'other'
    }
  }
  function inspect(parent: number, name: string): EntryKind {
    // Darwin inode64 stat starts with dev_t then mode_t. Linux statx exposes
    // its fixed, architecture-independent stx_mode at byte 28.
    const stat = Buffer.alloc(256)
    const result = fstatat === undefined
      ? statx!(parent, name, noFollowStat, 1 /* STATX_TYPE */, stat)
      : fstatat(parent, name, stat, noFollowStat)
    if (result !== 0) failure('inspect metadata entry')
    if (!darwin && (stat.readUInt32LE(0) & 1) === 0) throw new Error('the file type is unavailable')
    return kindOf(stat.readUInt16LE(darwin ? 4 : 28))
  }
  function open(parent: number, name: string, flags: number): number {
    const fd = openat(parent, name, flags | cloexec)
    if (fd < 0) failure('open metadata entry')
    return fd
  }
  function list(fd: number): string[] {
    const duplicate = open(fd, '.', dirFlags)
    const stream = fdopendir(duplicate)
    if (stream === null) {
      try { failure('open metadata directory stream') } finally { closeSync(duplicate) }
    }
    try {
      const names: string[] = []
      for (;;) {
        koffi.errno(0)
        const record = readdir(stream)
        if (record === null) {
          if (koffi.errno() !== 0) failure('enumerate metadata directory')
          return names
        }
        // inode64 dirent on both supported ABIs. The record length is at
        // byte 16. Darwin also stores the name length before d_type.
        const header = koffi.decode(record, 'uint8_t', darwin ? 21 : 19) as Uint8Array
        const bytes = Buffer.from(header)
        const offset = bytes.length
        const count = bytes.readUInt16LE(16) - offset
        if (count <= 0 || count > 1024) throw new Error('invalid directory record length')
        const name = Buffer.from(koffi.decode(record, offset, 'uint8_t', count) as Uint8Array)
        const end = name.indexOf(0)
        if (end < 0) throw new Error('unterminated directory entry')
        try {
          const decoded = utf8.decode(name.subarray(0, end))
          if (decoded !== '.' && decoded !== '..') names.push(decoded)
        } catch { /* Git pointer files cannot name a non-UTF-8 entry. */ }
      }
    } finally { closedir(stream) }
  }
  function handle(fd: number): NativeHandle {
    return {
      info() {
        const stat = fstatSync(fd, { bigint: true })
        return { ...stat, kind: kindOf(Number(stat.mode)) }
      },
      directory: () => ({
        inspect: name => inspect(fd, name),
        child(name) {
          const kind = inspect(fd, name)
          if (kind === 'symlink') throw Object.assign(new Error('metadata entry is a symlink'), { code: 'ELOOP' })
          if (kind !== 'directory' && kind !== 'file') throw Object.assign(new Error('metadata entry is not regular'), { code: 'EINVAL' })
          const flags = kind === 'directory' ? dirFlags : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          return handle(open(fd, name, flags))
        },
      }),
      canonical() {
        if (fcntl === undefined) return readlinkSync(`/proc/self/fd/${fd}`)
        const path = Buffer.alloc(1024)
        if (fcntl(fd, 50 /* F_GETPATH */, 'void *', path) !== 0) failure('get metadata handle path')
        return utf8.decode(path.subarray(0, path.indexOf(0)))
      },
      read: buffer => readSync(fd, buffer),
      list: () => list(fd),
      close: () => closeSync(fd),
    }
  }
  return (root: string) => handle(openSync(root, dirFlags))
}

function windows() {
  const koffi = loadHostKoffiSync()
  const dll = koffi.load('kernel32.dll')
  const open = dll.func('CreateFileW', 'intptr', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'])
  const close = dll.func('CloseHandle', 'int', ['intptr'])
  const fileInfo = dll.func('GetFileInformationByHandle', 'int', ['intptr', 'void *'])
  const fileType = dll.func('GetFileType', 'uint32', ['intptr'])
  const driveType = dll.func('GetDriveTypeW', 'uint32', ['str16'])
  const volumeName = dll.func('GetVolumeNameForVolumeMountPointW', 'int', ['str16', 'void *', 'uint32'])
  const volumePrefix = String.raw`\\?\Volume{`
  const getPath = dll.func('GetFinalPathNameByHandleW', 'uint32', ['intptr', 'void *', 'uint32', 'uint32'])
  const read = dll.func('ReadFile', 'int', ['intptr', 'void *', 'uint32', 'void *', 'void *'])
  const lastError = dll.func('GetLastError', 'uint32', [])
  function failure(operation: string, lookup = false): never {
    const status = lastError()
    const code = lookup && (status === 2 || status === 3) ? 'ENOENT' : 'EACCES'
    throw Object.assign(new Error(`${operation}: Win32 ${status}`), { code })
  }
  function handle(path: string): NativeHandle {
    // Each ancestor remains open with read/write sharing, without delete
    // sharing. Opening the next component cannot traverse a replaced parent.
    // OPEN_REPARSE_POINT inspects the final component itself.
    const fd = open(path, 0x80000000, 3, null, 3, 0x02200000, null)
    if (BigInt(fd) === -1n) failure('open metadata handle', true)
    function finalPath(flags: number): string {
      let buffer = Buffer.alloc(1024)
      let count = getPath(fd, buffer, buffer.length / 2, flags)
      if (count >= buffer.length / 2) {
        if (count > 32768) throw new Error('metadata handle path is too long')
        buffer = Buffer.alloc(count * 2)
        count = getPath(fd, buffer, buffer.length / 2, flags)
      }
      if (count === 0) failure('get metadata handle path')
      if (count >= buffer.length / 2) throw new Error('metadata handle path changed')
      return buffer.subarray(0, count * 2).toString('utf16le')
    }
    let volumePath: string | undefined
    function directoryPath(): string {
      if (volumePath !== undefined) return volumePath
      const name = finalPath(1 /* VOLUME_NAME_GUID */)
      if (!name.startsWith(volumePrefix)) throw new Error('metadata directory does not name a local volume')
      return volumePath = name
    }
    return {
      info() {
        const data = Buffer.alloc(52) // BY_HANDLE_FILE_INFORMATION
        if (!fileInfo(fd, data)) failure('inspect metadata handle')
        const attributes = data.readUInt32LE(0)
        let kind: EntryKind = 'other'
        if ((attributes & 0x400) !== 0) kind = 'symlink'
        else if ((attributes & 0x10) !== 0) kind = 'directory'
        else if (fileType(fd) === 1 /* FILE_TYPE_DISK */) kind = 'file'
        const wide = (high: number, low: number) => (BigInt(data.readUInt32LE(high)) << 32n) | BigInt(data.readUInt32LE(low))
        const creation = data.readBigUInt64LE(4)
        return { kind, dev: BigInt(data.readUInt32LE(28)), ino: wide(44, 48), size: wide(32, 36),
          birthtimeMs: creation / 10000n - 11644473600000n }
      },
      directory: () => ({
        child: name => handle(join(directoryPath(), name)),
        inspect(name) {
          const child = handle(join(directoryPath(), name))
          try { return child.info().kind } finally { child.close() }
        },
      }),
      canonical() {
        const result = finalPath(0 /* VOLUME_NAME_DOS */).slice(4)
        if (!/^[a-z]:\\/i.test(result)) throw new Error('metadata handle does not name a local drive')
        return result
      },
      read(buffer) {
        const count = Buffer.alloc(4)
        if (!read(fd, buffer, buffer.length, count, null)) failure('read metadata handle')
        return count.readUInt32LE(0)
      },
      list: () => readdirSync(directoryPath()),
      close() { close(fd) },
    }
  }
  return (root: string) => {
    const drive = root.replaceAll('/', '\\')
    const type = driveType(drive)
    if (type < 2 || type === 4 /* DRIVE_REMOTE */) throw new Error('metadata drive is not local')
    const buffer = Buffer.alloc(128)
    if (!volumeName(drive, buffer, buffer.length / 2)) failure('resolve local metadata volume')
    const volume = buffer.toString('utf16le').split('\u0000', 1)[0]!
    if (!volume.startsWith(volumePrefix)) throw new Error('metadata drive did not resolve to a local volume')
    return handle(volume)
  }
}

let openRoot: ((root: string) => NativeHandle) | undefined
export function openMetadataRoot(root: string): NativeHandle {
  return (openRoot ??= process.platform === 'win32' ? windows() : posix())(root)
}
