/**
 * Personal-mode remote operations (ADR-0041 §2): host-key scan tokens,
 * connection test, helper install, and the password → access-key bootstrap.
 * Every external command goes through the injectable `ExecFile` seam.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { ExecFile } from './credentials.ts'
import { managedHostAlias, renderAskpass } from './ssh-files.ts'
import type { PersonalEnvironment } from './config.ts'
import { checkRemotePath } from '../manifest.ts'

export class RemoteOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteOperationError'
  }
}

export interface ScannedHostKey {
  readonly type: string
  readonly fingerprint: string
  readonly line: string
}

interface ScanToken {
  readonly keys: readonly ScannedHostKey[]
  readonly expiresAt: number
}

/** 60-second, bounded host-key scan tokens: the confirmed fingerprint must come from OUR scan, never the client. */
export class HostKeyScans {
  private readonly tokens = new Map<string, ScanToken>()
  constructor(private readonly exec: ExecFile, private readonly ttlMs = 60_000, private readonly limit = 64) {}

  async scan(hostname: string, port: number): Promise<{ token: string; keys: readonly ScannedHostKey[] }> {
    const { stdout } = await this.exec('ssh-keyscan', ['-T', '5', '-p', String(port), hostname], { timeoutMs: 15_000 })
    const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
    if (lines.length === 0) throw new RemoteOperationError('host-key-scan-failed', `ssh-keyscan returned no host keys for ${hostname}:${port}`)
    const keys: ScannedHostKey[] = []
    for (const line of lines) {
      const { stdout: printed } = await this.exec('ssh-keygen', ['-lf', '-'], { input: `${line}\n`, timeoutMs: 10_000 })
      const match = /(SHA256:[A-Za-z0-9+/=]+)/.exec(printed)
      if (match === null) continue
      keys.push({ type: line.split(/\s+/)[1] ?? 'unknown', fingerprint: match[1]!, line })
    }
    if (keys.length === 0) throw new RemoteOperationError('host-key-scan-failed', `no usable host key fingerprints for ${hostname}:${port}`)
    if (this.tokens.size >= this.limit) {
      for (const [id, entry] of this.tokens) { if (entry.expiresAt <= Date.now()) this.tokens.delete(id) }
      if (this.tokens.size >= this.limit) throw new RemoteOperationError('host-key-scan-failed', 'too many outstanding host key scans')
    }
    const token = randomBytes(8).toString('hex')
    this.tokens.set(token, { keys, expiresAt: Date.now() + this.ttlMs })
    return { token, keys }
  }

  /** Resolve a token + confirmed fingerprint into the recorded known_hosts line(s). */
  resolve(token: string, fingerprint: string): readonly string[] {
    const entry = this.tokens.get(token)
    if (entry === undefined || entry.expiresAt <= Date.now()) {
      throw new RemoteOperationError('host-key-token-expired', 'the host key scan expired; rescan the host')
    }
    const matching = entry.keys.filter(key => key.fingerprint === fingerprint)
    if (matching.length === 0) {
      throw new RemoteOperationError('host-key-mismatch', 'the confirmed fingerprint does not belong to this scan')
    }
    this.tokens.delete(token)
    return matching.map(key => key.line)
  }
}

/** `ssh` argv for the environment's custody kind. */
export function sshArgs(environment: PersonalEnvironment, credentialRoot: string, extra: readonly string[] = []): string[] {
  if (environment.credential.kind === 'ssh-config') {
    // The user's own alias via ~/.ssh/config (upstream consistency).
    return [...extra, environment.credential.alias]
  }
  return ['-F', join(credentialRoot, 'ssh_config'), ...extra, managedHostAlias(environment.environmentId)]
}

export interface ConnectionTest {
  readonly platform: string
  readonly nodePath?: string | undefined
  readonly nodeVersion?: string | undefined
}

export async function testConnection(exec: ExecFile, environment: PersonalEnvironment, credentialRoot: string): Promise<ConnectionTest> {
  const args = sshArgs(environment, credentialRoot, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
  const { stdout } = await exec('ssh', [...args, 'uname -s; command -v node || true; node -v 2>/dev/null || true'], { timeoutMs: 30_000 })
  const [uname = '', nodePath = '', nodeVersion = ''] = stdout.split('\n').map(line => line.trim())
  return {
    platform: uname === 'Linux' ? 'linux' : uname === 'Darwin' ? 'darwin' : 'unsupported',
    nodePath: nodePath === '' ? undefined : nodePath,
    nodeVersion: nodeVersion === '' ? undefined : nodeVersion,
  }
}

/**
 * `SSH_PROTOCOL_VERSION` from the installed @deepseek-ai/dsh-ssh
 * (`lib/protocol.js`, constant 3 in 0.2.2-rc.x). The manifest's
 * `helper.protocol` is our deployment fact; recording the upstream constant
 * is the documented choice when no live hello is available.
 */
export function helperProtocol(): number {
  try {
    const require = createRequire(import.meta.url)
    const protocol = require('@deepseek-ai/dsh-ssh/lib/protocol.js') as { SSH_PROTOCOL_VERSION?: unknown }
    return typeof protocol.SSH_PROTOCOL_VERSION === 'number' ? protocol.SSH_PROTOCOL_VERSION : 3
  } catch {
    return 3
  }
}

export interface HelperInstallResult {
  readonly nodePath: string
  readonly helperPath: string
  readonly sha256: string
}

/** Single-quote a value for a remote command string. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * npm-install the host's exact dsh-ssh version on the remote and verify the
 * remote helper.js hash against the HOST's resolved copy. The recorded
 * nodePath is always an absolute normalized POSIX path — resolved with the
 * same remote `command -v node` as `testConnection` when not supplied.
 */
export async function installHelper(
  exec: ExecFile,
  environment: PersonalEnvironment,
  credentialRoot: string,
  options: { sshVersion: string; hostHelperPath: string; nodePath?: string | undefined },
): Promise<HelperInstallResult> {
  const version = options.sshVersion
  const dir = `.dsh-helper/${version}`
  const args = sshArgs(environment, credentialRoot, ['-o', 'BatchMode=yes'])
  let nodePath = options.nodePath
  if (nodePath === undefined) {
    const { stdout } = await exec('ssh', [...args, 'command -v node'], { timeoutMs: 15_000 })
    nodePath = stdout.split('\n')[0]!.trim()
  }
  try {
    checkRemotePath(nodePath)
  } catch {
    throw new RemoteOperationError('helper-node-missing', `the remote node path is missing or not an absolute POSIX path: ${JSON.stringify(nodePath)}`)
  }
  const install = `mkdir -p ~/${shellQuote(dir)} && npm install --prefix ~/${shellQuote(dir)} --no-audit --no-fund --omit=dev ${shellQuote(`@deepseek-ai/dsh-ssh@${version}`)}`
  await exec('ssh', [...args, install], { timeoutMs: 300_000 })
  const { stdout: home } = await exec('ssh', [...args, 'printf %s "$HOME"'], { timeoutMs: 15_000 })
  const helperAbs = `${home.trim()}/${dir}/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js`
  try {
    checkRemotePath(helperAbs)
  } catch {
    throw new RemoteOperationError('helper-install-failed', 'the remote $HOME did not resolve to an absolute path')
  }
  const { stdout } = await exec('ssh', [...args, `sha256sum ${shellQuote(helperAbs)} 2>/dev/null || shasum -a 256 ${shellQuote(helperAbs)}`], { timeoutMs: 30_000 })
  const remoteHash = /^[0-9a-f]{64}/.exec(stdout.trim())?.[0]
  if (remoteHash === undefined) throw new RemoteOperationError('helper-install-failed', 'the remote helper hash could not be read')
  const hostHash = createHash('sha256').update(readFileSync(options.hostHelperPath)).digest('hex')
  if (remoteHash !== hostHash) {
    throw new RemoteOperationError('helper-hash-mismatch', `the remote helper.js hash does not match the host's ${version} copy`)
  }
  return { nodePath, helperPath: helperAbs, sha256: remoteHash }
}

/**
 * Password credentials: log in once with the stored password (askpass,
 * pubkey auth disabled), append a freshly generated per-environment access
 * key to the remote authorized_keys, then every later connection uses it.
 */
export async function installAccessKey(
  exec: ExecFile,
  environment: PersonalEnvironment,
  credentialRoot: string,
  accessKey: { publicKey: string },
  secretFile: string,
): Promise<void> {
  renderAskpass(credentialRoot)
  const args = [
    '-F', join(credentialRoot, 'ssh_config'),
    '-o', 'BatchMode=no',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1',
    managedHostAlias(environment.environmentId),
    'umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys',
  ]
  await exec('ssh', args, {
    input: `${accessKey.publicKey}\n`,
    env: {
      SSH_ASKPASS: join(credentialRoot, 'askpass.sh'),
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: 'dsh',
      DSH_SSH_SECRET_FILE: secretFile,
    },
    timeoutMs: 60_000,
  })
}
