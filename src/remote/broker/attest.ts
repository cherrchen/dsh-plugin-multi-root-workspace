/**
 * Host-side attestation for the credential broker (ADR-0040).
 *
 * Nothing here trusts the broker's self-description: the socket's owner and
 * mode, the unreadability of the credential root from THIS account, the
 * kernel-authenticated hello and the deployment-recorded confinement probe
 * are each checked before any environment is opened. A failure returns
 * `unavailable` and the caller must not mount the remote tools — the
 * deployment stays `unattested` and no model-facing capability appears.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-broker/attest
 */
import { accessSync, constants, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { manifestDigest, type DeploymentManifest } from '../manifest.ts'
import { BrokerConnection, BrokerEnvironmentManager } from './client.ts'
import { MAX_COMMAND_OUTPUT } from './protocol.ts'

/** The deployment facts the Host's protected config carries. */
export interface BrokerConfig {
  /** The broker's Unix socket (in a broker-owned, group-only directory). */
  readonly socketPath: string
  /** The dedicated account's uid; the socket owner and the hello must match. */
  readonly brokerUid: number
  /** The broker's credential root; it must be UNREADABLE from this account. */
  readonly credentialRoot: string
  /** The deployment prohibits unrestricted Agent processes under the Host UID. */
  readonly fullAccessDisabled?: boolean
  /**
   * Deployment evidence that a command run under the Agent's sandbox mode
   * could neither read `credentialRoot` nor connect to `socketPath`. The
   * broker cannot prove this at run time; a missing/false record fails closed.
   */
  readonly confinementProbe?: { readonly verified: boolean; readonly evidence?: string }
}

/** One attestation outcome: a ready manager, or the reason there is none. */
export type BrokerAttestation =
  | { readonly status: 'attested'; readonly connection: BrokerConnection; readonly manager: BrokerEnvironmentManager }
  | { readonly status: 'unavailable'; readonly code: string; readonly reason: string }

const unavailable = (code: string, reason: string): BrokerAttestation => ({ status: 'unavailable', code, reason })

const refuse = (reason: string): never => {
  throw Object.assign(new Error(reason), { code: 'destination-isolation-required' })
}

export function assertBrokerDestinations(manifest: DeploymentManifest): void {
  const byId = new Map(manifest.environments.map(environment => [environment.environmentId, environment]))
  for (const binding of manifest.bindings) {
    const imports = (binding.transfers ?? []).filter(transfer => transfer.direction === 'import')
    if (imports.length === 0 || !binding.actions.includes('write')) continue
    const destination = byId.get(binding.environmentId)
    if (destination === undefined || destination.transport !== 'sftp'
      || destination.transfer?.destinationIsolation !== 'chroot-sftp') {
      refuse(`import binding "${binding.environmentId}/${binding.rootId}" requires an sftp destination declared destinationIsolation chroot-sftp`)
    }
    for (const other of manifest.environments) {
      if (other.environmentId !== destination!.environmentId
        && other.namespace === destination!.namespace && other.account === destination!.account
        && (other.transport === 'helper' || other.exec !== undefined)) {
        refuse(`environment "${other.environmentId}" shares the copy destination account "${destination!.account}" with general execution`)
      }
    }
  }
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'broker-failed'
}

/**
 * Check the broker boundary and, only when every check passes, connect.
 * @param config - the deployment's broker facts.
 * @param manifest - the same deployment manifest the broker reads (protected).
 * @returns an attested manager, or the first failed check.
 */
export async function attestBroker(config: BrokerConfig, manifest: DeploymentManifest): Promise<BrokerAttestation> {
  if (process.platform === 'win32') return unavailable('unsupported-platform', 'the credential broker is POSIX-only')
  const uid = process.getuid?.()
  if (uid === undefined) return unavailable('unsupported-platform', 'the Host has no POSIX uid')
  if (uid === 0 || config.brokerUid === 0) return unavailable('broker-root-uid', 'the Host and the broker must be unprivileged accounts')
  if (!Number.isInteger(config.brokerUid) || config.brokerUid <= 0) return unavailable('invalid-config', 'brokerUid must be a positive integer')
  if (config.brokerUid === uid) {
    return unavailable('broker-same-uid', 'the broker runs under the Host account; custody is not isolated')
  }
  if (config.confinementProbe?.verified !== true) {
    return unavailable('confinement-unproven', 'the deployment recorded no passing Agent-sandbox probe for the credential root and socket')
  }
  if (config.fullAccessDisabled !== true) {
    return unavailable('full-access-unrestricted', 'the deployment has not excluded danger-full-access under the Host account')
  }
  if (manifest.environments.some(({ exec }) => exec !== undefined
    && Math.max(exec.stdoutLimit, exec.stderrLimit) > MAX_COMMAND_OUTPUT)) {
    return unavailable('broker-output-limit', `remote command output limits must be at most ${MAX_COMMAND_OUTPUT} bytes per stream with broker custody`)
  }
  try {
    assertBrokerDestinations(manifest)
  } catch (error) {
    return unavailable(codeOf(error), error instanceof Error ? error.message : String(error))
  }

  let root
  try { root = lstatSync(config.credentialRoot) } catch (error) {
    return unavailable('credentials-unchecked', `cannot stat the credential root: ${codeOf(error)}`)
  }
  if (root.isSymbolicLink() || !root.isDirectory()) return unavailable('credential-root-not-directory', 'the credential root must be a real directory, not a symlink')
  if (root.uid !== config.brokerUid) return unavailable('credential-root-owner', 'the credential root is not owned by the broker account')
  if ((root.mode & 0o777) !== 0o700) return unavailable('credential-root-mode', 'the credential root must be mode 0700')

  // The decisive credential check comes first: this account must NOT be able
  // to read the broker's key/config root. EACCES/EPERM is the pass; success is
  // a failure.
  try {
    accessSync(config.credentialRoot, constants.R_OK)
    return unavailable('credentials-readable', 'the Host account can read the broker credential root')
  } catch (error) {
    const code = codeOf(error)
    if (code !== 'EACCES' && code !== 'EPERM') return unavailable('credentials-unchecked', `cannot probe the credential root: ${code}`)
  }

  let socket
  try { socket = lstatSync(config.socketPath) } catch (error) {
    return unavailable('socket-missing', `cannot stat the broker socket: ${codeOf(error)}`)
  }
  if (!socket.isSocket()) return unavailable('socket-not-a-socket', 'the configured path is not a Unix socket')
  if (socket.uid !== config.brokerUid) return unavailable('socket-owner-mismatch', 'the socket is not owned by the broker account')
  if ((socket.mode & 0o007) !== 0) return unavailable('socket-world-accessible', 'the socket is accessible to users outside the deployment group')
  let directory
  try { directory = lstatSync(dirname(config.socketPath)) } catch {
    return unavailable('socket-directory-unreadable', 'the socket directory is not accessible')
  }
  if (!directory.isDirectory() || directory.uid !== config.brokerUid || (directory.mode & 0o007) !== 0) {
    return unavailable('socket-directory-unsafe', 'the socket directory must be a broker-owned directory without world access')
  }

  let connection: BrokerConnection
  try {
    connection = await BrokerConnection.connect(config.socketPath, config.brokerUid)
  } catch (error) {
    return unavailable(codeOf(error), error instanceof Error ? error.message : String(error))
  }
  const hello = connection.hello
  if (hello === undefined || hello.brokerUid !== config.brokerUid) {
    connection.close()
    return unavailable('broker-uid-mismatch', 'the broker hello did not report the configured account')
  }
  if (hello.manifestDigest !== manifestDigest(manifest)) {
    connection.close()
    return unavailable('manifest-mismatch', 'the broker and Host loaded different deployment manifests')
  }
  const capability = hello.sshCapability as { eligible?: unknown; reason?: unknown } | undefined
  if (capability === undefined || typeof capability !== 'object' || capability.eligible !== true
    || (capability.reason !== undefined && typeof capability.reason !== 'string')) {
    connection.close()
    return unavailable('ssh-capability-absent', 'the broker reports no eligible SSH capability')
  }
  return { status: 'attested', connection, manager: new BrokerEnvironmentManager(manifest, connection) }
}
