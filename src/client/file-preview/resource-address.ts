/**
 * The opaque remote-file preview resource address — `dsh-resource://mrfw-remote/<uuid v4>`.
 * The address carries NOTHING about the remote: no session, environment, root,
 * grant or path — the live mapping lives in the in-memory registry only, so a
 * persisted or pasted address can never name a target (ADR-0053 P2).
 * The codec is pure and case sensitive: it never normalizes the URL, and any
 * id that is not a canonical lowercase UUID v4 is ineligible.
 */
export const REMOTE_PREVIEW_RESOURCE_TYPE = 'mrfw-remote'
export const REMOTE_PREVIEW_KIND = 'mrfw-remote-preview'
const PREFIX = `dsh-resource://${REMOTE_PREVIEW_RESOURCE_TYPE}/`
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function remoteFileAddress(id: string): string | undefined {
  return id.length === 36 && ID.test(id) ? `${PREFIX}${id}` : undefined
}

export function remoteFileId(address: string): string | undefined {
  if (!address.startsWith(PREFIX)) return undefined
  const id = address.slice(PREFIX.length)
  return remoteFileAddress(id) === address ? id : undefined
}
