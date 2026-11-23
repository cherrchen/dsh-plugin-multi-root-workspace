import { z } from 'zod'

export const SSH_HELPER_STAGES = [
  'host-preflight', 'ssh-connect', 'remote-prerequisites', 'remote-install',
  'artifact-verification', 'entry-generation', 'config-commit',
] as const

export const SSH_REMEDIATIONS = [
  'dependencies', 'restart', 'host', 'connection', 'authentication', 'host-key',
  'node', 'npm', 'directory', 'registry', 'verify', 'reload',
] as const

export const sshFailureDetailsSchema = z.object({
  stage: z.enum(SSH_HELPER_STAGES),
  retryable: z.boolean(),
  remediation: z.enum(SSH_REMEDIATIONS),
  exitCode: z.number().int().optional(),
  stderr: z.string().max(240).optional(),
  expectedVersion: z.string().max(64).optional(),
  actualVersion: z.string().max(64).optional(),
  remoteState: z.enum(['may-have-changed', 'installed', 'verified']).optional(),
  registration: z.enum(['not-committed', 'unconfirmed']).optional(),
})

export type SshFailureDetails = z.infer<typeof sshFailureDetailsSchema>

export const sshDependencyViewSchema = z.object({
  code: z.enum([
    'ready', 'ssh-host-unsupported', 'ssh-host-platform', 'ssh-deps-missing', 'ssh-deps-partial',
    'ssh-deps-version', 'ssh-deps-private', 'ssh-deps-resolution', 'ssh-deps-restart',
  ]),
  profile: z.string().optional(),
  release: z.string().optional(),
  command: z.string().optional(),
  packages: z.array(z.object({
    name: z.string(),
    state: z.enum(['missing', 'installed', 'version-mismatch', 'private', 'unresolvable']),
    version: z.string().optional(),
  })),
})
export type SshDependencyView = z.infer<typeof sshDependencyViewSchema>

export const REMOTE_NODE_MIN_VERSION = '24.9.0'

export function remoteNodeVersionStatus(version: string | undefined): 'ok' | 'old' | 'invalid' {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version ?? '')
  if (match === null) return 'invalid'
  const actual = match.slice(1).map(Number)
  for (const [index, minimum] of REMOTE_NODE_MIN_VERSION.split('.').map(Number).entries()) {
    const part = actual[index]!
    if (part !== minimum) return part < minimum ? 'old' : 'ok'
  }
  return 'ok'
}

/** POSIX absolute path suitable for the single-line SSH discovery result. */
export function isRemoteNodePath(path: string): boolean {
  return path.startsWith('/') && path.length <= 4096 && !/[\0\r\n]/.test(path)
    && path.split('/').slice(1).every(segment => segment !== '' && segment !== '.' && segment !== '..')
}
