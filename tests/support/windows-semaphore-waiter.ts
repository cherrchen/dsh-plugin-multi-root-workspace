/** Deliberately pause with a contender handle open to test last-handle recovery.
 * Production contenders close immediately; this represents OS suspension in
 * the tiny CreateSemaphore -> close interval, without changing production code.
 */
import { createInterface } from 'node:readline'
import { leaseNameWin32 } from '../../src/registry-lease-win32.ts'
const koffi = (await import('koffi')).default
const kernel = koffi.load('kernel32.dll')
const create = kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void *', 'int', 'int', 'str16'])
const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint'])
const handle = create(null, 1, 1, leaseNameWin32(process.argv[2]!))
if (!handle || wait(handle, 0) !== 258) throw new Error('expected a held authority semaphore')
process.stdout.write('waiter-holds-handle\n')
const lines = createInterface({ input: process.stdin })
await new Promise<void>(resolve => { lines.once('line', resolve); lines.once('close', resolve) })
if (!close(handle)) throw new Error('cannot close waiter handle')
process.stdout.write('waiter-closed-handle\n')
lines.close()
