/** One real, isolated web/headless composition. Invoked in its own OS process. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootProfile } from './profile-boot.mjs'
import { loadRuntimeModule, REPO_ROOT } from './dsh-runtime.mjs'
import { baselineRuntime, sha256 } from './baseline-identity.mjs'
import { chatCompletionFrames, messagesFrames } from './scripted-model-frames.mjs'
import { runForeground } from './shell-exec.mjs'

baselineRuntime(REPO_ROOT, process.env.DSH_CLI)
const [home, profile, patchFlag, output, roots = 'none', provider = 'existing'] = process.argv.slice(2)
const applyPatch = patchFlag === 'true'
const fixture = mkdtempSync(join(REPO_ROOT, '.dsh-smoke', 'g0-profile-'))
const primary = join(fixture, 'primary'); const outside = join(fixture, 'outside')
mkdirSync(primary); mkdirSync(outside)
const extra = join(fixture, 'extra'); mkdirSync(extra)
const evidence = { profile, applyPatch, roots, provider, operations: [], cancellation: {}, status: 'running' }
const save = () => writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)
const normalize = value => JSON.stringify(value).split(fixture).join('<fixture>').split(home).join('<home>')
const started = Promise.withResolvers()
const booted = Promise.withResolvers()
let bodyStopped = false
let ctx, handle, agentContext, agent
let steps = 0
function registerWait(scope) {
  scope.tools.register({ name: 'g0_wait', description: 'Wait for cancellation in the isolated G0 fixture.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', properties: { stopped: { type: 'boolean' } } }, render: () => [{ type: 'text', text: 'stopped' }] },
        execute: async (_args, exec) => {
          await booted.promise
          if (profile === 'headless') { agent = exec.agent; agentContext = agent.ctx }
          evidence.cancellation = { actualAgent: ctx.agents.get(exec.agent.id) === exec.agent, actualSession: ctx.sessions.get(exec.agent.session.id) === exec.agent.session,
            name: exec.name, callId: exec.callId, signalPresent: exec.signal !== undefined }
          started.resolve()
          await new Promise(resolve => {
            const stop = () => { bodyStopped = true; resolve() }
            if (exec.signal.aborted) stop(); else exec.signal.addEventListener('abort', stop, { once: true })
          })
          return { stopped: true }
        },
      })
}
const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8'); request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    try {
      const data = JSON.parse(body)
      const isStep = Array.isArray(data.tools) && data.tools.length > 0
      if (isStep) {
        steps++
        evidence.wireTools = data.tools.map(tool => tool.function?.name ?? tool.name).sort()
        evidence.prompt = JSON.parse(normalize({ system: data.system, messages: data.messages }))
        // Web's shipped time-context is intentionally sampled per turn. Keep
        // the raw normalized prompt; compare the same message/role with only
        // its clock reading, duration and ephemeral web port replaced.
        evidence.promptSha256 = sha256(JSON.stringify(evidence.prompt, (_key, value) => typeof value === 'string'
          ? value.replace(/(Time sampled while preparing turn \d+, step \d+: )[^\r\n]+/u, '$1<clock>')
            .replace(/(Elapsed since the preceding (?:model-visible message|step context): )[^\r\n]+/u, '$1<duration>')
            .replace(/(Web GUI URL: "http:\/\/127\.0\.0\.1:)\d+/u, '$1<port>')
            .replace(/(Web GUI at http:\/\/127\.0\.0\.1:)\d+/u, '$1<port>')
          : value))
      }
      const call = isStep && steps === 1 ? { name: 'g0_wait', arguments: {} } : undefined
      const frames = (request.url ?? '').includes('/v1/messages') ? messagesFrames : chatCompletionFrames
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frames(call, 'G0 complete', `g0-${steps}`).join(''))
    } catch (error) { response.writeHead(500); response.end(error.message) }
  })
})

// The child has a hard deadline even if a broken cancel/teardown never settles.
const deadline = setTimeout(() => { evidence.status = 'failed'; evidence.failure = 'G0_PROFILE_TIMEOUT'; save(); process.exit(1) }, 90_000)
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, { DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'g0-local-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` })
  process.chdir(primary)
  ;({ ctx } = await bootProfile(profile, home, async hostCtx => {
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    provideCmdline(hostCtx, { args: profile === 'headless' ? ['Run g0_wait until cancelled.'] : ['--no-open', '--port', '0'], exit: () => {} })
    if (profile === 'headless') hostCtx.inject(['tools'], scope => { registerWait(scope) })
    if (roots === 'local') hostCtx.on('agent/created', async () => {
      await hostCtx.get('multiRootRegistry').add(primary, { path: extra })
    }, { global: true })
  }))
  booted.resolve()
  if (profile === 'headless') {
    evidence.driver = 'native-headless'
    await started.promise
  } else {
  evidence.driver = 'web-agent-factory'
  const { installModelSelection } = await loadRuntimeModule('@deepseek-ai/dsh-agent')
  const selection = ctx.agentDefaultModel.currentSelection()
  const presets = ctx.get('agentPresets')
  const presetId = presets === undefined ? undefined : (await presets.resolve(undefined)).id
  handle = await ctx.agents.create({
    sessionId: `g0-${profile}-patch-${applyPatch}-${roots}`, meta: { cwd: primary, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async scope => {
      agentContext = scope
      installModelSelection(scope, { current: selection, assembled: undefined })
      if (presets !== undefined && presetId !== undefined) await presets.mount(scope, presetId)
      registerWait(scope)
    },
  })
  agent = handle.agent
  }
  evidence.tools = ctx.tools.schemas(agent).filter(tool => tool.name !== 'g0_wait').sort((a, b) => a.name.localeCompare(b.name))
  evidence.services = Object.fromEntries(['fs', 'sandbox', 'shell', 'tools', 'sessions', 'permissionPresets'].map(name => [name, ctx.get(name) !== undefined]))
  if (provider === 'facade') {
    const sameName = join(primary, 'same-name.txt')
    writeFileSync(sameName, 'local sentinel')
    const uri = 'remote://g1-unknown/root/same-name.txt'
    const remoteError = { code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' }
    await assert.rejects(ctx.fs.resolve(uri), remoteError)
    await assert.rejects(ctx.fs.readText({ targetKey: uri, displayPath: sameName }), remoteError)
    assert.equal(readFileSync(sameName, 'utf8'), 'local sentinel')
    evidence.remoteRefused = true
  }
  const hasPatch = evidence.tools.some(tool => tool.name === 'apply_patch')
  evidence.fsMethods = Object.fromEntries(['patchText', 'deleteFile', 'moveFile'].map(name => [name, typeof ctx.fs[name] === 'function']))
  assert.equal(hasPatch, applyPatch && evidence.fsMethods.patchText, 'actual apply_patch registration must follow backend capability and config')
  const { executeTool } = await import('../../tests/support/tool-executor.ts')
  let calls = 0
  const invoke = async (name, args, denied = false) => {
    const result = await executeTool(agentContext, { callId: `g0-${++calls}`, name, args, agent, signal: new AbortController().signal })
    const entry = { name, args: JSON.parse(normalize(args)), result: JSON.parse(normalize(result)) }
    evidence.operations.push(entry); save()
    assert.equal(result.isError, denied, `${name}: ${JSON.stringify(result)}`)
    return result
  }
  const inside = join(primary, 'tool.txt'); const denied = join(outside, 'denied.txt')
  await invoke('write', { file_path: inside, content: 'before\n' })
  await invoke('read', { file_path: inside })
  await invoke('edit', { file_path: inside, old_string: 'before', new_string: 'after' })
  assert.equal(readFileSync(inside, 'utf8'), 'after\n')
  await invoke('write', { file_path: denied, content: 'must-not-land' }, true)
  assert.equal(existsSync(denied), false)

  const created = join(primary, 'created.txt'); const edited = join(primary, 'patch.txt'); const deleted = join(primary, 'delete.txt')
  const source = join(primary, 'source.txt'); const moved = join(primary, 'moved.txt')
  for (const file of [edited, deleted, source]) {
    writeFileSync(file, 'before\n'); await invoke('read', { file_path: file })
  }
  const patch = ['*** Begin Patch', `*** Add File: ${created}`, '+created', `*** Update File: ${edited}`, '@@', '-before', '+patched',
    `*** Delete File: ${deleted}`, `*** Update File: ${source}`, `*** Move to: ${moved}`, '@@', '-before', '+moved', '*** End Patch'].join('\n')
  await invoke('apply_patch', { input: patch }, !hasPatch)
  assert.equal(existsSync(created), hasPatch)
  assert.equal(readFileSync(edited, 'utf8'), hasPatch ? 'patched\n' : 'before\n')
  assert.equal(existsSync(deleted), !hasPatch); assert.equal(existsSync(source), !hasPatch); assert.equal(existsSync(moved), hasPatch)
  if (hasPatch) {
    assert.equal(readFileSync(created, 'utf8'), 'created\n')
    assert.equal(readFileSync(moved, 'utf8'), 'moved\n')
    await invoke('apply_patch', { input: ['*** Begin Patch', `*** Add File: ${denied}`, '+must-not-land', '*** End Patch'].join('\n') }, true)
    assert.equal(existsSync(denied), false)
  }

  const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
  const raw = join(primary, 'raw.txt')
  await ctx.fs.writeText(await ctx.fs.resolve(raw), 'raw-before', undefined, undefined, policy)
  await ctx.fs.editText(await ctx.fs.resolve(raw), { oldString: 'before', newString: 'after', replaceAll: false }, undefined, undefined, policy)
  assert.equal(readFileSync(raw, 'utf8'), 'raw-after')
  await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(denied), 'bad', undefined, undefined, policy), { code: 'FS_SANDBOX_DENIED' })
  evidence.rawFs = { contentSha256: sha256(readFileSync(raw)), outsideDenied: !existsSync(denied) }
  if (roots !== 'none') {
    const projection = scope => ({ ...scope, roots: scope.roots.map((root, index) => ({ ...root, id: `registered-${index}` })) })
    const scopes = { display: projection(ctx.multiRootScope.snapshot(policy)),
      withoutAdmission: projection(ctx.multiRootScope.resolve(policy)) }
    const expectedRoots = roots === 'local' ? 1 : 0
    assert.equal(scopes.display.additionalRoots.length, expectedRoots)
    assert.equal(scopes.withoutAdmission.additionalRoots.length, 0)
    const command = [process.execPath, '-e', 'process.exit(0)']
    let shape
    const confined = await ctx.multiRootRegistry.withOperation(policy, 'process', () => {
      scopes.admitted = projection(ctx.multiRootScope.resolve(policy))
      assert.equal(scopes.admitted.additionalRoots.length, expectedRoots)
      const value = ctx.sandbox.confine(command, policy)
      shape = typeof value?.then === 'function' ? 'promise' : 'sync'
      return value
    })
    evidence.scope = JSON.parse(normalize(scopes))
    evidence.confinement = JSON.parse(normalize({ argv: confined.argv, enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures, runnerFailureRules: confined.runnerFailureRules, shape }))
    const additionalFile = join(extra, 'additional.txt')
    if (roots === 'local') {
      await invoke('write', { file_path: additionalFile, content: 'additional' })
      assert.equal(readFileSync(additionalFile, 'utf8'), 'additional')
    } else {
      await invoke('write', { file_path: additionalFile, content: 'must-not-land' }, true)
      assert.equal(existsSync(additionalFile), false)
    }
    evidence.additional = { exists: existsSync(additionalFile), sha256: existsSync(additionalFile) ? sha256(readFileSync(additionalFile)) : null }
  }
  const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const shellWrite = async path => {
    const program = `require('node:fs').writeFileSync(${JSON.stringify(path)},'g0-shell')`
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(program)}`
    const spec = ctx.shell.resolve({ command, workdir: primary, sandboxPolicy: policy })
    const result = await runForeground(ctx.shell, spec)
    return { command: JSON.parse(normalize(command)), exitCode: result.exitCode, sandbox: result.sandbox ?? null,
      exists: existsSync(path), sha256: existsSync(path) ? sha256(readFileSync(path)) : null }
  }
  evidence.shell = { primary: await shellWrite(join(primary, 'shell.txt')), outside: await shellWrite(join(outside, 'shell.txt')) }
  assert.equal(evidence.shell.primary.exitCode, 0); assert.equal(evidence.shell.primary.exists, true)
  assert.notEqual(evidence.shell.outside.exitCode, 0); assert.equal(evidence.shell.outside.exists, false)
  if (roots === 'local') {
    evidence.additional.shell = await shellWrite(join(extra, 'shell.txt'))
    assert.equal(evidence.additional.shell.exitCode, 0); assert.equal(evidence.additional.shell.exists, true)
  }

  const { createUserMessage } = await loadRuntimeModule('@deepseek-ai/dsh-llm')
  if (profile !== 'headless') agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run g0_wait until cancelled.' }], source: { kind: 'user' } }))
  // A failed turn should fail immediately, rather than wait for the hard deadline.
  await Promise.race([started.promise, agent.whenIdle().then(() => { throw new Error('G0 wait tool did not enter a real turn') })])
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  assert.equal(bodyStopped, true); assert.equal(evidence.cancellation.actualAgent, true); assert.equal(evidence.cancellation.actualSession, true)
  assert.ok(evidence.wireTools.includes('g0_wait'))
  assert.equal(evidence.wireTools.includes('apply_patch'), hasPatch)
  evidence.cancellation.stopped = bodyStopped
  evidence.cancellation.turnClosed = agent.session.snapshotEvents().some(event => event.type === 'turn/end')
  assert.equal(evidence.cancellation.turnClosed, true)
  evidence.sentinels = Object.fromEntries(['tool.txt', 'created.txt', 'patch.txt', 'delete.txt', 'source.txt', 'moved.txt', 'raw.txt', 'shell.txt'].map(name => [name,
    existsSync(join(primary, name)) ? sha256(readFileSync(join(primary, name))) : null]))
  evidence.status = 'passed'
} catch (error) { evidence.status = 'failed'; evidence.failure = error.stack; process.exitCode = 1 }
finally {
  save()
  try { await handle?.dispose(); await ctx?.fiber.dispose() } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    process.chdir(REPO_ROOT); rmSync(fixture, { recursive: true, force: true }); clearTimeout(deadline)
  }
}
