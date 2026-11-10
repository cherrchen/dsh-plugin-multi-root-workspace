/**
 * probe:remote-entry-isolation — deployment-side observations of supported
 * Agent process seams under the Host UID and the credential-broker boundary
 * (ADR-0039 / the control-plane reference's confinementProbe).
 *
 * Runs AS the Host user inside a provisioned deployment: the broker is up,
 * `dsh plugin add` installed this package into a dedicated profile, and the
 * profile carries the restricted preset table plus the broker-gated remote
 * tools row. The probe boots that real profile in-process (same mechanism as
 * smoke:behavior), then drives every Agent process entry — the shell
 * executor, an agent PTY (the `DSH_PTY_SESSION_ID` marker), the PTC runtime,
 * and raw/LSP-like/job-like spawn seams — under each restricted mode:
 * reading the broker credential root and talking to the broker socket.
 * Escalation entries are audited too: the preset table, the default mode, a
 * forged `sandbox/mode` event (records the runtime guard refusal),
 * setuid/sudo inside the confined shell, and a static inventory of other
 * profiles under the same UID (not runtime isolation proof).
 *
 * Environment:
 *   DSH_HOME      scratch harness home containing the dedicated profile
 *   DSH_PROFILE   profile name (default `remote-exp`)
 *   DSH_CLI       the deployment's own dsh bin.js (runtime resolution anchor)
 *   CRED_ROOT     broker credential root (default /var/lib/dsh-ssh-broker)
 *   BROKER_SOCK   broker socket (default /run/dsh-ssh-broker/broker.sock)
 *   PRIMARY       workspace directory the probe sessions run in (required)
 *   REPORT        optional path for the JSON evidence record
 *
 * @module scripts/probe-remote-entry-isolation
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { bootProfile } from './lib/profile-boot.mjs'
import { installPluginProfile, runtimeRequire } from './lib/dsh-runtime.mjs'
import { runForeground } from './lib/shell-exec.mjs'

const HOME = process.env.DSH_HOME
const PROFILE = process.env.DSH_PROFILE ?? 'remote-exp'
const CRED = process.env.CRED_ROOT ?? '/var/lib/dsh-ssh-broker'
const SOCK = process.env.BROKER_SOCK ?? '/run/dsh-ssh-broker/broker.sock'
const PRIMARY = process.env.PRIMARY
const REPORT = process.env.REPORT
if (HOME === undefined || PRIMARY === undefined) {
  console.error('DSH_HOME and PRIMARY are required')
  process.exit(1)
}
const PLUGIN_SOURCE = process.env.DSH_PROBE_PLUGIN_SOURCE
const PROFILE_PATCH = process.env.DSH_PROBE_PROFILE_PATCH

const evidence = {
  meta: {
    probe: 'probe-remote-entry-isolation',
    runAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    dshCli: process.env.DSH_CLI ?? null,
    scope: 'supported service seams; other-profile inventory is static only; this record is not deployment certification',
  },
  profile: PROFILE, primary: PRIMARY, credRoot: CRED, socket: SOCK,
  controls: {}, presets: {}, entries: {}, escalation: {},
}
const check = (run) => {
  try { return { ok: true, value: run() } } catch (error) { return { ok: false, error: error instanceof Error ? `${error.code ?? error.name}: ${error.message}` : String(error) } }
}

function observeRawSpawn(ctx, argv) {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv, cwd: PRIMARY, env: {},
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 500,
    })
  } catch (error) {
    return { refusedByGuard: error?.code === 'remote-profile-unconfined-spawn', error: String(error?.message ?? error) }
  }
  void handle.done?.catch(() => {})
  try { handle.terminate() } catch {}
  return { refusedByGuard: false, unexpectedProcessHandle: true }
}

/** One JSON-lines broker hello over a fresh connection; settles on first line, error, or timeout. */
function brokerHello(path, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = connect(path)
    let buffer = ''
    const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs)
    socket.on('data', chunk => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      try { finish({ outcome: 'hello', hello: JSON.parse(buffer.slice(0, nl)) }) }
      catch { finish({ outcome: 'unparsable', head: buffer.slice(0, 120) }) }
    })
    socket.on('error', error => finish({ outcome: 'error', code: error.code ?? error.message }))
  })
}

/** The one-line-per-probe command every shell-shaped entry executes. */
const shellProbe = [
  `echo "CRED_READ:$(cat '${CRED}/.ssh/id_ed25519' 2>&1 | head -c 80 | tr '\\n' ' ')"`,
  `echo "CRED_LIST:$(ls '${CRED}' 2>&1 | head -c 80 | tr '\\n' ' ')"`,
  `echo "SOCK_STAT:$(ls -la '${SOCK}' 2>&1 | head -c 80 | tr '\\n' ' ')"`,
  `echo "CLIENTS:$(command -v node socat python3 2>/dev/null | tr '\\n' ',')"`,
  'if command -v node >/dev/null 2>&1; then',
  `  node -e 'const s=require("net").connect(${JSON.stringify(SOCK)});let d="";let done=false;const fin=v=>{if(!done){done=true;console.log("SOCK:"+v);s.destroy()}};const t=setTimeout(()=>fin("timeout"),2000);s.on("data",c=>{d+=c;if(d.includes("\\n")){clearTimeout(t);fin("data:"+d.slice(0,80))}});s.on("error",e=>{clearTimeout(t);fin("err:"+(e.code||e.message))});s.on("close",()=>{clearTimeout(t);fin(d===""?"closed-no-data":"eof:"+d.slice(0,80))})'`,
  'elif command -v socat >/dev/null 2>&1; then',
  `  echo "SOCK:$(echo '' | timeout 2 socat - UNIX-CONNECT:${SOCK} 2>&1 | head -c 80 | tr '\\n' ' ')"`,
  'elif command -v python3 >/dev/null 2>&1; then',
  `  python3 -c 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect(${JSON.stringify(SOCK)});sys.stdout.write("SOCK:data:"+s.recv(200).decode("utf-8","replace")[:80])' 2>&1 | head -c 120`,
  'else',
  '  echo "SOCK:no-client-available"',
  'fi',
].join('\n')

const ptcProgram = `const out = {}
try {
  const fs = await import('node:fs')
  try { out.keyHead = fs.readFileSync(${JSON.stringify(CRED + '/.ssh/id_ed25519')}, 'utf8').slice(0, 40) }
  catch (e) { out.keyDenied = (e && e.code) || String(e) }
  try { out.credList = fs.readdirSync(${JSON.stringify(CRED)}) }
  catch (e) { out.credListDenied = (e && e.code) || String(e) }
  try { out.sockStat = fs.existsSync(${JSON.stringify(SOCK)}) } catch (e) { out.sockStatDenied = String(e) }
} catch (e) { out.fsUnavailable = String(e) }
try {
  const net = await import('node:net')
  out.sock = await new Promise(resolve => {
    const s = net.createConnection(${JSON.stringify(SOCK)})
    let d = ''
    let done = false
    const fin = v => { if (!done) { done = true; resolve(v); s.destroy() } }
    const t = setTimeout(() => fin('timeout'), 2000)
    s.on('data', c => { d += c; if (d.includes('\\n')) { clearTimeout(t); fin('data:' + d.slice(0, 80)) } })
    s.on('error', e => { clearTimeout(t); fin('err:' + ((e && e.code) || e)) })
    s.on('close', () => { clearTimeout(t); fin(d === '' ? 'closed-no-data' : 'eof:' + d.slice(0, 80)) })
  })
} catch (e) { out.netUnavailable = String(e) }
return JSON.stringify(out)`

// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g
const stripAnsi = text => text.replace(ansi, '')

async function drivePty(ctx, session, label) {
  const env = {
    DSH_PTY_SESSION_ID: String(session.id),
    DSH_SESSION_ID: String(session.id),
    TERM: 'xterm',
  }
  const handle = await ctx.subprocess.spawnTerminal({
    argv: ['/bin/bash', '--noprofile', '-i'],
    cwd: PRIMARY,
    env,
    rows: 24,
    cols: 160,
    terminalType: 'xterm',
    graceMs: 3000,
  })
  let output = ''
  const collect = new Promise(resolve => {
    handle.output.on('data', chunk => { output += chunk })
    handle.output.on('end', resolve)
    handle.output.on('error', resolve)
  })
  await new Promise(resolve => setTimeout(resolve, 800))
  await handle.write(`${shellProbe}\n`)
  await handle.write('echo PTY_DONE_MARKER; exit\n')
  const outcome = await Promise.race([
    handle.done.then(value => ({ outcome: 'done', exitCode: value?.exitCode ?? null })).catch(error => ({ outcome: 'failed', error: String(error?.message ?? error) })),
    new Promise(resolve => setTimeout(() => resolve({ outcome: 'timed-out' }), 15000)),
  ])
  try { await handle.terminate?.() } catch { /* already gone */ }
  await Promise.race([collect, new Promise(resolve => setTimeout(resolve, 2000))])
  return { label, ...outcome, output: stripAnsi(output).slice(-4000) }
}

async function drivePtc(ctx, policy) {
  try {
    const spec = ctx.ptcRuntime.resolve({
      program: ptcProgram,
      bindings: [],
      cwd: PRIMARY,
      sandboxPolicy: policy,
      timeoutMs: 30000,
    })
    const result = await ctx.ptcRuntime.run(spec)
    return { status: result.status ?? (result.value !== undefined ? 'ok' : 'unknown'), value: result.value, failure: result.failure, sandbox: result.sandbox }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}

async function driveBash(ctx, policy, extra = '') {
  const spec = ctx.shell.resolve({ command: `${shellProbe}\n${extra}`, workdir: PRIMARY, sandboxPolicy: policy })
  const result = await runForeground(ctx.shell, spec)
  return { exitCode: result.exitCode, denied: result.sandbox?.denied ?? null, enforcement: result.sandbox?.enforcement ?? null, stdout: result.stdout.text, stderr: result.stderr.text.slice(0, 400) }
}

// ── Host-level controls ───────────────────────────────────────────────────
evidence.controls.socket = await brokerHello(SOCK)
evidence.controls.credRead = check(() => accessSync(join(CRED, '.ssh', 'id_ed25519'), constants.R_OK))
evidence.controls.brokerConfigRead = check(() => accessSync('/etc/dsh-ssh-broker/broker.json', constants.R_OK))
evidence.controls.manifestRead = check(() => readFileSync('/etc/dsh-ssh-broker/manifest.json', 'utf8').length > 0)
const listProfiles = () => {
  const dir = join(HOME, 'profiles')
  return existsSync(dir) ? readdirSync(dir) : []
}

// ── Install + boot the dedicated profile ──────────────────────────────────
if (PLUGIN_SOURCE !== undefined) {
  const code = await installPluginProfile(PROFILE, HOME, PLUGIN_SOURCE)
  if (code !== 0) {
    console.error(`dsh plugin add exited ${code}`)
    process.exit(code)
  }
}
// The deployment patch layer lands after `dsh plugin add` materializes the
// profile: restricted presets, remoteEnvironments, and the broker-gated
// remote-tools insert. This is the file a deployment writes for the profile,
// exactly as the control-plane checklist describes.
if (PROFILE_PATCH !== undefined) {
  const { copyFileSync } = await import('node:fs')
  copyFileSync(PROFILE_PATCH, join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'))
}
const { ctx } = await bootProfile(PROFILE, HOME)
try {
  const require0 = runtimeRequire()
  evidence.meta.dshVersion = check(() => require0('@deepseek-ai/dsh/package.json').version)
  evidence.meta.pluginVersion = check(() => JSON.parse(readFileSync(
    join(HOME, 'profiles', PROFILE, 'node_modules', '@dsh-electron', 'dsh-plugin-multi-root-workspace', 'package.json'), 'utf8')).version)
  // The remote-tools row attests asynchronously; wait until the tools exist
  // (attestation passed) or record the row's absence as evidence.
  const toolsReady = await (async () => {
    for (let i = 0; i < 120; i++) {
      const copy = ctx.tools?.get?.('remote_copy')
      const bash = ctx.tools?.get?.('remote_bash')
      if (copy !== undefined && bash !== undefined) return { mounted: true }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return { mounted: false }
  })()
  evidence.tools = toolsReady
  evidence.remoteStatus = ctx.multiRootRegistry?.remoteStatus
  evidence.authority = ctx.multiRootRegistry?.authority

  // ── Preset + default-mode audit ─────────────────────────────────────────
  const presets = ctx.permissionPresets
  evidence.presets.defaultMode = ctx.sandboxPolicy?.defaultMode
  evidence.presets.table = Object.fromEntries((presets?.names ?? []).map(name => {
    const resolved = check(() => presets.resolve(name))
    return [name, resolved.ok ? resolved.value : resolved.error]
  }))
  evidence.presets.hasFullAccess = Object.values(evidence.presets.table).some(value => typeof value === 'object' && value !== null && value.sandbox === 'danger-full-access')

  // ── Entries × restricted modes ──────────────────────────────────────────
  for (const mode of ['workspace-write', 'read-only']) {
    const session = ctx.sessions.create(/** @type {never} */ (`probe-${mode}`), { meta: { cwd: PRIMARY } })
    session.append('sandbox/mode', { mode })
    const policy = ctx.sandboxPolicy.resolve({ session })
    const cell = { resolvedMode: policy.mode }
    cell.bash = await driveBash(ctx, policy)
    cell.pty = await drivePty(ctx, session, mode).catch(error => ({ threw: String(error?.message ?? error) }))
    cell.ptc = await drivePtc(ctx, policy)
    cell.rawSpawn = observeRawSpawn(ctx, ['/bin/true'])
    cell.lspLikeSpawn = observeRawSpawn(ctx, [process.execPath, '-e', 'process.exit(0)', 'lsp-probe'])
    cell.jobLikeSpawn = observeRawSpawn(ctx, [process.execPath, '-e', 'process.exit(0)', 'job-probe'])
    evidence.entries[mode] = cell
  }

  // ── Escalation audit ────────────────────────────────────────────────────
  // A forged mode event must be refused by the runtime guard; never launch
  // an unrestricted command even if the deployment unexpectedly permits it.
  const full = ctx.sessions.create(/** @type {never} */ ('probe-full'), { meta: { cwd: PRIMARY } })
  full.append('sandbox/mode', { mode: 'danger-full-access' })
  const fullPolicy = check(() => ctx.sandboxPolicy.resolve({ session: full }))
  evidence.escalation.forgedMode = fullPolicy.ok
    ? { refusedByGuard: false, resolved: fullPolicy.value.mode }
    : { refusedByGuard: fullPolicy.error.startsWith('remote-profile-full-access:'), error: fullPolicy.error }
  evidence.escalation.fullAccessBash = { skipped: 'never launch an unrestricted command from this probe' }

  // In-sandbox escalation tools under the restricted mode.
  const restricted = ctx.sessions.create(/** @type {never} */ ('probe-esc'), { meta: { cwd: PRIMARY } })
  restricted.append('sandbox/mode', { mode: 'workspace-write' })
  const restrictedPolicy = ctx.sandboxPolicy.resolve({ session: restricted })
  const escalationSpec = ctx.shell.resolve({
    command: [
      'echo "NONEVPRIVS:$(grep NoNewPrivs /proc/self/status 2>&1)"',
      'echo "SUDO:$(sudo -n id 2>&1 | head -c 80 | tr \'\\n\' \' \')"',
      'echo "SU:$(su -c id root </dev/null 2>&1 | head -c 80 | tr \'\\n\' \' \')"',
      'echo "SETUID_FILES:$(find /usr /bin /sbin -perm -4000 -type f 2>/dev/null | head -5 | tr \'\\n\' \' \')"',
      'echo "UNSHARE:$(unshare -r id -u 2>&1 | head -c 80 | tr \'\\n\' \' \')"',
    ].join('\n'),
    workdir: PRIMARY,
    sandboxPolicy: restrictedPolicy,
  })
  evidence.escalation.inSandboxTools = await runForeground(ctx.shell, escalationSpec).then(result => ({ exitCode: result.exitCode, stdout: result.stdout.text })).catch(error => String(error))

  // Static profile text is inventory, not proof of effective runtime policy.
  evidence.escalation.otherProfiles = listProfiles().map(name => {
    const dir = join(HOME, 'profiles', name)
    const read = file => { try { return readFileSync(join(dir, file), 'utf8') } catch { return '' } }
    const patch = read('cordis.patch.yml')
    const pkg = read('package.json')
    // Scan non-comment text only — full-line `#` comments may name the mode
    // (e.g. "can never resolve to danger-full-access") without granting it.
    const code = text => text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
    return {
      profile: name,
      mentionsFullAccess: /danger-full-access/.test(code(patch)) || /danger-full-access/.test(code(pkg)),
      patchPresent: patch !== '',
    }
  })
} finally {
  // The composed tree keeps fibers and the broker socket open; a clean exit
  // needs the explicit dispose when the runtime exposes one, else the probe
  // reports and the process is reaped by exit below.
  try { await ctx.dispose?.() } catch { /* best effort */ }
}

mkdirSync(join(HOME, 'probe'), { recursive: true })
const target = REPORT ?? join(HOME, 'probe', `entry-isolation-${Date.now()}.json`)
writeFileSync(target, JSON.stringify(evidence, null, 1))
console.log(JSON.stringify(evidence, null, 1))
console.log(`[probe] evidence written to ${target}`)
process.exit(0)
