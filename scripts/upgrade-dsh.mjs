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
 * Repoint every DSH devDependency.
 * @param version - the release to pin.
 * @returns the packages that were changed.
 */
function repointManifest(version) {
  const source = readFileSync(MANIFEST, 'utf8')
  const manifest = JSON.parse(source)
  const changed = []
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    if (!isDshPackage(name)) continue
    if (manifest.devDependencies[name] === version) continue
    changed.push(`${name}: ${manifest.devDependencies[name]} → ${version}`)
    manifest.devDependencies[name] = version
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
 * @returns the number of rewritten entries.
 */
function repointWorkspace(version) {
  const source = readFileSync(WORKSPACE, 'utf8')
  let count = 0
  const updated = source.replace(/^(\s*- '@deepseek-ai\/dsh(?:-[\w-]+)?)@[^']+'$/gmu, (line, prefix) => {
    count += 1
    return `${prefix}@${version}'`
  })
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

const changed = repointManifest(target)
const allowances = repointWorkspace(target)
console.log(`[upgrade] pinned ${target}`)
console.log(`[upgrade] devDependencies rewritten: ${changed.length}`)
for (const entry of changed) console.log(`           ${entry}`)
console.log(`[upgrade] release-age allowances rewritten: ${allowances}`)
console.log('[upgrade] next: pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0')
console.log('[upgrade] then: DSH_MULTI_ROOT_COMPAT=warn pnpm verify:all')
console.log('[upgrade] revert: git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml')
console.log('[upgrade]         ^ reverts those files to HEAD entirely — commit or stash first')
