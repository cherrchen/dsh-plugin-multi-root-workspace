/**
 * The local binary write port of `remote_copy` (ADR-0034): the only path a
 * transfer may use to create bytes inside a LOCAL root. It is not a Node `fs`
 * wrapper for callers to reach around the Registry — a sink can only be opened
 * with a {@link LocalDestinationAuthority} the Registry issued, it stages under
 * an exclusive-create name in the target's own directory (0600, `O_NOFOLLOW`),
 * reads the staged bytes back for verification, re-checks the bound parent and
 * the target's absence, and publishes with `link(2)` — the no-replace
 * primitive. Nothing is ever overwritten and a target that appears at any
 * point is reported, never replaced.
 *
 * The port is POSIX-only on purpose: the SSH experiment has no Windows
 * initiator (ADR-0030), and a Windows binary sink would need the ACL and
 * reparse-point machinery this gate does not audit.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote/local-sink
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { samePath, type RootAccess } from '../roots.ts'

/** A transfer refusal with a stable code the result reports verbatim. */
export class LocalTransferError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LocalTransferError'
  }
}

/**
 * The Registry-issued permission one local destination writes under. Produced
 * by `MultiRootRegistry.localTransferDestination()` from the SAME root states,
 * access levels, tool cap and protected boundaries the filesystem fence uses;
 * the sink never derives any of it from a caller-provided path.
 */
export interface LocalDestinationAuthority {
  /** The model-facing root id that was admitted (`primary` or an alias id). */
  readonly rootId: string
  /** The canonical granted directory. */
  readonly root: string
  /** Which registration produced the grant; diagnostics only. */
  readonly access: 'primary' | RootAccess
  /** Canonical protected DSH directories no staged file may land inside. */
  readonly deny: readonly string[]
}

const O_NOFOLLOW: number = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
const O_DIRECTORY: number = (constants as unknown as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const comparable = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

/** Equal or descending, segment-wise, on this platform's case convention. */
function isUnder(candidate: string, root: string): boolean {
  const target = comparable(candidate)
  const base = comparable(root)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * The relative-path rule shared by both transfer endpoints: normalized POSIX,
 * at least one non-special segment, no NUL/backslash/absolute spelling.
 */
export function checkTransferRelativePath(relativePath: string): void {
  const bad = relativePath === '' || relativePath.startsWith('/') || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (bad) throw new LocalTransferError('invalid-relative-path', `relative path must be a normalized relative POSIX path with a filename: ${JSON.stringify(relativePath)}`)
}

interface ParentBinding {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
  readonly fd: number
}

/**
 * One staged local destination. Construction (`open`) binds the target's
 * parent before any byte is written; every later step re-checks that binding.
 */
export class LocalBinarySink {
  private readonly fd: number
  private readonly parent: ParentBinding
  private readonly stagingPath: string
  private readonly stagingDev: bigint
  private readonly stagingIno: bigint
  private readonly maxBytes: number
  private bytes = 0
  private closed = false

  private constructor(options: {
    fd: number
    parent: ParentBinding
    stagingPath: string
    stagingDev: bigint
    stagingIno: bigint
    maxBytes: number
    target: string
  }) {
    this.fd = options.fd
    this.parent = options.parent
    this.stagingPath = options.stagingPath
    this.stagingDev = options.stagingDev
    this.stagingIno = options.stagingIno
    this.maxBytes = options.maxBytes
    this.targetPath = options.target
  }

  /** The published name; never touched until {@link publish}. */
  readonly targetPath: string

  /** How many bytes this operation has written to staging so far. */
  get written(): number { return this.bytes }

  /**
   * Open a staged destination under a Registry-issued authority.
   * @param authority - the local grant the Registry admitted.
   * @param relativePath - the normalized relative filename to create (it must NOT exist).
   * @param operationId - the transfer operation id; names this staging file.
   * @param maxBytes - the transfer byte cap.
   * @returns the bound sink; every refusal happens before the first byte.
   */
  static open(authority: LocalDestinationAuthority, relativePath: string, operationId: string, maxBytes: number): LocalBinarySink {
    if (process.platform === 'win32') {
      throw new LocalTransferError('local-platform-unsupported', 'the local transfer sink is POSIX-only; a Windows initiator is deferred (ADR-0030)')
    }
    checkTransferRelativePath(relativePath)
    if (!isAbsolute(authority.root)) throw new LocalTransferError('local-root-unavailable', `the granted local root is not absolute: ${JSON.stringify(authority.root)}`)
    let rootReal: string
    try { rootReal = realpathSync(authority.root) } catch { throw new LocalTransferError('local-root-unavailable', `the granted local root is unavailable: ${authority.root}`) }
    if (!samePath(rootReal, authority.root)) {
      throw new LocalTransferError('local-root-redirected', `the granted local root now resolves to "${rootReal}", not "${authority.root}"`)
    }
    const segments = relativePath.split('/')
    const parentLexical = join(rootReal, ...segments.slice(0, -1))
    if (!isUnder(parentLexical, rootReal)) {
      throw new LocalTransferError('destination-escapes-root', `${JSON.stringify(relativePath)} leaves the granted local root`)
    }
    // Every directory component between the root and the target must be a real
    // directory, never a symlink or a reparse point. The final component was
    // normalized above, so the walk stops at the parent.
    let cursor = rootReal
    for (const segment of segments.slice(0, -1)) {
      cursor = join(cursor, segment)
      let info
      try { info = lstatSync(cursor, { bigint: true }) }
      catch (error) {
        if (isMissing(error)) throw new LocalTransferError('destination-parent-missing', `the parent directory of ${JSON.stringify(relativePath)} does not exist`)
        throw error
      }
      if (info.isSymbolicLink()) throw new LocalTransferError('destination-symlinked', `a parent directory of ${JSON.stringify(relativePath)} is a symlink`)
      if (!info.isDirectory()) throw new LocalTransferError('destination-parent-not-directory', `a parent of ${JSON.stringify(relativePath)} is not a directory`)
    }
    let parentReal: string
    try { parentReal = realpathSync(parentLexical) } catch { throw new LocalTransferError('destination-parent-missing', `the parent directory of ${JSON.stringify(relativePath)} does not exist`) }
    if (realpathSync(rootReal) !== rootReal) {
      throw new LocalTransferError('local-root-redirected', 'the granted local root changed identity while the destination was being bound')
    }
    if (!samePath(parentReal, parentLexical)) {
      throw new LocalTransferError('destination-symlinked', `the parent of ${JSON.stringify(relativePath)} resolves elsewhere`)
    }
    for (const denied of authority.deny) {
      if (isUnder(parentReal, denied)) {
        throw new LocalTransferError('protected-path', `${JSON.stringify(relativePath)} lands inside the protected DSH directory ${denied}`)
      }
    }
    const filename = segments[segments.length - 1]!
    if (filename.startsWith('.dsh-staging-')) {
      throw new LocalTransferError('reserved-name', `${JSON.stringify(relativePath)} uses the transfer staging prefix`)
    }
    const target = join(parentReal, filename)
    try {
      lstatSync(target)
      throw new LocalTransferError('target-exists', `${JSON.stringify(relativePath)} already exists in the granted local root`)
    } catch (error) {
      if (error instanceof LocalTransferError) throw error
      if (!isMissing(error)) throw error
    }
    const parentInfo = lstatSync(parentReal, { bigint: true })
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new LocalTransferError('destination-parent-not-directory', `the parent of ${JSON.stringify(relativePath)} is not a real directory`)
    }
    const parentFd = openSync(parentReal, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    let fd: number | undefined
    let stagingPath: string | undefined
    try {
      const openedParent = fstatSync(parentFd, { bigint: true })
      if (openedParent.dev !== parentInfo.dev || openedParent.ino !== parentInfo.ino) {
        throw new LocalTransferError('destination-changed', 'the destination parent was replaced while it was being bound')
      }
      stagingPath = join(parentReal, `.dsh-staging-${operationId}`)
      // O_RDWR, not O_WRONLY: the read-back verification consumes the same
      // bound descriptor rather than re-opening the staging name.
      try {
        fd = openSync(stagingPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
      } catch (error) {
        throw new LocalTransferError('staging-unavailable', `cannot create the local staging object: ${error instanceof Error ? error.message : String(error)}`)
      }
      const staged = fstatSync(fd, { bigint: true })
      if (!staged.isFile() || staged.nlink !== 1n) {
        throw new LocalTransferError('staging-unverified', 'the staging object is not a single-link regular file')
      }
      if (staged.dev !== parentInfo.dev) {
        throw new LocalTransferError('staging-unverified', 'the staging object is not on the destination parent\'s filesystem')
      }
      return new LocalBinarySink({
        fd, parent: { path: parentReal, dev: parentInfo.dev, ino: parentInfo.ino, fd: parentFd },
        stagingPath, stagingDev: staged.dev, stagingIno: staged.ino, maxBytes, target,
      })
    } catch (error) {
      // Only a descriptor WE created proves the staging name is ours; an
      // EXCL failure means another operation owns that name and must be left
      // untouched.
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already closed */ }
        if (stagingPath !== undefined) { try { unlinkSync(stagingPath) } catch { /* already gone */ } }
      }
      try { closeSync(parentFd) } catch { /* already closed */ }
      throw error
    }
  }

  /** Append one chunk, bounded by the transfer budget. */
  write(chunk: Uint8Array): void {
    if (this.closed) throw new LocalTransferError('staging-closed', 'the local staging file is already closed')
    if (this.bytes + chunk.length > this.maxBytes) {
      throw new LocalTransferError('transfer-too-large', `the transfer exceeded its ${this.maxBytes}-byte limit`)
    }
    try {
      let written = 0
      while (written < chunk.length) written += writeSync(this.fd, chunk, written, chunk.length - written)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new LocalTransferError(
        code === 'ENOSPC' || code === 'EDQUOT' ? 'staging-full' : 'staging-write-failed',
        `cannot write the local staging file: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.bytes += chunk.length
  }

  /** Make the staged bytes durable and confirm the fd's size matches. */
  finish(): void {
    try { fsyncSync(this.fd) } catch (error) {
      throw new LocalTransferError('staging-write-failed', `cannot fsync the local staging file: ${error instanceof Error ? error.message : String(error)}`)
    }
    const info = fstatSync(this.fd, { bigint: true })
    if (!info.isFile() || Number(info.size) !== this.bytes) {
      throw new LocalTransferError('staging-changed', 'the local staging file changed while it was being written')
    }
  }

  /** Re-read the staged bytes from the fd and compare the SHA-256. */
  verify(expectedSha256: string): boolean {
    const staged = fstatSync(this.fd, { bigint: true })
    if (!staged.isFile() || Number(staged.size) !== this.bytes) return false
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    for (let position = 0; position < this.bytes;) {
      const read = readSync(this.fd, buffer, 0, Math.min(buffer.length, this.bytes - position), position)
      if (read === 0) return false
      hash.update(buffer.subarray(0, read))
      position += read
    }
    return hash.digest('hex') === expectedSha256
  }

  /**
   * Re-check the publish preconditions under the same parent binding: a real
   * directory with the bound identity, the target still absent, and staging
   * still this operation's inode with the expected size.
   */
  checkPublishable(): void {
    if (this.closed) throw new LocalTransferError('staging-closed', 'the local staging file is already closed')
    let parentInfo
    try { parentInfo = lstatSync(this.parent.path, { bigint: true }) }
    catch { throw new LocalTransferError('destination-changed', 'the destination parent disappeared before publication') }
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new LocalTransferError('destination-changed', 'the destination parent is no longer a real directory')
    }
    if (parentInfo.dev !== this.parent.dev || parentInfo.ino !== this.parent.ino) {
      throw new LocalTransferError('destination-changed', 'the destination parent was replaced before publication')
    }
    let parentReal: string
    try { parentReal = realpathSync(this.parent.path) } catch { throw new LocalTransferError('destination-changed', 'the destination parent cannot be resolved before publication') }
    if (!samePath(parentReal, this.parent.path)) {
      throw new LocalTransferError('destination-changed', 'the destination parent now resolves elsewhere')
    }
    try {
      lstatSync(this.targetPath)
      throw new LocalTransferError('target-exists', 'the destination name appeared before publication')
    } catch (error) {
      if (error instanceof LocalTransferError) throw error
      if (!isMissing(error)) throw error
    }
    let staged
    try { staged = lstatSync(this.stagingPath, { bigint: true }) }
    catch { throw new LocalTransferError('staging-changed', 'the local staging name disappeared before publication') }
    if (!staged.isFile() || staged.nlink !== 1n || staged.dev !== this.stagingDev || staged.ino !== this.stagingIno) {
      throw new LocalTransferError('staging-changed', 'the local staging name no longer belongs to this operation')
    }
    const fresh = fstatSync(this.fd, { bigint: true })
    if (!fresh.isFile() || Number(fresh.size) !== this.bytes) {
      throw new LocalTransferError('staging-changed', 'the local staging file changed size before publication')
    }
  }

  /**
   * Publish with an atomic no-replace link, then remove this operation's
   * staging name.
   * @returns whether staging was provably removed; `residual` still counts as
   *   committed (the target exists) and is reported separately.
   */
  publish(): 'removed' | 'residual' {
    this.checkPublishable()
    try {
      linkSync(this.stagingPath, this.targetPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new LocalTransferError('target-exists', 'the destination name appeared before publication')
      throw new LocalTransferError('publish-failed', `cannot publish the local destination: ${error instanceof Error ? error.message : String(error)}`)
    }
    let linked
    try { linked = lstatSync(this.targetPath, { bigint: true }) }
    catch { linked = undefined }
    if (linked === undefined || !linked.isFile() || linked.dev !== this.stagingDev || linked.ino !== this.stagingIno) {
      // The published name is not this operation's inode. Never remove it; the
      // caller reports an unknown publication with the operation id.
      throw new LocalTransferError('publish-unverified', 'the published local name is not this operation\'s staging inode')
    }
    return this.removeStaging()
  }

  /** Remove only this operation's staging name; any doubt leaves it. */
  cleanup(): 'removed' | 'residual' {
    return this.removeStaging()
  }

  private removeStaging(): 'removed' | 'residual' {
    let parentInfo
    try { parentInfo = lstatSync(this.parent.path, { bigint: true }) } catch { return 'residual' }
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || parentInfo.dev !== this.parent.dev || parentInfo.ino !== this.parent.ino) return 'residual'
    try {
      const staged = lstatSync(this.stagingPath, { bigint: true })
      // After a successful publish the staging name legitimately shares its
      // inode with the target (nlink 2); identity, not the count, is the test.
      if (!staged.isFile() || staged.dev !== this.stagingDev || staged.ino !== this.stagingIno) return 'residual'
      unlinkSync(this.stagingPath)
    } catch (error) {
      return isMissing(error) ? 'removed' : 'residual'
    }
    try { fsyncSync(this.parent.fd) } catch { /* durability of the directory entry is best-effort */ }
    return 'removed'
  }

  /** Close every handle; safe to call more than once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { closeSync(this.fd) } catch { /* already closed */ }
    try { closeSync(this.parent.fd) } catch { /* already closed */ }
  }
}
