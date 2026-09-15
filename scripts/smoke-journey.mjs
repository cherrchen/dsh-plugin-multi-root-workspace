/**
 * smoke:journey — the acceptance journey: a user registers a second Git
 * repository as an additional workspace root, and an Agent then works across
 * BOTH repositories in one session.
 *
 * What makes this an acceptance test rather than another battery:
 *
 * - the root is registered the way a user registers it, through
 *   `/workspace-folders add` executed by the real command runtime;
 * - the Agent runs REAL turns through the real loop, driven by a scripted
 *   OpenAI-compatible endpoint (`DEEPSEEK_BASE_URL`), so no credential is needed
 *   and the tool calls are the ones a user's session would get;
 * - every assertion reads the WORLD — file bytes, a `git` command re-run from
 *   outside the session, the recorded model request — rather than prose.
 *
 * Two compositions, two shapes of the same journey:
 *
 * - `web` is booted IN PROCESS with the launcher facts its app rows need, so the
 *   browser composition is assembled for real, the command is dispatched by
 *   `ctx.commands.execute`, and the panel's RPC channel is exercised over real
 *   HTTP against the bound web server (401 unauthenticated, an ok envelope
 *   authenticated) — the browser→HTTP→channel hop no other test covers;
 * - `headless` runs as a REAL `dsh --profile headless "<task>"` subprocess, with
 *   the registration pre-seeded in the registry store (the one path that process
 *   has to a registration) and its own one-shot turn.
 *
 * A host that cannot nest a kernel sandbox refuses confined `bash`; the
 * bash-dependent assertions then report an explicit skip with the reason instead
 * of passing silently (see docs/development/plugin-development-workflow.md).
 *
 * @module scripts/smoke-journey
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createChecker } from './lib/check.mjs'
import {
  assertIsolatedHome,
  loadRuntimeModule,
  pluginPackageDir,
  REPO_ROOT,
  resolveDshCliPath,
  resolveScratchHome,
  runDsh,
} from './lib/dsh-runtime.mjs'
import { bootProfile } from './lib/profile-boot.mjs'

const DOMAIN = 'multi_root_workspace'
const PLUGIN_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'
const PRIMARY_README = 'primary repository readme\n'
const SEED_README = 'seed readme for repo-b\n'
const EDITED_README = 'seed readme for repo-b\nedited by the agent through the additional root\n'
/**
 * Instruction-file markers, one per level of the discovery hierarchy.
 *
 * Each is a phrase no other part of the composition produces, so finding it in a
 * recorded model request proves WHICH file reached the model — and counting it
 * proves the plugin did not inject a second copy of something upstream already
 * supplies (the primary chain and the user-global file).
 */
const RULE_PRIMARY = 'house rule alpha: the primary repository is authoritative'
const RULE_ADDITIONAL = 'house rule bravo: the other repository uses four-space indentation'
const RULE_USER_GLOBAL = 'house rule charlie: always explain the plan first'
const RULE_ANCESTOR = 'house rule delta: this ancestor directory is not a workspace root'
/** One scripted turn: five tool calls, then the closing assistant text. */
const SCRIPT_LENGTH = 6

const home = resolveScratchHome(`journey-${process.pid}`)
const fixtureRoot = join(REPO_ROOT, '.dsh-smoke', `journey-${process.pid}`)
const primaryRepo = join(fixtureRoot, 'repo-a')
const additionalRepo = join(fixtureRoot, 'repo-b')
const outsideRoot = join(fixtureRoot, 'outside')
const keep = process.env.DSH_SMOKE_KEEP === '1'
const check = createChecker('journey')

/** The canonical spelling of a fixture path. */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Seed one Git repository with a tracked file and one commit. */
function seedRepo(path, trackedFile, content) {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, trackedFile), content)
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'smoke@example.invalid')
  git('config', 'user.name', 'Multi-root smoke')
  git('add', '.')
  git('commit', '--quiet', '-m', 'seed')
}

/**
 * One recorded model request's wire messages, flattened to role and text.
 *
 * Reading the WIRE body is the point: it is the only place that shows what the
 * model was actually told, in which role, after every row in the composition has
 * had its say.
 * @param request - one recorded request body.
 * @returns the messages, in wire order.
 */
function wireMessages(request) {
  return (request?.messages ?? []).map(message => ({
    role: message?.role,
    text: typeof message?.content === 'string'
      ? message.content
      : (Array.isArray(message?.content) ? message.content : []).map(part => part?.text ?? '').join(''),
  }))
}

/**
 * The roles of the wire messages carrying one marker.
 *
 * The length answers "how many times was this file injected" and the contents
 * answer "with what authority" — the two questions the instruction design turns
 * on: exactly once, and never as `system`.
 * @param request - one recorded request body.
 * @param marker - the phrase to look for.
 * @returns one role per carrying message.
 */
function rolesCarrying(request, marker) {
  return wireMessages(request).filter(entry => entry.text.includes(marker)).map(entry => entry.role)
}

/** Run one git command against a seeded repository and return its stdout. */
function git(path, ...args) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * One scripted turn in the chat-completions wire dialect.
 *
 * Deltas carry the whole tool call in one chunk; the smoke is scripting a model,
 * not testing the harness's stream reassembly.
 * @param call - the tool call to emit, or `undefined` to close the turn.
 * @param text - the assistant text used when closing the turn.
 * @param id - the tool call id.
 * @returns SSE frames, in order.
 */
function chatCompletionFrames(call, text, id) {
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  return [
    frame({ choices: [{ delta: { role: 'assistant', content: null } }] }),
    call === undefined
      ? frame({ choices: [{ delta: { content: text } }] })
      : frame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            }],
          },
        }],
      }),
    frame({
      choices: [{ delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
    'data: [DONE]\n\n',
  ]
}

/**
 * The same scripted turn in the block-oriented Messages wire dialect.
 *
 * This protocol has a stricter contract than chat completions, and all of it is
 * load-bearing here: every event names its `type`, the named SSE event must
 * agree with it, each content block is explicitly opened and closed, and the
 * stream must settle with a stop reason before `message_stop` or the harness
 * rejects it as malformed.
 * @param call - the tool call to emit, or `undefined` to close the turn.
 * @param text - the assistant text used when closing the turn.
 * @param id - the tool call id.
 * @returns SSE frames, in order.
 */
function messagesFrames(call, text, id) {
  const frame = payload => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  const block = call === undefined
    ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    ]
    : [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: call.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } },
      { type: 'content_block_stop', index: 0 },
    ]
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ...block,
    { type: 'message_delta', delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use' } },
    { type: 'message_stop' },
  ].map(frame)
}

/**
 * The scripted model endpoint.
 *
 * Two kinds of request arrive on it: the session-title side call (recognized by
 * its own system prompt) and the agent's own step requests. Title requests are
 * always answered with plain text and never consume the script; each STEP
 * request consumes the next tool call, and the request that starts a new cycle
 * closes the turn with plain text. Every body is recorded — that is how the
 * smoke reads what the model actually received, including the runtime-context
 * snapshot.
 *
 * It answers BOTH wire dialects the supported releases speak, selected per
 * request by path. A journey that only spoke one of them would fail on the other
 * release for a reason that has nothing to do with this plugin.
 * @returns the endpoint handle.
 */
async function startScriptedModel() {
  const requests = []
  const steps = []
  const calls = [
    { name: 'read', arguments: { file_path: join(additionalRepo, 'README.md') } },
    { name: 'write', arguments: { file_path: join(additionalRepo, 'README.md'), content: EDITED_README } },
    { name: 'bash', arguments: { command: `git -C '${additionalRepo}' diff --stat`, description: 'Show the other repository diff' } },
    { name: 'bash', arguments: { command: 'node check.mjs', description: 'Run the other repository check', workdir: additionalRepo } },
    { name: 'write', arguments: { file_path: join(outsideRoot, 'denied.txt'), content: 'must not land' } },
  ]
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = { unparsable: body.slice(0, 200) }
      }
      requests.push(parsed)
      // An agent STEP is the request that offers tools; the session-title side
      // call never does. That structural difference holds in both wire dialects,
      // unlike matching the title prompt's wording — on some releases the whole
      // session log travels with every request, so the title text appears in the
      // agent's own body too and a text match classifies everything as a title.
      const isTitle = !Array.isArray(parsed.tools) || parsed.tools.length === 0
      if (!isTitle) steps.push(parsed)
      const call = isTitle ? undefined : calls[(steps.length - 1) % SCRIPT_LENGTH]
      const text = isTitle ? 'journey' : 'journey complete'
      const id = `journey-${steps.length}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // The REQUEST PATH picks the wire dialect, because that is how the
      // harness itself distinguishes them: `/v1/messages` is the block-oriented
      // Messages protocol, anything else the chat-completions one. Answering
      // whichever the installed release asks for is what lets one journey
      // script serve the whole supported matrix (ADR-0009).
      const frames = (request.url ?? '').includes('/v1/messages')
        ? messagesFrames(call, text, id)
        : chatCompletionFrames(call, text, id)
      for (const frame of frames) response.write(frame)
      response.end()
    })
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the scripted model did not bind a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    steps,
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}

/**
 * Prepare one shipped profile on the scratch home.
 *
 * The shipped profiles are installation-owned and cannot be targets of
 * `--from-default-profile`; installing a plugin into one initializes its user
 * layer (bundles = the shipped template plus this bundle), which is exactly the
 * composition the journey must run in.
 */
async function prepareProfile(profile) {
  const added = await runDsh(['plugin', '--profile', profile, 'add', pluginPackageDir()], { DSH_HOME: home })
  check.ok(added === 0, `${profile}: plugin installed into the shipped profile`, `exit ${added}`)
}

/** Write the registry store a fresh process reads at boot. */
function seedRegistryStore(primaryRoot) {
  const storeRoot = join(home, 'storages')
  mkdirSync(storeRoot, { recursive: true })
  writeFileSync(join(storeRoot, `${DOMAIN}.json`), JSON.stringify({
    unit: { name: DOMAIN, version: 1 },
    global: null,
    tables: {
      roots: {
        [canonical(primaryRoot)]: {
          roots: [{
            id: 'journey-seed',
            path: canonical(additionalRepo),
            // The directory this registration is granted for. A record without it
            // is reported as unusable rather than granted on a guess (the plugin
            // never writes such a record itself; this seeding plays the registry).
            recordedPath: canonical(additionalRepo),
            alias: 'other-repo',
            addedAt: new Date().toISOString(),
          }],
        },
      },
    },
  }, null, 2))
}

/** Environment every leg runs the harness with. */
function legEnvironment(model) {
  return {
    ...process.env,
    DSH_PERMISSION_MODE: 'workspace-write',
    DEEPSEEK_API_KEY: 'journey-smoke-key',
    DEEPSEEK_BASE_URL: model.baseUrl,
  }
}

/**
 * The `web` leg: boot the browser composition in process, register the root
 * through the command, and drive one real turn.
 * @returns what the assertions read.
 */
async function runWebLeg() {
  const { ctx } = await bootProfile('web', home, async (hostCtx) => {
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    // The web app's rows read these launcher facts; `--port 0` keeps the smoke
    // from claiming a fixed port on the machine running it.
    provideCmdline(hostCtx, { args: ['--no-open', '--port', '0'], exit: () => {} })
  })
  const observed = { events: [] }
  try {
    // The bundle patch must carry a bare-package-name row, or the web
    // client-module scan never reads this package's `dsh.client` declaration
    // and the browser is never served `lib/client.js` — the footer action then
    // silently never registers (see docs/troubleshooting/).
    const clientModules = ctx.get('clientModules')
    observed.clientEntryServed = clientModules?.graph().entries.some(entry => entry.id === PLUGIN_NAME) === true
    const { installModelSelection } = await loadRuntimeModule('@deepseek-ai/dsh-agent')
    const selection = ctx.agentDefaultModel.currentSelection()
    const selected = { current: selection, assembled: undefined }
    // The browser composition keeps its model-facing tool rows in the agent
    // preset realm, so a session that does not join a preset resolves tools
    // against an empty layer. This mirrors what the shipped session controller
    // does for every Web session.
    const presets = ctx.get('agentPresets')
    const presetId = presets === undefined ? undefined : (await presets.resolve(undefined)).id
    const handle = await ctx.agents.create({
      sessionId: 'journey-web',
      meta: { cwd: primaryRepo, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, selected)
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
      },
    })
    const agent = handle.agent
    try {
      const registered = await ctx.commands.execute(
        agent,
        `/workspace-folders add '${additionalRepo}'`,
        [],
        new AbortController().signal,
      )
      observed.registration = registered?.result
      const dispose = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        observed.events.push(event)
      })
      try {
        const llm = await loadRuntimeModule('@deepseek-ai/dsh-llm')
        agent.followup(llm.createUserMessage({
          content: [{ type: 'text', text: 'work across both repositories' }],
          source: { kind: 'user' },
        }))
        await agent.whenIdle()
        await ctx.sessions.flush(agent.session)
      } finally {
        dispose()
      }
      observed.granted = ctx.multiRootScope.scopeOf(primaryRepo)

      // The panel's own path: real HTTP against the bound web server. An
      // unauthenticated POST must answer 401 — 405 would mean the channel
      // route never registered and the request fell through to the static
      // SPA fallback (the silent failure this probe exists to catch).
      const webServer = ctx.get('webServer')
      const base = `http://127.0.0.1:${webServer.port}/`
      const unauthenticated = await fetch(new URL('/multi-root-workspace/list', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'journey-unauth', method: 'list', payload: {} }),
      })
      observed.channelUnauthenticated = unauthenticated.status
      const authResponse = await fetch(ctx.get('connection').authenticatedUrl(base), { redirect: 'manual' })
      const cookie = authResponse.headers.get('set-cookie')?.split(';', 1)[0]
      const listed = await fetch(new URL('/multi-root-workspace/list', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'journey-list',
          method: 'list',
          payload: { sessionId: 'journey-web' },
        }),
      })
      observed.channelList = listed.status
      observed.channelView = listed.status === 200 ? (await listed.json())?.result : undefined
    } finally {
      await handle.dispose()
    }
    // The browser composition is the one that carries the panel's channel.
    observed.hasConnection = ctx.get('connection') !== undefined
    return observed
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * The `headless` leg: a real one-shot CLI process, with the registration
 * pre-seeded in the store the process reads at boot.
 * @param model - the scripted endpoint.
 * @returns the process outcome and its stdout.
 */
async function runHeadlessLeg(model) {
  const child = spawn(process.execPath, [resolveDshCliPath(), '--profile', 'headless', 'work across both repositories'], {
    cwd: primaryRepo,
    env: legEnvironment(model),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', value => { resolve(value ?? 1) })
  })
  return { code, stdout, stderr }
}

try {
  if (!existsSync(join(REPO_ROOT, 'lib', 'registry.js'))) throw new Error('lib/ is missing — run `pnpm build` before the smoke')

  rmSync(home, { recursive: true, force: true })
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  assertIsolatedHome(home)

  // Instruction files at all four levels: the primary root and the user-global
  // file are upstream's to inject, the additional root is this plugin's, and the
  // fixture's own parent is nobody's — it is an ancestor of an additional root,
  // which is the case a naive upward walk would wrongly pick up.
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(join(home, 'AGENTS.md'), `# user rules\n\n${RULE_USER_GLOBAL}\n`)
  writeFileSync(join(fixtureRoot, 'AGENTS.md'), `# ancestor rules\n\n${RULE_ANCESTOR}\n`)
  // Written before the seed commit, so `git status` stays clean: the journey's
  // strongest passthrough evidence is that the primary repository has no local
  // changes at the end, and an untracked fixture file would mask that.
  mkdirSync(primaryRepo, { recursive: true })
  writeFileSync(join(primaryRepo, 'AGENTS.md'), `# primary rules\n\n${RULE_PRIMARY}\n`)
  seedRepo(primaryRepo, 'README.md', PRIMARY_README)
  mkdirSync(additionalRepo, { recursive: true })
  writeFileSync(join(additionalRepo, 'check.mjs'), 'console.log("repo-b check ok")\n')
  writeFileSync(join(additionalRepo, 'AGENTS.md'), `# other repository rules\n\n${RULE_ADDITIONAL}\n`)
  seedRepo(additionalRepo, 'README.md', SEED_README)
  mkdirSync(outsideRoot, { recursive: true })
  writeFileSync(join(outsideRoot, 'keep.txt'), 'untouched\n')

  console.log(`[smoke:journey] scratch home: ${home}`)
  console.log(`[smoke:journey] fixture: ${fixtureRoot}`)

  const model = await startScriptedModel()
  const originalCwd = process.cwd()
  try {
    // ---- the browser composition ---------------------------------------------
    await prepareProfile('web')
    process.chdir(primaryRepo)
    Object.assign(process.env, legEnvironment(model))
    const stepsBeforeWeb = model.steps.length
    const web = await runWebLeg()

    check.equal(web.registration?.kind, 'success', 'web: /workspace-folders add succeeded', JSON.stringify(web.registration?.text))
    check.contains(String(web.registration?.text), additionalRepo, 'web: the command reports the registered root')
    check.equal(web.granted, [canonical(additionalRepo)], 'web: the scope grants exactly the registered root')
    check.ok(web.hasConnection, 'web: the browser composition carries the host Connection the panel needs')
    check.ok(web.clientEntryServed, 'web: the composed boot graph serves the plugin client bundle to the browser')
    check.equal(web.channelUnauthenticated, 401, 'web: an unauthenticated panel POST reaches the channel route (401, not the SPA fallback 405)', `status ${String(web.channelUnauthenticated)}`)
    check.equal(web.channelList, 200, 'web: the panel channel answers an authenticated list over real HTTP', `status ${String(web.channelList)}`)
    check.ok(web.channelView?.ok === true, 'web: the channel answers with an ok envelope', JSON.stringify(web.channelView)?.slice(0, 400))
    check.contains(JSON.stringify(web.channelView?.value), canonical(additionalRepo), 'web: the channel view lists the registered additional root', JSON.stringify(web.channelView)?.slice(0, 400))
    check.contains(JSON.stringify(web.channelView?.value), canonical(primaryRepo), 'web: the channel view names the primary root', JSON.stringify(web.channelView)?.slice(0, 400))
    check.equal(readFileSync(join(additionalRepo, 'README.md'), 'utf8'), EDITED_README, 'web: the additional root carries the agent\'s write')
    check.equal(readFileSync(join(primaryRepo, 'README.md'), 'utf8'), PRIMARY_README, 'web: the primary repository is byte-identical')
    check.equal(readFileSync(join(outsideRoot, 'keep.txt'), 'utf8'), 'untouched\n', 'web: a file outside every root is byte-identical')
    check.ok(!existsSync(join(outsideRoot, 'denied.txt')), 'web: the write outside every root left no file behind')
    check.contains(git(additionalRepo, 'status', '--porcelain'), ' M README.md', 'web: git reports the change in the other repository')
    check.equal(git(primaryRepo, 'status', '--porcelain'), '', 'web: the primary repository has no local changes')

    const webRequests = model.steps.slice(stepsBeforeWeb)
    // Tool results travel back to the model, so the step requests are the one
    // place every result is visible for BOTH legs (in process and subprocess).
    const webRendered = webRequests.map(request => JSON.stringify(request)).join('\n')
    const webBashUnavailable = webRendered.includes('SANDBOX_UNAVAILABLE') || webRendered.includes('no sandbox backend is usable')
    // The tool layer maps the structured FS_SANDBOX_DENIED code onto the shared
    // `[sandbox: …]` marker before the model sees it; that marker is what the
    // operator's denial text is built from.
    check.contains(webRendered, 'file access denied under workspace-write mode', 'web: the tool layer reported the outside write as a sandbox denial')
    if (webBashUnavailable) {
      check.skip('web: confined bash (git diff and the other repository\'s check) — no usable kernel runner in this process')
    } else {
      check.contains(webRendered, 'README.md |', 'web: bash saw the other repository\'s diff', webRendered.slice(-800))
      check.contains(webRendered, 'repo-b check ok', 'web: bash ran the other repository\'s check', webRendered.slice(-800))
    }
    const webExcerpt = webRendered.slice(-800)
    check.contains(webRendered, canonical(additionalRepo), 'web: the model\'s request names the additional root', webExcerpt)
    check.contains(webRendered, 'additional roots of this session\'s workspace', 'web: the runtime-context snapshot states the topology', webExcerpt)
    check.contains(webRendered, 'the session cwd remains the primary root', 'web: the snapshot states that the cwd is unchanged', webExcerpt)
    check.ok(webRequests.length >= SCRIPT_LENGTH, 'web: the agent issued one request per scripted step', `requests: ${webRequests.length}`)

    // The instruction journey, read off the first step's wire body: the Agent
    // sees all three repositories' rules before it touches anything, each
    // exactly once, and none of them with system authority.
    const webFirstStep = webRequests[0]
    const webWire = JSON.stringify(wireMessages(webFirstStep)).slice(0, 600)
    check.equal(rolesCarrying(webFirstStep, RULE_ADDITIONAL), ['user'], 'web: the additional root\'s AGENTS.md reached the model once, in the user role', webWire)
    check.equal(rolesCarrying(webFirstStep, RULE_PRIMARY).length, 1, 'web: the primary root\'s AGENTS.md reached the model exactly once', webWire)
    check.equal(rolesCarrying(webFirstStep, RULE_USER_GLOBAL).length, 1, 'web: the user-global AGENTS.md was not injected a second time', webWire)
    check.equal(rolesCarrying(webFirstStep, RULE_ANCESTOR).length, 0, 'web: an ancestor of the additional root was not injected at all', webWire)
    check.contains(JSON.stringify(webFirstStep), canonical(additionalRepo), 'web: the instruction text names the root its rules belong to')

    // ---- the one-shot composition --------------------------------------------
    await prepareProfile('headless')
    seedRegistryStore(primaryRepo)
    const stepsBeforeHeadless = model.steps.length
    // Reset the fixtures so the headless leg proves the same facts on its own.
    writeFileSync(join(additionalRepo, 'README.md'), SEED_README)
    execFileSync('git', ['-C', additionalRepo, 'checkout', '--', 'README.md'], { stdio: 'pipe' })

    const headless = await runHeadlessLeg(model)
    check.equal(headless.code, 0, 'headless: the one-shot task completed', headless.stderr.slice(-400))
    check.contains(headless.stdout, 'journey complete', 'headless: the run printed the final assistant message')
    check.equal(readFileSync(join(additionalRepo, 'README.md'), 'utf8'), EDITED_README, 'headless: the additional root carries the agent\'s write')
    check.equal(readFileSync(join(primaryRepo, 'README.md'), 'utf8'), PRIMARY_README, 'headless: the primary repository is byte-identical')
    check.ok(!existsSync(join(outsideRoot, 'denied.txt')), 'headless: the write outside every root left no file behind')
    check.contains(git(additionalRepo, 'status', '--porcelain'), ' M README.md', 'headless: git reports the change in the other repository')

    const headlessResults = model.steps.slice(stepsBeforeHeadless).map(request => JSON.stringify(request)).join('\n')
    if (headlessResults.includes('SANDBOX_UNAVAILABLE') || headlessResults.includes('no sandbox backend is usable')) {
      check.skip('headless: confined bash — no usable kernel runner in this process')
    } else {
      check.contains(headlessResults, 'repo-b check ok', 'headless: bash ran the other repository\'s check', headlessResults.slice(-800))
    }

    const headlessRequests = model.steps.slice(stepsBeforeHeadless)
    const headlessRendered = headlessRequests.map(request => JSON.stringify(request)).join('\n')
    const headlessExcerpt = headlessRendered.slice(-800)
    check.contains(headlessRendered, canonical(additionalRepo), 'headless: the model\'s request names the additional root', headlessExcerpt)
    check.contains(headlessRendered, 'additional roots of this session\'s workspace', 'headless: the runtime-context snapshot states the topology', headlessExcerpt)

    const headlessFirstStep = headlessRequests[0]
    const headlessWire = JSON.stringify(wireMessages(headlessFirstStep)).slice(0, 600)
    check.equal(rolesCarrying(headlessFirstStep, RULE_ADDITIONAL), ['user'], 'headless: the additional root\'s AGENTS.md reached the model once, in the user role', headlessWire)
    check.equal(rolesCarrying(headlessFirstStep, RULE_PRIMARY).length, 1, 'headless: the primary root\'s AGENTS.md reached the model exactly once', headlessWire)
    check.equal(rolesCarrying(headlessFirstStep, RULE_USER_GLOBAL).length, 1, 'headless: the user-global AGENTS.md was not injected a second time', headlessWire)
    check.equal(rolesCarrying(headlessFirstStep, RULE_ANCESTOR).length, 0, 'headless: an ancestor of the additional root was not injected at all', headlessWire)
  } finally {
    process.chdir(originalCwd)
    delete process.env.DSH_PERMISSION_MODE
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_BASE_URL
    // Under DSH_SMOKE_KEEP the recorded bodies are kept beside the fixture: when
    // an assertion about what the model was told fails, the body is the evidence,
    // and it is far too large to print.
    if (keep) writeFileSync(join(fixtureRoot, 'model-requests.json'), JSON.stringify(model.requests, null, 2))
    await model.close()
  }

  check.finish()
} finally {
  if (keep) {
    console.log(`[smoke:journey] kept scratch home at ${home} and fixture at ${fixtureRoot}`)
  } else {
    rmSync(home, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
