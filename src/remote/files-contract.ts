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

/**
 * The authorization lease endpoint (ADR-0052 P4): an authenticated metadata
 * wait that resolves when the grant's live identity no longer matches — or
 * `{unchanged: true}` when one lease expires. This is NOT a filesystem
 * watch: it observes the control plane (grant/digest drift), never remote
 * file data, and there is no polling, no stream, and no auto-relist.
 */
export const REMOTE_FILES_AUTHORIZATION_WAIT = 'remotes.waitForAuthorizationChange'

export const REMOTE_FILES_LIMITS = {
  entries: 1024,
  responseBytes: 128 * 1024,
  wireBytes: 512 * 1024,
  deadlineMs: 12_000,
  concurrent: 4,
  /** Root-relative path bound in UTF-8 bytes (not characters). */
  pathBytes: 4096,
  /** Binding root + relative path combined bound in UTF-8 bytes. */
  absolutePathBytes: 8192,
  /** Concurrent authorization leases; a seventeenth request fails `resource-budget`. */
  waitConcurrent: 16,
  /** One lease's lifetime: it always answers inside this window. */
  waitLeaseMs: 15_000,
  /** Each ordered admission inside a lease is bounded so owner stalls cannot outlive it. */
  waitAdmissionMs: 4_000,
} as const

export const REMOTE_FILES_READ = 'remoteFiles.read'
export const REMOTE_FILE_PREVIEW_TRANSPORT = 'sftp-binary-v1'

/** Content operations have a separate pool; both pools use the same owned-channel cap. */
export const REMOTE_FILE_PREVIEW_LIMITS = {
  bytes: 2 * 1024 * 1024,
  blockBytes: 128 * 1024,
  maxReadRequests: 65,
  concurrent: 2,
  deadlineMs: 20_000,
  clientResources: 8,
  clientContentViews: 4,
  clientReadConcurrent: 2,
  markdownBytes: 128 * 1024,
  markdownNodes: 4096,
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
    // `ignoreBOM: true` is the decode default on every spec runtime, but the
    // flag makes the intent explicit across runtimes: a literal U+FEFF name
    // mid-string decodes verbatim, so it still roundtrips correctly.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(text)) === text
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
 * slash-delimited segments that each satisfy {@link validSegment}, and the
 * whole path fits {@link REMOTE_FILES_LIMITS.pathBytes} UTF-8 bytes. Literal
 * backslashes, spaces and valid Unicode are legal POSIX name bytes.
 */
export function validRemoteRelativePath(path: string): boolean {
  if (path === '') return true
  // The whole path is bounded in BYTES before segmentation — the cheap
  // character check short-circuits the encoder for the common ASCII case,
  // and the byte check binds multibyte names the same way the wire does.
  if (path.length > REMOTE_FILES_LIMITS.pathBytes || utf8Length(path) > REMOTE_FILES_LIMITS.pathBytes) return false
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

export const remoteFilesReadRequest = remoteFilesListRequest.refine(value => value.relativePath !== '')
export type RemoteFilesReadRequest = z.infer<typeof remoteFilesReadRequest>

export const remoteFilesReadMetadata = z.object({
  kind: z.literal('file'),
  size: z.number().int().min(0).max(REMOTE_FILE_PREVIEW_LIMITS.bytes),
  modifiedAt: z.number().int().min(0).max(0xffffffff).optional(),
  complete: z.literal(true),
}).strict()
export type RemoteFilesReadMetadata = z.infer<typeof remoteFilesReadMetadata>

/** The result after Connection decoded the one binary field. No JSON fallback. */
export const remoteFilesReadContent = remoteFilesReadMetadata.extend({
  bytes: z.instanceof(Uint8Array),
}).strict().refine(value => value.bytes.byteLength === value.size)
export type RemoteFilesReadContent = z.infer<typeof remoteFilesReadContent>

/** The authorization lease: the list request minus the directory operand. */
export const remoteFilesAuthorizationRequest = remoteFilesListRequest.omit({ relativePath: true }).strict()
export type RemoteFilesAuthorizationRequest = z.infer<typeof remoteFilesAuthorizationRequest>

/** A lease that expired without an authorization change — the only success shape. */
export const remoteFilesAuthorizationAnswer = z.object({ unchanged: z.literal(true) }).strict()
export type RemoteFilesAuthorizationAnswer = z.infer<typeof remoteFilesAuthorizationAnswer>

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
  /** The remote root did not opt in to file preview (`filePreview`), or the live grant lost it. */
  'preview-not-authorized': { message: 'file preview is not authorized for this remote root', retryable: false },
  /** The file existed at listing time and vanished before or during the read. */
  'file-not-found': { message: 'the remote file no longer exists', retryable: true },
  'not-regular-file': { message: 'the remote target is not a regular file', retryable: false },
  'file-too-large': { message: 'the remote file exceeds the preview limit', retryable: false },
  'file-changed': { message: 'the remote file changed during reading', retryable: true },
  /** The response failed strict wire/shape/length validation on either side. */
  'invalid-content': { message: 'the remote file response is invalid', retryable: false },
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
