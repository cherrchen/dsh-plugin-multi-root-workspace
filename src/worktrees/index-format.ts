/**
 * The plugin's own Git index snapshot parser and literal path lookup.
 *
 * Git is never started and `ls-files` is never run (ADR-0039 §2.4): the index
 * is opened through the trusted-fd path and parsed here. That is what keeps
 * split indexes (`link`), sparse indexes (`sdir`, directory entries), the
 * `core.fsmonitor` program and pathspec magic out of the picture entirely.
 *
 * Format gate (any failure makes the checkout inactive):
 *
 * - magic `DIRC`, version 2, 3 or 4;
 * - no `link` / `sdir` extension, no unknown REQUIRED (lowercase) extension;
 * - no `040000` directory entry;
 * - strictly valid UTF-8 path names, no NUL, no `..` component;
 * - the declared entry count and extension sizes fit inside the buffer.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/index-format
 */

import type { ConfigSnapshot, IndexEntry } from './types.ts'

/** The parsed index. */
export interface GitIndex {
  readonly version: number
  readonly entries: readonly IndexEntry[]
}

/** A parse verdict. */
export type IndexParseResult =
  | { readonly ok: true; readonly index: GitIndex }
  | { readonly ok: false; readonly reason: 'unsupported-index'; readonly detail: string }

/** A lookup verdict. */
export type IndexLookupResult =
  | { readonly ok: true; readonly mode: number | undefined }
  | { readonly ok: false; readonly detail: string }

const SIGNATURE = 0x44495243 // 'DIRC'
const HEADER_BYTES = 12
const ENTRY_HEADER_BYTES = 62
const GITLINK_MODE = 0o160000
const DIRECTORY_MODE = 0o040000
const MAX_ENTRIES = 10_000_000

/** Decode one index path strictly; `undefined` when it is not UTF-8. */
function decodePath(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Decode Git's offset varint used by the version-4 prefix compression. */
function readVarint(buffer: Buffer, offset: number): { readonly value: number; readonly next: number } | undefined {
  if (offset >= buffer.length) return undefined
  let value = buffer[offset]! & 0x7f
  let index = offset
  while ((buffer[index]! & 0x80) !== 0) {
    index++
    if (index >= buffer.length) return undefined
    value = ((value + 1) << 7) | (buffer[index]! & 0x7f)
    if (value > 0x7fffffff) return undefined
  }
  return { value, next: index + 1 }
}

/**
 * Parse one index buffer.
 * @param buffer - the bounded file contents.
 * @returns the entries or the format gate's refusal.
 */
export function parseGitIndex(buffer: Buffer): IndexParseResult {
  if (buffer.length < HEADER_BYTES) return { ok: false, reason: 'unsupported-index', detail: 'index is shorter than its header' }
  if (buffer.readUInt32BE(0) !== SIGNATURE) return { ok: false, reason: 'unsupported-index', detail: 'index magic is not DIRC' }
  const version = buffer.readUInt32BE(4)
  if (version !== 2 && version !== 3 && version !== 4) return { ok: false, reason: 'unsupported-index', detail: `index version ${version} is not supported` }
  const count = buffer.readUInt32BE(8)
  if (count > MAX_ENTRIES) return { ok: false, reason: 'unsupported-index', detail: `index declares ${count} entries` }
  const entries: IndexEntry[] = []
  let offset = HEADER_BYTES
  let previous: Buffer = Buffer.alloc(0)
  for (let index = 0; index < count; index++) {
    const start = offset
    if (offset + ENTRY_HEADER_BYTES > buffer.length) return { ok: false, reason: 'unsupported-index', detail: 'index entry header is truncated' }
    const mode = buffer.readUInt32BE(offset + 24)
    if (mode === DIRECTORY_MODE) return { ok: false, reason: 'unsupported-index', detail: 'index contains a 040000 directory entry' }
    const flags = buffer.readUInt16BE(offset + 60)
    offset += ENTRY_HEADER_BYTES
    if ((flags & 0x4000) !== 0) {
      if (offset + 2 > buffer.length) return { ok: false, reason: 'unsupported-index', detail: 'extended index flags are truncated' }
      offset += 2
    }
    let pathBytes: Buffer
    if (version === 4) {
      const strip = readVarint(buffer, offset)
      if (strip === undefined || strip.value > previous.length) return { ok: false, reason: 'unsupported-index', detail: 'version-4 path prefix is invalid' }
      offset = strip.next
      const nul = buffer.indexOf(0, offset)
      if (nul < 0) return { ok: false, reason: 'unsupported-index', detail: 'version-4 path is not NUL-terminated' }
      pathBytes = Buffer.concat([previous.subarray(0, previous.length - strip.value), buffer.subarray(offset, nul)])
      offset = nul + 1
    } else {
      const nul = buffer.indexOf(0, offset)
      if (nul < 0) return { ok: false, reason: 'unsupported-index', detail: 'index path is not NUL-terminated' }
      pathBytes = buffer.subarray(offset, nul)
      // Git's on-disk entry size is `(offsetof(data) + namelen + 8) & ~7`:
      // 1-8 NUL bytes, ALWAYS at least one, measured from the entry start.
      const dataOffset = 62 + ((flags & 0x4000) !== 0 ? 2 : 0)
      offset = start + ((dataOffset + pathBytes.length + 8) & ~7)
      if (offset > buffer.length) return { ok: false, reason: 'unsupported-index', detail: 'index entry padding is truncated' }
    }
    if (pathBytes.length === 0) return { ok: false, reason: 'unsupported-index', detail: 'index entry has an empty path' }
    const path = decodePath(pathBytes)
    if (path === undefined) return { ok: false, reason: 'unsupported-index', detail: 'index path is not valid UTF-8' }
    const segments = path.split('/')
    if (path.startsWith('/') || segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
      return { ok: false, reason: 'unsupported-index', detail: `index path "${path}" is not a literal relative path` }
    }
    entries.push({ path, pathBytes: Buffer.from(pathBytes), mode })
    previous = pathBytes
  }
  // The index always ends with the object-format checksum; v1 only supports
  // sha1, so the last 20 bytes are NOT extension data.
  const extensionsEnd = buffer.length - 20
  if (offset > extensionsEnd) return { ok: false, reason: 'unsupported-index', detail: 'index entries overrun the checksum' }
  while (offset < extensionsEnd) {
    if (offset + 8 > extensionsEnd) return { ok: false, reason: 'unsupported-index', detail: 'index extension header is truncated' }
    const signature = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32BE(offset + 4)
    offset += 8
    if (size > extensionsEnd - offset) return { ok: false, reason: 'unsupported-index', detail: `index extension ${signature} is truncated` }
    if (signature === 'link') return { ok: false, reason: 'unsupported-index', detail: 'split index (link extension) is not supported' }
    if (signature === 'sdir') return { ok: false, reason: 'unsupported-index', detail: 'sparse index (sdir extension) is not supported' }
    const first = signature.charCodeAt(0)
    // Git's own rule: a lowercase first byte marks a REQUIRED extension this
    // reader does not know, which Git would refuse too.
    if (first >= 97 && first <= 122) return { ok: false, reason: 'unsupported-index', detail: `unknown required index extension ${signature}` }
    offset += size
  }
  if (offset !== extensionsEnd) return { ok: false, reason: 'unsupported-index', detail: 'index extension data does not end at the checksum' }
  return { ok: true, index: { version, entries } }
}

/** The equivalence key of one path on one platform. */
function pathKey(path: string, config: ConfigSnapshot, platform: NodeJS.Platform): string {
  if (platform === 'linux') return config.ignoreCase ? path.toLowerCase() : path
  if (platform === 'darwin') {
    // Accept both Unicode spellings: normalizing to NFC folds an NFD index
    // entry onto the NFC relative path and vice versa. APFS is case
    // insensitive by default, so case folding follows unless ignorecase is
    // explicitly false — Express as "fold unless ignoreCase === false" is not
    // possible (the config carries the resolved boolean), so fold here.
    return path.normalize('NFC').toLowerCase()
  }
  return path.toLowerCase()
}

/**
 * Find the index entry that names one literal relative path.
 *
 * The lookup is literal: no pathspec magic, no glob. Platform equivalence
 * rules are applied symmetrically to the index entry and the relative path;
 * conflicting modes for one equivalence key are refused rather than guessed.
 * @param index - the parsed index.
 * @param relativePath - the path from the repository root, '/'-separated.
 * @param config - the repository configuration snapshot.
 * @param platform - the platform the rules run for.
 * @returns the matching mode, `undefined` when absent, or a refusal.
 */
export function lookupGitlink(index: GitIndex, relativePath: string, config: ConfigSnapshot, platform: NodeJS.Platform): IndexLookupResult {
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.startsWith('../') || relativePath.includes('\u0000')) {
    return { ok: false, detail: `relative path "${relativePath}" is not a literal descendant path` }
  }
  const target = pathKey(relativePath, config, platform)
  const matched: number[] = []
  for (const entry of index.entries) {
    if (pathKey(entry.path, config, platform) !== target) continue
    matched.push(entry.mode)
  }
  if (matched.length === 0) return { ok: true, mode: undefined }
  const modes = new Set(matched)
  if (modes.size > 1) return { ok: false, detail: `index paths with different modes match "${relativePath}"` }
  return { ok: true, mode: matched[0] }
}

export { GITLINK_MODE }
