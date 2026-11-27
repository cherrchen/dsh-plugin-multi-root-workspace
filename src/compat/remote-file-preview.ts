import { REMOTE_FILE_PREVIEW_TRANSPORT } from '../remote/files-contract.ts'
import { SUPPORTED_SSH_RELEASES } from './dsh-version.ts'

/** Every release that may browse an SSH remote root also carries the preview's binary transport. */
export function remoteFilePreviewTransport(release: string | undefined): typeof REMOTE_FILE_PREVIEW_TRANSPORT | undefined {
  return release !== undefined && (SUPPORTED_SSH_RELEASES as readonly string[]).includes(release) ? REMOTE_FILE_PREVIEW_TRANSPORT : undefined
}
