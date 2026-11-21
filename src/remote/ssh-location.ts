/** SSH URI authority shared by the Host's views and the personal binding dialog. */
export function sshTarget(user: string, hostname: string, port?: number): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return `ssh://${encodeURIComponent(user)}@${host}${port === undefined ? '' : `:${port}`}`
}

/** Keep path separators and escape characters with special meaning in a URI. */
export function sshLocation(target: string | undefined, path: string): string {
  return target === undefined ? path : target + path.split('/').map(encodeURIComponent).join('/')
}
