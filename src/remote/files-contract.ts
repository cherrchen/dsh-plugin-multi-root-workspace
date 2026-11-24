/**
 * Browser-safe wire contract for `remoteFiles.list` — the panel's read of one
 * registered remote root's directory through the Host's bounded SFTP listing
 * service (ADR-0052 P3). This module carries schemas, budgets and the stable
 * failure vocabulary ONLY: no node imports, no SSH facts. The browser sends a
 * request that names a grant it was already shown (`browseAuthorization` from
 * `remotes`); it can never name a raw remote path.
 */
import { z } from 'zod'

export const REMOTE_FILES_LIST = 'remoteFiles.list'

export const REMOTE_FILES_LIMITS = {
  entries: 1024,
  responseBytes: 128 * 1024,
  wireBytes: 512 * 1024,
  deadlineMs: 12_000,
  concurrent: 4,
} as const

/**
 * A string with no unpaired surrogates. `String.prototype.isWellFormed` where
 * the runtime has it, else a UTF-8 encode/decode roundtrip (an unpaired
 * surrogate encodes as U+FFFD and cannot roundtrip).
 */
function wellFormed(text: string): boolean {
  const check = (text as { isWellFormed?: () => boolean }).isWellFormed
  if (typeof check === 'function') return check.call(text)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(text)) === text
  } catch {
    return false
  }
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength

/** One POSIX path segment: nonempty, not . or .., no NUL, <=255 UTF-8 bytes, well-formed. */
const validSegment = (segment: string): boolean =>
  segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\0')
  && utf8Length(segment) <= 255 && wellFormed(segment)

/**
 * A root-relative remote path: '' names the root itself; otherwise at most 64
 * slash-delimited segments that each satisfy {@link validSegment}. Literal
 * backslashes, spaces and valid Unicode are legal POSIX name bytes.
 */
export function validRemoteRelativePath(path: string): boolean {
  if (path === '') return true
  if (!wellFormed(path) || path.includes('\0')) return false
  const segments = path.split('/')
  return segments.length <= 64 && segments.every(validSegment)
}

/** One directory entry name: a single segment (no slash) with the same rules. */
export function validRemoteName(name: string): boolean {
  return !name.includes('/') && validSegment(name)
}

export const remoteFilesListRequest = z.object({
  sessionId: z.string().min(1).max(256),
  environmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).refine(id => id !== 'local'),
  rootId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  relativePath: z.string().max(4096).refine(validRemoteRelativePath),
  authorization: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const remoteEntrySchema = z.object({
  name: z.string().refine(validRemoteName),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
}).strict()

export const remoteFilesListing = z.object({
  entries: z.array(remoteEntrySchema).max(REMOTE_FILES_LIMITS.entries),
  truncated: z.boolean(),
}).strict().refine(
  value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= REMOTE_FILES_LIMITS.responseBytes,
)

export type RemoteFilesListRequest = z.infer<typeof remoteFilesListRequest>
export type RemoteEntry = z.infer<typeof remoteEntrySchema>
export type RemoteFilesListing = z.infer<typeof remoteFilesListing>

/**
 * The complete failure vocabulary of the listing service. Every code has one
 * fixed message and a fixed retry hint — the envelope NEVER carries a raw
 * error string, an SSH fact, or a remote path detail; a remote provider maps
 * the code to localized text.
 */
export const REMOTE_FILES_FAILURES = {
  'provider-unavailable': { message: 'the remote listing service is not mounted', retryable: true },
  'capability-unsupported': { message: 'this remote root does not opt in to directory listing', retryable: false },
  'session-unavailable': { message: 'the session is not live or has no resolvable workspace', retryable: true },
  'permission-denied': { message: 'the remote denied access to this directory', retryable: false },
  'root-unregistered': { message: 'this remote root is not registered for the session primary', retryable: false },
  'root-identity-changed': { message: 'the remote root identity changed; re-list from the root', retryable: true },
  'binding-changed': { message: 'the remote binding changed since the view was issued; reload the list', retryable: true },
  'environment-changed': { message: 'the remote environment definition changed; reload the list', retryable: true },
  'connection-failed': { message: 'the remote connection could not be established', retryable: true },
  'connection-lost': { message: 'the remote connection was lost during the listing', retryable: true },
  'directory-not-found': { message: 'the remote directory does not exist', retryable: false },
  'not-directory': { message: 'the remote path is not a directory', retryable: false },
  'path-escapes-root': { message: 'the remote path resolves outside its registered root', retryable: false },
  'timeout': { message: 'the remote listing exceeded its deadline', retryable: true },
  'cancelled': { message: 'the remote listing was cancelled', retryable: true },
  'resource-budget': { message: 'the remote listing service is busy', retryable: true },
  'invalid-request': { message: 'the remote listing request was rejected', retryable: false },
  'invalid-listing': { message: 'the remote returned a directory listing the host cannot trust', retryable: true },
} as const

export type RemoteFilesFailureCode = keyof typeof REMOTE_FILES_FAILURES

/** A failure whose message is ALWAYS the fixed vocabulary entry for its code. */
export class RemoteFilesError extends Error {
  constructor(readonly code: RemoteFilesFailureCode, options?: ErrorOptions) {
    super(REMOTE_FILES_FAILURES[code].message, options)
    this.name = 'RemoteFilesError'
  }

  get retryable(): boolean { return REMOTE_FILES_FAILURES[this.code].retryable }
}
