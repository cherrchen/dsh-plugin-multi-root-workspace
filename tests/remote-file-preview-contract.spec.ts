/**
 * P2: the frozen `remoteFiles.read` wire contract, the opaque preview resource
 * address codec, and the SSH-matrix transport gate. The read request is
 * the listing identity PLUS a nonempty file path; the content envelope is one
 * strict metadata object whose single binary field arrives decoded — never a
 * JSON array, base64, or foreign typed array; the address is an opaque
 * lowercase UUID v4 token that cannot smuggle session, grant or path facts;
 * and the `sftp-binary-v1` carrier follows the exact SSH support matrix —
 * the same version floor as remote browsing rather than a second release list.
 */
import { describe, expect, it } from 'vitest'
import {
  REMOTE_FILE_PREVIEW_LIMITS,
  REMOTE_FILE_PREVIEW_TRANSPORT,
  remoteFilesReadContent,
  remoteFilesReadMetadata,
  remoteFilesReadRequest,
} from '../src/remote/files-contract.ts'
import {
  REMOTE_PREVIEW_KIND,
  REMOTE_PREVIEW_RESOURCE_TYPE,
  remoteFileAddress,
  remoteFileId,
} from '../src/client/file-preview/resource-address.ts'
import { remoteFilePreviewTransport } from '../src/compat/remote-file-preview.ts'
import { SUPPORTED_SSH_RELEASES } from '../src/compat/dsh-version.ts'

const validRequest = {
  sessionId: 'session',
  environmentId: 'env-a',
  rootId: 'work',
  authorization: 'a'.repeat(64),
  relativePath: 'src/空 格\\name.ts',
}

describe('remoteFilesReadRequest', () => {
  it('accepts the listing identity with a nonempty file path, including POSIX name bytes', () => {
    expect(remoteFilesReadRequest.safeParse(validRequest).success).toBe(true)
  })

  it.each(['', '../x', '/x', 'dir//file', 'dir/\0file'])('rejects the directory/escape path %j', relativePath => {
    expect(remoteFilesReadRequest.safeParse({ ...validRequest, relativePath }).success).toBe(false)
  })

  it('rejects an unknown absolutePath operand — the request can never name a raw remote path', () => {
    expect(remoteFilesReadRequest.safeParse({ ...validRequest, absolutePath: '/tmp/x' }).success).toBe(false)
  })
})

describe('remoteFilesReadContent', () => {
  const metadata = { kind: 'file', size: 3, complete: true, modifiedAt: 0 } as const

  it('accepts metadata plus the decoded bytes', () => {
    expect(remoteFilesReadContent.safeParse({ ...metadata, bytes: new Uint8Array([0, 255, 1]) }).success).toBe(true)
  })

  it('accepts an empty file carried as zero bytes', () => {
    expect(remoteFilesReadContent.safeParse({ kind: 'file', size: 0, complete: true, bytes: new Uint8Array() }).success).toBe(true)
  })

  it('accepts the exact 2 MiB ceiling', () => {
    const bytes = new Uint8Array(REMOTE_FILE_PREVIEW_LIMITS.bytes)
    expect(remoteFilesReadContent.safeParse({ kind: 'file', size: bytes.byteLength, complete: true, bytes }).success).toBe(true)
  })

  it.each([
    ['a JSON array', [0, 255, 1]],
    ['a base64 string', 'AP8B'],
    ['a foreign typed array', new Uint16Array([0, 255, 1])],
    ['a null attachment', null],
  ])('rejects bytes decoded as %s', (_label, bytes) => {
    expect(remoteFilesReadContent.safeParse({ ...metadata, bytes }).success).toBe(false)
  })

  it.each([
    ['short', new Uint8Array([0, 1])],
    ['long', new Uint8Array([0, 1, 2, 3])],
  ])('rejects a payload whose actual length disagrees with size (%s)', (_label, bytes) => {
    expect(remoteFilesReadContent.safeParse({ ...metadata, bytes }).success).toBe(false)
  })

  it('rejects size above the cap', () => {
    const bytes = new Uint8Array()
    expect(remoteFilesReadContent.safeParse({ kind: 'file', size: REMOTE_FILE_PREVIEW_LIMITS.bytes + 1, complete: true, bytes }).success).toBe(false)
  })

  it.each([
    ['missing', { kind: 'file', size: 3 }],
    ['false', { kind: 'file', size: 3, complete: false }],
  ])('rejects an incomplete envelope (%s)', (_label, body) => {
    expect(remoteFilesReadContent.safeParse({ ...body, bytes: new Uint8Array([0, 1, 2]) }).success).toBe(false)
  })

  it('rejects unknown properties', () => {
    expect(remoteFilesReadContent.safeParse({ ...metadata, bytes: new Uint8Array([0, 1, 2]), extra: 1 }).success).toBe(false)
  })

  it('remoteFilesReadMetadata rejects an envelope that already carries bytes', () => {
    expect(remoteFilesReadMetadata.safeParse({ ...metadata, bytes: new Uint8Array([0, 1, 2]) }).success).toBe(false)
  })
})

describe('remote preview resource address', () => {
  const id = '0fe429f0-dc60-4e4c-b8a8-1f57b6282dd4'

  it('encodes a lowercase UUID v4 and roundtrips', () => {
    const address = remoteFileAddress(id)
    expect(address).toBe(`dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}`)
    expect(remoteFileId(address!)).toBe(id)
  })

  it('exposes the viewer kind constant for candidate matching', () => {
    expect(REMOTE_PREVIEW_KIND).toBe('mrfw-remote-preview')
  })

  it.each([
    ['corrupt id', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/0fe429f0-dc60-4e4c-b8a8-1f57b6282dd`],
    ['non-v4 id', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/0fe429f0-dc60-3e4c-b8a8-1f57b6282dd4`],
    ['newline', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}\n`],
    ['uppercase id', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id.toUpperCase()}`],
    ['query', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}?x=1`],
    ['hash', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}#f`],
    ['extra segment', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}/extra`],
    ['differently cased scheme', `DSH-RESOURCE://${REMOTE_PREVIEW_RESOURCE_TYPE}/${id}`],
    ['percent-encoded byte', `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/0fe429f0-dc60-4e4c-b8a8-1f57b6282dd%34`],
    ['wrong resource type', `dsh-resource://file/${id}`],
  ])('rejects %s', (_label, address) => {
    expect(remoteFileId(address)).toBeUndefined()
  })

  it.each(['', 'not-a-uuid', id.toUpperCase(), `${id}\n`])('refuses to encode the ineligible id %j', bad => {
    expect(remoteFileAddress(bad)).toBeUndefined()
  })
})

describe('remoteFilePreviewTransport', () => {
  it.each([...SUPPORTED_SSH_RELEASES])('answers the carrier for every SSH-browsing release (%s)', release => {
    expect(remoteFilePreviewTransport(release)).toBe(REMOTE_FILE_PREVIEW_TRANSPORT)
  })

  it.each([undefined, '0.2.1-rc.5', '0.2.2-alpha.3', '0.2.3-alpha.1', '0.2.3'])(
    'stays disabled outside the SSH support matrix for %s',
    release => {
      expect(remoteFilePreviewTransport(release)).toBeUndefined()
    },
  )
})
