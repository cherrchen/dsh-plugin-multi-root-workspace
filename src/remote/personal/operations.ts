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
import { isRemoteNodePath, REMOTE_NODE_MIN_VERSION, remoteNodeVersionStatus, type SshFailureDetails } from '../ssh-diagnostics.ts'
import { helperCommandError, HelperInstallError } from './helper-error.ts'

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
  const result = await exec('ssh', [...args, 'uname -s; command -v node || true; node -v 2>/dev/null || true'], {
    timeoutMs: 30_000, env: { LC_ALL: 'C' },
  }).catch((error: unknown) => { throw helperCommandError(error, 'ssh-connect') })
  const [uname = '', nodePath = '', nodeVersion = ''] = result.stdout.split('\n').map(line => line.trim())
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
export function helperProtocol(root: string): number {
  try {
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

/** Read a small JSON response from a remote step that owns its output. */
function objectReply(stdout: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* The caller classifies a malformed response by stage. */ }
  return {}
}

const npmNetworkCodes = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN'])
const npmUnavailableCodes = new Set(['E404', 'ETARGET'])
const hashPattern = /^[0-9a-f]{64}$/

function remoteFailure(
  stage: SshFailureDetails['stage'], code: string, message: string,
  remediation: SshFailureDetails['remediation'], extra: Partial<SshFailureDetails> = {}, cause?: unknown,
): HelperInstallError {
  return new HelperInstallError(code, message, { stage, remediation, retryable: false, ...extra }, cause)
}

function hostLibHashes(path: string): Record<string, string> {
  try {
    const files = Object.fromEntries(readdirSync(path).filter(name => statSync(join(path, name)).isFile())
      .map(name => [name, createHash('sha256').update(readFileSync(join(path, name))).digest('hex')]))
    if (files['helper.js'] === undefined) throw new Error('lib/helper.js is missing')
    return files
  } catch (error) {
    throw remoteFailure('host-preflight', 'helper-host-artifact', 'The Host cannot read its dsh-ssh lib files.', 'dependencies', {}, error)
  }
}

/**
 * Deploy the exact Host helper using one non-retried npm operation and one
 * atomic entry write. Every read-only prerequisite runs before the first
 * remote filesystem mutation. The dependency-tree digest and upstream hello
 * hash continue to describe different artifacts.
 */
export async function installHelper(
  exec: ExecFile,
  environment: PersonalEnvironment,
  credentialRoot: string,
  options: { sshVersion: string; hostHelperPath: string; nodePath?: string | undefined },
): Promise<HelperInstallResult> {
  const version = options.sshVersion
  const hostLib = hostLibHashes(dirname(options.hostHelperPath))
  const args = sshArgs(environment, credentialRoot, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
  const run = async (
    stage: SshFailureDetails['stage'], command: string, timeoutMs: number,
    remoteState?: SshFailureDetails['remoteState'], input?: string,
  ): Promise<string> => {
    try {
      const { stdout } = await exec('ssh', [...args, command], {
        timeoutMs, env: { LC_ALL: 'C' }, ...(input === undefined ? {} : { input }),
      })
      return stdout
    } catch (error) {
      throw helperCommandError(error, stage, remoteState)
    }
  }

  if (options.nodePath !== undefined && !isRemoteNodePath(options.nodePath)) {
    throw remoteFailure('remote-prerequisites', 'helper-node-path', 'The requested Node path is invalid.', 'node')
  }
  const discovery = await run('ssh-connect', `printf '%s\\n' "$(uname -s)" "$(command -v node)" "$HOME"`, 25_000)
  const lines = discovery.replace(/\n$/, '').split('\n')
  const [platform, detectedNode, home] = lines
  if (lines.length !== 3) {
    throw remoteFailure('remote-prerequisites', 'helper-stage-unexpected', 'The remote shell did not return a valid discovery record.', 'verify')
  }
  if (platform !== 'Linux' && platform !== 'Darwin') {
    throw remoteFailure('remote-prerequisites', 'helper-remote-platform', 'The server did not report Linux or macOS.', 'host')
  }
  const nodePath = options.nodePath ?? detectedNode
  if (nodePath === undefined || nodePath === '') {
    throw remoteFailure('remote-prerequisites', 'helper-node-missing', 'Node was not found on the server PATH.', 'node')
  }
  if (!isRemoteNodePath(nodePath)) {
    throw remoteFailure('remote-prerequisites', 'helper-node-path', 'The server did not report a normalized absolute Node path.', 'node')
  }
  if (home === undefined || !isRemoteNodePath(home)) {
    throw remoteFailure('remote-prerequisites', 'helper-remote-directory', 'Remote HOME must be an absolute normalized POSIX path.', 'directory')
  }

  const base = `${home}/.dsh-helper/${version}`
  const modulesDir = `${base}/node_modules`
  const packageLib = `${modulesDir}/@deepseek-ai/dsh-ssh/lib`
  const entryAbs = `${base}/helper-entry.mjs`
  const node = shellQuote(nodePath)
  const nodeCommand = (code: string): string => `${node} -e ${shellQuote(code)}`
  const send = 'const send=(result)=>process.stdout.write(JSON.stringify(result));'
  const configureNpm = `process.env.PATH=${JSON.stringify(dirname(nodePath) + ':')}+(process.env.PATH??"");const {spawnSync}=require("node:child_process");`
  const preflight = send + configureNpm + `
    const {accessSync, statSync, constants}=require("node:fs"), {dirname}=require("node:path");
    const version=process.version;
    let directory=${JSON.stringify(base)};
    try {
      while (true) {
        try { if (!statSync(directory).isDirectory()) { send({version,directory:"ENOTDIR"}); return; } break; }
        catch (error) { if (error.code !== "ENOENT") throw error; directory=dirname(directory); }
      }
      accessSync(directory,constants.W_OK|constants.X_OK);
    } catch (error) { send({version,directory:error.code??"UNKNOWN"}); return; }
    const npm=spawnSync("npm",["--version"],{encoding:"utf8",timeout:8000});
    send({version,npm:npm.status===0});`
  const nodeProbe = objectReply(await run('remote-prerequisites',
    `if [ -f ${node} ] && [ -x ${node} ]; then ${nodeCommand(`(()=>{${preflight}})()`)}; else printf '%s' '{"nodeMissing":true}'; fi`, 20_000))
  if (nodeProbe.nodeMissing === true) {
    throw remoteFailure('remote-prerequisites', 'helper-node-missing', 'The selected Node executable is unavailable.', 'node')
  }
  const actualVersion = typeof nodeProbe.version === 'string' ? nodeProbe.version : undefined
  const nodeStatus = remoteNodeVersionStatus(actualVersion)
  if (nodeStatus !== 'ok') {
    throw remoteFailure('remote-prerequisites', nodeStatus === 'old' ? 'node-too-old' : 'helper-node-version',
      'The selected Node executable does not report a supported release.', 'node', {
        expectedVersion: REMOTE_NODE_MIN_VERSION,
        ...(nodeStatus === 'old' ? { actualVersion: actualVersion!.slice(0, 64) } : {}),
      })
  }
  if (nodeProbe.directory !== undefined) {
    throw remoteFailure('remote-prerequisites', 'helper-remote-directory', 'The Helper directory or its existing parent is not writable.', 'directory')
  }
  if (nodeProbe.npm !== true) {
    throw remoteFailure('remote-prerequisites', 'helper-npm-missing', 'npm --version could not run on the server.', 'npm')
  }

  const install = send + configureNpm + `
    const prefix=${JSON.stringify(base)};
    try { require("node:fs").mkdirSync(prefix,{recursive:true,mode:0o700}); }
    catch (error) { send({outcome:"directory",code:error.code}); return; }
    const npm=spawnSync("npm",["install","--prefix",prefix,"--json","--no-audit","--no-fund","--omit=dev",
      ${JSON.stringify(`@deepseek-ai/dsh-ssh@${version}`)}],{encoding:"utf8",timeout:285000,maxBuffer:1048576});
    if (npm.error) { send({outcome:"process",code:npm.error.code}); return; }
    if (npm.status===0) { send({outcome:"installed"}); return; }
    let code;
    try { code=JSON.parse(npm.stdout)?.error?.code; } catch {}
    send({outcome:"npm",exitCode:npm.status,code});`
  const result = objectReply(await run('remote-install', nodeCommand(`(()=>{${install}})()`), 300_000, 'may-have-changed'))
  const installFacts = {
    remoteState: 'may-have-changed' as const,
    ...(typeof result.exitCode === 'number' && Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
  }
  if (result.outcome !== 'installed') {
    const code = typeof result.code === 'string' ? result.code : ''
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      throw remoteFailure('remote-install', 'helper-disk-space', 'The server reported exhausted disk space or quota.', 'directory', installFacts)
    }
    if (result.outcome === 'directory' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw remoteFailure('remote-install', 'helper-remote-directory', 'The server could not prepare or write the Helper directory.', 'directory', installFacts)
    }
    if (result.outcome === 'process' && code === 'ETIMEDOUT') {
      throw remoteFailure('remote-install', 'helper-install-timeout', 'The server stopped waiting for npm.', 'verify', installFacts)
    }
    if (result.outcome === 'npm' && npmNetworkCodes.has(code)) {
      throw remoteFailure('remote-install', 'helper-npm-network', `npm reported ${code}.`, 'registry', installFacts)
    }
    if (result.outcome === 'npm' && npmUnavailableCodes.has(code)) {
      throw remoteFailure('remote-install', 'helper-npm-package', `npm reported ${code} for the requested package or release.`, 'registry', {
        ...installFacts, expectedVersion: version,
      })
    }
    if (result.outcome === 'npm' && installFacts.exitCode !== undefined) {
      throw remoteFailure('remote-install', 'helper-npm-exit', 'npm exited unsuccessfully.', 'verify', installFacts)
    }
    throw remoteFailure('remote-install', 'helper-stage-unexpected', 'No valid npm completion record was returned.', 'verify', installFacts)
  }

  const verify = send + `const{createHash}=require("node:crypto"),{readdirSync,readFileSync,readlinkSync,statSync}=require("node:fs"),{join}=require("node:path"),digest=${treeDigestSource},lib=Object.create(null);
    try {
      for(const n of readdirSync(${JSON.stringify(packageLib)}))if(statSync(join(${JSON.stringify(packageLib)},n)).isFile())lib[n]=createHash("sha256").update(readFileSync(join(${JSON.stringify(packageLib)},n))).digest("hex");
    } catch (error) { send({artifact:error.code==="ENOENT"?"missing":"unreadable"}); return; }
    try { send({tree:digest(${JSON.stringify(modulesDir)}),lib}); }
    catch { send({artifact:"tree"}); }`
  const installed = objectReply(await run('artifact-verification', nodeCommand(`(()=>{${verify}})()`), 60_000, 'installed'))
  const artifactFacts = { remoteState: 'installed' as const }
  const lib = installed.lib
  if (installed.artifact === 'missing' || (lib !== null && typeof lib === 'object' && !Array.isArray(lib) && !Object.hasOwn(lib, 'helper.js'))) {
    throw remoteFailure('artifact-verification', 'helper-artifact-missing', 'The remote package has no lib/helper.js.', 'verify', artifactFacts)
  }
  if (installed.artifact === 'tree' || (typeof installed.tree === 'string' && !hashPattern.test(installed.tree))) {
    throw remoteFailure('artifact-verification', 'helper-tree-invalid', 'The remote dependency-tree digest is invalid.', 'verify', artifactFacts)
  }
  if (typeof installed.tree !== 'string' || lib === null || typeof lib !== 'object' || Array.isArray(lib)
    || Object.values(lib).some(hash => typeof hash !== 'string' || !hashPattern.test(hash))) {
    throw remoteFailure('artifact-verification', 'helper-artifact-invalid', 'The remote artifact probe returned unreadable or invalid data.', 'verify', artifactFacts)
  }
  const libEntries = (files: Record<string, unknown>) => Object.keys(files).sort().map(name => [name, files[name]])
  if (JSON.stringify(libEntries(lib as Record<string, unknown>)) !== JSON.stringify(libEntries(hostLib))) {
    throw remoteFailure('artifact-verification', 'helper-hash-mismatch', 'The remote dsh-ssh lib files differ from the Host copy.', 'verify', artifactFacts)
  }

  const entry = renderHelperEntry(installed.tree)
  const deploy = send + `
    const {readFileSync,writeFileSync,renameSync,rmSync}=require("node:fs"), {randomUUID,createHash}=require("node:crypto");
    const path=${JSON.stringify(entryAbs)}, temp=path+"."+randomUUID();
    try {
      const bytes=readFileSync(0);
      if (createHash("sha256").update(bytes).digest("hex")!==${JSON.stringify(createHash('sha256').update(entry).digest('hex'))}) {
        send({written:false}); return;
      }
      writeFileSync(temp,bytes,{flag:"wx",mode:0o600});
      renameSync(temp,path);
      send({written:true});
    } catch (error) { send({written:false,code:error.code}); }
    finally { try { rmSync(temp,{force:true}); } catch {} }`
  const deployed = objectReply(await run('entry-generation', nodeCommand(`(()=>{${deploy}})()`), 30_000, 'installed', entry))
  if (deployed.written !== true) {
    const disk = deployed.code === 'ENOSPC' || deployed.code === 'EDQUOT'
    throw remoteFailure('entry-generation', disk ? 'helper-disk-space' : 'helper-entry-write',
      'The server did not confirm the Helper entry write.', disk ? 'directory' : 'verify', artifactFacts)
  }
  return { nodePath, helperPath: entryAbs, sha256: hostLib['helper.js']!, integrity: 2, treeSha256: installed.tree }
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
