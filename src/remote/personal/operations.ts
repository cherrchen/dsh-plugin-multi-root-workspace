/**
 * Personal-mode remote operations (ADR-0049 §2): host-key scan tokens,
 * connection test, helper install, and the password → access-key bootstrap.
 * Every external command goes through the injectable `ExecFile` seam.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import type { ExecFile } from './credentials.ts'
import { managedHostAlias, renderAskpass } from './ssh-files.ts'
import type { PersonalEnvironment } from './config.ts'
import { checkRemotePath } from '../manifest.ts'
import { sshPackageRoot } from '../../compat/dsh-version.ts'

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
  readonly hostname: string
  readonly port: number
  readonly alias?: string
  readonly user?: string
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
    return { token: this.remember({ hostname, port, keys }), keys }
  }

  rememberAlias(alias: string, endpoint: { hostname: string; port: number; user: string }, fingerprint: string): string {
    return this.remember({ ...endpoint, alias, keys: [{ type: 'known-hosts', fingerprint, line: '' }] })
  }

  private remember(entry: Omit<ScanToken, 'expiresAt'>): string {
    if (this.tokens.size >= this.limit) {
      for (const [id, entry] of this.tokens) { if (entry.expiresAt <= Date.now()) this.tokens.delete(id) }
      if (this.tokens.size >= this.limit) throw new RemoteOperationError('host-key-scan-failed', 'too many outstanding host key scans')
    }
    const token = randomBytes(8).toString('hex')
    this.tokens.set(token, { ...entry, expiresAt: Date.now() + this.ttlMs })
    return token
  }

  /** Resolve a token + confirmed fingerprint into the recorded known_hosts line(s). */
  resolve(token: string, fingerprint: string, hostname: string, port: number, alias?: string, user?: string): readonly string[] {
    const entry = this.tokens.get(token)
    if (entry === undefined || entry.expiresAt <= Date.now()) {
      throw new RemoteOperationError('host-key-token-expired', 'the host key scan expired; rescan the host')
    }
    const matching = entry.keys.filter(key => key.fingerprint === fingerprint)
    if (entry.hostname !== hostname || entry.port !== port || entry.alias !== alias || entry.user !== user || matching.length === 0) {
      throw new RemoteOperationError('host-key-mismatch', 'the confirmed target or fingerprint does not belong to this scan')
    }
    this.tokens.delete(token)
    return matching.map(key => key.line)
  }
}

/** `ssh` argv for the environment's custody kind. */
export function sshArgs(environment: PersonalEnvironment, credentialRoot: string, extra: readonly string[] = []): string[] {
  if (environment.credential.kind === 'ssh-config') {
    // The user's own alias via ~/.ssh/config. Managed aliases get these from
    // the generated ssh_config; the user's alias config must not weaken them.
    return ['-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'UpdateHostKeys=no',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      ...extra, environment.credential.alias]
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
    const root = sshPackageRoot('@deepseek-ai/dsh-ssh')
    if (root === undefined) return 3
    const require = createRequire(import.meta.url)
    const protocol = require(join(root, 'lib', 'protocol.js')) as { SSH_PROTOCOL_VERSION?: unknown }
    return typeof protocol.SSH_PROTOCOL_VERSION === 'number' ? protocol.SSH_PROTOCOL_VERSION : 3
  } catch {
    return 3
  }
}

export interface HelperInstallResult {
  readonly nodePath: string
  readonly helperPath: string
  readonly sha256: string
  readonly integrity: 2
  readonly treeSha256: string
}

/** Single-quote a value for a remote command string. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * One bounded retry for the second-scale remote probes: the managed link
 * commonly flaps right after `npm install` churns a small remote host, and a
 * bare `printf` failure was observed hiding exactly that. `npm install`
 * itself is NEVER retried — a real package failure must surface at once.
 */
const probe = async (exec: ExecFile, file: string, args: readonly string[], options?: Parameters<ExecFile>[2]): ReturnType<ExecFile> => {
  try {
    return await exec(file, args, options)
  } catch {
    return await exec(file, args, options)
  }
}

/**
 * The digest the remote helper entry recomputes at every launch: every
 * regular file under the installed `node_modules` as a sha256 over sorted
 * `<relative path>\0<content>\0` pairs. The same source runs in the install
 * probe and inside `helper-entry.mjs`, so the two sides cannot drift. Keep
 * the source free of single quotes — the probe embeds it in a remote
 * shell single-quoted `node -e` argument.
 */
export const treeDigestSource = `(root) => {
  const entries = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const rel = full.slice(root.length + 1).replace(/\\\\/g, "/")
      if (entry.isFile()) entries.push([rel, "file", full])
      else if (entry.isSymbolicLink()) entries.push([rel, "symlink", readlinkSync(full)])
      else entries.push([rel, "special", ""])
    }
  }
  walk(root)
  entries.sort()
  const hash = createHash("sha256")
  for (const entry of entries) {
    hash.update(entry[0])
    hash.update("\\0")
    hash.update(entry[1])
    hash.update("\\0")
    hash.update(entry[1] === "file" ? readFileSync(entry[2]) : entry[2])
    hash.update("\\0")
  }
  return hash.digest("hex")
}`

/**
 * The remote entry `helperPath` points at: recompute the recorded file-set
 * digest and refuse to load the upstream helper on any drift — sibling
 * chunks (`protocol.js`, `schemas.js`, `stream-security-*.js`), every
 * npm-installed dependency file, and non-regular dirents like `.bin`
 * symlinks (pinned by path + readlink target) are covered, not just
 * `helper.js`. `helper.sha256` keeps recording `lib/helper.js` itself: the
 * upstream `hello.hash` check compares against the launched helper's own
 * bytes (`fileURLToPath(import.meta.url)` inside helper.js), never this
 * entry file.
 */
export const renderHelperEntry = (expected: string): string => `// dsh-helper entry: verify the installed artifact set, then load the upstream helper.
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
const { createHash } = require("node:crypto")
const { readdirSync, readFileSync, readlinkSync } = require("node:fs")
const digest = ${treeDigestSource}
const root = join(dirname(fileURLToPath(import.meta.url)), "node_modules")
if (digest(root) !== ${JSON.stringify(expected)}) {
  process.stderr.write("dsh remote helper integrity check failed: the installed artifact set differs from the recorded digest\\n")
  process.exit(78)
}
await import("./node_modules/@deepseek-ai/dsh-ssh/lib/helper.js")
`

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
    // `|| true`: a missing node must reach checkRemotePath so the caller sees
    // `helper-node-missing`, not a bare `Command failed:` from execFile.
    const { stdout } = await probe(exec, 'ssh', [...args, 'command -v node || true'], { timeoutMs: 15_000 })
    nodePath = stdout.split('\n')[0]!.trim()
  }
  try {
    checkRemotePath(nodePath)
  } catch {
    throw new RemoteOperationError('helper-node-missing', `the remote node path is missing or not an absolute POSIX path: ${JSON.stringify(nodePath)}`)
  }
  const install = `mkdir -p ~/${shellQuote(dir)} && npm install --prefix ~/${shellQuote(dir)} --no-audit --no-fund --omit=dev ${shellQuote(`@deepseek-ai/dsh-ssh@${version}`)}`
  await exec('ssh', [...args, install], { timeoutMs: 300_000 })
  const { stdout: home } = await probe(exec, 'ssh', [...args, 'printf %s "$HOME"'], { timeoutMs: 15_000 })
  const base = `${home.trim()}/${dir}`
  const modulesDir = `${base}/node_modules`
  const packageLib = `${modulesDir}/@deepseek-ai/dsh-ssh/lib`
  const entryAbs = `${base}/helper-entry.mjs`
  try {
    checkRemotePath(packageLib)
    checkRemotePath(entryAbs)
  } catch {
    throw new RemoteOperationError('helper-install-failed', 'the remote $HOME did not resolve to an absolute path')
  }
  // One remote node probe: the file-set digest the entry will pin, plus the
  // per-file lib/ hashes the host cross-checks against its own package —
  // `lib/*.js` bytes must be identical to the published tarball the host runs.
  const probeJs = `const{createHash}=require("node:crypto"),{readdirSync,readFileSync,readlinkSync,statSync}=require("node:fs"),{join}=require("node:path"),digest=${treeDigestSource},lib={};`
    + `for(const n of readdirSync(${JSON.stringify(packageLib)}))if(statSync(join(${JSON.stringify(packageLib)},n)).isFile())lib[n]=createHash("sha256").update(readFileSync(join(${JSON.stringify(packageLib)},n))).digest("hex");`
    + `process.stdout.write(JSON.stringify({tree:digest(${JSON.stringify(modulesDir)}),lib}))`
  const { stdout } = await probe(exec, 'ssh', [...args, `${shellQuote(nodePath)} -e ${shellQuote(probeJs)}`], { timeoutMs: 60_000 })
  let installed: { tree?: unknown; lib?: unknown }
  try {
    installed = JSON.parse(stdout) as { tree?: unknown; lib?: unknown }
  } catch {
    installed = {}
  }
  if (typeof installed.tree !== 'string' || !/^[0-9a-f]{64}$/.test(installed.tree) || installed.lib === null || typeof installed.lib !== 'object') {
    throw new RemoteOperationError('helper-install-failed', 'the remote helper artifact set could not be read')
  }
  const hostLibDir = dirname(options.hostHelperPath)
  const hostLib: Record<string, string> = {}
  for (const name of readdirSync(hostLibDir)) {
    if (statSync(join(hostLibDir, name)).isFile()) {
      hostLib[name] = createHash('sha256').update(readFileSync(join(hostLibDir, name))).digest('hex')
    }
  }
  const libEntries = (lib: Record<string, unknown>) => Object.keys(lib).sort().map(name => [name, lib[name]])
  if (JSON.stringify(libEntries(installed.lib as Record<string, unknown>)) !== JSON.stringify(libEntries(hostLib))) {
    throw new RemoteOperationError('helper-hash-mismatch', `the remote dsh-ssh lib files do not match the host's ${version} copy`)
  }
  // helper.sha256 is lib/helper.js itself — the artifact upstream's
  // hello.hash check identifies — while the entry script pins the file set.
  const helperSha = hostLib['helper.js']
  if (helperSha === undefined) {
    throw new RemoteOperationError('helper-install-failed', `the host's dsh-ssh package has no lib/helper.js under ${hostLibDir}`)
  }
  const entry = renderHelperEntry(installed.tree)
  await exec('ssh', [...args, `umask 077; cat > ${shellQuote(entryAbs)}`], { input: entry, timeoutMs: 30_000 })
  return { nodePath, helperPath: entryAbs, sha256: helperSha, integrity: 2, treeSha256: installed.tree }
}

/** Verify the installed entry against Host-owned metadata before opening it. */
export async function verifyHelperEntry(
  exec: (file: string, args: readonly string[]) => Promise<{ stdout: string }>,
  host: string, nodePath: string, entryPath: string, treeSha256: string,
): Promise<void> {
  const expected = createHash('sha256').update(renderHelperEntry(treeSha256)).digest('hex')
  const probe = 'const fs=require("node:fs"), crypto=require("node:crypto"); const p=process.argv[1]; if(!fs.lstatSync(p).isFile()) process.exit(78); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"))'
  const { stdout } = await exec('ssh', [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'UpdateHostKeys=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', host,
    `${shellQuote(nodePath)} -e ${shellQuote(probe)} ${shellQuote(entryPath)}`,
  ])
  if (stdout.trim() !== expected) throw new RemoteOperationError('helper-hash-mismatch', 'the remote Helper entry differs from the Host-pinned artifact')
}

/**
 * Pin the exact confirmed server key and password before a two-phase remote
 * edit. Later local config changes cannot redirect an install or its rollback.
 */
export function pinAccessKeyTarget(environment: PersonalEnvironment, credentialRoot: string, secretFile: string): {
  readonly knownHosts: string; readonly secretFile: string; dispose(): void
} {
  const { hostname, port } = environment.endpoint
  const lookup = port === 22 ? hostname : `[${hostname}]:${port}`
  const entries = readFileSync(join(credentialRoot, 'known_hosts'), 'utf8').split('\n').flatMap(line => {
    const [hosts, type, payload] = line.trim().split(/\s+/)
    if (hosts !== lookup || type === undefined || payload === undefined) return []
    const fingerprint = createHash('sha256').update(Buffer.from(payload, 'base64')).digest('base64').replace(/=+$/, '')
    return `SHA256:${fingerprint}` === environment.hostKey ? [`${lookup} ${type} ${payload}`] : []
  })
  if (entries.length !== 1) throw new RemoteOperationError('host-identity-unverifiable', 'the confirmed access-key server key is unavailable or ambiguous')
  const temp = mkdtempSync(join(credentialRoot, 'access-key-'))
  const dispose = () => rmSync(temp, { recursive: true, force: true })
  try {
    const pinnedSecret = join(temp, 'password')
    const knownHosts = join(temp, 'known_hosts')
    writeFileSync(pinnedSecret, readFileSync(secretFile), { mode: 0o600 })
    writeFileSync(knownHosts, entries[0]! + '\n', { mode: 0o600 })
    return { knownHosts, secretFile: pinnedSecret, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

// Both edits take the same lock so two plugin Hosts cannot lose each other's
// entries. Write a new file alongside the old one before replacing it.
const AUTHORIZED_KEYS_EDIT = [
  'umask 077; mkdir -p "$HOME/.ssh" && cd "$HOME/.ssh" || exit 1',
  'IFS= read -r key && [ -n "$key" ] || exit 1',
  'for i in 1 2 3 4 5; do mkdir .dsh-authorized-keys.lock 2>/dev/null && break; [ "$i" != 5 ] || exit 1; sleep 1; done',
  `tmp=; trap '[ -z "$tmp" ] || rm -f "$tmp"; rmdir .dsh-authorized-keys.lock' EXIT`,
  `trap 'exit 1' HUP INT TERM`,
  '[ ! -L authorized_keys ] && { [ ! -e authorized_keys ] || [ -f authorized_keys ]; } || exit 1',
  'tmp=$(mktemp .dsh-authorized-keys.XXXXXXXX) || exit 1',
  `if [ -f authorized_keys ]; then DSH_EDIT_KEY="$key" awk '$0 != ENVIRON["DSH_EDIT_KEY"]' authorized_keys > "$tmp" || exit 1; fi`,
].join('; ')

async function editAccessKey(
  exec: ExecFile,
  environment: PersonalEnvironment,
  credentialRoot: string,
  accessKey: { publicKey: string },
  secretFile: string,
  operation: 'install' | 'remove',
  knownHosts?: string,
): Promise<void> {
  renderAskpass(credentialRoot)
  const { hostname, port, user } = environment.endpoint
  const target = knownHosts === undefined
    ? ['-F', join(credentialRoot, 'ssh_config'), managedHostAlias(environment.environmentId)]
    : ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'UpdateHostKeys=no',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', `UserKnownHostsFile="${knownHosts.replace(/%/g, '%%').replace(/[\\"]/g, '\\$&')}"`, '-p', String(port), '-l', user, '--', hostname]
  const install = operation === 'install' ? '; printf "%s\\n" "$key" >> "$tmp" || exit 1' : ''
  await exec('ssh', [
    '-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1',
    ...target, `${operation === 'remove' ? '[ -e "$HOME/.ssh/authorized_keys" ] || exit 0; ' : ''}${AUTHORIZED_KEYS_EDIT}${install}; mv -f "$tmp" authorized_keys`,
  ], {
    input: `${accessKey.publicKey}\n`,
    env: { SSH_ASKPASS: join(credentialRoot, 'askpass.sh'), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'dsh', DSH_SSH_SECRET_FILE: secretFile },
    timeoutMs: 30_000,
  })
}

export async function installAccessKey(
  exec: ExecFile, environment: PersonalEnvironment, credentialRoot: string, accessKey: { publicKey: string }, secretFile: string,
  knownHosts?: string,
): Promise<void> {
  await editAccessKey(exec, environment, credentialRoot, accessKey, secretFile, 'install', knownHosts)
}

export async function removeAccessKey(
  exec: ExecFile, environment: PersonalEnvironment, credentialRoot: string, accessKey: { publicKey: string }, secretFile: string,
  knownHosts: string,
): Promise<void> {
  await editAccessKey(exec, environment, credentialRoot, accessKey, secretFile, 'remove', knownHosts)
}
