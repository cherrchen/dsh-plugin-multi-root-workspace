/**
 * LIVE evidence harness: real DSH `web` host + real SSH remote file tree + real
 * headless Chrome, on a scratch `$DSH_HOME`.
 *
 * What it proves (the P7 "真实生产 DSH↔SSH 端到端 + 真实宿主 GUI" gap):
 *   1. The packed plugin tarball installs into a scratch `web` profile and the
 *      host mounts the personal-custody SSH remote plane off a REAL replicated
 *      personal store (`ali` env + a browsable `ali-sftp` sibling env).
 *   2. The real browser UI paints the remote section of the Workspace Folders
 *      dialog, registers both bindings through the row "…" menu (`addRemote`
 *      → real ssh -G + SFTP/helper verify against the VPS), and the
 *      RootSwitcher offers both the helper-less SFTP row and the opted-in
 *      Helper row enabled.
 *   3. Selecting the remote row lists the LIVE directory through the real
 *      `remoteFiles.list` channel endpoint — entries served off an actual SFTP
 *      `readdir` on the VPS — and a second listing happens on expand.
 *
 * Safety: never writes to the real `$DSH_HOME` (read-only copy source), never
 * touches the remote host outside `/root/dsh-live-browse` (created, used, and
 * removed by this run), and every host artifact lives under
 * `.dsh-smoke/live-gui/` (wiped and recreated on each run).
 *
 * Run: `DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs`
 *
 * @module scripts/live-remote-gui
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { createChecker } from './lib/check.mjs'
import { packTarball } from './check-pack.mjs'
import { bootProfile } from './lib/profile-boot.mjs'
import { assertIsolatedHome, captureDsh, installPluginProfile, loadRuntimeModule, REPO_ROOT, runtimeRequire } from './lib/dsh-runtime.mjs'
import { chatCompletionFrames, messagesFrames } from './lib/scripted-model-frames.mjs'

if (process.env.DSH_LIVE_GUI !== '1') {
  console.error([
    'live-remote-gui: refusing to run without DSH_LIVE_GUI=1.',
    'This harness drives the REAL user VPS over SSH (fixture /root/dsh-live-browse),',
    'boots a scratch DSH web profile, and drives headless Chrome through the real UI.',
    'Run explicitly: DSH_LIVE_GUI=1 node scripts/live-remote-gui.mjs',
  ].join('\n'))
  process.exit(2)
}

const PLUGIN_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'
const REAL_HOME = join(process.env.HOME ?? '', '.dsh')
const REAL_STORAGES = join(REAL_HOME, 'storages')
const REAL_ENV_FILE = join(REAL_STORAGES, 'multi_root_workspace.remote-personal.json')
const REAL_SSH_ROOT = join(REAL_STORAGES, 'multi_root_workspace.ssh')

const RUN = join(REPO_ROOT, '.dsh-smoke', 'live-gui')
const HOME = join(RUN, 'dsh-home')
const WORKSPACE = join(RUN, 'live-gui-workspace')
const EVIDENCE_DIR = join(RUN, 'evidence')
const PACK_DIR = join(RUN, 'pack')
const STORAGES = join(HOME, 'storages')
const ENV_FILE = join(STORAGES, 'multi_root_workspace.remote-personal.json')
const BINDINGS_FILE = `${ENV_FILE}.bindings.json`
const SSH_ROOT = join(STORAGES, 'multi_root_workspace.ssh')
const SSH_CONFIG = join(SSH_ROOT, 'ssh_config')

const SESSION_ID = 'live-remote-gui'
const REMOTE_BASE = '/root/dsh-live-browse'
const SFTP_ENV = 'ali-sftp'
const SFTP_ROOT = 'live-browse'
const HELPER_ENV = 'ali'
const HELPER_ROOT = 'helper-root'

const check = createChecker('live-gui')
const evidence = {
  harness: 'live-remote-gui', startedAt: new Date().toISOString(),
  dshVersion: undefined, tarball: undefined, sessionId: SESSION_ID,
  scratchHome: HOME, workspace: undefined, port: undefined,
  remoteFixture: REMOTE_BASE, store: {}, screenshots: {}, wire: [],
  remoteRows: undefined, registerOutcomes: {}, listings: {}, remotesView: undefined,
  checks: [], notes: [],
}
const note = (message) => { evidence.notes.push(message); console.log(`[live-gui] ${message}`) }
const recordCheck = (ok, message, detail) => {
  const text = detail === undefined ? undefined : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000)
  evidence.checks.push({ ok, message, ...(text === undefined ? {} : { detail: text }) })
  check.ok(ok, message, text)
}
const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms))
/** realpath with a resolve-through-parent fallback for paths that may not exist. */
const canonical = (path) => { try { return realpathSync.native(path) } catch { return join(realpathSync.native(dirname(path)), path.split('/').pop()) } }

// ---------------------------------------------------------------------------
// Run dir (wiped each run); everything else happens inside `try` so the VPS
// fixture cleanup in `finally` always runs.
// ---------------------------------------------------------------------------
rmSync(RUN, { recursive: true, force: true })
mkdirSync(STORAGES, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })
mkdirSync(PACK_DIR, { recursive: true })
chmodSync(STORAGES, 0o700)
const primary = canonical(WORKSPACE)
evidence.workspace = primary
assertIsolatedHome(HOME)
note(`scratch run dir: ${RUN}`)

/** Seed the personal env store: the real `ali` env verbatim + an `ali-sftp`
 * sibling with the same endpoint/hostKey but helper:null and an ssh-config
 * credential reusing the ambient `dsh-ali` alias (the user's real ssh_config
 * Include already resolves it). `helper !== null` is what makes an env
 * permanently non-browsable, so the browsable lane must be its own env. */
function seedPersonalStore() {
  const stored = JSON.parse(readFileSync(REAL_ENV_FILE, 'utf8'))
  const ali = stored.environments.find(entry => entry.environmentId === HELPER_ENV)
  if (ali === undefined) throw new Error(`the real personal store has no "${HELPER_ENV}" environment to replicate`)
  const sftp = {
    ...ali,
    environmentId: SFTP_ENV,
    displayName: 'ali (SFTP)',
    identityId: randomUUID(),
    credential: { kind: 'ssh-config', alias: 'dsh-ali' },
    helper: null,
    // `exec` is only legal on helper transport (manifest rejects otherwise);
    // `transfer` stays — SFTP is the transport remote_copy itself uses.
    exec: undefined,
  }
  writeFileSync(ENV_FILE, JSON.stringify({ schemaVersion: 2, revision: 1, environments: [ali, sftp] }, null, 2), { mode: 0o600 })
  writeFileSync(BINDINGS_FILE, JSON.stringify({
    schemaVersion: 1, revision: 1,
    bindings: [
      { primary, environmentId: SFTP_ENV, rootId: SFTP_ROOT, bindingId: randomUUID(), path: REMOTE_BASE, directoryListing: 'stable-path', actions: ['read'] },
      { primary, environmentId: HELPER_ENV, rootId: HELPER_ROOT, bindingId: randomUUID(), path: '/root/coding', actions: ['read'], directoryListing: 'stable-path' },
    ],
  }, null, 2), { mode: 0o600 })
  evidence.store.envFile = { environments: ['ali', 'ali-sftp'], note: 'ali copied verbatim; ali-sftp = same endpoint/hostKey, helper:null, credential ssh-config alias dsh-ali' }
  evidence.store.bindings = { file: BINDINGS_FILE, rows: 2 }
}

/**
 * The authenticated browser entry URL contributed by the composition.
 * DSH 0.2.3 moved `authenticatedUrl` off the public Connection service; older
 * hosts still expose it as a method. Mirror smoke-journey's version-tolerant
 * lookup so this harness runs on the full supported line.
 */
function entryUrlOf(ctx, base) {
  const entries = []
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) ctx.emit(webServer, 'webserver/entry-url', base, entries)
  const entry = entries.find(candidate => candidate.open === true) ?? entries[0]
  if (entry === undefined) throw new Error('live-gui: the composition contributed no entry URL')
  return entry.url
}

/** Copy the credential root (keys, known_hosts, credentials.json, ssh_config)
 * preserving the 0700/0600 protection bits, and rewrite ssh_config's absolute
 * paths at the scratch copies so the profile stays self-contained. */
function seedCredentialRoot() {
  cpSync(REAL_SSH_ROOT, SSH_ROOT, { recursive: true })
  chmodSync(SSH_ROOT, 0o700)
  for (const entry of readdirSync(SSH_ROOT, { withFileTypes: true })) {
    const full = join(SSH_ROOT, entry.name)
    if (entry.isDirectory()) { chmodSync(full, 0o700); for (const name of readdirSync(full)) chmodSync(join(full, name), 0o600) }
    else if (entry.isFile()) chmodSync(full, 0o600)
  }
  const text = readFileSync(SSH_CONFIG, 'utf8')
  writeFileSync(SSH_CONFIG, text.split(REAL_SSH_ROOT).join(SSH_ROOT), { mode: 0o600 })
  evidence.store.credentialRoot = { source: REAL_SSH_ROOT, note: 'copied read-only; ssh_config paths rewritten to scratch' }
}

// Remote fixture on the VPS (fixture path only). `literal\\dir` reaches the
// remote shell as one backslash inside double quotes — a literal-backslash dir.
const FIXTURE_SCRIPT = [
  'set -eu',
  `base=${REMOTE_BASE}`,
  'rm -rf "$base"',
  'mkdir -p "$base/deep/inner" "$base/space dir" "$base/literal\\\\dir"',
  'printf \'live-browse\\n\' > "$base/readme.txt"',
  'printf \'unicode name\\n\' > "$base/uni-名字.md"',
  'printf \'leaf of the live tree\\n\' > "$base/deep/inner/leaf.txt"',
  'printf \'a file with a space\\n\' > "$base/space dir/a file.txt"',
  'printf \'literal backslash dir\\n\' > "$base/literal\\\\dir/note.txt"',
  'ln -s readme.txt "$base/alias.link"',
  'find "$base" | sort',
].join('\n')
const CLEANUP_SCRIPT = `rm -rf ${REMOTE_BASE}`

let ctx, model, browser, page, sessionId = SESSION_ID, guiError, fatal

function sshAli(script) {
  // The scratch ssh_config reuses the copied managed keypair + known_hosts.
  return execFileSync('/usr/bin/ssh', ['-F', SSH_CONFIG, 'dsh-ali', script], { encoding: 'utf8', timeout: 60_000 })
}
const shot = async (name) => {
  const file = join(EVIDENCE_DIR, name)
  await page.screenshot({ path: file, fullPage: false })
  evidence.screenshots[name] = createHash('sha256').update(readFileSync(file)).digest('hex')
  note(`screenshot ${name}`)
}
const dumpDom = async (name) => {
  try {
    writeFileSync(join(EVIDENCE_DIR, name), await page.content())
    const interactive = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role=menuitem],[role=treeitem],[role=tab],[role=link],a,[aria-haspopup]')]
        .slice(0, 160)
        .map(el => `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? ''}] "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 90)}"${el.disabled ? ' disabled' : ''}`))
    writeFileSync(join(EVIDENCE_DIR, `${name}.elements.txt`), interactive.join('\n'))
    note(`DOM dumped to ${name} (+ .elements.txt)`)
  } catch (error) { note(`DOM dump failed: ${error instanceof Error ? error.message : String(error)}`) }
}

try {
  // --- build + pack + install -------------------------------------------
  note('building the plugin tree (pnpm build)')
  const built = spawnSync('pnpm', ['build'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`pnpm build failed (${built.error?.message ?? `exit ${built.status}`}):\n${built.stdout}\n${built.stderr}`)
  const { tarball } = packTarball(PACK_DIR)
  evidence.tarball = { name: tarball.split('/').pop(), sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') }
  note(`packed ${evidence.tarball.name} (${evidence.tarball.sha256.slice(0, 12)}…)`)

  seedPersonalStore()
  seedCredentialRoot()
  note('scratch personal store seeded (ali verbatim + ali-sftp browsable; two bindings)')

  note('creating the remote fixture on the VPS (fixture path only)')
  const fixtureListing = sshAli(FIXTURE_SCRIPT)
  evidence.store.fixture = fixtureListing.trim().split('\n')
  note(`fixture: ${fixtureListing.trim().split('\n').length} remote entries`)

  const installed = await installPluginProfile('web', HOME, tarball)
  if (installed !== 0) throw new Error(`installPluginProfile exited ${installed}`)
  note('plugin tarball installed into the scratch web profile')

  // The remote plane only mounts when the profile resolves all four SSH peer
  // packages — they live in the profile's own dependency tree, not the repo's,
  // so the scratch profile needs the same `dsh plugin add` the published
  // install-ssh-deps command runs.
  const dshRelease = runtimeRequire()('@deepseek-ai/dsh/package.json').version
  const sshPeers = ['@deepseek-ai/dsh-ssh', '@deepseek-ai/dsh-fs-ssh', '@deepseek-ai/dsh-subprocess-ssh', '@deepseek-ai/dsh-sandbox-ssh']
    .map(name => `${name}@${dshRelease}`)
  const deps = await captureDsh(['plugin', '--profile', 'web', 'add', '--save-exact', ...sshPeers], { DSH_HOME: HOME })
  if (deps.code !== 0) throw new Error(`SSH peer install exited ${deps.code}: ${`${deps.stdout}\n${deps.stderr}`.trim().slice(-400)}`)
  note(`four SSH peers installed into the scratch web profile at ${dshRelease}`)

  // Profile patch: flip the experimental remote plane on (personal custody) —
  // the same opt-in shape the user's real profile carries.
  const patchPath = join(HOME, 'profiles', 'web', 'cordis.patch.yml')
  const remoteRow = [
    '# live-gui: enable the personal SSH remote plane for this run.',
    '- id: multi-root-remote-tools',
    "  name: '@dsh-electron/dsh-plugin-multi-root-workspace/remote-tools'",
    '  config:',
    '    mode: personal',
    '    enabled: true',
  ].join('\n')
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (!existing.includes('multi-root-remote-tools')) {
    // A fresh profile writes a comment header + a bare `[]` document — an
    // appended `- id:` under it would be a second document. Replace the whole
    // file when it carries nothing but comments/blank lines and `[]`.
    const body = existing.trim()
    const emptyList = body === '' || /^([\s]*(?:#[^\n]*)?\n)*\[\][\s]*$/u.test(existing)
    writeFileSync(patchPath, emptyList ? `${remoteRow}\n` : `${existing.trimEnd()}\n\n${remoteRow}\n`)
  } else {
    note('profile patch already names multi-root-remote-tools; leaving it unchanged')
  }

  // --- scripted model + in-process web boot + one session -----------------
  // The model is only needed so `agentDefaultModel.currentSelection()` resolves
  // and any side call (e.g. session title) answers — no agent turn is driven.
  model = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const frames = (request.url ?? '').includes('/v1/messages')
        ? messagesFrames(undefined, 'live-gui', `msg-${body.length}`)
        : chatCompletionFrames(undefined, 'live-gui', `cmpl-${body.length}`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(frame)
      response.end()
    })
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  process.env.DEEPSEEK_API_KEY = 'live-gui-key'
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${model.address().port}`

  process.chdir(WORKSPACE)
  const booted = await bootProfile('web', HOME, async (hostCtx) => {
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
  })
  ctx = booted.ctx
  evidence.dshVersion = runtimeRequire()('@deepseek-ai/dsh/package.json').version
  const clientModules = ctx.get('clientModules')
  recordCheck(clientModules?.graph().entries.some(entry => entry.id === PLUGIN_NAME) === true,
    'the client-module graph serves the plugin bundle (lib/client.js)')

  // The workspace + session are created through the same host controllers the
  // UI's composer calls, so the sidebar row is a real session row the drive can
  // click. `sessionId` is pinned so evidence naming stays stable.
  const workspaceController = ctx.get('workspaceController')
  const sessionController = ctx.get('sessionController')
  if (workspaceController === undefined || sessionController === undefined) {
    throw new Error('workspaceController/sessionController not mounted in the web composition')
  }
  const presets = ctx.get('agentPresets')
  const presetId = presets === undefined ? undefined : (await presets.resolve(undefined)).id
  const { workspace } = await workspaceController.create({ path: primary })
  const createdSession = await sessionController.create({
    workspaceId: workspace.workspaceId,
    sessionId: SESSION_ID,
    ...(presetId === undefined ? {} : { agentPreset: presetId }),
  })
  sessionId = createdSession.sessionId
  evidence.sessionId = sessionId
  note(`session ${sessionId} created in workspace ${workspace.workspaceId} on ${primary}`)

  const webServer = ctx.get('webServer')
  const base = `http://127.0.0.1:${webServer.port}/`
  evidence.port = webServer.port
  const connection = ctx.get('connection')
  const authUrl = typeof connection?.authenticatedUrl === 'function'
    ? connection.authenticatedUrl(base)
    : entryUrlOf(ctx, base)

  // The cookie for the in-process channel probes (ground truth under the GUI).
  const authResponse = await fetch(authUrl, { redirect: 'manual' })
  const cookie = authResponse.headers.get('set-cookie')?.split(';', 1)[0]
  let rpcSequence = 0
  const channel = async (endpoint, payload) => {
    const response = await fetch(new URL(`/multi-root-workspace/${endpoint}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId: `live-gui-${++rpcSequence}`, method: endpoint, payload }),
    })
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }

  // --- headless Chrome through the real UI ---------------------------------
  const { chromium } = await import('playwright')
  const launchAttempts = []
  for (const options of [
    { headless: true },
    { channel: 'chrome', headless: true },
    { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true },
  ]) {
    try { browser = await chromium.launch(options); break }
    catch (error) { launchAttempts.push(String(error).split('\n')[0]) }
  }
  if (browser === undefined) throw new Error(`no usable Chromium/Chrome: ${launchAttempts.join(' | ')}`)
  page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
  page.on('console', message => { if (message.type() === 'error') evidence.wire.push({ console: message.text().slice(0, 400) }) })
  page.on('response', response => {
    const url = response.url()
    if (!url.includes('/multi-root-workspace')) return
    const entry = { method: response.request().method(), path: new URL(url).pathname, status: response.status() }
    evidence.wire.push(entry)
    response.json().then(body => {
      const result = body?.result
      if (result?.ok === false) entry.error = result.error?.code ?? 'error'
      const value = result?.value
      if (value?.endpoints !== undefined) {
        entry.view = {
          status: value.status?.state, custodyMode: value.custodyMode,
          endpoints: value.endpoints.map(ep => ({
            id: `${ep.environmentId}/${ep.rootId}`, state: ep.state,
            browseAuthorization: ep.browseAuthorization === undefined ? 'absent' : `present:${ep.browseAuthorization.length}`,
            ...(ep.reason === undefined ? {} : { reason: ep.reason }),
          })),
        }
      } else if (value?.entries !== undefined) {
        entry.listing = { entries: value.entries.map(item => `${item.name}:${item.type}`), truncated: value.truncated }
      }
    }).catch(() => {})
  })

  await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // `.mrfw-trigger` is the plugin's own footer action — it only exists once
  // the served client bundle mounted, doubling as the "our code is live" probe.
  try {
    await page.waitForSelector('.mrfw-trigger', { timeout: 120_000 })
  } catch (error) {
    await shot('stuck-boot.png')
    await dumpDom('stuck-boot.html')
    recordCheck(false, 'the client bundle never mounted .mrfw-trigger in the served UI', 'see evidence/stuck-boot.*')
    throw error
  }
  await shot('01-boot.png')

  // The GUI drive is exploratory by design: any stall dumps the live DOM and a
  // screenshot, records the failure, and still lets the channel probes run.
  try {
    // --- dismiss the first-run Preview Notice modal -----------------------
    // It overlays the whole UI until Continue is clicked (fresh home = every
    // run). After it, the sidebar exposes the Workspaces composer.
    try {
      await page.getByRole('button', { name: 'Continue' }).first().click({ timeout: 15_000 })
      await settle(800)
      note('Preview Notice dismissed')
    } catch { note('no Preview Notice shown') }
    await shot('01b-after-notice.png')
    await dumpDom('01b-after-notice.html')

    // --- select the session ----------------------------------------------
    // The workspace + session were created through the same host controllers
    // the UI's composer calls, so the Sessions sidebar tree lists a real row.
    // Clicking it opens the session view; `.mrfw-rootSwitchBtn` only mounts
    // once the session's Files pane renders.
    const marker = 'live-gui-workspace'
    const switcherReady = async (timeout) => {
      try { await page.waitForSelector('.mrfw-rootSwitchBtn', { timeout }); return true } catch { return false }
    }
    // The session view's chrome carries a right-sidebar toggle and an enabled
    // composer; the RootSwitcher mounts only inside the expanded files pane,
    // so the "session opened" probe cannot be `.mrfw-rootSwitchBtn` itself.
    const sessionViewReady = async (timeout) => {
      try {
        await page.waitForSelector(
          'button[aria-label="Open right sidebar"], button[aria-label="Collapse right sidebar"], [aria-label="Send message"], .mrfw-rootSwitchBtn',
          { timeout, state: 'visible' },
        )
        return true
      } catch { return false }
    }
    let sessionClicked = false
    const sessionRowProbes = [
      // Rows inside the Sessions tree carry data-row-key; the empty-state row
      // is data-row-key="empty" and must be excluded.
      () => page.locator('[aria-label="Sessions"] [data-row-key]:not([data-row-key="empty"])').first(),
      () => page.locator('[aria-label="Sessions"] [role="treeitem"]').first(),
      () => page.getByRole('treeitem', { name: new RegExp(`${marker}|${sessionId}|新会话|New session`, 'i') }).first(),
      () => page.getByText(marker, { exact: false }).first(),
    ]
    for (let round = 0; round < 4 && !sessionClicked; round++) {
      for (const probe of sessionRowProbes) {
        try {
          const target = probe()
          await target.waitFor({ state: 'visible', timeout: 12_000 })
          await target.click()
          note(`session row clicked (round ${round})`)
          if (await sessionViewReady(12_000)) { sessionClicked = true; break }
        } catch { /* next probe */ }
      }
      if (!sessionClicked) await settle(2500)
    }
    await shot('02-after-session-click.png')
    await dumpDom('02-session-opened.html')
    if (!sessionClicked) {
      await dumpDom('stuck-session.html')
      await shot('stuck-session.png')
      recordCheck(false, 'no session row opened the session view', 'see evidence/stuck-session.*')
      throw new Error('cannot reach the session view; inspect evidence/stuck-session.* and iterate')
    }

    // The Files pane lives in the right sidebar's "files" tab, which only
    // renders its content while the rail is expanded — the RootSwitcher is
    // absent from the DOM while the rail stays collapsed.
    try {
      const expandRail = page.locator('button[data-sidebar-right-expand="true"], button[aria-label="Open right sidebar"]').first()
      if (await expandRail.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expandRail.click()
        await settle(1500)
        note('right sidebar expanded')
      }
    } catch { /* rail may already be open */ }
    await shot('02c-rightbar.png')
    await dumpDom('02c-rightbar.html')
    if (!(await switcherReady(30_000))) {
      for (const probe of [
        // The right rail's "Workspace files" launcher opens the files pane.
        () => page.getByRole('button', { name: /Workspace files|Browse files|工作区文件|文件/i }).first(),
        () => page.getByRole('tab', { name: /文件|Files/i }).first(),
        () => page.locator('[aria-label*="Workspace files"], [aria-label*="文件"], [title*="Files"], [title*="文件"]').first(),
      ]) {
        try {
          await probe().click({ timeout: 5_000 })
          await settle(1500)
          if (await switcherReady(15_000)) break
        } catch { /* next */ }
      }
    }
    if (!(await switcherReady(60_000))) {
      await dumpDom('stuck-files.html')
      await shot('stuck-files.png')
      recordCheck(false, 'the Files tab never mounted .mrfw-rootSwitchBtn', 'see evidence/stuck-files.*')
      throw new Error('cannot reach the Files pane; inspect evidence/stuck-files.* and iterate')
    }
    await shot('03-files-pane.png')

    // --- the Workspace Folders dialog remote section ----------------------
    // `.mrfw-trigger` exists twice (footer + collapsed-rail variant); click
    // the visible one.
    await page.locator('.mrfw-trigger:visible').first().click()
    const sectionVisible = await (async () => {
      try { await page.waitForSelector('.mrfw-sectionTitle', { timeout: 15_000 }); return true } catch { return false }
    })()
    // The remote section fills asynchronously off the `remotes` channel call.
    // (.mrfw-cwdTag/.mrfw-accessBadge appear on local rows too, so the wait
    // targets the remote row's own path text instead.)
    const remoteRows = page.locator('.mrfw-section', { hasText: /远端工作目录|Remote working directories/ }).locator('.mrfw-row')
    try { await remoteRows.filter({ hasText: 'dsh-live-browse' }).first().waitFor({ state: 'visible', timeout: 45_000 }) }
    catch { /* rows recorded below */ }
    await settle(1200)
    await shot('04-remote-live-dialog.png')
    recordCheck(sectionVisible, 'the Workspace Folders dialog opened')

    // Remote rows carry `.mrfw-cwdTag` (env name) and `.mrfw-accessBadge`
    // (title = registration state). Read the rows verbatim before touching them.
    const rowTexts = await remoteRows.evaluateAll(rows => rows.map(row => row.textContent?.trim() ?? ''))
    evidence.remoteRows = rowTexts
    recordCheck(rowTexts.some(text => text.includes('dsh-live-browse')), 'remote row for the sftp binding is listed', rowTexts)
    recordCheck(rowTexts.some(text => text.includes('/root/coding')), 'remote row for the helper binding is listed', rowTexts)

    // --- register both endpoints through the row "…" menu ------------------
    // The primitives Menu renders real role=menuitem entries; a leftover open
    // menu blocks the next row's anchor, so every attempt ends with Escape.
    const REGISTER_NAME = /^(登记|Register|重新登记|Re-register)/
    const openRowMenu = async (rowHas) => {
      // Registration re-renders the remote section (badge/state updates), so a
      // row resolved before a refresh detaches mid-click — retry with a fresh
      // locator after a settle instead of relying on one resolution.
      let item
      for (let attempt = 0; attempt < 3; attempt++) {
        await settle(1500)
        const row = remoteRows.filter({ hasText: rowHas }).first()
        try {
          await row.locator('button').last().click({ timeout: 10_000 }) // RemoteRootMenu anchor (IconButton, 更多操作)
          item = page.getByRole('menuitem', { name: REGISTER_NAME }).first()
          await item.waitFor({ state: 'visible', timeout: 10_000 })
          return item
        } catch (error) {
          if (attempt === 2) throw error
          const menuOpen = await page.locator('[role="menu"]').first().isVisible().catch(() => false)
          if (menuOpen) await page.keyboard.press('Escape').catch(() => {})
        }
      }
      return item
    }
    const rowStateTitle = async (rowHas) =>
      remoteRows.filter({ hasText: rowHas }).first().locator('.mrfw-accessBadge').getAttribute('title').catch(() => undefined)

    for (const [key, rowHas, id] of [
      ['sftp', 'dsh-live-browse', 'ali-sftp/live-browse'],
      ['helper', '/root/coding', 'ali/helper-root'],
    ]) {
      const before = evidence.wire.length
      try {
        const register = await openRowMenu(rowHas)
        await register.click({ timeout: 8_000 })
        // addRemote verifies through a real ssh -G + transport connect: allow
        // it the real round-trip (the helper handshake takes longer). Once the
        // response landed, the badge settles almost immediately.
        const deadline = Date.now() + 120_000
        let state, rpcSeenAt
        for (;;) {
          state = await rowStateTitle(rowHas)
          if (state === '已登记' || state === 'Registered') break
          if (rpcSeenAt === undefined && evidence.wire.slice(before).some(entry => entry.path?.endsWith('/addRemote'))) rpcSeenAt = Date.now()
          if (rpcSeenAt !== undefined && Date.now() - rpcSeenAt > 6_000) break
          if (Date.now() > deadline) break
          await settle(1000)
        }
        const rpc = evidence.wire.slice(before).find(entry => entry.path?.endsWith('/addRemote'))
        const ep = rpc?.view?.endpoints?.find(candidate => candidate.id === id)
        evidence.registerOutcomes[key] = { rowHas, stateTitle: state, rpcStatus: rpc?.status, rpcError: rpc?.error, viewState: ep?.state, browseAuthorization: ep?.browseAuthorization }
        recordCheck(state === '已登记' || state === 'Registered',
          `register via row menu reached a registered state for ${key}`, evidence.registerOutcomes[key])
      } catch (error) {
        evidence.registerOutcomes[key] = { rowHas, error: String(error) }
        recordCheck(false, `register via row menu for ${key} threw`, String(error))
        await dumpDom(`register-${key}-failed.html`).catch(() => {})
      } finally {
        // A still-open row menu intercepts the next row's anchor button — but
        // on success the menu already closed itself, and a stray Escape here
        // would close the whole dialog. Only Escape a visible menu.
        const menuOpen = await page.locator('[role="menu"]').first().isVisible().catch(() => false)
        if (menuOpen) await page.keyboard.press('Escape').catch(() => {})
        await settle(800)
      }
    }
    await dumpDom('05-registered.html')
    await shot('05-registered.png')

    // --- RootSwitcher: enabled sftp row + enabled opted-in helper row -------
    // Close the dialog via its own header button (aria-label = panel.close);
    // page-level "关闭" matches would hit unrelated chrome (tab × buttons).
    const dialogClose = page.locator('[aria-label="工作区目录"], [aria-label="Workspace folders"]')
      .getByRole('button', { name: /^关闭$|^Close$/ }).first()
    try { await dialogClose.click({ timeout: 4_000 }) } catch { await page.keyboard.press('Escape') }
    await settle(600)
    await page.locator('.mrfw-rootSwitchBtn').first().click()
    await settle(2000) // opening the menu refreshes the remotes view first
    await shot('06-remote-live-enabled.png')
    const helperRow = page.getByRole('menuitem', { name: /helper-root.*SSH/ }).first()
    const helperShown = await helperRow.isVisible().catch(() => false)
    const helperEnabled = helperShown && !(await helperRow.isDisabled().catch(() => true))
    recordCheck(helperEnabled, 'the opted-in helper row renders selectable',
      helperShown ? 'row present but still disabled' : 'row not found in the switcher menu')
    const sftpItem = page.getByRole('menuitem', { name: /live-browse.*dsh-live-browse.*SSH/ }).first()
    if (!(await sftpItem.isVisible().catch(() => false))) {
      await dumpDom('stuck-menu.html')
      await shot('stuck-menu.png')
      recordCheck(false, 'the browsable remote row never appeared in the RootSwitcher menu')
      throw new Error('browsable remote row missing; inspect evidence/stuck-menu.*')
    }
    if (await sftpItem.isDisabled().catch(() => true)) {
      await dumpDom('stuck-menu.html')
      recordCheck(false, 'the browsable remote row rendered disabled — registration did not stick')
      throw new Error('browsable remote row disabled; see wire log and registerOutcomes')
    }
    await sftpItem.click()

    // --- the LIVE remote listing -------------------------------------------
    await page.waitForSelector('[data-files-path^="/mrfw/"]', { timeout: 60_000 })
    await settle(1200)
    const visible = () => page.evaluate(() => [...document.querySelectorAll('[data-files-path^="/mrfw/"]')].map(el => el.dataset.filesPath))
    const rootNodes = await visible()
    evidence.listings.treeNodes = rootNodes
    const expected = ['readme.txt', 'uni-名字.md', 'deep', 'space dir', 'literal\\dir', 'alias.link']
    const names = rootNodes.map(path => path.split('/').pop())
    recordCheck(expected.every(name => names.includes(name)), 'the remote tree painted every fixture entry', names)
    await shot('07-remote-live-tree.png')

    // Expand deep → inner → leaf (two more live listings).
    try {
      await page.getByRole('button', { name: 'deep', exact: true }).first().click({ timeout: 8_000 })
      await page.waitForSelector('[data-files-path$="deep/inner"]', { timeout: 30_000 })
      await page.getByRole('button', { name: 'inner', exact: true }).first().click({ timeout: 8_000 })
      await page.waitForSelector('[data-files-path$="deep/inner/leaf.txt"]', { timeout: 30_000 })
      evidence.listings.expanded = await visible()
      recordCheck(true, 'expanding deep/inner ran two more live remoteFiles.list calls')
    } catch (error) {
      recordCheck(false, 'expanding the remote tree failed', String(error))
    }
    await shot('08-remote-live-expanded.png')
  } catch (error) {
    guiError = error
    recordCheck(false, 'the GUI drive aborted', error instanceof Error ? (error.stack ?? error.message) : String(error))
    try { await dumpDom('gui-abort.html'); await shot('gui-abort.png') } catch { /* page may be gone */ }
  }

  // --- in-process channel truth under the GUI (runs even on GUI failure) ---
  const remotes = await channel('remotes', { sessionId })
  const view = remotes.body?.result?.value
  evidence.remotesView = view === undefined ? { status: remotes.status, error: remotes.body?.result?.error } : {
    primaryRoot: view.primaryRoot, mode: view.mode, custodyMode: view.custodyMode,
    status: view.status,
    endpoints: view.endpoints.map(ep => ({
      environmentId: ep.environmentId, rootId: ep.rootId, path: ep.path, state: ep.state,
      target: ep.target, browseAuthorization: ep.browseAuthorization === undefined ? 'absent' : `present:${ep.browseAuthorization.length}`,
      ...(ep.reason === undefined ? {} : { reason: ep.reason }),
    })),
  }
  const sftpEndpoint = view?.endpoints?.find(ep => ep.environmentId === SFTP_ENV && ep.rootId === SFTP_ROOT)
  if (sftpEndpoint?.browseAuthorization !== undefined) {
    for (const relativePath of ['', 'deep', 'deep/inner']) {
      const listed = await channel('remoteFiles.list', {
        sessionId, environmentId: SFTP_ENV, rootId: SFTP_ROOT,
        relativePath, authorization: sftpEndpoint.browseAuthorization,
      })
      evidence.listings[`channel:${relativePath === '' ? '/' : relativePath}`] =
        listed.body?.result?.ok === true ? listed.body.result.value : listed.body?.result ?? { status: listed.status }
    }
  }

  for (const line of [
    `remotes view: ${evidence.remotesView?.status?.state ?? 'unavailable'}`,
    `register: ${JSON.stringify(evidence.registerOutcomes)}`,
    `tree nodes: ${JSON.stringify(evidence.listings.treeNodes ?? [])}`,
    ...(guiError === undefined ? [] : [`GUI drive aborted: ${guiError instanceof Error ? guiError.message : String(guiError)}`]),
  ]) note(line)
} catch (error) {
  fatal = error
  recordCheck(false, 'the harness aborted before completing', error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  evidence.failures = evidence.checks.filter(entry => !entry.ok)
  writeFileSync(join(EVIDENCE_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2))
  try { await browser?.close() } catch { /* best effort */ }
  try { await ctx?.fiber.dispose() } catch { /* best effort */ }
  try { model?.close() } catch { /* best effort */ }
  // `rm -rf` on an absent path is a no-op, so the cleanup is unconditional —
  // it must still run when the run died between fixture creation and now.
  try { sshAli(CLEANUP_SCRIPT); note(`remote fixture ${REMOTE_BASE} removed`) }
  catch (error) { note(`fixture cleanup FAILED: ${error instanceof Error ? error.message : String(error)} — remove ${REMOTE_BASE} manually`) }
}

check.finish()
if (fatal !== undefined) process.exitCode = 1
note(`evidence at ${join(EVIDENCE_DIR, 'evidence.json')}`)
