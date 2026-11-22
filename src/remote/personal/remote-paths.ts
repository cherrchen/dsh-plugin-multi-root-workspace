/**
 * Read-only remote directory browsing for the personal SSH panel (ADR-0049
 * §2 UI support). The picker needs names only — never file contents — and the
 * SFTP channel is the same enforced transport the transfer path uses, with one
 * deliberate addition: a managed environment passes the plugin-generated
 * ssh_config through `-F`, so browsing works before `~/.ssh/config` is linked.
 */
import { join } from 'node:path'
import { SftpClient, SftpStatusError, type SftpDirEntry } from '../sftp.ts'
import { managedAlias, type PersonalEnvironment } from './config.ts'
import { RemoteOperationError } from './operations.ts'

/** One selectable directory. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** One directory page, resolved by the SFTP server's own realpath. */
export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly RemoteDirectoryEntry[]
}

const DIRECTORY = 0o040000
const MAX_ENTRIES = 500
const BROWSE_TIMEOUT_MS = 15_000

const isDirectory = (entry: SftpDirEntry): boolean => {
  const permissions = entry.attrs.permissions
  if (permissions !== undefined) return (permissions & 0o170000) === DIRECTORY
  return entry.longname.startsWith('d')
}

const childPath = (parent: string, name: string): string =>
  parent === '/' ? `/${name}` : `${parent}/${name}`

const parentOf = (path: string): string => {
  if (path === '/') return '/'
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

/**
 * Turn one SFTP readdir answer into the picker's bounded, sorted page.
 * @param path - the canonical directory path the server returned.
 * @param entries - the raw readdir entries.
 * @returns names and paths only; files and `.`/`..` are dropped.
 */
export function directoryListingOf(path: string, entries: readonly SftpDirEntry[]): RemoteDirectoryListing {
  const directories = entries
    .filter(entry => entry.name !== '.' && entry.name !== '..' && !entry.name.includes('/') && isDirectory(entry))
    .map(entry => ({ name: entry.name, path: childPath(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_ENTRIES)
  return { path, parent: parentOf(path), entries: directories }
}

const listingError = (error: unknown): never => {
  if (error instanceof RemoteOperationError) throw error
  const detail = error instanceof SftpStatusError
    ? `SFTP status ${error.code}: ${error.message}`
    : error instanceof Error ? error.message : String(error)
  throw new RemoteOperationError('remote-path-listing-failed', detail)
}

/**
 * Open one personal environment's SFTP session and list its directories.
 * @param environment - the saved personal environment.
 * @param credentialRoot - the plugin credential root (managed ssh_config lives here).
 * @param requested - an absolute POSIX path, or undefined for the login directory.
 * @returns the canonical directory plus its parent and child directories.
 */
export async function listRemoteDirectories(
  environment: PersonalEnvironment,
  credentialRoot: string,
  requested?: string | undefined,
): Promise<RemoteDirectoryListing> {
  const configFile = environment.credential.kind === 'managed' ? join(credentialRoot, 'ssh_config') : undefined
  const client = SftpClient.connect(managedAlias(environment), {
    ...(configFile === undefined ? {} : { configFile }),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.dispose()
      reject(new RemoteOperationError('remote-path-listing-failed', `the SFTP directory listing exceeded ${BROWSE_TIMEOUT_MS} ms`))
    }, BROWSE_TIMEOUT_MS)
    timer.unref?.()
  })
  const browse = async (): Promise<RemoteDirectoryListing> => {
    await client.init()
    const target = requested === undefined || requested.trim() === '' ? '.' : requested
    const resolved = await client.realpath(target)
    const entries = await client.readdir(resolved)
    return directoryListingOf(resolved, entries)
  }
  try {
    return await Promise.race([browse(), timeout])
  } catch (error: unknown) {
    return listingError(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    client.dispose()
  }
}
