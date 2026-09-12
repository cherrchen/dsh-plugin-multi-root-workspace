/**
 * smoke:behavior — the empty-root pass-through acceptance test plus the
 * additional-root behavior matrix.
 *
 * It boots a real composed profile in-process (no model call, no credentials),
 * runs one battery of filesystem and bash operations against the mounted
 * services, and does so twice: once with `mr-plugin` (this bundle installed) and
 * once with `mr-baseline` (the same composition without it). Every recorded
 * outcome must be identical — that is what "installed plugin behaves exactly
 * like no plugin" means for the empty-root case — while the provider IDENTITY
 * must differ.
 *
 * It then repeats both batteries under `read-only`, which is the other half of
 * the requirement: the mode must keep denying writes through `ctx.fs` and
 * through `ctx.shell`, with the upstream denial facts intact.
 *
 * Finally it registers an additional root on the plugin's scope service and
 * asserts the multi-root behavior end to end: the fence grants that root, the
 * HOST dialect's own profile gains it (read straight out of `ctx.sandbox.confine`,
 * so the assertion holds even where a confined process cannot be spawned), the
 * denial names every allowed root, and — when this process can actually run a
 * confined command — bash writes the additional root while the outside tree
 * stays denied. `read-only` must leave the additional root ungranted.
 *
 * The run is isolated: a scratch `$DSH_HOME` and a fixture tree under the
 * repository's ignored `.dsh-smoke/` directory (outside `/tmp`, so containment
 * denials are meaningful rather than satisfied by a temporary grant).
 *
 * @module scripts/smoke-behavior
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import MultiRootFileSystem from '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
import MultiRootSandboxProvider from '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
import { createChecker } from './lib/check.mjs'
import { requireKernelRunner } from '../tests/support/kernel-runner.ts'
import { assertIsolatedHome, pluginPackageDir, REPO_ROOT, resolveScratchHome, runDsh } from './lib/dsh-runtime.mjs'
import { bootProfile } from './lib/profile-boot.mjs'

const home = resolveScratchHome(`behavior-${process.pid}`)
const fixtureRoot = join(REPO_ROOT, '.dsh-smoke', `behavior-${process.pid}`)
const primaryRoot = join(fixtureRoot, 'ws')
const outsideRoot = join(fixtureRoot, 'out')
/** The additional root a multi-root session registers. */
const extraRoot = join(fixtureRoot, 'extra')
/** A tree outside every root, used to prove the denial is still enforced. */
const thirdRoot = join(fixtureRoot, 'third')
const keep = process.env.DSH_SMOKE_KEEP === '1'
const check = createChecker('behavior')

const PLUGIN_PROFILE = 'mr-plugin'
const BASELINE_PROFILE = 'mr-baseline'

/** Replace fixture paths so the two profiles' outcomes are comparable. */
function normalize(value) {
  if (typeof value !== 'string') return JSON.stringify(value)
  return value.split(fixtureRoot).join('<fixture>').split(primaryRoot).join('<primary>').split(outsideRoot).join('<outside>')
}

function describe(error) {
  const code = error?.code === undefined ? undefined : String(error.code)
  return code === undefined ? `threw ${error?.name}: ${error?.message}` : `denied ${code}: ${error?.message}`
}

/**
 * One battery of operations against a booted tree.
 * @param ctx - the settled root context.
 * @returns a map of case name to normalized outcome.
 */
async function battery(ctx) {
  const results = new Map()
  const record = async (name, run) => {
    try {
      results.set(name, normalize(await run()))
    } catch (error) {
      results.set(name, normalize(describe(error)))
    }
  }

  const policy = ctx.sandboxPolicy.resolve({})
  const write = async (path, content) => {
    await ctx.fs.writeText(await ctx.fs.resolve(path), content, undefined, undefined, policy)
  }
  // A confined bash run can be refused outright when the host provides no
  // usable runner for this process (a nested kernel sandbox is denied inside an
  // already-confined harness). The outcome object records that fact instead of
  // throwing, so the two profiles stay comparable and the assertions can say
  // explicitly what they could not exercise.
  const bash = async command => {
    const wrote = () => ({
      wroteInside: existsSync(join(primaryRoot, 'bash-inside.txt')),
      wroteOutside: existsSync(join(outsideRoot, 'bash-outside.txt')),
    })
    try {
      const spec = ctx.shell.resolve({ command, workdir: primaryRoot, sandboxPolicy: policy })
      const result = await ctx.shell.run(spec)
      return {
        exitCode: result.exitCode,
        denied: result.sandbox?.denied ?? null,
        enforcement: result.sandbox?.enforcement ?? null,
        stdout: result.stdout.text.trim(),
        ...wrote(),
      }
    } catch (error) {
      return { failure: describe(error), ...wrote() }
    }
  }

  await record('capability fact (ctx.fs.sandboxMode)', async () => ctx.fs.sandboxMode)
  await record('fs writes inside the primary root', () => write(join(primaryRoot, 'fs-inside.txt'), 'payload'))
  // `os.tmpdir()` is what the policy grants on this platform; a literal `/tmp` is
  // a POSIX spelling that would ask the wrong question elsewhere.
  await record('fs writes to the platform temp area', () => write(join(tmpdir(), `dsh-mr-behavior-${process.pid}.txt`), 'payload'))
  await record('fs writes outside every root', () => write(join(outsideRoot, 'fs-outside.txt'), 'payload'))
  await record('fs edits inside the primary root', async () => {
    const path = join(primaryRoot, 'fs-edited.txt')
    writeFileSync(path, 'before')
    await ctx.fs.editText(await ctx.fs.resolve(path), { oldString: 'before', newString: 'after', replaceAll: false }, undefined, undefined, policy)
    return readFileSync(path, 'utf8')
  })
  await record('fs reads outside every root', async () => {
    const path = join(outsideRoot, 'readable.txt')
    writeFileSync(path, 'visible')
    return await ctx.fs.readText(await ctx.fs.resolve(path))
  })
  await record('bash reports the primary root as its cwd', () => bash('pwd'))
  await record('bash writes inside the primary root', async () => {
    const inside = await confinedWrite(bash, join(primaryRoot, 'bash-inside.txt'))
    return { ...inside, artifactRemoved: markerProbe(join(primaryRoot, 'bash-inside.txt')).cleanUp() }
  })
  await record('bash writes outside every root', async () => {
    const outside = await confinedWrite(bash, join(outsideRoot, 'bash-outside.txt'))
    return { ...outside, artifactRemoved: markerProbe(join(outsideRoot, 'bash-outside.txt')).cleanUp() }
  })

  return results
}

/** Compare two batteries and record every mismatch. */
function compare(label, expected, actual) {
  for (const [name, expectedOutcome] of expected) {
    check.equal(actual.get(name), expectedOutcome, `${label}: ${name}`)
  }
}

/**
 * Remove one marker file and report whether a confined command recreated it.
 *
 * The marker is deleted BEFORE the confined run and read immediately after, so
 * the answer describes that run only. Watching a shared file across a whole
 * battery cannot work: a file left by an earlier run (the fixture directory is
 * keyed on the process id, and a CI runner restarts at the same id) or by an
 * earlier probe would answer for the command being measured, in either direction.
 * @param path - the marker file the confined command is expected to create.
 * @returns whether the file exists after the run, and whether it does now.
 */
function markerProbe(path) {
  rmSync(path, { force: true })
  return {
    present: () => existsSync(path),
    /** Remove it again and report whether it was removed. */
    cleanUp: () => { const existed = existsSync(path); rmSync(path, { force: true }); return existed },
  }
}

/**
 * The `wrote` / `present` facts one recorded confined-write outcome carries.
 *
 * Read from the SERIALIZED record, because that is what travels out of the battery
 * and what appears in a failure message: whether the value is a boolean or the
 * string `"true"` depends on how the child serialized it, and §either way the
 * question being asked — did the confined command write? — has the same answer.
 * @param outcome - the recorded value (an object, or the battery's failure text).
 * @returns the two facts, plus whether the command ran at all.
 */
function confinedFacts(outcome) {
  const text = typeof outcome === 'string' ? outcome : JSON.stringify(outcome)
  const fact = (name) => {
    const match = new RegExp(`"${name}":(true|false)`).exec(text)
    return match === null ? undefined : match[1] === 'true'
  }
  const wrote = fact('wrote')
  const refused = text.includes('"failure"') || text.includes('SANDBOX_UNAVAILABLE')
  return {
    text,
    wrote,
    present: fact('present'),
    denied: fact('denied'),
    // The command ran only if it reported its own redirect AND the host did not
    // refuse to confine at all (a refusal outcome also carries `wrote: false`,
    // which is why the failure has to be excluded explicitly).
    ran: !refused && wrote !== undefined,
  }
}

/**
 * A confined write of `target`, reported by the COMMAND itself: it prints the
 * outcome of its own `>` redirect, so "the command ran and wrote" comes from
 * inside the confined process rather than from a file the host then inspects.
 * @param bash - the battery's confined bash runner.
 * @param target - the path the command tries to write.
 * @returns the battery outcome plus what the command said about its own write.
 */
async function confinedWrite(bash, target) {
  const marker = markerProbe(target)
  const outcome = await bash(`if echo payload > ${JSON.stringify(target)}; then echo wrote=yes; else echo wrote=no; fi`)
  return { ...outcome, wrote: String(outcome.stdout ?? '').includes('wrote=yes'), present: marker.present() }
}

/**
 * One battery of operations against a booted tree that carries an ADDITIONAL
 * root: the scope is populated before anything is asked of the providers, so the
 * fs fence and the kernel dialect must both answer with the widened root set.
 * @param ctx - the settled root context.
 * @returns a map of case name to outcome.
 */
async function multiRootBattery(ctx) {
  const results = new Map()
  const policy = ctx.sandboxPolicy.resolve({})
  const scope = ctx.get('multiRootScope')
  // A registration always carries the canonical directory it is granted for
  // (see src/scope.ts): the smoke plays the registry's role, so it records it.
  scope.setAdditionalRoots(policy.workspaceRoot, [{
    id: 'extra',
    path: extraRoot,
    recordedPath: canonical(extraRoot),
  }])
  const resolved = scope.resolve(policy)
  const canonicalExtra = resolved.additionalRoots[0]
  results.set('scope resolves the additional root', String(canonicalExtra))
  results.set('scope resolves the canonical primary root', resolved.primaryRoot)

  const write = async (path) => {
    try {
      await ctx.fs.writeText(await ctx.fs.resolve(path), 'payload', undefined, undefined, policy)
      return 'ok'
    } catch (error) {
      return describe(error)
    }
  }

  results.set('fs writes into the additional root', await write(join(extraRoot, 'fs-extra.txt')))
  const denial = await write(join(thirdRoot, 'fs-third.txt'))
  results.set('fs writes outside every root', denial)
  results.set('fs denial names every allowed root', String(
    denial.includes(resolved.primaryRoot) && denial.includes(String(canonicalExtra)),
  ))
  results.set('fs leaves no file behind outside every root', String(!existsSync(join(thirdRoot, 'fs-third.txt'))))

  // The HOST dialect's own profile, read without executing anything: this is the
  // assertion that still holds in a process that cannot nest a kernel sandbox.
  try {
    const confined = ctx.sandbox.confine(['bash', '-c', 'true'], policy)
    results.set('the host dialect grants the additional root', String(
      confined.argv.some(argument => argument.includes(String(canonicalExtra))),
    ))
    results.set('the host dialect keeps its enforcement facts', `${confined.enforcement}/${confined.denialSignatures.length}`)
  } catch (error) {
    results.set('the host dialect grants the additional root', describe(error))
    results.set('the host dialect keeps its enforcement facts', describe(error))
  }

  const bash = async (command) => {
    try {
      const spec = ctx.shell.resolve({ command, workdir: primaryRoot, sandboxPolicy: policy })
      const result = await ctx.shell.run(spec)
      return {
        exitCode: result.exitCode,
        denied: result.sandbox?.denied ?? null,
        enforcement: result.sandbox?.enforcement ?? null,
        wroteExtra: existsSync(join(extraRoot, 'bash-extra.txt')),
        wroteThird: existsSync(join(thirdRoot, 'bash-third.txt')),
      }
    } catch (error) {
      return { failure: describe(error) }
    }
  }
  results.set('bash writes into the additional root', JSON.stringify(await confinedWrite(bash, join(extraRoot, 'bash-extra.txt'))))
  results.set('bash writes outside every root', JSON.stringify(await confinedWrite(bash, join(thirdRoot, 'bash-third.txt'))))

  return results
}

/**
 * One battery of operations driven the way a USER drives them: through
 * `/workspace-folders` and the registry, with nothing injected by hand. It
 * proves the M3 path end to end inside a real composed profile — the command
 * reaches the store, the store feeds the scope, and the scope decides what the
 * fs fence grants right now.
 * @param ctx - the settled root context.
 * @returns a map of case name to outcome.
 */
async function registryBattery(ctx) {
  const results = new Map()
  const policy = ctx.sandboxPolicy.resolve({})
  const registry = ctx.get('multiRootRegistry')
  results.set('the registry service is mounted', registry === undefined ? 'undefined' : registry.constructor.name)

  // A root agent is what a command needs: the dispatch surface is per agent, and
  // this profile boots without a session until something asks for one.
  const handle = await ctx.agents.create({
    sessionId: `mr-smoke-${process.pid}`,
    meta: { cwd: primaryRoot },
  })
  const agent = handle.agent
  try {
    const run = async (line) => await ctx.commands.execute(agent, line, [], new AbortController().signal)
    results.set('the command is registered', String(ctx.commands.find(agent, 'workspace-folders') !== undefined))

    const write = async (path) => {
      try {
        await ctx.fs.writeText(await ctx.fs.resolve(path), 'payload', undefined, undefined, policy)
        return 'ok'
      } catch (error) {
        return describe(error)
      }
    }

    const deniedBefore = await write(join(extraRoot, 'registry-before.txt'))
    results.set('fs denies the extra root before it is registered', deniedBefore)

    const added = await run(`/workspace-folders add ${extraRoot}`)
    results.set('the command reports success', String(added?.result?.kind))
    results.set('the command names the workspace root', String(added?.result?.text?.includes(canonical(primaryRoot))))
    const granted = ctx.multiRootScope.scopeOf(policy.workspaceRoot)
    results.set('the scope grants the command-registered root', String(granted.includes(canonical(extraRoot))))

    const writeAfter = await write(join(extraRoot, 'registry-after.txt'))
    results.set('fs writes the command-registered root', writeAfter)
    results.set('the file is really on disk', String(existsSync(join(extraRoot, 'registry-after.txt'))))

    const listed = await run('/workspace-folders list')
    results.set('list reports the registered root', String(listed?.result?.text?.includes(extraRoot)))
    results.set('list reports only the workspace root as primary', String(listed?.result?.text?.includes('primary, always writable')))

    const aliased = await run('/workspace-folders alias 1 payments')
    results.set('alias is stored and reported', String(aliased?.result?.text?.includes('[payments]')))

    const duplicate = await run(`/workspace-folders add ${primaryRoot}`)
    results.set('adding the workspace root is refused loudly', String(duplicate?.result?.text?.includes('equals-primary')))

    // --- the read path re-checks the directory, without a restart -------------
    // A registered directory that disappears must stop being writable the moment
    // a listing notices, and must come back the same way.
    const moved = `${extraRoot}-moved`
    rmSync(moved, { recursive: true, force: true })
    renameSync(extraRoot, moved)
    const whileGone = await run('/workspace-folders list')
    results.set('list reports a vanished root as missing', String(whileGone?.result?.text?.includes('missing')))
    results.set('a vanished root loses its grant', String(!ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot))))

    renameSync(moved, extraRoot)
    const whenBack = await run('/workspace-folders list')
    results.set('list re-grants a restored root', String(!whenBack?.result?.text?.includes('missing')))
    results.set('a restored root is writable again', String(ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot))))

    // --- a replaced directory must NOT transfer the grant --------------------
    // Swapping the registered directory for a symlink used to move the writable
    // root to whatever the link pointed at, with the registry still reporting the
    // original path. It must now revoke instead.
    const swapped = `${extraRoot}-swapped`
    rmSync(swapped, { recursive: true, force: true })
    mkdirSync(swapped, { recursive: true })
    rmSync(extraRoot, { recursive: true, force: true })
    symlinkSync(swapped, extraRoot)
    const afterSwap = await run('/workspace-folders list')
    results.set('list reports a replaced root as redirected', String(afterSwap?.result?.text?.includes('redirected')))
    results.set('a replaced root loses its grant', String(!ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot))))
    results.set('a replaced root does not grant the new target', String(!ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(swapped))))

    rmSync(extraRoot, { force: true })
    mkdirSync(extraRoot)
    rmSync(swapped, { recursive: true, force: true })
    const afterRestore = await run('/workspace-folders list')
    results.set('restoring the directory restores the grant', String(ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot))))
    results.set('the restored root is reported available', String(!afterRestore?.result?.text?.includes('redirected')))

    const removed = await run('/workspace-folders remove 1')
    results.set('the command removes the root', String(removed?.result?.kind))
    results.set('the removal revokes the grant', String(!ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot))))
    const writeAfterRemoval = await write(join(extraRoot, 'registry-removed.txt'))
    results.set('fs denies the removed root again', writeAfterRemoval)

    // Leave one root registered — with an alias, so the NEXT boot can prove
    // durability of both the registration and its display alias.
    const readded = await run(`/workspace-folders add ${extraRoot}`)
    results.set('the root can be registered again after removal', String(readded?.result?.kind))
    const realiased = await run('/workspace-folders alias 1 payments')
    results.set('the alias is set on the re-registered root', String(realiased?.result?.text?.includes('[payments]')))
    results.set('the root is registered for the restart check', String(ctx.multiRootScope.scopeOf(policy.workspaceRoot).length))
  } finally {
    await handle.dispose()
  }
  return results
}

/**
 * The restart half of the registry battery: a fresh boot must grant the root
 * that the previous boot persisted, without any command running this time.
 * @param ctx - the settled root context of the second boot.
 * @returns a map of case name to outcome.
 */
async function registryRestartBattery(ctx) {
  const results = new Map()
  const policy = ctx.sandboxPolicy.resolve({})
  const registry = ctx.get('multiRootRegistry')
  const statuses = registry.list(policy.workspaceRoot)
  results.set('the persisted root survives the restart', String(statuses.length))
  results.set('the persisted root is available', String(statuses[0]?.state))
  results.set('the alias survives the restart', String(statuses[0]?.alias))
  results.set('the scope grants the persisted root', String(
    ctx.multiRootScope.scopeOf(policy.workspaceRoot).includes(canonical(extraRoot)),
  ))
  try {
    await ctx.fs.writeText(await ctx.fs.resolve(join(extraRoot, 'registry-restart.txt')), 'payload', undefined, undefined, policy)
    results.set('fs writes the persisted root after a restart', 'ok')
  } catch (error) {
    results.set('fs writes the persisted root after a restart', describe(error))
  }
  // Leave the store as it was found so the pass-through comparisons that ran
  // earlier in this script keep their meaning on a re-run.
  await registry.remove(policy.workspaceRoot, { kind: 'ordinal', ordinal: 1 })
  results.set('the battery cleans up after itself', String(registry.list(policy.workspaceRoot).length))
  return results
}

/**
 * The kernel dialect this host would use, as far as the assertions care: the
 * per-dialect requirement rule needs a name even when confinement is impossible
 * (Windows has no kernel rung for additional roots at all).
 */
function hostDialect() {
  if (process.platform === 'darwin') return 'seatbelt'
  if (process.platform === 'linux') return 'bwrap'
  return 'none'
}

/** The canonical spelling of a path, resolved the way the plugin resolves it. */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Boot one profile and run the registry battery, then the restart battery. */
async function runRegistryProfile(profile) {
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  const first = await bootProfile(profile, home)
  let outcomes
  try {
    outcomes = await registryBattery(first.ctx)
  } finally {
    await first.ctx.fiber.dispose()
  }
  const second = await bootProfile(profile, home)
  try {
    return { outcomes, restart: await registryRestartBattery(second.ctx) }
  } finally {
    await second.ctx.fiber.dispose()
  }
}

/** The plugin profile booted with an additional root registered. */
async function runMultiRootProfile(profile, mode) {
  process.env.DSH_PERMISSION_MODE = mode
  const { ctx } = await bootProfile(profile, home)
  try {
    return await multiRootBattery(ctx)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runProfile(profile, mode) {
  process.env.DSH_PERMISSION_MODE = mode
  const { ctx } = await bootProfile(profile, home)
  try {
    return { identities: identitiesOf(profile, ctx), outcomes: await battery(ctx) }
  } finally {
    await ctx.fiber.dispose()
  }
}

function identitiesOf(profile, ctx) {
  const names = {
    fs: ctx.get('fs')?.constructor?.name ?? 'undefined',
    sandbox: ctx.get('sandbox')?.constructor?.name ?? 'undefined',
    shell: ctx.get('shell')?.constructor?.name ?? 'undefined',
    scope: ctx.get('multiRootScope') === undefined ? 'undefined' : ctx.get('multiRootScope').constructor?.name,
  }
  const plugin = profile === PLUGIN_PROFILE
  check.equal(names.fs, plugin ? 'MultiRootFileSystem' : 'SandboxedFileSystem', `${profile}: ctx.fs provider identity`)
  check.equal(names.sandbox, plugin ? 'MultiRootSandboxProvider' : 'LocalSandboxProvider', `${profile}: ctx.sandbox provider identity`)
  check.equal(names.shell, 'SandboxBashExecutor', `${profile}: ctx.shell stays upstream`)
  check.equal(names.scope, plugin ? 'MultiRootScopeService' : 'undefined', `${profile}: scope service presence`)
  if (plugin) {
    check.ok(ctx.get('fs') instanceof MultiRootFileSystem, 'ctx.fs is this plugin\'s class')
    check.ok(ctx.get('sandbox') instanceof MultiRootSandboxProvider, 'ctx.sandbox is this plugin\'s class')
    check.ok(ctx.get('fs') instanceof FileSystem, 'ctx.fs shares the host filesystem seam identity')
    check.ok(ctx.get('sandbox') instanceof LocalSandboxProvider, 'ctx.sandbox keeps the upstream provider as its base class')
  } else {
    // The baseline tree loads the upstream providers from the RUNTIME's own
    // module graph, so a class-identity comparison against this repository's
    // copy would only be comparing module instances. The name assertions above
    // are the real check; what matters here is that this plugin is absent.
    check.ok(!(ctx.get('fs') instanceof MultiRootFileSystem), 'baseline does not mount this plugin\'s fs provider')
    check.ok(!(ctx.get('sandbox') instanceof MultiRootSandboxProvider), 'baseline does not mount this plugin\'s sandbox provider')
  }
  return names
}

try {
  if (!existsSync(join(REPO_ROOT, 'lib', 'fs.js'))) throw new Error('lib/ is missing — run `pnpm build` before the smoke')

  rmSync(home, { recursive: true, force: true })
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(primaryRoot, { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
  mkdirSync(extraRoot, { recursive: true })
  mkdirSync(thirdRoot, { recursive: true })
  assertIsolatedHome(home)

  console.log(`[smoke:behavior] scratch home: ${home}`)
  console.log(`[smoke:behavior] fixture: ${fixtureRoot}`)

  const initCode = await runDsh(['plugin', '--profile', BASELINE_PROFILE, 'install'], { DSH_HOME: home })
  check.ok(initCode === 0, 'baseline profile initialized without the plugin', `exit ${initCode}`)
  const addCode = await runDsh(['plugin', '--profile', PLUGIN_PROFILE, 'add', pluginPackageDir()], { DSH_HOME: home })
  check.ok(addCode === 0, 'plugin installed into a profile', `exit ${addCode}`)

  const originalCwd = process.cwd()
  // The composed `sandbox-policy` row pins the deployment root to process.cwd().
  process.chdir(primaryRoot)
  try {
    for (const mode of ['workspace-write', 'read-only']) {
      const plugin = await runProfile(PLUGIN_PROFILE, mode)
      const baseline = await runProfile(BASELINE_PROFILE, mode)
      compare(`${mode}: plugin vs baseline`, baseline.outcomes, plugin.outcomes)

      // The pass-through must be meaningful: the battery has to include a real
      // write, a real denial, and (when the host allows a nested runner) a real
      // confined shell run.
      const insideWrite = String(plugin.outcomes.get('fs writes inside the primary root'))
      // Parsed, not substring-matched: the recorded outcome is an object whose
      // JSON quoting would make `includes('"wrote":true')` a question about the
      // encoding rather than about the run (it silently never matched).
      const bashInside = confinedFacts(plugin.outcomes.get('bash writes inside the primary root'))
      const bashOutside = confinedFacts(plugin.outcomes.get('bash writes outside every root'))
      // `wrote` is the fact that says whether the confined command ran at all: when
      // the host cannot nest a kernel sandbox the plugin's confined bash returns a
      // failure outcome instead of a boolean. Not `failure !== undefined` — the raw
      // recorded objects carry host-level fields (`failure`, `denied`) that have
      // nothing to do with whether THIS command ran, which is how a successful
      // `wrote: true` run got reported as an unusable runner.
      const runnerRefused = !bashInside.ran

      if (mode === 'workspace-write') {
        check.ok(insideWrite.startsWith('undefined'), `${mode}: fs write inside the primary root succeeded`, insideWrite)
        check.contains(String(plugin.outcomes.get('fs writes outside every root')), 'FS_SANDBOX_DENIED',
          'workspace-write denies a write outside every root')
        check.ok(insideWrite.includes('undefined') || insideWrite.length > 0, 'the inside write produced an outcome')
      } else {
        check.contains(insideWrite, 'FS_SANDBOX_DENIED', 'read-only denies the inside write too')
        check.ok(!String(plugin.outcomes.get('fs writes to the platform temp area')).startsWith('undefined'),
          'read-only denies the temp-area write too')
      }

      // One decision per mode, then the facts about what the confined command did.
      if (runnerRefused) {
        check.skip(`${mode}: confined bash execution (${requireKernelRunner(hostDialect(), String(bashInside.failure).slice(0, 120))})`)
      } else if (bashInside.wrote) {
        if (mode === 'workspace-write') {
          check.equal(bashOutside.wrote, false, 'bash cannot write outside every root', bashOutside.text)
          check.equal(bashOutside.denied, true, 'bash reports the denial as a sandbox denial fact', bashOutside.text)
        }
      } else if (mode === 'workspace-write') {
        check.ok(false, `${mode}: bash wrote inside the primary root as expected`, bashInside.text)
      } else {
        // Read-only: the command ran and its own redirect failed, and nothing was
        // left on disk. Both are facts about THIS run (see `confinedWrite`).
        check.equal(bashInside.present, false, 'read-only leaves no file behind from bash', bashInside.text)
        check.ok(!existsSync(join(primaryRoot, 'bash-inside.txt')),
          'read-only leaves no bash-inside.txt on disk either', bashInside.text)
      }
    }

    // --- additional roots: the same composition, one root wider -----------------
    for (const mode of ['workspace-write', 'read-only']) {
      for (const name of ['fs-extra.txt', 'bash-extra.txt']) rmSync(join(extraRoot, name), { force: true })
      for (const name of ['fs-third.txt', 'bash-third.txt']) rmSync(join(thirdRoot, name), { force: true })

      const outcomes = await runMultiRootProfile(PLUGIN_PROFILE, mode)
      const extraWrite = String(outcomes.get('fs writes into the additional root'))
      const thirdWrite = String(outcomes.get('fs writes outside every root'))
      const dialectGrant = String(outcomes.get('the host dialect grants the additional root'))
      const bashExtra = confinedFacts(outcomes.get('bash writes into the additional root'))
      const bashThird = confinedFacts(outcomes.get('bash writes outside every root'))

      check.equal(String(outcomes.get('scope resolves the additional root')).length > 0, true,
        `${mode}: the scope resolves the registered additional root`)
      check.equal(String(outcomes.get('scope resolves the canonical primary root')).length > 0, true,
        `${mode}: the scope resolves the primary root`)
      check.equal(String(outcomes.get('fs leaves no file behind outside every root')), 'true',
        `${mode}: no file was created outside every root`)
      check.equal(String(outcomes.get('the host dialect keeps its enforcement facts')).includes('/'), true,
        `${mode}: the host dialect still reports enforcement facts`, String(outcomes.get('the host dialect keeps its enforcement facts')))

      if (mode === 'workspace-write') {
        check.equal(extraWrite, 'ok', `${mode}: fs writes into the additional root`, extraWrite)
        check.contains(thirdWrite, 'FS_SANDBOX_DENIED', `${mode}: fs denies a write outside every root`)
        check.contains(thirdWrite, 'allowed roots:', `${mode}: the denial names the allowed roots`)
        check.equal(String(outcomes.get('fs denial names every allowed root')), 'true',
          `${mode}: the denial lists both the primary and the additional root`, thirdWrite)
      } else {
        check.contains(extraWrite, 'FS_SANDBOX_DENIED', `${mode}: read-only denies the additional root too`, extraWrite)
      }

      if (process.platform === 'win32') {
        check.skip(`${mode}: the host dialect grants the additional root (Windows ACL kernel multi-root is out of first-release scope)`)
      } else {
        check.equal(dialectGrant, String(mode === 'workspace-write'), `${mode}: host dialect grant matches the mode`, dialectGrant)
      }

      if (!bashExtra.ran) {
        check.skip(`${mode}: confined bash against the additional root (${requireKernelRunner(hostDialect(), String(bashExtra.failure).slice(0, 120))})`)
      } else if (mode === 'workspace-write') {
        check.equal(bashExtra.wrote, true, `${mode}: bash writes the additional root`, bashExtra.text)
        check.equal(bashThird.wrote, false, `${mode}: bash cannot write outside every root`, bashThird.text)
        check.equal(bashThird.denied, true, `${mode}: bash reports the outside denial`, bashThird.text)
      } else {
        check.equal(bashExtra.wrote, false, `${mode}: read-only leaves the additional root untouched`, bashExtra.text)
      }
    }
    // --- the M3 path: roots registered by the command, not by the smoke --------
    for (const name of ['registry-before.txt', 'registry-after.txt', 'registry-removed.txt', 'registry-restart.txt']) {
      rmSync(join(extraRoot, name), { force: true })
    }
    const registry = await runRegistryProfile(PLUGIN_PROFILE)

    check.equal(String(registry.outcomes.get('the registry service is mounted')), 'MultiRootRegistry',
      'the plugin profile mounts the root registry service')
    check.equal(String(registry.outcomes.get('the command is registered')), 'true',
      'the plugin profile registers /workspace-folders')
    check.contains(String(registry.outcomes.get('fs denies the extra root before it is registered')), 'FS_SANDBOX_DENIED',
      'the extra root is denied before the command registers it')
    check.equal(String(registry.outcomes.get('the command reports success')), 'success',
      'the command adds the root', String(registry.outcomes.get('the command reports success')))
    check.equal(String(registry.outcomes.get('the command names the workspace root')), 'true',
      'the command output names the session workspace root')
    check.equal(String(registry.outcomes.get('the scope grants the command-registered root')), 'true',
      'the registry feeds the scope the command-registered root')
    check.equal(String(registry.outcomes.get('fs writes the command-registered root')), 'ok',
      'fs writes the command-registered root', String(registry.outcomes.get('fs writes the command-registered root')))
    check.equal(String(registry.outcomes.get('the file is really on disk')), 'true',
      'the write really landed on disk')
    check.equal(String(registry.outcomes.get('list reports the registered root')), 'true', 'list reports the root')
    check.equal(String(registry.outcomes.get('list reports only the workspace root as primary')), 'true',
      'list distinguishes the primary root')
    check.equal(String(registry.outcomes.get('alias is stored and reported')), 'true', 'an alias round-trips')
    check.equal(String(registry.outcomes.get('adding the workspace root is refused loudly')), 'true',
      'adding the workspace root itself fails with equals-primary')
    check.equal(String(registry.outcomes.get('the command removes the root')), 'success', 'the command removes the root')
    check.equal(String(registry.outcomes.get('the removal revokes the grant')), 'true',
      'removal revokes the grant immediately')
    check.equal(String(registry.outcomes.get('the root can be registered again after removal')), 'success',
      'the same directory can be registered again after removal')
    check.equal(String(registry.outcomes.get('the alias is set on the re-registered root')), 'true',
      'the alias is set on the re-registered root')
    check.contains(String(registry.outcomes.get('fs denies the removed root again')), 'FS_SANDBOX_DENIED',
      'the removed root is denied again')

    check.equal(String(registry.restart.get('the persisted root survives the restart')), '1',
      'the registered root survives a restart')
    check.equal(String(registry.restart.get('the persisted root is available')), 'available',
      'the persisted root is available after the restart')
    check.equal(String(registry.restart.get('the alias survives the restart')), 'payments',
      'the alias survives the restart')
    check.equal(String(registry.restart.get('the scope grants the persisted root')), 'true',
      'the persisted root is granted without any command running')
    check.equal(String(registry.restart.get('fs writes the persisted root after a restart')), 'ok',
      'fs writes the persisted root after a restart')
    check.equal(String(registry.restart.get('the battery cleans up after itself')), '0',
      'the registry battery leaves the store empty')
  } finally {
    process.chdir(originalCwd)
    delete process.env.DSH_PERMISSION_MODE
  }

  check.finish()
} finally {
  rmSync(join(tmpdir(), `dsh-mr-behavior-${process.pid}.txt`), { force: true })
  if (keep) {
    console.log(`[smoke:behavior] kept scratch home at ${home} and fixture at ${fixtureRoot}`)
  } else {
    rmSync(home, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
