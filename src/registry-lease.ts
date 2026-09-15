/**
 * Store-wide kernel lease for the multi-root registry.
 *
 * The JSON storage backend is memory-authoritative after `open`: it reads the
 * domain document once, then every write is an atomic rewrite of that in-memory
 * snapshot. Two DSH processes sharing one storage root can therefore each grant
 * a stale set, and a later rewrite silently drops the other process's mutation.
 * The in-process `chains` queue in `registry.ts` cannot see that race.
 *
 * This lease makes one process the Registry Authority for the whole
 * `multi_root_workspace` medium. The arbiter is the kernel, matching upstream
 * session JSONL persistence: POSIX non-blocking `flock(2)` via
 * `@deepseek-ai/node-addon-system/flock`, Windows a named kernel semaphore.
 * There is no TTL and no stale-PID algorithm — the kernel releases the lock
 * when the holder's descriptor (or last object handle) closes, including on
 * crash. See ADR-0007.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/registry-lease
 */

import { closeSync, fstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** How a held lease is represented on each platform. */
type HeldLease =
  | { readonly kind: 'posix'; readonly fd: number }
  | { readonly kind: 'win32'; readonly handle: number }

/** Thrown when another live process already holds the registry lease. */
export class RegistryLeaseContendedError extends Error {
  /** Stable code the registry maps onto `registry-contended`. */
  readonly code = 'registry-contended' as const
  /** Absolute lock path that was contended. */
  readonly leasePath: string

  /**
   * @param leasePath - the store-wide lock path that was contended.
   */
  constructor(leasePath: string) {
    super(`the root registry lease is held by another DSH process (${leasePath})`)
    this.name = 'RegistryLeaseContendedError'
    this.leasePath = leasePath
  }
}

/** Whether a native lock failure means another holder keeps the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBUSY'
}

/**
 * One held store-wide registry lock. Constructed only by
 * {@link RegistryAuthorityLease.acquire}; `release` closes the descriptor or
 * handle, which is what releases the lock.
 */
export class RegistryAuthorityLease {
  private released = false

  private constructor(private readonly held: HeldLease) {}

  /**
   * Acquire the exclusive kernel lock for one registry store.
   *
   * POSIX opens `leasePath` (creating it and its parent) and takes a
   * non-blocking exclusive flock. Because flock names an inode, the holder then
   * verifies the locked inode is still the file at `leasePath` and retries
   * otherwise — an unlinked-and-recreated lock file carries a fresh inode.
   * Windows never flocks the file: it holds a named kernel semaphore derived
   * from the canonical path so readers and directory removal stay free.
   * @param leasePath - absolute path of the lock file (store-wide, beside the domain JSON).
   * @returns the held lease.
   * @throws {RegistryLeaseContendedError} while another holder keeps the lock.
   */
  static async acquire(leasePath: string): Promise<RegistryAuthorityLease> {
    mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      const { acquireLockHandleWin32 } = await import('./registry-lease-win32.ts')
      let handle: number
      try {
        handle = await acquireLockHandleWin32(leasePath)
      } catch (error: unknown) {
        if (isLockContention(error)) throw new RegistryLeaseContendedError(leasePath)
        throw error
      }
      return new RegistryAuthorityLease({ kind: 'win32', handle })
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fd = openSync(leasePath, 'w')
      try {
        try {
          await tryLockExclusive(fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new RegistryLeaseContendedError(leasePath)
          throw error
        }
        const held = fstatSync(fd, { bigint: true })
        let current: ReturnType<typeof statSync> | undefined
        try {
          current = statSync(leasePath, { bigint: true })
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new RegistryAuthorityLease({ kind: 'posix', fd })
        }
      } catch (error: unknown) {
        closeSync(fd)
        throw error
      }
      closeSync(fd)
    }
    throw new RegistryLeaseContendedError(leasePath)
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. The POSIX
   * lock file is never removed: keeping it preserves the stable inode later
   * lockers verify against. POSIX close is synchronous so a fiber disposer that
   * does not await this promise still drops the flock before returning.
   * Idempotent.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    if (this.held.kind === 'win32') {
      const { releaseLockHandleWin32 } = await import('./registry-lease-win32.ts')
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    closeSync(this.held.fd)
  }
}
