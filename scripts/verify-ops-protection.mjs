/** macOS/Linux/Windows OPS P5 regression on an isolated, peer-compatible host.
 * node --experimental-transform-types scripts/verify-ops-protection.mjs <hostDir> [bwrap|landlock]
 * hostDir contains node_modules and an unchanged ops-current checkout with lib/
 * and a staged native Worker. The current MR source is copied into that host.
 * Results and fixtures stay in hostDir; nothing writes a real user profile.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert(['darwin', 'linux', 'win32'].includes(process.platform), 'this probe requires macOS, Linux or Windows')
const windows = process.platform === 'win32'
const host = path.resolve(process.argv[2] ?? '')
assert(process.argv[2], 'usage: verify-ops-protection.mjs <isolated-host-dir>')
const dialect = process.argv[3]
assert(dialect === undefined || (process.platform === 'linux' && ['bwrap', 'landlock'].includes(dialect)), 'explicit dialect requires Linux bwrap or landlock')
const repo = fileURLToPath(new URL('..', import.meta.url))
assert.notEqual(fs.realpathSync(host), fs.realpathSync(repo), 'use a separate host')
// Isolate OPS shell preparation and caches from the real user's profile.
process.env.DSH_HOME = path.join(host, 'dsh-home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
const source = path.join(host, 'multi-root')
fs.mkdirSync(source, { recursive: true })
fs.cpSync(path.join(repo, 'src'), path.join(source, 'src'), { recursive: true })
fs.copyFileSync(path.join(repo, 'package.json'), path.join(source, 'package.json'))
if (windows) {
  // windows-profile.ts locates this standalone bundled runner beside itself.
  for (const file of fs.readdirSync(path.join(repo, 'lib')).filter(file => file.endsWith('.js'))) {
    fs.copyFileSync(path.join(repo, 'lib', file), path.join(source, 'src', file))
  }
}
const requireHost = createRequire(path.join(host, 'package.json'))
const pkg = name => import(pathToFileURL(requireHost.resolve(name)).href)
const mr = file => import(pathToFileURL(path.join(source, 'src', file + '.ts')).href)
const { Context } = await pkg('@deepseek-ai/cordis')
const { default: Tools } = await pkg('@deepseek-ai/dsh-tools')
const { default: Prompt } = await pkg('@deepseek-ai/dsh-system-prompt')
const { default: Sessions } = await pkg('@deepseek-ai/dsh-session')
const { default: Projections } = await pkg('@deepseek-ai/dsh-session-projection')
const { default: Policy } = await pkg('@deepseek-ai/dsh-sandbox-policy')
const { default: Subprocess } = await pkg('@deepseek-ai/dsh-subprocess-local')
const { default: Storage } = await pkg('@deepseek-ai/dsh-storage')
const { DomainFacility } = await pkg('@deepseek-ai/dsh-storage-domain')
const Json = await pkg('@deepseek-ai/dsh-storage-json')
const { createScope } = await pkg('@deepseek-ai/dsh-scope')
const { default: Llm, LlmAdapter } = await pkg('@deepseek-ai/dsh-llm')
const { default: PtcRuntime } = await pkg('@deepseek-ai/dsh-ptc-runtime-node')
const { default: Scope } = await mr('scope')
const Compat = await mr('compat')
const { default: MRFS } = await mr('fs')
const { default: Sandbox } = await mr('sandbox')
const { default: Providers } = await mr('providers')
const { default: Registry } = await mr('registry')
const { default: OpsMode } = await mr('ops-compatibility')
const Fence = await mr('process-fence')
const { wrapMethod } = await mr('method-wrapper')
const { integration } = await import(pathToFileURL(createRequire(path.join(host, 'ops-current', 'package.json')).resolve('dsh-ops/integration')).href)
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = () => new Promise(resolve => setTimeout(resolve, 20))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const hostLock = JSON.parse(fs.readFileSync(path.join(host, 'package-lock.json'), 'utf8'))
const dshTree = Object.entries(hostLock.packages).filter(([name]) => /node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(name))
  .map(([location, entry]) => ({ location, version: entry.version }))
const dshRelease = requireHost('@deepseek-ai/dsh/package.json').version
assert(dshTree.length > 0 && dshTree.every(entry => entry.version === dshRelease), 'isolated DSH tree must use one exact release')
// This selects the upstream probe chain. FA ambient-minus-deny still uses
// bwrap when Landlock cannot subtract a subtree; started[].argv is authoritative.
const report = { platform: process.platform, os: os.release(), node: process.version, arch: process.arch, requestedDialect: dialect,
  repoCommit: git(repo, 'rev-parse', 'HEAD'), opsCommit: git(path.join(host, 'ops-current'), 'rev-parse', 'HEAD'),
  opsWorkingTree: git(path.join(host, 'ops-current'), 'status', '--short'),
  dsh: dshRelease, dshTree,
  ops: JSON.parse(fs.readFileSync(path.join(host, 'ops-current', 'package.json'), 'utf8')).version,
  hostLockSha256: sha(path.join(host, 'package-lock.json')),
  workerSha256: process.env.DSH_OPS_WORKER_BIN ? sha(process.env.DSH_OPS_WORKER_BIN) : undefined,
  sourceSha256: Object.fromEntries(['src/compat/ops-tools.ts', 'src/process-fence.ts', 'src/scope.ts', 'src/method-wrapper.ts']
    .map(file => [file, sha(path.join(repo, file))])),
  checks: [], worlds: [] }
const completed = result => result.isError !== true && result.value?.status === 'completed'
const refused = result => result.isError === true || result.value?.status === 'error'
async function check(name, run) {
  try { await run(); report.checks.push({ name, pass: true }) }
  catch (error) { report.checks.push({ name, pass: false, error: error.stack }); process.exitCode = 1 }
}
// Hash the isolated profile and the complete business tree, including empty
// directories. A rejected preparation must not create caches or result files.
function snapshot(root) {
  if (!fs.existsSync(root)) return null
  const entries = {}
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file)
      if (entry.isSymbolicLink()) entries[relative] = { link: fs.readlinkSync(file) }
      else if (entry.isDirectory()) { entries[relative] = 'directory'; visit(file) }
      else entries[relative] = sha(file)
    }
  }
  visit(root)
  return entries
}
async function world(mode, shared) {
  const base = fs.mkdtempSync(path.join(host, 'fixture-'))
  const primary = path.join(base, 'primary'), ro = path.join(base, 'ro'), rw = path.join(base, 'rw'), store = path.join(base, 'store')
  for (const dir of [primary, ro, rw, store]) fs.mkdirSync(dir)
  const roFile = path.join(ro, 'file.txt'), primaryFile = path.join(primary, 'file.txt')
  fs.writeFileSync(roFile, 'readonly original\n'); fs.writeFileSync(primaryFile, 'primary original\n')
  fs.symlinkSync(ro, path.join(primary, 'alias-ro'), windows ? 'junction' : 'dir')
  const ctx = new Context(); ctx.logger.level = 0
  const data = { mode, shared, started: [], attempts: [], base }
  data.warnings = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') data.warnings.push(message.args.map(String).join(' '))
  } })
  report.worlds.push(data)
  try {
    await ctx.plugin(Projections); await ctx.plugin(Prompt, {}); await ctx.plugin(Tools, {}); await ctx.plugin(Sessions)
    await ctx.plugin(Llm)
    class Recorder extends LlmAdapter { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    ctx.llm.registerAdapter(['probe'], new Recorder())
    await ctx.plugin(Policy, { mode, workspaceRoot: primary })
    await ctx.plugin(Subprocess); await ctx.plugin(Storage); await ctx.plugin(Json, { root: store })
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility); ctx.provide('storageDomain', facility)
    // Count actual launches beneath both MR wrappers.
    const stopStarted = wrapMethod(ctx.get('subprocess'), 'spawn', original => function (spec) {
      data.started.push({ argv: spec.argv, cwd: spec.cwd }); return original.call(this, spec)
    })
    await ctx.plugin(Scope, windows ? {} : { toolAccess: { ops_write_file: 'read-only' } })
    ctx.provide('settings', { installSection(_owner, ns, _schema, _initial, hooks) {
      if (ns === 'multi-root-ops-compatibility') hooks.setSource(() => ({ enabled: true }))
    } })
    await ctx.plugin(OpsMode, { enabled: true }); await ctx.plugin(Compat)
    assert(ctx.get('multiRootCompat'), 'compatible tree required')
    await ctx.plugin(MRFS, { cwd: primary }); await ctx.plugin(Sandbox, {}); await ctx.plugin(Providers)
    if (dialect) ctx.sandbox.internals = { chain: [dialect] }
    data.profiles = []
    const stopProfiles = wrapMethod(ctx.get('sandbox'), 'confine', original => function (...args) {
      const record = { policy: args[1] }; data.profiles.push(record)
      const result = original.apply(this, args)
      const observe = profile => { record.argv = profile.argv; return profile }
      return result?.then ? result.then(observe) : observe(result)
    })
    const registry = await ctx.plugin(Registry, { leasePath: path.join(store, 'multi_root_workspace.lock'), ...(shared ? { sharedStorageRoot: store } : {}) })
    const fence = await ctx.plugin(Fence)
    const stopAttempts = wrapMethod(ctx.get('subprocess'), 'spawn', original => function (spec) {
      const attempt = { argv: spec.argv, error: undefined }; data.attempts.push(attempt)
      try { return original.call(this, spec) } catch (error) { attempt.error = error.message; throw error }
    })
    const agents = []
    ctx.provide('agents', { list: () => agents, get: id => agents.find(agent => agent.id === id) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    const session = ctx.sessions.create('native', { meta: { cwd: primary, agentPreset: 'probe-native' } })
    const agent = { id: 'native', session }; agent.ctx = createScope(ctx, agent).ctx; agents.push(agent)
    await ctx.serial('agent/created', { agent })
    if (!windows) await ctx.multiRootRegistry.add(primary, { path: ro, access: 'read-only' })
    await ctx.multiRootRegistry.add(primary, { path: rw, access: 'read-write' })
    await ctx.plugin(integration({ preset: 'probe-native', discovery: false, required: true, replaceOfficial: false, shell: windows,
      residentNames: ['inspect_local_file', 'read_files', 'write_file', 'edit_file', 'replace', 'copy', 'move', 'remove', 'stat', 'result'] }))
    for (let i = 0; i < 200 && !ctx.tools.get('ops_write_file', agent); i++) await sleep()
    assert(ctx.tools.get('ops_write_file', agent), 'OPS tools must be published')
    let callId = 0
    const call = (name, args, caller = agent) => ctx.tools.execute({ agent: caller, callId: 'probe-' + ++callId, name, arguments: args, signal: new AbortController().signal })
    if (windows) {
      // Prove that real Workers work before testing MR's conservative refusal.
      await check(`${mode}/${shared}/no-deny-read`, async () => {
        const before = data.started.length
        const result = await call('ops_read_files', { files: [{ path: primaryFile }] })
        data.positiveRead = result
        assert(completed(result), JSON.stringify(result))
        assert(data.started.length > before, 'positive control did not launch a Worker')
      })
      if (mode !== 'read-only') await check(`${mode}/${shared}/no-deny-primary-write`, async () => {
        const target = path.join(primary, 'positive-control.txt')
        const result = await call('ops_write_file', { path: target, content: 'positive write\n', expectedRevision: 'absent' })
        data.positiveWrite = result
        assert(completed(result), JSON.stringify(result))
        assert.equal(fs.readFileSync(target, 'utf8'), 'positive write\n')
      })
      assert(ctx.tools.get('ops_bash', agent), 'real Windows OPS Bash must be published')
      await ctx.multiRootRegistry.add(primary, { path: ro, access: 'read-only' })
    }
    const revision = sha(roFile)
    const operations = [
      ['ops_write_file', { path: roFile, content: 'VIOLATION\n', expectedRevision: revision }],
      ['ops_write_file', { path: path.join(ro, 'created.txt'), content: 'VIOLATION\n', expectedRevision: 'absent' }],
      ['ops_edit_file', { path: roFile, expectedRevision: revision, edits: [{ oldText: 'readonly', newText: 'VIOLATION' }] }],
      ['ops_replace', { path: ro, pattern: 'readonly', replacement: 'VIOLATION' }],
      ['ops_copy', { path: primaryFile, to: path.join(ro, 'copied.txt'), expectedRevision: sha(primaryFile) }],
      ['ops_move', { path: roFile, to: path.join(primary, 'moved.txt'), expectedRevision: revision }],
      ['ops_move', { path: primaryFile, to: path.join(ro, 'moved.txt'), expectedRevision: sha(primaryFile) }],
      ['ops_remove', { path: roFile, expectedRevision: revision }],
      ['ops_write_file', { path: path.join(primary, 'alias-ro', 'file.txt'), content: 'VIOLATION\n', expectedRevision: revision }],
    ]
    for (const [name, args] of operations) await check(`${mode}/${shared}/${name}/${args.path}`, async () => {
      const before = data.started.length
      const profiles = data.profiles.length
      const earlyRefusal = windows || mode !== 'danger-full-access'
      const preparation = earlyRefusal ? snapshot(process.env.DSH_HOME) : undefined
      const business = earlyRefusal ? [snapshot(primary), snapshot(ro), snapshot(rw)] : undefined
      const result = await call(name, args)
      data.results ??= []; data.results.push({ name, args, result })
      assert(refused(result), JSON.stringify(result))
      assert.equal(sha(roFile), revision); assert.deepEqual(fs.readdirSync(ro), ['file.txt'])
      assert.equal(fs.readFileSync(primaryFile, 'utf8'), 'primary original\n', 'failed move removed source')
      if (earlyRefusal) {
        assert.equal(data.started.length, before, 'early refusal launched a Worker')
        assert.equal(data.profiles.length, profiles, 'rejected call attempted cache confinement')
        assert.deepEqual(snapshot(process.env.DSH_HOME), preparation, 'rejected call changed OPS preparation')
        assert.deepEqual([snapshot(primary), snapshot(ro), snapshot(rw)], business, 'rejected call changed business files')
        assert.match(JSON.stringify(result), /OPS .*refused|OPS worker preparation|OPS execution is refused/)
      } else {
        assert(data.started.length > before, 'protected POSIX operation did not reach a real Worker')
      }
    })
    await check(`${mode}/${shared}/read`, async () => {
      const earlyRefusal = windows || mode !== 'danger-full-access'
      const before = data.started.length, profiles = data.profiles.length
      const preparation = earlyRefusal ? snapshot(process.env.DSH_HOME) : undefined
      const result = await call('ops_read_files', { files: [{ path: roFile }] })
      assert(!windows && mode === 'danger-full-access' ? completed(result) : refused(result), JSON.stringify(result))
      if (earlyRefusal) {
        assert.equal(data.started.length, before)
        assert.equal(data.profiles.length, profiles)
        assert.deepEqual(snapshot(process.env.DSH_HOME), preparation)
      }
    })
    if (mode === 'danger-full-access') {
      if (!windows) {
        await check(`${mode}/${shared}/tool-cap`, async () => {
          const target = path.join(rw, 'capped.txt'), before = data.started.length
          const result = await call('ops_write_file', { path: target, content: 'VIOLATION\n', expectedRevision: 'absent' })
          data.capResult = result
          assert(refused(result), JSON.stringify(result))
          assert(data.started.length > before, 'cap test did not reach a protected Worker')
          assert(!fs.existsSync(target), 'capped tool wrote the read-write root')
        })
        await check(`${mode}/${shared}/uncapped-sibling`, async () => {
          const target = path.join(rw, 'uncapped.txt')
          const result = await call('ops_copy', { path: primaryFile, to: target, expectedRevision: sha(primaryFile) })
          data.uncappedResult = result
          assert(completed(result), JSON.stringify(result))
          assert.equal(fs.readFileSync(target, 'utf8'), 'primary original\n')
        })
        await check(`${mode}/${shared}/tmp-sibling`, async () => {
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-ops-denied-'))
          const target = path.join(directory, 'file.txt')
          fs.writeFileSync(target, 'temporary readonly original\n')
          const revision = sha(target)
          const records = await ctx.multiRootRegistry.add(primary, { path: directory, access: 'read-only' })
          const canonicalDirectory = fs.realpathSync.native(directory)
          const record = records.find(record => record.path === canonicalDirectory)
          assert(record)
          data.tmpSibling = { directory, revision }
          try {
            const before = data.started.length
            const result = await call('ops_write_file', { path: target, content: 'VIOLATION\n', expectedRevision: revision })
            data.tmpSibling.result = result
            assert(refused(result), JSON.stringify(result))
            assert(data.started.length > before, 'ordinary tmp sibling was refused before the protected Worker')
            assert.equal(sha(target), revision)
            assert.deepEqual(fs.readdirSync(directory), ['file.txt'])
          } finally { await ctx.multiRootRegistry.remove(primary, { kind: 'id', id: record.id }) }
        })
      }
      await check(`${mode}/${shared}/legal-primary-write`, async () => {
        const result = await call('ops_write_file', { path: primaryFile, content: 'primary ok\n', expectedRevision: sha(primaryFile) })
        if (windows) {
          assert(refused(result), JSON.stringify(result))
          assert.equal(fs.readFileSync(primaryFile, 'utf8'), 'primary original\n')
        } else {
          assert(completed(result), JSON.stringify(result)); assert.equal(fs.readFileSync(primaryFile, 'utf8'), 'primary ok\n')
        }
      })
      await check(`${mode}/${shared}/maintenance`, async () => {
        const before = data.started.length, attempts = data.attempts.length
        const warnings = data.warnings.length
        ctx.emit('session/disposed', session)
        for (let i = 0; i < 200 && data.attempts.length === attempts && data.warnings.length === warnings; i++) await sleep()
        if (windows && shared && data.attempts.length === attempts) {
          data.maintenanceBoundary = 'no purge spawn; inspect cache preparation profiles and cleanup warnings'
          assert(data.profiles.length > 0, 'no real cache preparation was observed')
          assert(data.profiles.every(profile => !profile.argv.includes('--temp-write-sid')), 'private cache was prepared but purge was not observed')
          data.maintenanceBoundary = 'not applicable: shared FA cache preparation has no private temp SID; no purge registered'
        } else {
          assert(data.attempts.length > attempts, 'real OPS purge was not attempted')
          assert.match(data.attempts.at(-1).error ?? '', /unattributed subprocess|expired|live admission/)
          data.maintenanceBoundary = 'real purge spawn refused'
        }
        assert.equal(data.started.length, before, 'maintenance launched a process')
        assert.equal(sha(roFile), revision)
      })
    }
    await check(`${mode}/${shared}/PTC`, async () => {
      await ctx.plugin(PtcRuntime, {})
      const ptcSession = ctx.sessions.create('ptc', { meta: { cwd: primary, agentPreset: 'probe-ptc' } })
      const ptc = { id: 'ptc', session: ptcSession }; ptc.ctx = createScope(ctx, ptc).ctx; agents.push(ptc)
      ctx.provide('workingDirectory', { ensure: async () => primary })
      ptc.ctx.inject(['tools'], inner => inner.tools.presentAs('ptc'))
      await ctx.plugin(integration({ preset: 'probe-ptc', discovery: false, presentation: 'ptc',
        allowedTools: ['write_file'], alwaysLoaded: ['write_file'], required: true }))
      await ctx.serial('agent/created', { agent: ptc })
      for (let i = 0; i < 200 && !ctx.tools.get('ops_write_file', ptc); i++) await sleep()
      let inner
      const stop = ctx.on('tools/result', (exec, result) => {
        if (exec.agent === ptc && exec.parent !== undefined && exec.name === 'ops_write_file') inner = result
      }, { global: true })
      const startsBefore = data.started.length
      const result = await call('run_code', { code: `return await tools.ops_write_file(${JSON.stringify(operations[0][1])})`, description: 'Verify read-only root protection' }, ptc)
      stop()
      if (inner === undefined && !shared && mode !== 'danger-full-access') {
        assert(refused(result), JSON.stringify(result))
        assert.match(JSON.stringify(result), /unattributed subprocess/)
        assert.equal(data.started.length, startsBefore, 'legacy PTC must refuse before launch')
        data.ptcBoundary = 'launch-refused: no profile admission; child not reached'
      } else {
        assert(inner && refused(inner), 'real PTC child was not refused: ' + JSON.stringify(result))
        data.ptcBoundary = 'real child dispatch refused'
      }
      assert.equal(sha(roFile), revision)
    })
    {
      await check(`${mode}/${shared}/tmp-overlap`, async () => {
        const records = await ctx.multiRootRegistry.add(primary, { path: os.tmpdir(), access: 'read-only' })
        // Registry paths are canonical. macOS tmpdir() commonly uses /var,
        // while realpath and the Registry use /private/var for the same root.
        const canonicalTemp = fs.realpathSync.native(os.tmpdir())
        const temp = records.find(record => windows
          ? record.path.toLowerCase() === canonicalTemp.toLowerCase()
          : record.path === canonicalTemp)
        assert(temp, 'temporary deny root must be registered')
        try {
          const starts = data.started.length, profiles = data.profiles.length
          const preparation = snapshot(process.env.DSH_HOME)
          const result = await call('ops_read_files', { files: [{ path: roFile }] })
          assert(refused(result), JSON.stringify(result))
          assert.equal(data.started.length, starts)
          assert.equal(data.profiles.length, profiles, 'tmp overlap reached cache preparation')
          assert.deepEqual(snapshot(process.env.DSH_HOME), preparation)
          assert.equal(sha(roFile), revision)
        } finally { await ctx.multiRootRegistry.remove(primary, { kind: 'id', id: temp.id }) }
      })
      if (windows) await check(`${mode}/${shared}/background-bash`, async () => {
        const before = data.started.length, preparation = snapshot(process.env.DSH_HOME)
        const result = await call('ops_bash', { command: `echo VIOLATION > '${roFile.replaceAll('\\', '/')}'`, run_in_background: true })
        data.results.push({ name: 'ops_bash', result })
        assert(refused(result), JSON.stringify(result))
        assert.match(JSON.stringify(result), mode === 'danger-full-access' ? /run_in_background is refused/ : /OPS .*refused/)
        assert.equal(data.started.length, before, 'background Bash launched')
        assert.deepEqual(snapshot(process.env.DSH_HOME), preparation, 'background Bash prepared a payload')
        assert.equal(sha(roFile), revision)
      })
      await check(`${mode}/${shared}/authority-unavailable`, async () => {
        await registry.dispose()
        const before = data.started.length, profiles = data.profiles.length
        const preparation = snapshot(process.env.DSH_HOME)
        const business = [snapshot(primary), snapshot(ro), snapshot(rw)]
        const result = await call('ops_read_files', { files: [{ path: primaryFile }] })
        data.unavailableResult = result
        assert(refused(result), JSON.stringify(result))
        assert.match(JSON.stringify(result), /authority.*unavailable|protection.*not ready/)
        assert.equal(data.started.length, before)
        assert.equal(data.profiles.length, profiles)
        assert.deepEqual(snapshot(process.env.DSH_HOME), preparation)
        assert.deepEqual([snapshot(primary), snapshot(ro), snapshot(rw)], business)
      })
    }
    await check(`${mode}/${shared}/fence-unload`, async () => {
      stopAttempts(); await fence.dispose()
      const before = data.started.length
      assert.throws(() => ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: primary }), /unattributed subprocess/)
      assert.equal(data.started.length, before)
    })
    stopStarted()
    stopProfiles()
  } finally { await ctx.fiber.dispose() }
}
try {
  for (const shared of [false, true]) for (const mode of ['danger-full-access', 'workspace-write', 'read-only']) await world(mode, shared)
} finally {
  const output = path.join(host, dialect ? `p5-results-${dialect}.json` : 'p5-results.json')
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, passed: report.checks.filter(row => row.pass).length, failed: report.checks.filter(row => !row.pass).length }))
}
