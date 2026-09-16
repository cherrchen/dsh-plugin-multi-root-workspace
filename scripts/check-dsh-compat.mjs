/**
 * compat:check — the static half of the DSH compatibility contract.
 *
 * The runtime gate (`src/compat.ts`) protects an installed harness; this script
 * protects the REPOSITORY, and it is the check that answers the complaint this
 * whole contract came from: `package.json` used to promise a whole minor range
 * while the code had only ever been verified against one release. A runtime
 * gate cannot catch that, because by the time it runs, npm has already resolved
 * whatever the range allowed.
 *
 * Four things must agree, and this script fails when any pair of them drifts:
 *
 * ```text
 * src/compat/dsh-version.ts   SUPPORTED_DSH_RELEASES   the allowlist
 * package.json                peerDependencies         what npm promises
 * package.json                devDependencies          what CI actually runs
 * node_modules                resolved versions        what is installed here
 * ```
 *
 * It deliberately re-reads the allowlist out of the TypeScript source rather
 * than importing it: this script must run before `pnpm build`, on a clean
 * checkout with no `lib/`, so it cannot depend on the bundle existing.
 *
 * @module scripts/check-dsh-compat
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = join(REPO_ROOT, 'src', 'compat', 'dsh-version.ts')

const failures = []
const notes = []

/** Record a violation. */
function fail(message) {
  failures.push(message)
}

/**
 * Extract one `export const NAME = [...]` string array from the contract source.
 *
 * Parsing the source keeps the allowlist single-sourced without needing a
 * TypeScript loader in a pre-build step. The shapes accepted are exactly the
 * ones the contract file uses; anything else is a hard error rather than a
 * silent empty list, because an empty allowlist would make every check pass.
 * @param source - the contract file's text.
 * @param name - the exported binding to read.
 * @returns the string entries, in order.
 */
function readStringArray(source, name) {
  const match = new RegExp(String.raw`export const ${name} = \[([^\]]*)\]`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is not declared as an array literal in src/compat/dsh-version.ts`)
  const entries = [...match[1].matchAll(/'([^']+)'/gu)].map(token => token[1])
  if (entries.length === 0) throw new Error(`${name} is empty in src/compat/dsh-version.ts`)
  return entries
}

const contractSource = readFileSync(CONTRACT, 'utf8')
const supported = readStringArray(contractSource, 'SUPPORTED_DSH_RELEASES')
const required = readStringArray(contractSource, 'REQUIRED_CORE_PACKAGES')
const optional = readStringArray(contractSource, 'OPTIONAL_CORE_PACKAGES')
const core = [...required, ...optional]

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const peers = manifest.peerDependencies ?? {}
const devs = manifest.devDependencies ?? {}

console.log(`[compat] allowlist: ${supported.join(', ')}`)

// 1. Every dsh peer promises exactly the allowlist — no ranges, no extra
//    versions, nothing the code has not been run against.
const expectedRange = supported.join(' || ')
for (const [name, range] of Object.entries(peers)) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
  if (range !== expectedRange) {
    fail(`peerDependencies["${name}"] is "${range}" but the allowlist is "${expectedRange}"`)
  }
}

// 2. Every required core package is declared as a peer at all. A package this
//    plugin subclasses but does not declare would be resolved from whatever the
//    host happens to hoist.
for (const name of required) {
  if (!(name in peers)) fail(`${name} is a required core package but is not declared in peerDependencies`)
}

// 3. The development pin is one of the allowlisted releases. CI runs this pin,
//    so a pin outside the allowlist means the list has no evidence behind it.
const pinned = new Set()
for (const [name, version] of Object.entries(devs)) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
  pinned.add(version)
}
if (pinned.size > 1) {
  fail(`devDependencies pin several dsh releases (${[...pinned].sort().join(', ')}); pin exactly one`)
} else {
  const [pin] = [...pinned]
  if (pin === undefined) fail('devDependencies pin no dsh release at all')
  else if (!supported.includes(pin)) fail(`devDependencies pin ${pin}, which is not on the allowlist`)
  else notes.push(`development pin: ${pin}`)
}

// 4. What is actually installed here agrees with itself and with the allowlist.
//    This mirrors the runtime gate, so `pnpm compat:check` reproduces a boot
//    refusal without booting a harness.
const installed = new Map()
for (const name of core) {
  try {
    installed.set(name, require(`${name}/package.json`).version)
  } catch {
    installed.set(name, undefined)
  }
}
for (const name of required) {
  if (installed.get(name) === undefined) fail(`${name} is required but not installed (run pnpm install)`)
}
const releases = [...new Set([...installed.values()].filter(version => version !== undefined))]
if (releases.length > 1) {
  fail(`the installed tree mixes dsh releases: ${releases.sort().join(', ')}`)
  for (const [name, version] of installed) console.log(`         ${name} ${version ?? '(not installed)'}`)
} else if (releases.length === 1) {
  const [release] = releases
  if (!supported.includes(release)) fail(`the installed tree is dsh ${release}, which is not on the allowlist`)
  else notes.push(`installed tree: ${release}`)
}

for (const note of notes) console.log(`[compat] ${note}`)

if (failures.length > 0) {
  console.error('\n[compat] the DSH compatibility contract is violated:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\nSee docs/decisions/ADR-0009-dsh-compat-contract.md for what each of these guards.\n')
  process.exit(1)
}

console.log('[compat] allowlist, peerDependencies, development pin and installed tree agree')
