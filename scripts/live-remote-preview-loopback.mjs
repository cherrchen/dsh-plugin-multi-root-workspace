/**
 * Packed production plugin, real DSH Web, Chromium and OpenSSH SFTP.
 * Run pnpm build first, then DSH_LIVE_PREVIEW=1 node scripts/live-remote-preview-loopback.mjs.
 * Uses throwaway keys and an isolated ssh_config; never contacts the user's SSH servers.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
import { createServer as createTcp, Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { packTarball } from './check-pack.mjs'
import { captureDsh, installPluginProfile, loadRuntimeModule, REPO_ROOT, runtimeRequire } from './lib/dsh-runtime.mjs'
import { bootProfile } from './lib/profile-boot.mjs'
import { chatCompletionFrames } from './lib/scripted-model-frames.mjs'

if (process.env.DSH_LIVE_PREVIEW !== '1') throw new Error('Set DSH_LIVE_PREVIEW=1 to run the isolated loopback/browser acceptance.')
const sshdPath = ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd'].find(existsSync)
if (process.platform === 'win32' || !sshdPath) throw new Error('A usable POSIX sshd is required.')
const version = runtimeRequire()('@deepseek-ai/dsh/package.json').version
const previewExpected = version === '0.2.3-alpha.2'
const run = realpathSync(mkdtempSync(join(tmpdir(), 'mrfw-preview-live-')))
const artifacts = join(REPO_ROOT, '.dsh-smoke', 'remote-preview', `${version}-${randomUUID().slice(0, 8)}`)
mkdirSync(artifacts, { recursive: true })
const evidence = { version, previewExpected, results: [], status: 'FAIL' }
const check = (name, verdict, facts) => {
  evidence.results.push({ name, status: verdict ? 'PASS' : 'FAIL', ...facts })
  console.log(`${verdict ? 'PASS' : 'FAIL'} ${name}`, facts ?? '')
  assert.ok(verdict, name)
}
const home = join(run, 'dsh')
const workspace = join(run, 'preview-workspace')
const remote = join(run, 'remote-files')
const session = 'mrfw-preview-live'
const endpoint = { sessionId: session, environmentId: 'preview-ssh', rootId: 'remote-root' }
const execute = (path, args) => execFileSync(path, args, { encoding: 'utf8', timeout: 10_000 }).trim()
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const reachable = port => new Promise(resolve => {
  const socket = new Socket()
  const finish = value => { socket.destroy(); resolve(value) }
  socket.once('error', () => finish(false)).once('connect', () => finish(true)).setTimeout(300, () => finish(false))
  socket.connect(port, '127.0.0.1')
})
let sshd, model, context, browser, page
try {
  for (const dir of ['dsh/storages', 'preview-workspace', 'remote-files/nested', 'remote-files/side',
    'second-files/nested', 'list-only', 'additional', 'keys', 'bin', 'pack']) {
    mkdirSync(join(run, dir), { recursive: true, mode: 0o700 })
  }
  const text = `ssh-only-${randomUUID()}\n`
  const markdown = '# From OpenSSH\n\n![no fetch](https://127.0.0.1:1/test.png)\n\n<script>no execution</script>\n'
  const bulk = '0123456789abcdef\n'.repeat(120_000)
  const secondText = `different-environment-${randomUUID()}\n`
  writeFileSync(join(remote, 'nested', 'a.txt'), text)
  writeFileSync(join(remote, 'nested', 'b.md'), markdown)
  writeFileSync(join(remote, 'bulk.txt'), bulk)
  writeFileSync(join(remote, 'oversize.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
  writeFileSync(join(workspace, 'local.txt'), 'native-local-control\n')
  writeFileSync(join(run, 'additional', 'extra.txt'), 'native-additional-control\n')
  writeFileSync(join(run, 'second-files', 'nested', 'a.txt'), secondText)
  writeFileSync(join(run, 'list-only', 'names-only.txt'), 'this fixture has no preview opt-in\n')

  const hostKey = join(run, 'keys', 'host')
  const userKey = join(run, 'keys', 'user')
  for (const key of [hostKey, userKey]) execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  const account = userInfo().username
  const reserved = createTcp()
  const port = await listen(reserved)
  await new Promise(resolve => reserved.close(resolve))
  const knownHosts = join(run, 'keys', 'known_hosts')
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${readFileSync(`${hostKey}.pub`, 'utf8')}`)
  writeFileSync(join(run, 'sshd_config'), [
    'ListenAddress 127.0.0.1', `Port ${port}`, `HostKey ${hostKey}`, `PidFile ${join(run, 'sshd.pid')}`,
    'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
    `AuthorizedKeysFile ${userKey}.pub`, 'StrictModes no', 'Subsystem sftp internal-sftp', '',
  ].join('\n'))
  sshd = spawn(sshdPath, ['-D', '-e', '-f', join(run, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
  let daemonLog = ''
  sshd.stderr.on('data', chunk => { daemonLog = (daemonLog + chunk.toString()).slice(-4096) })
  const until = Date.now() + 10_000
  while (!await reachable(port)) {
    if (sshd.exitCode !== null || Date.now() > until) throw new Error(`sshd not ready: ${daemonLog}`)
    await delay(100)
  }
  const config = join(run, 'ssh_config')
  writeFileSync(config, [
    'Host mrfw-preview-loopback', 'HostName 127.0.0.1', `Port ${port}`, `User ${account}`, `IdentityFile ${userKey}`,
    `UserKnownHostsFile ${knownHosts}`, 'GlobalKnownHostsFile /dev/null', 'StrictHostKeyChecking yes',
    'IdentitiesOnly yes', 'BatchMode yes', 'ForwardAgent no', 'UpdateHostKeys no', '',
  ].join('\n'), { mode: 0o600 })
  // The fixture supplies configuration only. Both identity verification and SFTP
  // still run on real OpenSSH; an unexpected host cannot leave loopback.
  writeFileSync(join(run, 'bin', 'ssh'), [
    '#!/bin/sh', '# Accept the fixture alias only.',
    'case " $* " in *" mrfw-preview-loopback "*) ;; *) exit 64;; esac',
    'exec /usr/bin/ssh -F "$MRFW_PREVIEW_SSH_CONFIG" "$@"', '',
  ].join('\n'), { mode: 0o700 })
  process.env.MRFW_PREVIEW_SSH_CONFIG = config
  process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`
  const fingerprint = execute('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${hostKey}.pub`]).split(/\s+/u)[1]
  const store = join(home, 'storages', 'multi_root_workspace.remote-personal.json')
  const environment = {
    identityId: randomUUID(), displayName: 'Loopback SFTP',
    platform: process.platform, endpoint: { hostname: '127.0.0.1', port, user: account },
    credential: { kind: 'ssh-config', alias: 'mrfw-preview-loopback' }, hostKey: fingerprint, helper: null,
  }
  const firstBinding = {
    primary: workspace, environmentId: endpoint.environmentId, rootId: endpoint.rootId, bindingId: randomUUID(),
    path: remote, directoryListing: 'stable-path', filePreview: 'stable-path', actions: ['read'],
  }
  const second = { sessionId: session, environmentId: 'second-ssh', rootId: 'second-root' }
  const listOnly = { sessionId: session, environmentId: endpoint.environmentId, rootId: 'list-only' }
  writeFileSync(store, JSON.stringify({ schemaVersion: 2, revision: 1, environments: [
    { ...environment, environmentId: endpoint.environmentId },
    ...(previewExpected ? [{ ...environment, identityId: randomUUID(), environmentId: second.environmentId, displayName: 'Second environment' }] : []),
  ] }), { mode: 0o600 })
  writeFileSync(`${store}.bindings.json`, JSON.stringify({ schemaVersion: 1, revision: 1, bindings: [
    firstBinding,
    ...(previewExpected ? [
      { ...firstBinding, environmentId: second.environmentId, rootId: second.rootId, path: join(run, 'second-files'), bindingId: randomUUID() },
      { ...firstBinding, rootId: listOnly.rootId, path: join(run, 'list-only'), bindingId: randomUUID(), filePreview: undefined },
    ] : []),
  ] }), { mode: 0o600 })

  const { tarball } = packTarball(join(run, 'pack'))
  evidence.tarSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  assert.equal(await installPluginProfile('web', home, tarball), 0)
  const sshPeerNames = ['dsh-ssh', 'dsh-fs-ssh', 'dsh-subprocess-ssh', 'dsh-sandbox-ssh']
  const peers = await captureDsh([
    'plugin', '--profile', 'web', 'add', '--save-exact', ...sshPeerNames.map(name => `@deepseek-ai/${name}@${version}`),
  ], { DSH_HOME: home })
  assert.equal(peers.code, 0, peers.stderr.slice(-1500))
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: multi-root-remote-tools', '  name: "@dsh-electron/dsh-plugin-multi-root-workspace/remote-tools"',
    '  config:', '    mode: personal', '    enabled: true', '',
  ].join('\n'))

  model = createHttp((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of chatCompletionFrames(undefined, 'preview-test', 'preview-test-response')) res.write(frame)
      res.end()
    })
  })
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DEEPSEEK_API_KEY = 'loopback-fixture-key'
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${await listen(model)}`
  process.chdir(workspace)
  const { ctx } = await bootProfile('web', home, async host => {
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    provideCmdline(host, { args: ['--no-open', '--port', '0'], exit: () => {} })
  })
  context = ctx
  const { workspace: created } = await ctx.get('workspaceController').create({ path: workspace })
  const preset = await ctx.get('agentPresets')?.resolve(undefined)
  const opened = await ctx.get('sessionController').create({ workspaceId: created.workspaceId, sessionId: session,
    ...(preset ? { agentPreset: preset.id } : {}) })
  assert.equal(opened.sessionId, session)
  const web = ctx.get('webServer')
  const base = `http://127.0.0.1:${web.port}/`
  const connection = ctx.get('connection')
  const entries = []
  ctx.emit(web, 'webserver/entry-url', base, entries)
  const authUrl = typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(base) : entries[0]?.url
  assert.ok(authUrl, 'authenticated browser entry')
  const authResponse = await fetch(authUrl, { redirect: 'manual' })
  const cookie = authResponse.headers.get('set-cookie')?.split(';', 1)[0]
  let rpc = 0
  const call = async (method, payload) => {
    const response = await fetch(new URL(`/multi-root-workspace/${method}`, base), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: `preview-test-${++rpc}`, method, payload }),
    })
    const { result } = await response.json()
    assert.ok(result?.ok, `${method}: ${response.status} ${result?.error?.code}`)
    return result.value
  }
  const authorized = (await call('addRemote', endpoint)).endpoints.find(item => item.rootId === endpoint.rootId)
  check('personal binding registered through real SSH identity and SFTP', authorized?.state === 'registered' && !!authorized.browseAuthorization)
  check('exact-release capability hint', authorized.preview === (previewExpected ? 'sftp-binary-v1' : undefined))
  if (previewExpected) {
    await call('addRemote', second)
    const browseOnly = (await call('addRemote', listOnly)).endpoints.find(item => item.rootId === listOnly.rootId)
    check('listing opt-in alone never advertises content access', !!browseOnly?.browseAuthorization && browseOnly.preview === undefined)
    await call('add', { sessionId: session, path: join(run, 'additional'), alias: 'Local additional', access: 'read-only' })
  }

  browser = await chromium.launch({ headless: true, ...(process.env.DSH_CHROME_CHANNEL ? { channel: process.env.DSH_CHROME_CHANNEL } : {}) })
  page = await browser.newPage({ viewport: { width: 1500, height: 940 }, locale: 'en-US' })
  page.setDefaultTimeout(18_000)
  page.on('pageerror', error => console.log('browser error:', error.message))
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click({ timeout: 4_000 }).catch(() => {})
  const sessions = page.locator('[aria-label="Sessions"] [data-row-key]:not([data-row-key="empty"]), [aria-label="Sessions"] [role="treeitem"]')
  await sessions.first().click()
  await page.locator('button[data-sidebar-right-expand="true"], button[aria-label="Open right sidebar"]').first().click({ timeout: 3500 }).catch(() => {})
  const switcher = page.locator('.mrfw-rootSwitchBtn').first()
  if (!await switcher.isVisible()) await page.getByRole('button', { name: /Workspace files|Browse files/iu }).first().click()
  const selectRoot = async (name = /remote-root.*SSH/iu) => {
    await switcher.click()
    await page.getByRole('menuitem', { name }).first().click()
  }
  const row = (parent, path) => parent.locator(`[data-files-path="/mrfw/${path}"] > button, [data-files-path="/mrfw/${path}"] > div > button`).first()
  const viewer = page.locator('[data-mrfw-preview]:visible')
  const display = viewer.locator('[data-mrfw-preview-content]')
  const ready = () => display.and(page.locator('[data-mrfw-preview-state="ready"]')).waitFor()
  const dockTabs = page.locator('[data-dockkit-tab]')
  const showFiles = () => dockTabs.filter({ has: page.getByText('Files', { exact: true }) }).first().click()
  const openFile = async (path, root) => {
    await selectRoot(root)
    if (path.startsWith('nested/') && await row(page, 'nested').getAttribute('aria-expanded') !== 'true') await row(page, 'nested').click()
    await row(page, path).click()
  }
  await selectRoot()
  await row(page, 'nested').click()
  const first = row(page, 'nested/a.txt')
  const firstEntry = page.locator('[data-files-path="/mrfw/nested/a.txt"]')
  await firstEntry.waitFor()
  check('real classic Files provider mounted and browsed', await firstEntry.getAttribute('data-files-entry') === 'file')
  if (!previewExpected) {
    check('older Host renders the remote file inert while listing still works',
      await firstEntry.locator('[aria-disabled="true"], button:disabled').count() > 0
      && await firstEntry.locator('button:enabled').count() === 0
      && await viewer.count() === 0)
  }
  if (previewExpected) {
    await first.click()
    await ready()
    check('real Files row opens exact real SFTP bytes in read-only Viewer',
      await display.locator('pre').textContent() === text
      && await viewer.locator('textarea,[contenteditable="true"]').count() === 0)
    const textTab = dockTabs.filter({ has: page.getByText('a.txt', { exact: true }) }).first()
    check('remote preview tab carries the file-type icon', await textTab.locator('.mrfw-previewTitleIcon').count() === 1)
    const rev = `${text}updated\n`
    writeFileSync(join(remote, 'nested', 'a.txt'), rev)
    await viewer.getByRole('button', { name: 'Reload file' }).click()
    await ready()
    check('refresh reads changed bytes in the same Viewer', await display.locator('pre').textContent() === rev)
    await viewer.getByRole('button', { name: 'Show file tree', exact: true }).click()
    const folder = viewer.locator('[data-mrfw-preview-folder]')
    await row(folder, 'nested/a.txt').and(page.locator('[aria-current="true"]')).waitFor()
    check('Folder reuses FilesPane and reveals current remote file', true)
    await row(folder, 'side').click()
    const pane = () => viewer.evaluate(node => {
      const carrier = node.closest('[data-dockkit-pane],[data-dockkit-float]')
      return carrier?.getAttribute('data-dockkit-pane') ?? carrier?.getAttribute('data-dockkit-float')
    })
    const tabCount = () => page.locator('[data-dockkit-tab]').count()
    const paneBefore = await pane()
    const tabsBefore = await tabCount()
    await row(folder, 'nested/b.md').click()
    await display.getByRole('heading', { name: 'From OpenSSH' }).waitFor()
    const markdownTab = dockTabs.filter({ has: page.getByText('b.md', { exact: true }) }).first()
    check('replace-in-place keeps the Markdown tab icon', await markdownTab.locator('.mrfw-previewTitleIcon').count() === 1)
    check('same-pane replaceTab preserves tab count and current-file affordance',
      !!paneBefore && await pane() === paneBefore && await tabCount() === tabsBefore)
    await row(folder, 'nested/b.md').and(page.locator('[aria-current="true"]')).waitFor()
    check('Folder restores expansion and Markdown renders only safe literal children',
      await row(folder, 'side').getAttribute('aria-expanded') === 'true'
      && await display.locator('a,img,script,iframe').count() === 0
      && (await display.textContent()).includes('<script>no execution</script>'))
    await page.screenshot({ path: join(artifacts, 'viewer.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark')
    const darkStyle = await viewer.evaluate(element => {
      const style = getComputedStyle(element)
      return style.backgroundColor !== style.color && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
    })
    check('dark host tokens paint the same safe Viewer', darkStyle && await display.getByRole('heading', { name: 'From OpenSSH' }).isVisible())
    await page.screenshot({ path: join(artifacts, 'viewer-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })

    const start = performance.now()
    await row(folder, 'bulk.txt').click()
    await ready()
    const shown = await display.locator('pre').textContent()
    check('large content byte-exact through binary RPC',
      createHash('sha256').update(shown).digest('hex') === createHash('sha256').update(bulk).digest('hex'),
      { bytes: Buffer.byteLength(bulk), elapsedMs: Math.round(performance.now() - start) })
    await row(folder, 'oversize.txt').click()
    await display.and(page.locator('[data-mrfw-preview-state="error"]')).waitFor()
    check('oversize refuses without previous content', /larger than 2 MiB/u.test(await display.textContent()) && await display.locator('pre').count() === 0)
    await row(folder, 'nested/a.txt').click()
    await ready()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await display.and(page.locator('[data-mrfw-preview-state="expired"]')).waitFor()
    check('reload: persisted tab fails closed without retaining bytes', await display.locator('pre').count() === 0)

    await showFiles()
    // Refreshing the menu re-proves the incarnation after reload.
    await openFile('nested/a.txt')
    await ready()
    await call('removeRemote', endpoint)
    await display.and(page.locator('[data-mrfw-preview-state="expired"]')).waitFor()
    check('revoke while Viewer visible drops content and refresh affordance',
      await display.locator('pre').count() === 0 && await viewer.getByRole('button', { name: 'Reload file' }).count() === 0)
    const regranted = (await call('addRemote', endpoint)).endpoints.find(item => item.rootId === endpoint.rootId)
    check('regrant does not revive old preview', regranted?.browseAuthorization !== authorized.browseAuthorization
      && await display.getAttribute('data-mrfw-preview-state') === 'expired')

    await showFiles()
    await selectRoot(/list-only.*SSH/iu)
    const inert = page.locator('[data-files-path="/mrfw/names-only.txt"]')
    await inert.waitFor()
    check('same-release file without explicit opt-in is inert', await inert.locator('[aria-disabled="true"], button:disabled').count() > 0)
    await openFile('nested/a.txt', /second-root.*SSH/iu)
    await ready()
    check('same relative path in another environment resolves only to its own bytes', await display.locator('pre').textContent() === secondText)
    const activeClose = dockTabs.filter({ has: page.getByText('a.txt', { exact: true }) })
      .and(page.locator('[aria-selected="true"]')).locator('[data-dockkit-tab-close]')
    await activeClose.click()
    check('closing the active Viewer removes its content', await display.getByText(secondText.trim(), { exact: true }).count() === 0)

    await showFiles()
    await selectRoot(/^Local additional/u)
    await page.getByRole('button', { name: 'extra.txt', exact: true }).click()
    await page.getByText('native-additional-control', { exact: false }).first().waitFor()
    check('additional-root file still opens native local preview', await viewer.count() === 0)
    await showFiles()
    await selectRoot(/^preview-workspace/u)
    await page.getByRole('button', { name: 'local.txt', exact: true }).click()
    await page.getByText('native-local-control', { exact: false }).first().waitFor()
    check('switch back to primary and open native local preview', await viewer.count() === 0)
  }
  evidence.status = 'PASS'
} catch (cause) {
  evidence.failure = String(cause).split('\n').slice(0, 12).join('\n')
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
  throw cause
} finally {
  writeFileSync(join(artifacts, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`Evidence: ${artifacts}`)
  await browser?.close()
  await context?.fiber.dispose()
  model?.close()
  sshd?.kill()
  process.chdir(REPO_ROOT)
  rmSync(run, { recursive: true, force: true })
}
