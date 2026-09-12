/**
 * smoke:compose — the composition acceptance test.
 *
 * It drives the real plugin install chain (`dsh plugin --profile <name> add`),
 * dumps two composed profiles with `dsh --dump-config` — one with the plugin
 * and one without — and asserts that the ONLY difference is the two disabled
 * provider rows plus the three inserted rows.
 *
 * This is the milestone's structural gate. The upstream patch semantics warn
 * and skip on an id that no longer matches, so "the replacement silently did
 * nothing" is a real failure mode; comparing a baseline dump against the patched
 * one is what turns it into a hard failure here instead of a surprise at runtime.
 *
 * The run is always isolated: it uses a scratch `$DSH_HOME` and refuses to touch
 * the operator's real one.
 *
 * @module scripts/smoke-compose
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { createChecker } from './lib/check.mjs'
import { assertIsolatedHome, captureDsh, pluginPackageDir, REPO_ROOT, resolveScratchHome, runDsh } from './lib/dsh-runtime.mjs'

const PLUGIN_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'
const REPLACED = new Map([
  ['fs-sandbox', '@deepseek-ai/dsh-fs-sandbox'],
  ['sandbox', '@deepseek-ai/dsh-sandbox-local'],
])
const INSERTED = [
  'multi-root-fs',
  'multi-root-sandbox',
  'multi-root-scope',
  'multi-root-registry',
  'multi-root-command',
  // The client-graph anchor: mounted at the bare package name so the web
  // client-module scan reads this package's `dsh.client` declaration.
  'multi-root-client',
]
const UPSTREAM_STANDALONE = ['bash-sandbox', 'sandbox-policy', 'tool-fs', 'tool-bash', 'terminal-bash']

const check = createChecker('compose')
const home = resolveScratchHome(`compose-${process.pid}`)
const keep = process.env.DSH_SMOKE_KEEP === '1'

/** The dump must be a YAML array of rows; `!!js` tag warnings are expected. */
function parseDump(text, label) {
  const rows = parse(text, { logLevel: 'silent' })
  if (!Array.isArray(rows)) throw new Error(`${label}: --dump-config did not print a YAML array`)
  return rows
}

function byId(rows) {
  const map = new Map()
  for (const row of rows) if (row !== null && typeof row === 'object' && typeof row.id === 'string') map.set(row.id, row)
  return map
}

async function dump(profile) {
  const result = await captureDsh(['--profile', profile, '--dump-config'], { DSH_HOME: home })
  check.ok(result.code === 0, `dsh --profile ${profile} --dump-config exits 0`, result.stderr.trim())
  check.ok(!result.stderr.includes('not found'), `dsh reports no unmatched patch rows for ${profile}`, result.stderr.trim())
  return { rows: parseDump(result.stdout, profile), stderr: result.stderr }
}

try {
  if (!existsSync(join(REPO_ROOT, 'lib', 'fs.js'))) throw new Error('lib/ is missing — run `pnpm build` before the smoke')

  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  assertIsolatedHome(home)

  const baselineProfile = 'mr-baseline'
  const pluginProfile = 'mr-plugin'

  console.log(`[smoke:compose] scratch home: ${home}`)
  const initCode = await runDsh(['plugin', '--profile', baselineProfile, 'install'], { DSH_HOME: home })
  check.ok(initCode === 0, 'baseline profile initialized without the plugin', `exit ${initCode}`)

  const addCode = await runDsh(['plugin', '--profile', pluginProfile, 'add', pluginPackageDir()], { DSH_HOME: home })
  check.ok(addCode === 0, 'plugin installed into a profile through `dsh plugin add`', `exit ${addCode}`)

  const baseline = await dump(baselineProfile)
  const composed = await dump(pluginProfile)

  const baselineRows = byId(baseline.rows)
  const composedRows = byId(composed.rows)

  // 1. The baseline really is the untouched composition.
  for (const [id, name] of REPLACED) {
    const row = baselineRows.get(id)
    check.ok(row !== undefined, `baseline still mounts ${id}`, `rows: ${[...baselineRows.keys()].length}`)
    check.equal(row?.name, name, `baseline ${id} points at the upstream provider`)
    check.ok(row?.disabled !== true, `baseline ${id} is enabled`)
  }

  // 2. The plugin's rows are present, enabled, and point at this package.
  const insertedIds = composed.rows
    .filter(row => typeof row?.id === 'string' && row.id.startsWith('multi-root-'))
    .map(row => row.id)
  check.equal(insertedIds, INSERTED, 'exactly the six plugin rows were inserted')
  for (const id of INSERTED) {
    const row = composedRows.get(id)
    check.ok(
      row?.name === PLUGIN_NAME || row?.name?.startsWith(`${PLUGIN_NAME}/`) === true,
      `${id} resolves inside ${PLUGIN_NAME}`,
      String(row?.name),
    )
    check.ok(row?.disabled !== true, `${id} is enabled`)
  }

  // 3. The two replaced rows are disabled, and nothing else changed about them.
  for (const [id] of REPLACED) {
    const before = baselineRows.get(id)
    const after = composedRows.get(id)
    check.equal(after?.disabled, true, `${id} is disabled in the composed tree`)
    const { disabled: _dropped, ...restAfter } = after ?? {}
    check.equal(restAfter, before, `${id} is byte-identical apart from \`disabled\``)
  }

  // 4. Every other row is untouched, in the same order.
  const composedWithoutInserted = composed.rows.filter(row => !(typeof row?.id === 'string' && row.id.startsWith('multi-root-')))
  check.equal(composedWithoutInserted.length, baseline.rows.length, 'the composed tree adds no rows beyond the plugin rows')
  check.equal(
    composedWithoutInserted.map(row => row?.id),
    baseline.rows.map(row => row?.id),
    'row order is unchanged',
  )
  const changed = []
  for (const [index, before] of baseline.rows.entries()) {
    const after = composedWithoutInserted[index]
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(after?.id)
  }
  check.equal(changed.sort(), [...REPLACED.keys()].sort(), 'only the two replaced rows differ')

  // 5. The rows this plugin deliberately keeps upstream are still enabled.
  for (const id of UPSTREAM_STANDALONE) {
    if (!baselineRows.has(id)) continue
    const before = baselineRows.get(id)
    const after = composedRows.get(id)
    check.equal(after?.disabled, before?.disabled, `${id} keeps its upstream enablement`)
  }

  check.finish()
} finally {
  if (!keep && process.env.DSH_SMOKE_KEEP !== '1') rmSync(home, { recursive: true, force: true })
  else console.log(`[smoke:compose] kept scratch home at ${home}`)
}
