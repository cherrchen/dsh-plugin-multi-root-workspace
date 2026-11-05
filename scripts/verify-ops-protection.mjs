/** macOS OPS P5 regression on an isolated, peer-compatible host.
 * node --experimental-transform-types scripts/verify-ops-protection.mjs <hostDir>
 * hostDir contains node_modules and an unchanged ops-current checkout with lib/
 * and a staged native Worker. The current MR source is copied into that host.
 * Results and fixtures stay in hostDir; nothing writes a real user profile.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', 'this probe validates macOS only')
const host = path.resolve(process.argv[2] ?? '')
assert(process.argv[2], 'usage: verify-ops-protection.mjs <isolated-host-dir>')
const repo = fileURLToPath(new URL('..', import.meta.url))
assert.notEqual(fs.realpathSync(host), fs.realpathSync(repo), 'use a separate host')
const source = path.join(host, 'multi-root')
fs.mkdirSync(source, { recursive: true })
fs.cpSync(path.join(repo, 'src'), path.join(source, 'src'), { recursive: true })
fs.copyFileSync(path.join(repo, 'package.json'), path.join(source, 'package.json'))
const requireHost = createRequire(path.join(host, 'package.json'))
const pkg = name => import(requireHost.resolve(name))
const mr = file => import(path.join(source, 'src', file + '.ts'))
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
const { integration } = await import(createRequire(path.join(host, 'ops-current', 'package.json')).resolve('dsh-ops/integration'))
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = () => new Promise(resolve => setTimeout(resolve, 20))
const report = { os: os.release(), node: process.version, arch: process.arch,
  dsh: requireHost('@deepseek-ai/dsh/package.json').version,
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
async function world(mode, shared) {
  const base = fs.mkdtempSync(path.join(host, 'fixture-'))
  const primary = path.join(base, 'primary'), ro = path.join(base, 'ro'), rw = path.join(base, 'rw'), store = path.join(base, 'store')
  for (const dir of [primary, ro, rw, store]) fs.mkdirSync(dir)
  const roFile = path.join(ro, 'file.txt'), primaryFile = path.join(primary, 'file.txt')
  fs.writeFileSync(roFile, 'readonly original\n'); fs.writeFileSync(primaryFile, 'primary original\n')
  fs.symlinkSync(ro, path.join(primary, 'alias-ro'))
  const ctx = new Context(); ctx.logger.level = 0
  const data = { mode, shared, started: [], attempts: [], base }
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
    await ctx.plugin(Scope, {})
    ctx.provide('settings', { installSection(_owner, ns, _schema, _initial, hooks) {
      if (ns === 'multi-root-ops-compatibility') hooks.setSource(() => ({ enabled: true }))
    } })
    await ctx.plugin(OpsMode, { enabled: true }); await ctx.plugin(Compat)
    assert(ctx.get('multiRootCompat'), 'compatible tree required')
    await ctx.plugin(MRFS, { cwd: primary }); await ctx.plugin(Sandbox, {}); await ctx.plugin(Providers)
    await ctx.plugin(Registry, { leasePath: path.join(store, 'multi_root_workspace.lock'), ...(shared ? { sharedStorageRoot: store } : {}) })
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
    await ctx.multiRootRegistry.add(primary, { path: ro, access: 'read-only' })
    await ctx.multiRootRegistry.add(primary, { path: rw, access: 'read-write' })
    await ctx.plugin(integration({ preset: 'probe-native', discovery: false, required: true, replaceOfficial: false,
      residentNames: ['inspect_local_file', 'read_files', 'write_file', 'edit_file', 'replace', 'copy', 'move', 'remove', 'stat', 'result'] }))
    for (let i = 0; i < 200 && !ctx.tools.get('ops_write_file', agent); i++) await sleep()
    assert(ctx.tools.get('ops_write_file', agent), 'OPS tools must be published')
    let callId = 0
    const call = (name, args, caller = agent) => ctx.tools.execute({ agent: caller, callId: 'probe-' + ++callId, name, arguments: args, signal: new AbortController().signal })
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
      const result = await call(name, args)
      assert(refused(result), JSON.stringify(result))
      assert.equal(sha(roFile), revision); assert.deepEqual(fs.readdirSync(ro), ['file.txt'])
      assert.equal(fs.readFileSync(primaryFile, 'utf8'), 'primary original\n', 'failed move removed source')
      if (mode !== 'danger-full-access') assert.equal(data.started.length, before, 'early refusal launched a Worker')
    })
    await check(`${mode}/${shared}/read`, async () => {
      const result = await call('ops_read_files', { files: [{ path: roFile }] })
      assert(mode === 'danger-full-access' ? completed(result) : refused(result), JSON.stringify(result))
    })
    if (mode === 'danger-full-access') {
      await check(`${mode}/${shared}/legal-primary-write`, async () => {
        const result = await call('ops_write_file', { path: primaryFile, content: 'primary ok\n', expectedRevision: sha(primaryFile) })
        assert(completed(result), JSON.stringify(result)); assert.equal(fs.readFileSync(primaryFile, 'utf8'), 'primary ok\n')
      })
      await check(`${mode}/${shared}/maintenance`, async () => {
        const before = data.started.length, attempts = data.attempts.length
        ctx.emit('session/disposed', session)
        for (let i = 0; i < 200 && data.attempts.length === attempts; i++) await sleep()
        assert(data.attempts.length > attempts, 'real OPS purge was not attempted')
        assert.match(data.attempts.at(-1).error ?? '', /unattributed subprocess|expired|live admission/)
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
        data.ptcBoundary = 'launch-refused: no legacy profile admission; child not reached'
      } else {
        assert(inner && refused(inner), 'real PTC child was not refused: ' + JSON.stringify(result))
        data.ptcBoundary = 'real child dispatch refused'
      }
      assert.equal(sha(roFile), revision)
    })
    await check(`${mode}/${shared}/fence-unload`, async () => {
      stopAttempts(); await fence.dispose()
      const before = data.started.length
      assert.throws(() => ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', 'exit 0'], cwd: primary }), /unattributed subprocess/)
      assert.equal(data.started.length, before)
    })
    stopStarted()
  } finally { await ctx.fiber.dispose() }
}
try {
  for (const shared of [false, true]) for (const mode of ['danger-full-access', 'workspace-write', 'read-only']) await world(mode, shared)
} finally {
  const output = path.join(host, 'p5-results.json')
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, passed: report.checks.filter(row => row.pass).length, failed: report.checks.filter(row => !row.pass).length }))
}
