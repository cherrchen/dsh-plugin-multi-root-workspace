import { REMOTE_FILE_PREVIEW_TRANSPORT } from '../remote/files-contract.ts'

/** Binary carrier evidence is currently limited to this exact release. */
export function remoteFilePreviewTransport(release: string | undefined): typeof REMOTE_FILE_PREVIEW_TRANSPORT | undefined {
  return release === '0.2.3-alpha.2' ? REMOTE_FILE_PREVIEW_TRANSPORT : undefined
}
