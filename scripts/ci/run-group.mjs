import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { nodeForRelease } from './plan.mjs'
import { autoReviewRelease } from '../lib/auto-review-development.mjs'

const minute = 60_000
const { CI_GROUP, GITHUB_SHA: sha, GITHUB_WORKSPACE, GITHUB_STEP_SUMMARY, RUNNER_TEMP } = process.env
const { os, group, versions, node } = JSON.parse(CI_GROUP)
if (process.versions.node !== node || versions.length < 1 || versions.length > 4
  || versions.some(version => !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(version) || nodeForRelease(version) !== node)) {
  throw new Error('Invalid CI group or Node version')
}

const windows = process.platform === 'win32'
const full = os === 'ubuntu-latest'
const resultRoot = join(RUNNER_TEMP, 'ci-results')
const workspace = realpathSync.native(GITHUB_WORKSPACE)
const parent = dirname(workspace)
for (let dir = parent; ; dir = dirname(dir)) {
  if (existsSync(join(dir, 'node_modules'))) throw new Error(`A parent node_modules would contaminate the test tree: ${dir}`)
  if (dirname(dir) === dir) break
}
for (const root of [tmpdir(), '/tmp']) {
  const temp = existsSync(root) ? realpathSync.native(root) : root
  const suffix = relative(temp, parent)
  if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)) {
    throw new Error(`CI fixture parents must be outside the automatic temporary write grant: ${temp}`)
  }
}
const pin = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/dsh']
const reviewPin = autoReviewRelease(readFileSync(join(workspace, 'src/compat/auto-review-contract.ts'), 'utf8'))
const scratch = mkdtempSync(join(parent, 'mr-'))
const archive = join(scratch, 'source.tar')

function run(command, args, { cwd, env, log, prefix, timeout }) {
  // pnpm/action-setup supplies pnpm.cmd on Windows. All arguments passed to
  // cmd are fixed command names/options. Paths and versions travel via cwd/env.
  const viaCmd = windows && command === 'pnpm'
  const file = viaCmd ? process.env.ComSpec : command
  const argv = viaCmd ? ['/d', '/c', command, ...args] : args
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd, env, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => {
        appendFileSync(log, line + '\n')
        console.log(`[${prefix}] ${line}`)
      })
    }
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      if (!child.pid) return
      try {
        if (windows) execFileSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { timeout: 10_000 })
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        // The process may have exited while the timeout callback was queued.
        child.kill('SIGKILL')
        console.error(`[${prefix}] Terminating ${command}: ${error.message}`)
      }
    }, timeout)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (!expired && code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} ${expired ? 'timed out' : `exited ${code ?? signal}`}`))
    })
  })
}

async function verify(version) {
  const output = join(resultRoot, version)
  mkdirSync(output, { recursive: true })
  const cwd = join(scratch, version)
  const temp = mkdtempSync(join(tmpdir(), 'mr-'))
  const prefix = `${os}/${version}`
  const started = Date.now()
  const record = { os, group, version, sha, node, status: 'failure', dialects: [] }
  let stage = 'source'
  try {
    mkdirSync(cwd)
    const env = {
      ...process.env,
      DSH_HOME: join(temp, 'dsh'),
      DSH_SMOKE_HOME: join(temp, 'smoke'),
      DSH_TEST_FIXTURE_PARENT: join(cwd, '.dsh-smoke'),
      DSH_CI_NATIVE_TESTS: full ? '0' : '1',
      DSH_CI_VITEST_REPORT: join(output, 'vitest-cases.json'),
    }
    delete env.DSH_PROBE_VERIFIED_DIALECTS
    delete env.GITHUB_ENV
    const step = (name, command, args, limit = 42, stepEnv = env) => {
      stage = name
      console.log(`[${prefix}] ${stage}`)
      const timeout = Math.min(started + 42 * minute - Date.now(), limit * minute)
      if (timeout <= 0) throw new Error('Version exceeded its 42-minute limit')
      return run(command, args, { cwd, env: stepEnv, log: join(output, name + '.log'), prefix, timeout })
    }
    await step('source', 'tar', ['-xf', archive])
    if (version !== pin) {
      await step('repoint', process.execPath, ['scripts/upgrade-dsh.mjs', version])
      // pnpm also rechecks the ages before every script in this disposable tree.
      appendFileSync(join(cwd, 'pnpm-workspace.yaml'), '\nminimumReleaseAge: 0\n')
    }
    await step('install', 'pnpm', ['install', version === pin ? '--frozen-lockfile' : '--no-frozen-lockfile'])
    await step('compat', 'pnpm', ['compat:check'])
    if (full) await step('typecheck', 'pnpm', ['typecheck'])
    if (full && version === reviewPin) await step('auto-review-fork', 'pnpm', ['auto-review:fork'])
    await step('build', 'pnpm', ['build'])
    await step('registry-probe', 'pnpm', ['registry:probe', '--required'])
    const probe = join(temp, 'kernel.env')
    await step('kernel-probe', 'pnpm', ['kernel:probe'], 5, { ...env, GITHUB_ENV: probe })
    if (existsSync(probe)) {
      const match = /^DSH_PROBE_VERIFIED_DIALECTS=([a-z,-]+)\r?\n$/u.exec(readFileSync(probe, 'utf8'))
      if (!match) throw new Error('Invalid kernel probe result')
      env.DSH_PROBE_VERIFIED_DIALECTS = match[1]
      record.dialects = match[1].split(',')
    }
    const workers = full ? '2' : '4'
    await step('vitest', 'pnpm', ['test', '--maxWorkers=' + workers, '--reporter=default', '--reporter=./scripts/ci/vitest-reporter.mjs'])
    if (!existsSync(env.DSH_CI_VITEST_REPORT)) throw new Error('Vitest did not write the case report')
    await step('smoke-compose', 'pnpm', ['smoke:compose'])
    await step('smoke-behavior', 'pnpm', ['smoke:behavior'])
    await step('smoke-journey', 'pnpm', ['smoke:journey'])
    await step('pack', 'pnpm', ['pack:check'])
    await step('smoke-packed', 'pnpm', ['smoke:packed'], 15)
    if (version === reviewPin) await step('smoke-auto-review', 'pnpm', ['smoke:auto-review'])
    record.status = 'success'
  } catch (error) {
    record.failure = `${stage}: ${error.message}`
    console.error(`[${prefix}] ${record.failure}`)
  }
  for (const path of [temp, cwd]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
    } catch (error) {
      record.status = 'failure'
      record.failure = [record.failure, `cleanup: ${error.message}`].filter(Boolean).join('\n')
      console.error(`[${prefix}] cleanup: ${error.message}`)
    }
  }
  record.seconds = Math.round((Date.now() - started) / 1000)
  writeFileSync(join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n')
  return record
}

try {
  execFileSync('git', ['archive', '--format=tar', '-o', archive, sha], { cwd: workspace, stdio: 'inherit' })
  const results = []
  const concurrent = full ? 2 : 1
  for (let start = 0; start < versions.length; start += concurrent) {
    const batch = await Promise.allSettled(versions.slice(start, start + concurrent).map(verify))
    for (const result of batch) {
      if (result.status === 'fulfilled') results.push(result.value)
      else {
        console.error(result.reason)
        process.exitCode = 1
      }
    }
  }
  const summary = [
    '| Image | DSH | Result | Verified dialects | Seconds |',
    '| --- | --- | --- | --- | ---: |',
    ...results.map(result => `| ${os} | ${result.version} | ${result.status} | ${result.dialects.join(', ') || 'none'} | ${result.seconds} |`),
  ].join('\n')
  console.log(summary)
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, summary + '\n')
  if (results.some(result => result.status !== 'success')) process.exitCode = 1
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
}
