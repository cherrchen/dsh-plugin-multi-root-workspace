/**
 * smoke:behavior — the empty-root pass-through acceptance test.
 *
 * It boots a real composed profile in-process (no model call, no credentials),
 * runs one battery of filesystem and bash operations against the mounted
 * services, and does so twice: once with `mr-plugin` (this bundle installed) and
 * once with `mr-baseline` (the same composition without it). Every recorded
 * outcome must be identical — that is what "installed plugin behaves exactly
 * like no plugin" means for M1 — while the provider IDENTITY must differ.
 *
 * It then repeats both batteries under `read-only`, which is the other half of
 * the requirement: the mode must keep denying writes through `ctx.fs` and
 * through `ctx.shell`, with the upstream denial facts intact.
 *
 * The run is isolated: a scratch `$DSH_HOME` and a fixture tree under the
 * repository's ignored `.dsh-smoke/` directory (outside `/tmp`, so containment
 * denials are meaningful rather than satisfied by a temporary grant).
 *
 * @module scripts/smoke-behavior
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import MultiRootFileSystem from '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
import MultiRootSandboxProvider from '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
import { createChecker } from './lib/check.mjs'
import { assertIsolatedHome, pluginPackageDir, REPO_ROOT, resolveScratchHome, runDsh } from './lib/dsh-runtime.mjs'
import { bootProfile } from './lib/profile-boot.mjs'

const home = resolveScratchHome(`behavior-${process.pid}`)
const fixtureRoot = join(REPO_ROOT, '.dsh-smoke', `behavior-${process.pid}`)
const primaryRoot = join(fixtureRoot, 'ws')
const outsideRoot = join(fixtureRoot, 'out')
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
  await record('fs writes to the platform temp area', () => write(join('/tmp', `dsh-mr-behavior-${process.pid}.txt`), 'payload'))
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
  await record('bash writes inside the primary root', () => bash('echo payload > bash-inside.txt'))
  await record('bash writes outside every root', () => bash('echo payload > ../out/bash-outside.txt'))

  return results
}

/** Compare two batteries and record every mismatch. */
function compare(label, expected, actual) {
  for (const [name, expectedOutcome] of expected) {
    check.equal(actual.get(name), expectedOutcome, `${label}: ${name}`)
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
      const bashInside = String(plugin.outcomes.get('bash writes inside the primary root'))
      const bashOutside = String(plugin.outcomes.get('bash writes outside every root'))
      const runnerRefused = bashInside.includes('SANDBOX_UNAVAILABLE') || bashInside.includes('SANDBOX_UNAVAILABLE')

      if (mode === 'workspace-write') {
        check.ok(insideWrite.startsWith('undefined'), `${mode}: fs write inside the primary root succeeded`, insideWrite)
        check.contains(String(plugin.outcomes.get('fs writes outside every root')), 'FS_SANDBOX_DENIED',
          'workspace-write denies a write outside every root')
        check.ok(insideWrite.includes('undefined') || insideWrite.length > 0, 'the inside write produced an outcome')
      } else {
        check.contains(insideWrite, 'FS_SANDBOX_DENIED', 'read-only denies the inside write too')
        check.ok(bashInside.includes('"wroteInside":false'), 'read-only leaves no file behind from bash', bashInside)
        check.ok(!String(plugin.outcomes.get('fs writes to the platform temp area')).startsWith('undefined'),
          'read-only denies the temp-area write too')
      }

      if (bashInside.includes('"wroteInside":true')) {
        if (mode === 'workspace-write') {
          check.ok(bashOutside.includes('"wroteOutside":false'), 'bash cannot write outside every root', bashOutside)
          check.equal(JSON.parse(bashOutside).denied, true, 'bash reports the denial as a sandbox denial fact')
        }
      } else if (runnerRefused) {
        check.skip(`${mode}: confined bash execution (no usable kernel runner in this process: ${bashInside.slice(0, 120)}…)`)
      } else {
        check.ok(false, `${mode}: bash wrote inside the primary root as expected`, bashInside)
      }
    }
  } finally {
    process.chdir(originalCwd)
    delete process.env.DSH_PERMISSION_MODE
  }

  check.finish()
} finally {
  rmSync(join('/tmp', `dsh-mr-behavior-${process.pid}.txt`), { force: true })
  if (keep) {
    console.log(`[smoke:behavior] kept scratch home at ${home} and fixture at ${fixtureRoot}`)
  } else {
    rmSync(home, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
