/**
 * G0 evidence collector. Creates only isolated LOCAL profiles; never loads SSH,
 * reads deployment configuration, or changes the compatibility contract.
 * Run after `pnpm build`. Raw reports live under ignored .dsh-smoke/.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, release } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { parse, stringify } from 'yaml'
import { captureDsh, ensureProfileCopyImport, installPluginProfile, REPO_ROOT, resolveScratchHome, runtimeRequire, loadRuntimeModule } from './lib/dsh-runtime.mjs'
import { baselineRuntime, baselineSource, sha256 as digest } from './lib/baseline-identity.mjs'
import { baselineProfilePatch } from './lib/baseline-profile-patch.mjs'

const { values } = parseArgs({ options: { upstream: { type: 'string' }, 'local-facade': { type: 'boolean' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: pnpm baseline:multi-environment [--upstream <checkout>] [--local-facade] (after pnpm build)')
  process.exit(0)
}
const g1 = values['local-facade'] === true
const rootStates = g1 ? ['empty', 'local'] : ['none']
const label = (kind, profile, applyPatch, roots) => `${kind}-${profile}-patch-${applyPatch}${roots === 'none' ? '' : `-roots-${roots}`}`
mkdirSync(join(REPO_ROOT, '.dsh-smoke'), { recursive: true })
const output = mkdtempSync(join(REPO_ROOT, '.dsh-smoke', `multi-environment-${g1 ? 'g1' : 'g0'}-`))
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
let runtime
const sshPackages = ['@deepseek-ai/dsh-ssh', '@deepseek-ai/dsh-fs-ssh', '@deepseek-ai/dsh-subprocess-ssh', '@deepseek-ai/dsh-sandbox-ssh']
const consumerPackages = ['dsh-tool-fs', 'dsh-tool-bash', 'dsh-shell', 'dsh-bash-sandbox', 'dsh-terminal-bash', 'dsh-ptc-runtime-node', 'dsh-working-directory', 'dsh-tool-executor-native']
  .map(name => `@deepseek-ai/${name}`)
const packageNames = [...new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.devDependencies), ...consumerPackages, ...sshPackages])]
  .filter(name => name.startsWith('@deepseek-ai/')).sort()

function installed(name) {
  try { return { version: runtime(`${name}/package.json`).version } } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') return { status: 'absent' }
    throw error
  }
}

const report = {
  schemaVersion: 2, gate: g1 ? 'G1' : 'G0', startedAt: new Date().toISOString(),
  profiles: [], checks: [],
  unverified: ['real SSH connection, host identity, Helper and kernel enforcement', 'managed SFTP exclusive-create/hardlink/no-replace and object binding', 'other native host platforms; Electron and other untested entrypoints'],
}
const save = () => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
save()

/** Stream logs to disk, never accumulate a complete verification run in memory. */
async function check(label, args) {
  const file = join(output, `${label}.log`)
  const { openSync, closeSync } = await import('node:fs')
  const fd = openSync(file, 'w')
  console.log(`[${report.gate}] ${label}`)
  try {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', fd, fd] })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)) })
    report.checks.push({ label, command: ['node', ...args], code, log: `${label}.log` })
    save()
    if (code !== 0) throw new Error(`${label} failed; see ${file}`)
  } finally { closeSync(fd) }
}

try {
  baselineRuntime(REPO_ROOT, process.env.DSH_CLI)
  runtime = runtimeRequire()
  report.plugin = { version: manifest.version, ...baselineSource(REPO_ROOT) }
  report.upstream = values.upstream === undefined ? { status: 'unverified' } : {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: values.upstream, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: values.upstream, encoding: 'utf8' }).trim() !== '',
  }
  report.host = { platform: process.platform, arch: arch(), kernel: release(), node: process.version }
  report.packages = Object.fromEntries(packageNames.map(name => [name, installed(name)]))
  report.inputs = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => [name, digest(readFileSync(join(REPO_ROOT, name)))]))
  const { LocalFileSystem } = await loadRuntimeModule('@deepseek-ai/dsh-fs-local')
  report.fsMethods = Object.fromEntries(['resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains', 'lstat', 'stat', 'listDir', 'readText', 'streamText', 'readBytes', 'readByteRange', 'writeText', 'editText', 'patchText', 'deleteFile', 'moveFile', 'watch']
    .map(name => [name, typeof Reflect.get(LocalFileSystem.prototype, name) === 'function']))
  save()
  await check('compat', ['scripts/check-dsh-compat.mjs'])
  // The JSON reporter retains individual skipped tests instead of counting a
  // successful vitest exit as proof that every OS/kernel case actually ran.
  await check('tests', ['node_modules/vitest/vitest.mjs', 'run',
    'tests/multi-environment-baseline.spec.ts', 'tests/baseline-identity.spec.ts', 'tests/baseline-profile-patch.spec.ts', 'tests/fs-parity.spec.ts', 'tests/apply-patch.e2e.ts',
    'tests/process-entrypoints.spec.ts', 'tests/sandbox-passthrough.spec.ts', 'tests/optional-peers.spec.ts',
    'tests/provider-conflict.spec.ts', 'tests/static-ssh-imports.spec.ts',
    ...(g1 ? ['tests/local-fs-facade.spec.ts'] : []),
    '--reporter=default', '--reporter=json', `--outputFile.json=${join(output, 'tests.json')}`])
  for (const kind of g1 ? ['plugin', 'baseline'] : ['baseline', 'plugin']) {
    const parent = resolveScratchHome('multi-environment-g0')
    mkdirSync(parent, { recursive: true })
    // Allocate, then delete only this run's directory, even after PID reuse.
    const home = mkdtempSync(join(parent, `${kind}-`))
    try {
      for (const profile of ['web', 'headless']) {
        ensureProfileCopyImport(home, profile)
        const code = kind === 'plugin' || g1 ? await installPluginProfile(profile, home)
          : (await captureDsh(['plugin', '--profile', profile, 'install'], { DSH_HOME: home })).code
        if (code !== 0) throw new Error(`${kind}/${profile}: install failed (${code})`)
        for (const applyPatch of [false, true]) for (const roots of rootStates) {
          const stamp = label(kind, profile, applyPatch, roots)
          const before = await captureDsh(['--profile', profile, '--dump-config'], { DSH_HOME: home })
          if (before.code !== 0) throw new Error(`${kind}/${profile}: pre-override dump failed`)
          const overlay = baselineProfilePatch(before.stdout, applyPatch)
          if (g1 && kind === 'plugin') {
            // A patch's `name` is an assertion, not a replacement. Mount the
            // candidate via the same disable+insert composition seam as M1.
            overlay.yaml += stringify([{ id: 'multi-root-fs', disabled: true },
              { insert: [{ id: 'g1-local-fs', name: pathToFileURL(join(REPO_ROOT, 'tests/support/local-fs-facade.ts')).href }] }])
            overlay.targets.push('multi-root-fs', 'g1-local-fs')
          }
          const overlayFile = `${stamp}-overlay.yml`
          writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), overlay.yaml)
          writeFileSync(join(output, overlayFile), overlay.yaml)
          const dumped = await captureDsh(['--profile', profile, '--dump-config'], { DSH_HOME: home })
          if (dumped.code !== 0) throw new Error(`${kind}/${profile}: dump failed (${dumped.code})`)
          const rows = parse(dumped.stdout, { logLevel: 'silent' })
          if (!Array.isArray(rows)) throw new Error(`${kind}/${profile}: expected a row array`)
          const toolFs = rows.find(row => row.id === 'tool-fs')
          if (toolFs?.config?.applyPatch !== applyPatch) throw new Error(`${kind}/${profile}: applyPatch override did not reach tool-fs`)
          if (g1 && kind === 'plugin' && (!rows.some(row => row.id === 'g1-local-fs' && !row.disabled)
            || !rows.some(row => row.id === 'multi-root-fs' && row.disabled === true))) {
            throw new Error(`${kind}/${profile}: G1 replacement rows did not compose`)
          }
          const filename = `${stamp}.yml`
          writeFileSync(join(output, filename), dumped.stdout)
          const executionFile = `${stamp}.json`
          await check(stamp, ['scripts/lib/baseline-profile.mjs', home, profile, String(applyPatch), join(output, executionFile), roots,
            g1 && kind === 'plugin' ? 'facade' : 'existing'])
          const execution = JSON.parse(readFileSync(join(output, executionFile), 'utf8'))
          if (execution.status !== 'passed') throw new Error(`${executionFile}: profile execution did not pass`)
          report.profiles.push({ kind, profile, applyPatch, roots, filename, sha256: digest(dumped.stdout), rows: rows.length,
            overlayFile, overlaySha256: digest(overlay.yaml), patchTargets: overlay.targets,
            executionFile, executionSha256: digest(readFileSync(join(output, executionFile))) })
          save()
        }
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
  report.comparisons = []
  for (const profile of ['web', 'headless']) for (const applyPatch of [false, true]) for (const roots of rootStates) {
    const read = kind => JSON.parse(readFileSync(join(output, `${label(kind, profile, applyPatch, roots)}.json`), 'utf8'))
    const baseline = read('baseline'); const plugin = read('plugin')
    for (const field of ['tools', 'wireTools', 'sentinels', 'services', 'rawFs', ...(g1 ? ['scope', 'confinement', 'promptSha256', 'additional'] : [])]) {
      assert.deepEqual(plugin[field], baseline[field], `${profile}/${applyPatch}/${roots}: candidate must preserve ${field}`)
    }
    report.comparisons.push({ profile, applyPatch, roots, status: 'passed' })
  }
  report.status = 'local-baseline-recorded'
} catch (error) {
  report.status = 'failed'
  report.failure = error.message
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  save()
  console.log(`[${report.gate}] ${report.status}: ${join(output, 'report.json')}`)
}
