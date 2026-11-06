/** macOS Phase-A live acceptance: real AgentLoop, OPS Worker and next model request.
 * node --experimental-transform-types scripts/verify-ops-activity.mjs <isolated-host> <new-output.json>
 * Host requirements match verify-ops-protection.mjs; raw evidence stays local.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'darwin', 'this live AgentLoop probe validates macOS only')
const [hostArgument, outputArgument] = process.argv.slice(2)
assert(hostArgument && outputArgument, 'usage: verify-ops-activity.mjs <isolated-host> <new-output.json>')
const host = resolve(hostArgument)
const destination = resolve(outputArgument)
const repo = fileURLToPath(new URL('..', import.meta.url))
assert.notEqual(realpathSync(host), realpathSync(repo), 'use an isolated host')
mkdirSync(join(host, 'multi-root'), { recursive: true })
cpSync(join(repo, 'src'), join(host, 'multi-root', 'src'), { recursive: true })
copyFileSync(join(repo, 'package.json'), join(host, 'multi-root', 'package.json'))
process.env.DSH_HOME = join(host, 'activity-home')
mkdirSync(process.env.DSH_HOME, { recursive: true })
const requireHost = createRequire(join(host, 'ops-current', 'package.json'))
const load = name => import(pathToFileURL(requireHost.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Agents } = await load('@deepseek-ai/dsh-agent')
const { default: Sessions } = await load('@deepseek-ai/dsh-session')
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
const { default: Prompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Loop } = await load('@deepseek-ai/dsh-agent-loop')
const { default: Policy } = await load('@deepseek-ai/dsh-sandbox-policy')
const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
const { default: Llm, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { default: Storage } = await load('@deepseek-ai/dsh-storage')
const { DomainFacility } = await load('@deepseek-ai/dsh-storage-domain')
const Json = await load('@deepseek-ai/dsh-storage-json')
const { integration } = await load('dsh-ops/integration')
const own = file => import(pathToFileURL(join(host, 'multi-root', 'src', file)).href)
const { default: Scope } = await own('scope.ts')
const Compat = await own('compat.ts')
const { default: MRFS } = await own('fs.ts')
const { default: Sandbox } = await own('sandbox.ts')
const { default: Providers } = await own('providers.ts')
const { default: Registry } = await own('registry.ts')
const Fence = await own('process-fence.ts')
const Instructions = await own('instructions.ts')
const { default: OpsMode } = await own('ops-compatibility.ts')
const { wrapMethod } = await own('method-wrapper.ts')
const base = mkdtempSync(join(tmpdir(), 'ops-agent-loop-'))
const primary = join(base, 'primary')
const additional = join(base, 'additional')
const store = join(base, 'store')
for (const directory of [primary, store, additional, join(additional, 'a'), join(additional, 'a', 'deep'), join(additional, 'b'), join(additional, 'failed')]) mkdirSync(directory, { recursive: true })
const sentinels = { root: 'OPS_E2E_ROOT_RULE', a: 'OPS_E2E_A_RULE', deep: 'OPS_E2E_DEEP_RULE', b: 'OPS_E2E_B_RULE', failed: 'OPS_E2E_FAILED_RULE' }
for (const [directory, text] of [[additional, sentinels.root], [join(additional, 'a'), sentinels.a], [join(additional, 'a', 'deep'), sentinels.deep], [join(additional, 'b'), sentinels.b], [join(additional, 'failed'), sentinels.failed]]) writeFileSync(join(directory, 'AGENTS.md'), text)
const a = join(additional, 'a', 'deep', 'first.txt')
const b = join(additional, 'b', 'second.txt')
const absent = join(additional, 'failed', 'absent.txt')
writeFileSync(a, 'first actual OPS read\n')
writeFileSync(b, 'second actual OPS read\n')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const output = { host, base, node: process.version, platform: process.platform, arch: process.arch,
  repoCommit: git(repo, 'rev-parse', 'HEAD'),
  opsCommit: git(join(host, 'ops-current'), 'rev-parse', 'HEAD'),
  opsWorkingTree: git(join(host, 'ops-current'), 'status', '--short'),
  workerSha256: process.env.DSH_OPS_WORKER_BIN ? sha(process.env.DSH_OPS_WORKER_BIN) : undefined,
  cordis: requireHost('@deepseek-ai/cordis/package.json').version,
  dsh: requireHost('@deepseek-ai/dsh/package.json').version,
  ops: requireHost('dsh-ops/package.json').version,
  sourceSha256: Object.fromEntries(['instructions.ts', 'compat/instruction-activity.ts', 'process-fence.ts', 'scope.ts']
    .map(file => [file, sha(join(repo, 'src', file))])), requests: [], results: [], checks: [], errors: [], spawns: [] }
const ctx = new Context()
ctx.logger.level = 0
let scripts = []
try {
  for (const plugin of [Projections, Sessions, Agents, Prompt, Tools]) await ctx.plugin(plugin, {})
  await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: primary })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Llm)
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root: store })
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(Scope, {})
  ctx.provide('settings', { configure: () => () => {} })
  await ctx.plugin(OpsMode, { enabled: true })
  await ctx.plugin(Compat)
  await ctx.plugin(MRFS, { cwd: primary })
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(Providers)
  assert(ctx.get('multiRootOpsCompatibility')?.token, 'OPS mode must be explicitly active')
  output.opsModeEnabled = true
  await ctx.plugin(Registry, { leasePath: join(store, 'multi_root_workspace.lock'), sharedStorageRoot: store })
  const subprocess = ctx.get('subprocess')
  ctx.effect(() => wrapMethod(subprocess, 'spawn', original => function(spec) {
    output.spawns.push({ argv: spec.argv, cwd: spec.cwd })
    return original.call(this, spec)
  }))
  await ctx.plugin(Fence)
  await ctx.plugin(Instructions, {})
  await ctx.multiRootRegistry.add(primary, { path: additional, access: 'read-only' })
  class ScriptedAdapter extends LlmAdapter {
    async *stream(request) {
      output.requests.push(JSON.parse(JSON.stringify({ sessionId: request.sessionId, tools: request.tools, messages: request.messages })))
      assert(scripts.length, 'unexpected model request')
      const calls = scripts.shift()
      for (const [index, call] of calls.entries()) yield { type: 'tool-call-delta', index, id: `e2e-${output.requests.length}-${index}`, name: call.name, argumentsDelta: JSON.stringify(call.args) }
      if (!calls.length) yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['ops-e2e'], new ScriptedAdapter())
  ctx.on('tools/result', (exec, result) => output.results.push({ sessionId: exec.agent?.session.id, name: exec.name, nested: exec.parent !== undefined, result }), { global: true })
  ctx.on('agent/error', ({ error }) => output.errors.push({ message: String(error), stack: error?.stack }))
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 3 })
  await ctx.plugin(integration({ preset: 'ops-e2e-native', discovery: false, residentNames: ['inspect_local_file', 'read_files'], required: true }))
  const run = async (id, tool, args, ptc = false) => {
    const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: primary, agentPreset: ptc ? 'ops-e2e-ptc' : 'ops-e2e-native' }, agentOptions: { provider: 'ops-e2e', model: 'scripted' } })
    if (ptc) agent.ctx.inject(['tools'], scoped => scoped.tools.presentAs('ptc'))
    const before = output.requests.length
    scripts = [[{ name: tool, args }], []]
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read only the isolated fixture files using the requested tool.' }] }))
    await agent.whenIdle()
    assert.equal(scripts.length, 0, 'the scripted turn did not finish')
    const requests = output.requests.slice(before)
    assert.equal(requests.length, 2, 'expected a tool request and its next real model request')
    const text = JSON.stringify(requests[1].messages)
    const records = output.results.filter(result => result.sessionId === agent.session.id)
    return { agent, text, records, requests: [before, before + 1] }
  }
  const first = await run('ops-e2e-inspect', 'ops_inspect_local_file', { path: a })
  const firstValue = first.records.find(result => result.name === 'ops_inspect_local_file')?.result.value
  assert.equal(firstValue?.status, 'completed')
  for (const name of ['root', 'a', 'deep']) assert(first.text.includes(sentinels[name]), `inspect missed ${name}`)
  assert(!first.text.includes(sentinels.b), 'inspect manufactured activity in b')
  output.checks.push({ name: 'native-inspect-next-model-request', pass: true, requests: first.requests })
  const partial = await run('ops-e2e-partial', 'ops_read_files', { files: [{ path: a }, { path: absent }, { path: b }] })
  const partialValue = partial.records.find(result => result.name === 'ops_read_files')?.result.value
  assert.equal(partialValue?.items?.[0]?.status, 'completed')
  assert.equal(partialValue?.items?.[1]?.status, 'error')
  assert.equal(partialValue?.items?.[2]?.status, 'completed')
  for (const name of ['root', 'a', 'deep', 'b']) assert(partial.text.includes(sentinels[name]), `partial read missed ${name}`)
  assert(!partial.text.includes(sentinels.failed), 'a failed read manufactured nested instructions')
  output.checks.push({ name: 'native-partial-multiple-targets-next-model-request', pass: true, requests: partial.requests })
  const { default: PtcRuntime } = await load('@deepseek-ai/dsh-ptc-runtime-node')
  await ctx.plugin(PtcRuntime, {})
  try {
    const { default: WorkingDirectory } = await load('@deepseek-ai/dsh-working-directory')
    await ctx.plugin(WorkingDirectory)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    output.workingDirectory = 'ABSENT: the 0.2.0 runtime uses its native cwd fallback; no substitute service was installed'
  }
  await ctx.plugin(integration({ preset: 'ops-e2e-ptc', presentation: 'ptc', discovery: false, allowedTools: ['read_files'], alwaysLoaded: ['read_files'], required: true }))
  const ptc = await run('ops-e2e-ptc', 'run_code', { description: 'Read two isolated additional-root fixtures', code: `return await tools.ops_read_files({files:[{path:${JSON.stringify(a)}},{path:${JSON.stringify(b)}}]})` }, true)
  const ptcValue = ptc.records.find(result => result.nested && result.name === 'ops_read_files')?.result.value
  assert.equal(ptcValue?.status, 'completed')
  for (const name of ['root', 'a', 'deep', 'b']) assert(ptc.text.includes(sentinels[name]), `PTC read missed ${name}`)
  assert(!ptc.text.includes(sentinels.failed))
  output.checks.push({ name: 'real-ptc-subdispatch-next-model-request', pass: true, requests: ptc.requests })
  assert.equal(output.errors.length, 0, JSON.stringify(output.errors))
  assert(output.spawns.length > 0)
  assert(output.spawns.every(spawn => spawn.argv[0] === 'sandbox-exec' && spawn.argv[1] === '-p' && spawn.argv[2].includes('(deny file-write*')), 'an AgentLoop process was not confined')
} catch (error) {
  output.errors.push({ message: error.message, stack: error.stack })
  process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  writeFileSync(destination, JSON.stringify(output, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ destination, checks: output.checks, errors: output.errors }, null, 2))
}
