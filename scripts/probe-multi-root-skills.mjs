/** ADR-0023 feasibility probe. No production registrations or upstream edits.
 * Run: node --experimental-transform-types scripts/probe-multi-root-skills.mjs --upstream <upstream checkout>
 * DSH_CLI selects an isolated installed runtime, as for the existing smokes.
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadRuntimeModule, runtimeRequire, REPO_ROOT } from './lib/dsh-runtime.mjs'
import { wrapMethod } from '../src/method-wrapper.ts'

const upstream = process.argv.includes('--upstream') ? resolve(process.argv[process.argv.indexOf('--upstream') + 1]) : undefined
const [{ Context }, skillApi, filesystemApi, toolSkill, agentApi, sessionApi, llmApi, toolsApi, fsApi] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs-local',
].map(loadRuntimeModule))
const home = await realpath(await mkdtemp(join(tmpdir(), 'multi-root-skills-probe-')))
const results = []
const contexts = []
const hash = value => createHash('sha256').update(value).digest('hex')
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
const internalName = (root, name) => `mr-${hash(`${root.primary}\0${root.id}`)}-${name}`
const deferred = () => { let release; const promise = new Promise(done => { release = done }); return { promise, release } }
async function check(name, fn) { await fn(); results.push(name); console.log(`[PASS] ${name}`) }
async function skill(root, dir, name, body, metadata = '') {
  const path = join(root, dir, name, 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\nname: ${name}\ndescription: ${name} description\n${metadata}---\n${body}\n`)
  return path
}

// Metadata-only migration prototype. The production authority queues still
// belong to MultiRootRegistry; this function is deliberately not a second store.
function migrate(records) {
  const used = new Set()
  const generated = new Map()
  for (const row of records) {
    if (row.aliasId === undefined) continue
    assert.match(row.aliasId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert(row.aliasId.length <= 48 && !used.has(row.aliasId))
    used.add(row.aliasId)
  }
  for (const row of [...records].filter(row => row.aliasId === undefined).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const base = (row.alias || row.path.split(/[\\/]/).at(-1)).normalize('NFKD').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/g, '') || 'root'
    const aliasId = used.has(base) ? `${base}-${hash(row.id).slice(0, 12)}` : base
    assert(!used.has(aliasId))
    used.add(aliasId)
    generated.set(row.id, aliasId)
  }
  return records.map(row => {
    let aliasId = row.aliasId
    if (aliasId === undefined) {
      aliasId = generated.get(row.id)
    }
    const access = row.readOnlyRecordedPath !== undefined ? 'read-only' : row.readWriteRecordedPath !== undefined ? 'read-write' : 'inherit'
    if (row.skillsEnabled !== undefined) assert.equal(typeof row.skillsEnabled, 'boolean')
    return { ...row, aliasId, skillsEnabled: row.skillsEnabled ?? access !== 'read-only' }
  })
}

try {
  if (upstream !== undefined) await check('source contracts across every supported tag', async () => {
    const versions = readFileSync(join(REPO_ROOT, 'src/compat/dsh-version.ts'), 'utf8')
      .match(/SUPPORTED_DSH_RELEASES\s*=\s*\[([\s\S]*?)\]/)[1].match(/'[^']+'/g).map(v => v.slice(1, -1))
    const files = {
      registry: 'packages/skill/skill/src/index.ts', tool: 'packages/skill/tool-skill/src/index.ts',
      filesystem: 'packages/skill/skill-filesystem/src/index.ts', remote: 'packages/api/session-controller/src/skill-catalog.ts',
      trigger: 'packages/client/ui-input-trigger/src/core/detect.ts', settings: 'packages/settings/settings/src/index.ts',
    }
    for (const version of versions) {
      const contents = Object.fromEntries(Object.entries(files).map(([key, path]) => [key,
        execFileSync('git', ['-C', upstream, 'show', `dsh-v${version}:${path}`], { encoding: 'utf8' })]))
      assert(contents.registry.includes('provider.list(options)') && contents.registry.includes('scopeChainOf(options.scope)'))
      assert(contents.registry.includes('match.provider.get(match.candidate, options)'))
      assert(contents.tool.includes('scope: exec.agent') && contents.tool.includes('scope: agent'))
      assert(contents.remote.includes('filter(isUserInvocable)'))
      assert(contents.filesystem.includes('includeDefaultRoots') && contents.filesystem.includes('export class FileSystemSkillProvider'))
      assert(contents.tool.includes('if (!isSkillName(args.name))'))
      let userText = false
      try {
        execFileSync('git', ['-C', upstream, 'cat-file', '-e', `dsh-v${version}:packages/client/ui-conversation/src/client/contract/user-text.ts`], { stdio: 'pipe' })
        userText = true
      } catch { /* Older hosts have no sent-message UserTextRule seam. */ }
      let manager = ''
      try {
        manager = execFileSync('git', ['-C', upstream, 'show', `dsh-v${version}:packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch { /* The earliest releases predate the package-detail page. */ }
      console.log(JSON.stringify({ version, features: { userText, bundleCard: manager.includes('plugins.bundle.config'),
        legacySettings: contents.settings.includes('installSection'), volatileSettings: contents.settings.includes('volatileForm') },
      source: Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, hash(value).slice(0, 12)])) }))
    }
  })

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin((await loadRuntimeModule('@deepseek-ai/dsh-system-prompt')).default)
  await ctx.plugin(toolsApi.default)
  await ctx.plugin(agentApi.default)
  await ctx.plugin(skillApi.default)
  await ctx.plugin(fsApi.default, { cwd: home })
  await ctx.plugin(filesystemApi, { dshHome: join(home, 'global-dsh'), agentsHome: join(home, 'global-agents'), watch: false })
  // New runtimes require workingDirectory; older ones harmlessly ignore it.
  ctx.provide('workingDirectory', { ensure: async agent => agent.effectiveCwd ?? agent.session.header.cwd })
  const primaryA = join(home, 'a'), primaryB = join(home, 'b'), shared = join(home, 'shared')
  const extraA = join(home, 'extra-a'), extraB = join(home, 'extra-b')
  for (const path of [primaryA, primaryB, shared, extraA, extraB]) { await mkdir(path); await mkdir(join(path, '.git')) }
  const first = { id: randomUUID(), primary: primaryA, path: extraA, aliasId: 'repo-a', skillsEnabled: true, available: true }
  const second = { id: randomUUID(), primary: primaryB, path: extraB, aliasId: 'repo-b', skillsEnabled: true, available: true }
  const roots = new Map([[primaryA, [first]], [primaryB, [second]]])
  const headers = new Map()
  const state = { enabled: true, authority: true, revision: 0 }
  const readers = new Map()
  let control, holdRead
  let outsideReads = 0
  const readersToDispose = []
  const invalidate = () => { state.revision++; control.invalidate() }
  const live = options => {
    const agent = options.scope
    return agent !== undefined && ctx.agents.get(agent.id) === agent ? agent : undefined
  }
  // Native filesystem discovery follows effective cwd in newer releases. A
  // registered additional root must not re-enter as an unqualified project.
  // Only that routing case is changed; unregistered cwd keeps native behavior.
  const coldOrigin = new AsyncLocalStorage()
  const originOptions = async options => {
    const primary = live(options)?.session.header.cwd ?? coldOrigin.getStore()
    const additional = roots.get(primary) ?? []
    if (options.cwd === undefined || additional.length === 0) return options
    const canonicalCwd = await realpath(options.cwd).catch(() => resolve(options.cwd))
    return additional.some(root => within(root.path, resolve(options.cwd)) || within(root.path, canonicalCwd))
      ? { ...options, cwd: primary } : options
  }
  const rawSnapshot = ctx.skills.snapshot
  const originalSnapshotDescriptor = Object.getOwnPropertyDescriptor(ctx.skills, 'snapshot')
  const originalGetDescriptor = Object.getOwnPropertyDescriptor(ctx.skills, 'get')
  const restoreSnapshot = wrapMethod(ctx.skills, 'snapshot', original => async function (options = {}) {
    return await Reflect.apply(original, this, [await originOptions(options)])
  })
  const restoreGet = wrapMethod(ctx.skills, 'get', original => async function (name, options = {}) {
    return await Reflect.apply(original, this, [name, await originOptions(options)])
  })
  ctx.effect(() => () => { restoreGet(); restoreSnapshot() })
  const allowed = (agent, root) => agent !== undefined && state.enabled && state.authority && root.skillsEnabled && root.available
    && roots.get(agent.session.header.cwd)?.includes(root)
  const stillRoot = async root => root.available && await realpath(root.path).catch(() => undefined) === root.path

  // Guard the delegate BEFORE discovery reads, not just after it returned paths.
  // The read handle is checked on both sides; this does not claim atomicity
  // against arbitrary ancestor rename (ADR-0012's inherited boundary).
  const readerFor = root => {
    if (readers.has(root.id)) return readers.get(root.id)
    const baseFs = ctx.fs
    const guard = async target => {
      const path = typeof target === 'string' ? target : baseFs.processPath(target)
      const canonical = await realpath(path).catch(() => resolve(path))
      assert(await stillRoot(root) && within(root.path, canonical), 'skill path escaped registered root')
      return canonical
    }
    const guardedFs = new Proxy(baseFs, { get(target, key) {
      if (key === 'readText') return async (targetPath, signal) => {
        signal?.throwIfAborted()
        const path = await guard(targetPath)
        if (!within(root.path, path)) outsideReads++
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const before = await handle.stat()
          assert(before.isFile())
          const content = await handle.readFile('utf8')
          if (holdRead !== undefined) { const hold = holdRead; holdRead = undefined; hold.entered.release(); await hold.resume.promise }
          signal?.throwIfAborted()
          await guard(targetPath)
          return content
        } finally { await handle.close() }
      }
      if (['resolve', 'stat', 'listDir'].includes(key)) return async (...args) => {
        await guard(args[0])
        return await Reflect.apply(target[key], target, args)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const reader = new filesystemApi.FileSystemSkillProvider({ get: name => name === 'fs' ? guardedFs : undefined, logger: ctx.logger },
      { signal: control.signal, invalidate: control.invalidate }, {
        providerName: 'multi-root-probe', includeDefaultRoots: false, watch: false,
        customSkillDirs: [join(root.path, '.dsh/skills'), join(root.path, '.agents/skills')],
      })
    readers.set(root.id, reader)
    readersToDispose.push(reader)
    return reader
  }
  const load = async (agent, root, candidate, signal, user) => {
    if (!allowed(agent, root) || !await stillRoot(root)) return undefined
    const revision = state.revision
    const definition = await readerFor(root).get(candidate, { signal })
    if (definition === undefined || definition.name !== candidate.name || !allowed(agent, root)
      || revision !== state.revision || !await stillRoot(root)) return undefined
    if (!(user ? definition.invocation.userInvocable : definition.invocation.modelInvocable)) return undefined
    return definition
  }
  const catalogFor = async agent => {
    const entries = []
    for (const root of roots.get(agent?.session.header.cwd) ?? []) {
      if (!allowed(agent, root) || !await stillRoot(root)) continue
      const revision = state.revision
      const observed = await readerFor(root).list({})
      if (revision !== state.revision || !allowed(agent, root) || !await stillRoot(root)) continue
      const seen = new Set()
      for (const candidate of Array.isArray(observed) ? observed : observed.candidates) {
        if (seen.has(candidate.name)) continue
        seen.add(candidate.name)
        entries.push({ root, candidate })
      }
    }
    return entries
  }
  ctx.skills.registerProvider(capability => {
    control = capability
    return {
      name: 'multi-root-probe',
      async list(options) {
        const agent = live(options)
        return (await catalogFor(agent)).map(({ root, candidate }) => ({
          ...candidate, name: internalName(root, candidate.name), provider: 'multi-root-probe',
          rank: Number.MAX_SAFE_INTEGER,
          invocation: { modelInvocable: candidate.invocation.modelInvocable, userInvocable: false },
          locator: { root, candidate },
        }))
      },
      async get(entry, options) {
        const { root, candidate } = entry.locator
        const definition = await load(live(options), root, candidate, options.signal, false)
        return definition === undefined ? undefined : {
          ...definition, name: entry.name, provider: 'multi-root-probe',
          invocation: { modelInvocable: definition.invocation.modelInvocable, userInvocable: false },
        }
      },
    }
  })
  const aliasLoad = async (agent, alias, name) => {
    const entry = (await catalogFor(agent)).find(value => value.root.aliasId === alias && value.candidate.name === name)
    return entry === undefined ? undefined : load(agent, entry.root, entry.candidate, undefined, true)
  }
  // Register outside the native tool listeners: unwind after the native
  // catalog, retaining the user's literal message and placing the body last.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const injections = []
    const seen = new Set()
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      for (const block of message.content) {
        if (block.type !== 'text') continue
        for (const match of block.text.matchAll(/(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)(?!\S)/g)) {
          if (seen.has(match[0])) continue
          seen.add(match[0])
          const loaded = await aliasLoad(agent, match[1], match[2])
          if (loaded === undefined) continue
          const source = sessionApi.SESSION_FORMAT_VERSION >= 4
            ? { kind: 'multi-root-skill-invocation', form: 'instructions' }
            : { kind: 'plugin', plugin: 'multi-root-skills', form: 'instructions' }
          injections.push(llmApi.createUserMessage({ source,
            content: [{ type: 'text', text: skillApi.renderSkillContent({ ...loaded, name: `${match[1]}:${match[2]}` }) }] }))
        }
      }
    }
    return { ...decision, messages: [...decision.messages, ...injections] }
  })
  await ctx.plugin(toolSkill)
  const clientCatalog = async sessionId => {
    using observation = await ctx.sessionQuery.observeSession(sessionId)
    const view = { session: { header: observation.header } }
    return (await catalogFor(view)).filter(({ candidate }) => candidate.invocation.userInvocable)
      .map(({ root, candidate }) => `${root.aliasId}:${candidate.name}`)
  }
  function makeAgent(cwd) {
    const id = sessionApi.SessionId(randomUUID())
    const session = sessionApi.Session.create(id, [], { id, cwd, version: sessionApi.SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
    const agent = { id, session, effectiveCwd: shared, options: {}, ctx: new Context(), status: 'idle',
      inbox: {}, send() {}, followup() {}, steer() {}, inject() { throw new Error('probe must not inject outside pre-step') },
      cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: async () => {} }
    ctx.agents.enter(agent, undefined)
    headers.set(id, session.header)
    return agent
  }
  const a = makeAgent(primaryA), b = makeAgent(primaryB)
  const { bindScopeParent } = await loadRuntimeModule('@deepseek-ai/dsh-scope')
  const child = makeAgent(primaryB)
  bindScopeParent(child, a)
  const signal = new AbortController().signal
  const snapshot = agent => ctx.skills.snapshot({ cwd: agent.effectiveCwd, scope: agent, signal })
  const execute = (agent, name) => ctx.tools.get('skill', agent).execute({ name }, { agent, signal })
  const preStep = (agent, messages = []) => agentApi.agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages, turn: 1, step: 1, signal }, async () => ({ kind: 'enter', messages }))
  const append = (agent, decision) => { for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' }) }
  await skill(extraA, '.dsh/skills', 'shared-skill', 'A SECRET BODY')
  await skill(extraA, '.agents/skills', 'shared-skill', 'LOWER PRIORITY BODY')
  await skill(extraB, '.agents/skills', 'shared-skill', 'B SECRET BODY')
  await skill(extraA, '.dsh/skills', 'user-only', 'USER ONLY BODY', 'disable-model-invocation: true\n')
  await skill(extraA, '.dsh/skills', 'model-only', 'MODEL ONLY BODY', 'user-invocable: false\n')

  await check('real registry: shared cwd, concurrent scopes, first native pre-step', async () => {
    const [sa, sb] = await Promise.all([snapshot(a), snapshot(b)])
    assert(sa.skills.some(s => s.name === internalName(first, 'shared-skill')))
    assert(!sa.skills.some(s => s.name === internalName(second, 'shared-skill')))
    assert(!sb.skills.some(s => s.name === internalName(first, 'shared-skill')))
    assert.equal((await ctx.skills.list({ cwd: shared })).length, 0)
    const decision = await preStep(a)
    const text = JSON.stringify(decision.messages)
    assert(text.includes(internalName(first, 'shared-skill')) && !text.includes('A SECRET BODY'))
    append(a, decision)
    const [ra, rb] = await Promise.all([execute(a, internalName(first, 'shared-skill')), execute(b, internalName(second, 'shared-skill'))])
    assert.match(ra.content, /A SECRET BODY/); assert.match(rb.content, /B SECRET BODY/)
    await assert.rejects(execute(b, internalName(first, 'shared-skill')))
    assert(!(await snapshot(child)).skills.some(s => s.name === internalName(first, 'shared-skill')))
    assert((await snapshot(child)).skills.some(s => s.name === internalName(second, 'shared-skill')))
  })
  let nativeCatalog
  await check('internal IDs excluded from native human catalog; namespace alias keeps original policy', async () => {
    assert((await snapshot(a)).skills.every(s => !skillApi.isUserInvocable(s)))
    const { SessionSkillCatalog } = await loadRuntimeModule('@deepseek-ai/dsh-api-session-controller')
    ctx.provide('sessionQuery', { observeSession: async sessionId => {
      assert(headers.has(sessionId), 'unknown session must fail closed')
      return { header: headers.get(sessionId), projections: { values: { workingDirectory: extraA } }, [Symbol.dispose]() {} }
    } })
    nativeCatalog = new SessionSkillCatalog(ctx)
    const restore = wrapMethod(nativeCatalog, 'list', original => async function (request, abort) {
      using observation = await ctx.sessionQuery.observeSession(request.sessionId)
      return await coldOrigin.run(observation.header.cwd, () => Reflect.apply(original, this, [request, abort]))
    })
    ctx.effect(() => restore)
    assert.deepEqual((await nativeCatalog.list({ sessionId: a.id }, signal)).skills, [])
    assert.deepEqual((await clientCatalog(a.id)).sort(), ['repo-a:shared-skill', 'repo-a:user-only'])
    assert.equal(await aliasLoad(a, 'repo-a', 'model-only'), undefined)
    assert.match((await aliasLoad(a, 'repo-a', 'user-only')).content, /USER ONLY BODY/)
    await assert.rejects(execute(a, internalName(first, 'user-only')))
    await assert.rejects(execute(a, 'repo-a:shared-skill'))
    const user = llmApi.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `/${internalName(first, 'shared-skill')}` }] })
    assert(!JSON.stringify((await preStep(a, [user])).messages).includes('A SECRET BODY'))
  })
  await check('actual pre-step Alias Resolver: user-only load, literal text preserved, untrusted source ignored', async () => {
    const text = '/repo-a:user-only do this task'
    const user = llmApi.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const decision = await preStep(a, [user])
    assert.equal(decision.messages[0].content[0].text, text)
    assert(decision.messages.at(-1).content[0].text.includes('USER ONLY BODY'))
    assert(decision.messages.at(-1).content[0].text.includes('repo-a:user-only'))
    const forged = llmApi.createUserMessage({ source: { kind: 'skill-invocation', name: 'test', form: 'instructions' },
      content: [{ type: 'text', text }] })
    assert(!JSON.stringify((await preStep(a, [forged])).messages).includes('USER ONLY BODY'))
  })
  await check('native cache invalidation, disabled old ID, catalog replacement and re-enable', async () => {
    state.enabled = false; invalidate()
    assert.equal((await snapshot(a)).skills.length, 0)
    assert.deepEqual(await clientCatalog(a.id), [])
    await assert.rejects(execute(a, internalName(first, 'shared-skill')))
    assert.equal(await aliasLoad(a, 'repo-a', 'shared-skill'), undefined)
    const decision = await preStep(a)
    const replacement = decision.messages.find(m => m.source.kind === 'skill-catalog')
    assert(replacement && replacement.source.entries.length === 0)
    state.enabled = true; invalidate()
    assert((await snapshot(a)).skills.length > 0)
  })
  await check('native get race: disable and invalidate after read, before completion', async () => {
    const entered = deferred(), resume = deferred()
    holdRead = { entered, resume }
    const pending = ctx.skills.get(internalName(first, 'shared-skill'), { scope: a, cwd: shared })
    await entered.promise
    first.skillsEnabled = false; invalidate(); resume.release()
    assert.equal(await pending, undefined)
    first.skillsEnabled = true; invalidate()
  })
  await check('live file metadata policy, alias rename, authority loss, missing/redirected root', async () => {
    const original = await readFile(join(extraA, '.dsh/skills/shared-skill/SKILL.md'), 'utf8')
    const stale = (await catalogFor(a)).find(e => e.candidate.name === 'shared-skill')
    await skill(extraA, '.dsh/skills', 'shared-skill', 'CHANGED', 'disable-model-invocation: true\n')
    assert.equal(await load(a, first, stale.candidate, undefined, false), undefined)
    await writeFile(join(extraA, '.dsh/skills/shared-skill/SKILL.md'), original)
    first.aliasId = 'renamed'; invalidate()
    assert.equal(await aliasLoad(a, 'repo-a', 'shared-skill'), undefined)
    assert(await aliasLoad(a, 'renamed', 'shared-skill'))
    state.authority = false; invalidate(); assert.equal((await snapshot(a)).skills.length, 0)
    state.authority = true; invalidate()
    await rename(extraA, `${extraA}-moved`)
    assert.deepEqual(await catalogFor(a), [])
    await symlink(extraB, extraA, process.platform === 'win32' ? 'junction' : 'dir')
    assert.deepEqual(await catalogFor(a), [])
    await rm(extraA); await rename(`${extraA}-moved`, extraA); invalidate()
  })
  await check('guarded native filesystem parser refuses escaped skill before content read', async () => {
    const outside = join(home, 'outside')
    await skill(outside, '.dsh/skills', 'escape', 'OUTSIDE SECRET')
    await symlink(join(outside, '.dsh/skills/escape'), join(extraA, '.dsh/skills/escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(catalogFor(a), /escaped registered root/)
    assert.equal(outsideReads, 0)
    await rm(join(extraA, '.dsh/skills/escape'))
  })
  await check('effective cwd bypass reproduced and closed for native tool, catalog and cold Remote', async () => {
    await skill(primaryA, '.dsh/skills', 'primary-skill', 'PRIMARY BODY')
    a.effectiveCwd = extraA
    invalidate()
    // Negative control: unwrapped native discovery exposes the raw name.
    const unwrapped = await Reflect.apply(rawSnapshot, ctx.skills, [{ cwd: extraA, scope: a }])
    assert(unwrapped.skills.some(s => s.name === 'shared-skill'))
    const wrapped = await snapshot(a)
    assert(!wrapped.skills.some(s => s.name === 'shared-skill'))
    assert(wrapped.skills.some(s => s.name === 'primary-skill'))
    await assert.rejects(execute(a, 'shared-skill'))
    state.enabled = false; invalidate()
    assert((await snapshot(a)).skills.some(s => s.name === 'primary-skill'))
    assert.deepEqual((await nativeCatalog.list({ sessionId: a.id }, signal)).skills.map(s => s.name), ['primary-skill'])
    const coldId = sessionApi.SessionId('cold-a')
    headers.set(coldId, { ...a.session.header, id: coldId })
    assert.deepEqual((await nativeCatalog.list({ sessionId: coldId }, signal)).skills.map(s => s.name), ['primary-skill'])
    state.enabled = true; invalidate()
    assert((await clientCatalog(coldId)).some(name => name === 'renamed:shared-skill'))
    await assert.rejects(clientCatalog(sessionApi.SessionId('unknown')))
    const aliasCwd = join(home, 'cwd-alias')
    await symlink(extraA, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir')
    a.effectiveCwd = aliasCwd
    assert(!(await snapshot(a)).skills.some(s => s.name === 'shared-skill'))
    a.effectiveCwd = shared
  })
  await check('metadata migration is repeatable and preserves grants; legacy schema strips choices', async () => {
    const rows = [
      { id: '1', path: extraA, alias: 'Repo A', recordedPath: extraA, addedAt: 'date' },
      { id: '2', path: extraB, alias: 'Repo A', readOnlyRecordedPath: extraB, addedAt: 'date' },
      { id: '3', path: shared, alias: '中文', readWriteRecordedPath: shared, addedAt: 'date' },
    ]
    const migrated = migrate(rows)
    assert.deepEqual(migrate(migrated), migrated)
    assert.deepEqual(migrate([...rows].reverse()).reverse(), migrated)
    assert.equal(new Set(migrated.map(row => row.aliasId)).size, 3)
    assert.deepEqual(migrated.map(row => row.skillsEnabled), [true, false, true])
    assert.deepEqual(migrated.map(({ aliasId: _alias, skillsEnabled: _enabled, ...row }) => row), rows)
    assert.throws(() => migrate([{ ...rows[0], skillsEnabled: 'false' }]))
    const previous = { ...migrated[0], skillsEnabled: false }
    const accessChange = (row, before, after) => ({ ...row, skillsEnabled: before === after ? row.skillsEnabled : after !== 'read-only' })
    assert.equal(accessChange(previous, 'inherit', 'inherit').skillsEnabled, false)
    assert.equal(accessChange(previous, 'inherit', 'read-write').skillsEnabled, true)
    assert.equal(accessChange(previous, 'inherit', 'read-only').skillsEnabled, false)
    const { multiRootDomainSpec } = await import(pathToFileURL(join(REPO_ROOT, 'lib/registry.js')).href)
    const legacy = multiRootDomainSpec.tables.roots.valueSchema.parse({ roots: [{ ...migrated[0], skillsEnabled: false }] })
    assert.equal(legacy.roots[0].aliasId, undefined)
    assert.equal(migrate(legacy.roots)[0].skillsEnabled, true)
  })

  await check('real Loader/Settings: multi-row bundle edits only Skills config, live without remount', async () => {
    const [{ boot, initProfile, readProfilePatches }, editor, settingsApi, schemaApi] = await Promise.all([
      '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery',
    ].map(loadRuntimeModule))
    const z = schemaApi.default
    const dir = join(home, 'profiles/probe')
    initProfile(dir, ['probe-bundle'])
    const bundle = join(dir, 'node_modules/probe-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(home, 'package.json'), '{"name":"skills-probe-installation"}')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'probe-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'multi-root-registry', name: 'cordis:registry' }, { id: 'multi-root-skills', name: 'cordis:skills' },
    ] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const profile = { name: 'probe', dir, home, startedBundles: ['probe-bundle'], patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, overlays: [], telemetryDisabledEnv: undefined }
    let config, mounts = 0, invalidations = 0
    const field = z.boolean().default(true)
    const volatile = typeof field.volatile === 'function'
    const Probe = { Config: z.object({ enabled: volatile ? field.volatile() : field }), apply(context, value) {
      mounts++; config = value
      context.on('settings/document-updated', namespace => {
        if (namespace !== 'multi-root-skills') return
        state.enabled = config.enabled?.get?.() ?? config.enabled
        invalidate()
        invalidations++
      })
    } }
    const instance = await boot('probe', join(dir, 'cordis.yml'), readProfilePatches('probe', profile), bootCtx => {
      bootCtx.provide('profileContext', profile)
      bootCtx.provide('appReady', { onReady: callback => { callback(); return () => {} } })
      Object.assign(bootCtx.loader.builtins, { editor: editor.default, settings: settingsApi.default,
        registry: { apply() {} }, skills: Probe })
    })
    contexts.push(instance)
    const descriptors = instance.settings.describe()
    const descriptor = descriptors.find(row => row.ns === 'multi-root-skills')
    assert(descriptor, 'Config form must use loader row ID')
    assert(!descriptors.some(row => row.ns === 'probe-bundle' || row.ns === 'multi-root-registry'))
    await instance.settings.mutate('multi-root-skills', [{ op: 'set', path: ['enabled'], value: false }], descriptor.revision)
    assert.equal(config.enabled?.get?.() ?? config.enabled, false)
    assert(!(await snapshot(a)).skills.some(entry => entry.provider === 'multi-root-probe'))
    assert.equal(first.skillsEnabled, true)
    if (volatile) assert.equal(mounts, 1)
    assert(invalidations > 0)
    await instance.settings.mutate('multi-root-skills', [{ op: 'set', path: ['enabled'], value: true }])
    assert.equal(config.enabled?.get?.() ?? config.enabled, true)
    assert((await snapshot(a)).skills.some(entry => entry.provider === 'multi-root-probe'))
    const override = await readFile(profile.patchPath, 'utf8')
    assert(override.includes('multi-root-skills') && !override.includes('multi-root-registry'))
  })

  if (upstream !== undefined) await check('actual UI pure cores: colon trigger, draft limitation, sent-message rule', async () => {
    const { detectTrigger } = await import(pathToFileURL(join(upstream, 'packages/client/ui-input-trigger/src/core/detect.ts')).href)
    const { scanTextRefs } = await import(pathToFileURL(join(upstream, 'packages/client/ui-conversation/src/client/input/decorations.ts')).href)
    const { UserTextDocument } = await import(pathToFileURL(join(upstream, 'packages/client/ui-conversation/src/client/conversation/user-text-document.ts')).href)
    const text = '/repo-a:shared-skill'
    assert.equal(detectTrigger(text, text.length, { tier: 'plain' }).query, 'repo-a:shared-skill')
    assert.deepEqual(scanTextRefs(text, new Map([['/', ['repo-a:shared-skill']]])), [])
    const rule = { id: 'multi-root-skill', order: 19, match(input, from) {
      const token = /(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)(?!\S)/g
      token.lastIndex = from
      const match = token.exec(input)
      return match === null ? undefined : { id: 'multi-root-skill', start: match.index, end: match.index + match[0].length,
        data: { aliasId: match[1], name: match[2] } }
    } }
    assert(new UserTextDocument().evaluate({ text, facts: {} }, [rule]).some(node => node.id === 'multi-root-skill'))
  })
  await check('public method wrappers restore original own descriptors', async () => {
    restoreGet(); restoreSnapshot()
    assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.skills, 'snapshot'), originalSnapshotDescriptor)
    assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.skills, 'get'), originalGetDescriptor)
  })
  for (const reader of readersToDispose) await reader.dispose()
  console.log(JSON.stringify({ runtime: runtimeRequire()('@deepseek-ai/dsh/package.json').version, passed: results.length, checks: results }, null, 2))
} finally {
  for (const context of contexts.reverse()) await context.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
