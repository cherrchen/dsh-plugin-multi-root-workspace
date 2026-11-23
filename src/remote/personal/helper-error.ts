import type { SshFailureDetails } from '../ssh-diagnostics.ts'
import { CommandExecutionError } from './credentials.ts'

export class HelperInstallError extends Error {
  constructor(readonly code: string, message: string, readonly details: SshFailureDetails, cause?: unknown) {
    super(message, { cause })
    this.name = 'HelperInstallError'
  }
}

// OpenSSH only guarantees exit 255 for its own failures. Match explicit
// C-locale diagnostics in that context. Forward a fixed excerpt, never a
// target, command line, key path, or arbitrary stderr supplied by the server.
const sshDiagnostics = [
  [/^Host key verification failed\.$|^WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!$/m, 'ssh-connect-host-key', 'host-key', 'Host key verification failed.'],
  [/^(?:[^\r\n]+: )?Permission denied \([a-z,-]+\)\.?$/m, 'ssh-connect-auth', 'authentication', 'Permission denied (SSH authentication).'],
  [/^ssh: (?:Could not resolve hostname [^\r\n]+|connect to host [^\r\n]+: (?:Connection refused|No route to host|Network is unreachable))$/mi,
    'ssh-connect-unreachable', 'connection', 'SSH could not reach the host.'],
  [/^(?:ssh: connect to host [^\r\n]+: (?:Connection|Operation) timed out|Connection timed out during banner exchange)$/mi,
    'ssh-connect-timeout', 'connection', 'SSH connection timed out.'],
  [/^(?:Connection (?:closed|reset) by [^\r\n]+|client_loop: send disconnect: Broken pipe)$/mi,
    'ssh-connect-interrupted', 'connection', 'SSH connection closed or reset.'],
] as const

export function helperCommandError(
  cause: unknown, stage: SshFailureDetails['stage'], remoteState?: SshFailureDetails['remoteState'],
): HelperInstallError {
  const processError = cause instanceof CommandExecutionError ? cause : undefined
  const exitCode = processError?.exitCode
  const facts = {
    stage, ...(remoteState === undefined ? {} : { remoteState }),
    ...(exitCode === undefined ? {} : { exitCode }),
  }
  if (processError?.timedOut === true) {
    const code = stage === 'ssh-connect' ? 'ssh-connect-timeout' : stage === 'remote-install' ? 'helper-install-timeout' : 'helper-stage-timeout'
    return new HelperInstallError(code, 'The SSH process exceeded its time limit.', {
      ...facts, retryable: remoteState === undefined, remediation: remoteState === undefined ? 'connection' : 'verify',
    }, cause)
  }
  if (processError?.systemCode === 'ENOENT') {
    return new HelperInstallError('ssh-client-missing', 'The local ssh executable is unavailable.', {
      ...facts, stage: stage === 'ssh-connect' ? 'host-preflight' : stage, retryable: false, remediation: 'host',
    }, cause)
  }
  if (stage === 'ssh-connect' || exitCode === 255) {
    const match = exitCode === 255 ? sshDiagnostics.find(([pattern]) => pattern.test(processError!.stderr)) : undefined
    const [, code, remediation, stderr] = match ?? [undefined, 'ssh-connect-unknown', 'connection', undefined] as const
    return new HelperInstallError(code, 'OpenSSH could not complete the request.', {
      ...facts, retryable: remoteState === undefined && remediation === 'connection', remediation,
      ...(stderr === undefined ? {} : { stderr }),
    }, cause)
  }
  const code = stage === 'entry-generation' ? 'helper-entry-write' : 'helper-stage-unexpected'
  return new HelperInstallError(code, 'The remote command ended without a recognized result.', {
    ...facts, retryable: false, remediation: 'verify',
  }, cause)
}
