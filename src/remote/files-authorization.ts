/**
 * The opaque `browseAuthorization` token (ADR-0052 P3), split into its own
 * node-only module so `command.ts` can mint it without pulling the whole
 * listing service into the general command carrier.
 */
import { createHash } from 'node:crypto'

/** The opaque token `remotes` hands the panel: sha256 of the grant's live identity. */
export function remoteFilesAuthorization(epoch: string, incarnation: string, binding: string, environment: string): string {
  return createHash('sha256').update(JSON.stringify([epoch, incarnation, binding, environment])).digest('hex')
}
