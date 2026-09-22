/**
 * upgrade-dsh — repoint this repository's DSH pin at one upstream release.
 *
 * The upgrade lane's job is to answer a single question: would this plugin
 * still be correct if the harness were release X? Answering it requires the
 * whole repository to be pinned at X — `devDependencies`, the release-age
 * allowances, and the lockfile — because the fence and the kernel-sandbox
 * dialects are verified against the copy that is actually installed, not
 * against a range.
 *
 * This script performs exactly that repointing and nothing else. It does NOT
 * touch `SUPPORTED_DSH_RELEASES` or `peerDependencies`: a green upgrade lane is
 * evidence that a release COULD be supported, and promoting it is a human act
 * performed afterwards (ADR-0009). That separation is the whole point — a
 * scheduled job that widened the support matrix on its own would reintroduce the
 * over-promise this contract was written to remove.
 *
 * ```bash
 * node scripts/upgrade-dsh.mjs 0.1.6-alpha.1   # pin an exact release
 * node scripts/upgrade-dsh.mjs --latest-prerelease   # pin the newest published
 * node scripts/upgrade-dsh.mjs --print-latest-prerelease   # just report it
 * node scripts/upgrade-dsh.mjs --print-installed   # report the resolved tree
 *
 * pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0
 * DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all
 * ```
 *
 * Reverting is `git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml`.
 * That is safe in CI, which always runs on a clean checkout, and it is the ONLY
 * way back this script offers on purpose — a backup file would be a second
 * source of truth for "what the pin was".
 *
 * Locally it is a loaded gun: it reverts those three files to HEAD *entirely*,
 * so any UNCOMMITTED edit to them — a new script, a widened peer range — is
 * destroyed along with the pin. Commit or stash before running an upgrade probe
 * over dirty manifests.
 *
 * @module scripts/upgrade-dsh
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(REPO_ROOT, 'package.json')
const WORKSPACE = join(REPO_ROOT, 'pnpm-workspace.yaml')

/** Whether a dependency name belongs to the upstream harness. */
function isDshPackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * The newest published pre-release of `@deepseek-ai/dsh`.
 *
 * The npm `versions` array is in publish order, so the last pre-release entry
 * is the newest one — no semver comparison of pre-release identifiers needed,
 * and none wanted: publish order is what "newest" means for an upgrade probe.
 * @returns the version string.
 */
function latestPrerelease() {
  const raw = execFileSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], { encoding: 'utf8' })
  const versions = JSON.parse(raw)
  const prereleases = versions.filter(version => version.includes('-'))
  const newest = prereleases.at(-1)
  if (newest === undefined) throw new Error('@deepseek-ai/dsh has published no pre-release')
  return newest
}

/**
 * The cordis version the pinned `dsh` package declares.
 *
 * `dsh` 0.1.7 depends on cordis `^4.0.3`. Leaving the repository's 4.0.2 pin
 * in the same tree installs both, and pnpm then gives `dsh-agent-loop` and
 * `dsh-tools` different physical copies. The tool scheduler is a module-local
 * `Symbol`, so the loop looks the symbol up on a runtime built by the other
 * copy and every tool call dies with `reading 'prepare'` of `undefined`.
 * The declared range is a single caret or tilde of one exact version; that
 * exact version is the pin. A wider range is refused rather than guessed.
 * @param dshVersion - the exact `@deepseek-ai/dsh` release being pinned.
 * @returns the exact cordis version to pin.
 */
function cordisRequiredBy(dshVersion) {
  const raw = execFileSync(
    'npm',
    ['view', `@deepseek-ai/dsh@${dshVersion}`, 'dependencies.@deepseek-ai/cordis', '--json'],
    { encoding: 'utf8' },
  )
  const range = JSON.parse(raw)
  const exact = typeof range === 'string' ? /^[\^~]?(\d+\.\d+\.\d+)$/u.exec(range) : null
  if (exact === null) {
    throw new Error(
      `[upgrade] @deepseek-ai/dsh@${dshVersion} depends on cordis ${JSON.stringify(range)}, `
      + 'which is not a single caret or tilde this script can pin',
    )
  }
  return exact[1]
}

/**
 * Repoint every DSH devDependency, and cordis to the version that release requires.
 * @param version - the release to pin.
 * @param cordisVersion - the exact cordis version {@link cordisRequiredBy} returned.
 * @returns the packages that were changed.
 */
function repointManifest(version, cordisVersion) {
  const source = readFileSync(MANIFEST, 'utf8')
  const manifest = JSON.parse(source)
  const changed = []
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    if (!isDshPackage(name)) continue
    if (manifest.devDependencies[name] === version) continue
    changed.push(`${name}: ${manifest.devDependencies[name]} → ${version}`)
    manifest.devDependencies[name] = version
  }
  const cordisName = '@deepseek-ai/cordis'
  if (manifest.devDependencies?.[cordisName] !== cordisVersion) {
    changed.push(`${cordisName}: ${manifest.devDependencies?.[cordisName]} → ${cordisVersion}`)
    manifest.devDependencies[cordisName] = cordisVersion
  }
  // Re-serialize with the trailing newline the repository's manifest carries, so
  // the only diff is the versions themselves.
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  return changed
}

/**
 * Repoint the release-age allowances.
 *
 * Every upstream release is published minutes before this repository uses it, so
 * `minimumReleaseAge` would otherwise reject it outright (ADR-0002). Only the
 * entries already listed are rewritten; the upgrade lane additionally installs
 * with `--config.minimumReleaseAge=0`, because a candidate release drags in every
 * transitive `@deepseek-ai/*` package and enumerating those here would turn a
 * throwaway probe into a 200-line diff.
 *
 * Editing the YAML as TEXT is deliberate: a parse-and-dump round trip would drop
 * the comments that explain why each allowance exists.
 * @param version - the release to pin.
 * @param cordisVersion - the exact cordis version to write into the cordis allowance.
 * @returns the number of rewritten entries.
 */
function repointWorkspace(version, cordisVersion) {
  const source = readFileSync(WORKSPACE, 'utf8')
  let count = 0
  let updated = source.replace(/^(\s*- '@deepseek-ai\/dsh(?:-[\w-]+)?)@[^']+'$/gmu, (line, prefix) => {
    count += 1
    return `${prefix}@${version}'`
  })
  const cordisLine = /^(\s*- '@deepseek-ai\/cordis@)[^']+'$/mu
  if (!cordisLine.test(updated)) {
    throw new Error('[upgrade] pnpm-workspace.yaml has no @deepseek-ai/cordis release-age entry to repoint')
  }
  updated = updated.replace(cordisLine, `$1${cordisVersion}'`)
  count += 1
  writeFileSync(WORKSPACE, updated)
  return count
}

/**
 * Report what each declared DSH package actually RESOLVED to.
 *
 * The declared pin and the resolved tree are different facts, and only the
 * second one is what the tests ran against — so it is the one an upgrade run
 * must print into its log before drawing any conclusion.
 */
function printInstalled() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
  const require = createRequire(import.meta.url)
  const resolved = {}
  for (const name of Object.keys(declared).filter(isDshPackage).sort()) {
    try {
      resolved[name] = require(`${name}/package.json`).version
    } catch {
      resolved[name] = null
    }
  }
  console.log(JSON.stringify(resolved, null, 2))
}

const [argument] = process.argv.slice(2)
if (argument === undefined) {
  console.error('usage: node scripts/upgrade-dsh.mjs <version> | --latest-prerelease | --print-latest-prerelease | --print-installed')
  process.exit(2)
}

if (argument === '--print-latest-prerelease') {
  console.log(latestPrerelease())
  process.exit(0)
}

if (argument === '--print-installed') {
  printInstalled()
  process.exit(0)
}

const target = argument === '--latest-prerelease' ? latestPrerelease() : argument
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(target)) {
  console.error(`[upgrade] "${target}" is not an exact version`)
  process.exit(2)
}

const cordisVersion = cordisRequiredBy(target)
const changed = repointManifest(target, cordisVersion)
const allowances = repointWorkspace(target, cordisVersion)
console.log(`[upgrade] cordis pin: ${cordisVersion}`)
console.log(`[upgrade] pinned ${target}`)
console.log(`[upgrade] devDependencies rewritten: ${changed.length}`)
for (const entry of changed) console.log(`           ${entry}`)
console.log(`[upgrade] release-age allowances rewritten: ${allowances}`)
console.log('[upgrade] next: pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0')
console.log('[upgrade] then: DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all')
console.log('[upgrade] revert: git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml')
console.log('[upgrade]         ^ reverts those files to HEAD entirely — commit or stash first')
