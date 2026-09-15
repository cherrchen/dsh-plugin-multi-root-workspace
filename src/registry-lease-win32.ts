/**
 * Windows named-kernel-semaphore adapter for the registry authority lease.
 *
 * This follows the same kernel-object contract as upstream
 * `SessionWriteLease` (published `@deepseek-ai/dsh-session-persistence-jsonl`
 * 0.1.5-rc.2): a count-1 named semaphore, a zero-timeout wait, and release by
 * restoring the count then closing the handle — the object dies with its last
 * handle, including on process death. It is a local reimplementation; it does
 * not deep-import `session-persistence-jsonl/src/win32.ts` (ADR-0002).
 *
 * Koffi is loaded lazily so POSIX processes never load it.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/registry-lease-win32
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const ERROR_SHARING_VIOLATION = 32

type Win32Fn = (...args: readonly unknown[]) => number

interface Kernel32 {
  readonly createSemaphoreW: Win32Fn
  readonly waitForSingleObject: Win32Fn
  readonly releaseSemaphore: Win32Fn
  readonly closeHandle: Win32Fn
  readonly getLastError: Win32Fn
}

let bindings: Kernel32 | undefined

/** Load kernel32 through Koffi the first time a Windows process needs it. */
async function kernel32(): Promise<Kernel32> {
  if (bindings !== undefined) return bindings
  const loaded = await import('koffi')
  const library = (loaded.default as { load: (name: string) => {
    func: (convention: string, name: string, ret: string, args: readonly string[]) => Win32Fn
  } }).load('kernel32.dll')
  bindings = {
    createSemaphoreW: library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
    waitForSingleObject: library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
    releaseSemaphore: library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
    closeHandle: library.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    getLastError: library.func('__stdcall', 'GetLastError', 'uint', []),
  }
  return bindings
}

/**
 * A syscall-shaped error so POSIX contention (`EAGAIN`) and Windows contention
 * (`EBUSY`) can share one `isLockContention` check.
 */
function win32Error(syscall: string, win32Code: number, path: string, dest: string): NodeJS.ErrnoException {
  const code = win32Code === ERROR_SHARING_VIOLATION ? 'EBUSY' : 'EIO'
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`) as NodeJS.ErrnoException
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  return error
}

/**
 * Acquire the store-wide registry lock as a named kernel semaphore whose name
 * is derived from the canonical lease path (case-folded: Windows paths are
 * case-insensitive). A second acquirer's zero-timeout wait times out as
 * `EBUSY`.
 * @param path - the lock path the name is derived from (the file need not exist).
 * @returns the open semaphore handle.
 */
export async function acquireLockHandleWin32(path: string): Promise<number> {
  const api = await kernel32()
  const name = `Local\\dsh-multi-root-registry-${createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')}`
  const handle = api.createSemaphoreW(null, 1, 1, name)
  if (handle === 0) throw win32Error('CreateSemaphoreW', api.getLastError(), path, name)
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === WAIT_OBJECT_0) return handle
  api.closeHandle(handle)
  if (wait === WAIT_TIMEOUT) throw win32Error('WaitForSingleObject', ERROR_SHARING_VIOLATION, path, name)
  throw win32Error('WaitForSingleObject', api.getLastError(), path, name)
}

/**
 * Restore the semaphore count and close the handle (the object dies with its
 * last handle, including on process death).
 * @param handle - the open semaphore handle.
 */
export async function releaseLockHandleWin32(handle: number): Promise<void> {
  const api = await kernel32()
  const released = api.releaseSemaphore(handle, 1, null)
  const closed = api.closeHandle(handle)
  if (released === 0 || closed === 0) {
    throw win32Error('ReleaseSemaphore', api.getLastError(), `handle:${String(handle)}`, `handle:${String(handle)}`)
  }
}
