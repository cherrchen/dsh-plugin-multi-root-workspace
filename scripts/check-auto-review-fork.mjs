/** Portable differential gate: pristine baseline + explicit patch = fork, per baseline. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTO_REVIEW_BASELINES, AUTO_REVIEW_CONTRACT, AUTO_REVIEW_CONTRACT_DATA } from './lib/auto-review-development.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const CONTRACT = readFileSync(AUTO_REVIEW_CONTRACT, 'utf8')
const CONTRACT_DATA = AUTO_REVIEW_CONTRACT_DATA
const read = path => readFileSync(join(root, 'src', 'auto-review', path), 'utf8')

/**
 * Per-baseline reviewed delta: the pristine upstream hash, the protected
 * upstream behaviors (they must be byte-identical to the baseline), and the
 * normalization that undoes the documented fork differences before comparing
 * the snapshot/owner sections.
 */
const BASELINES = {
  '0.2.1': {
    directory: 'legacy',
    hash: '1b0ebf6539f2f412c012eadf8049d19f711267040423d7800b3c4f06809413a7',
    protectedFunctions: ['json', 'parseLoggedArguments', 'sameJson', 'isRecord', 'loggedSchema', 'isAborted', 'isHumanInstruction', 'isProjectInstruction', 'isCheckpoint', 'isDirectParentInstruction', 'directParentInitialPromptSeq', 'textRole', 'filteredUserEntries', 'stepIdentity', 'sameStep', 'scopedCallKey', 'scopePtcStarts', 'nativeAction', 'ptcAction', 'topLevelMemberCount', 'parseDecision', 'readDecision', 'denied', 'askUser', 'failed'],
    normalizeSnapshot: source => source
      .replace(', multiRoot: ReviewContext', '')
      .replace('    multiRoot,\n', '')
      .replace(`          const entry: HistoricalUserMessage = {
            kind: 'user-message',
            role: 'constraint',
            source: event.data.source,
            content,
          }
          projectInstructions.push(entry)
          // A demoted frame keeps its surface position: this placeholder is
          // rewritten to 'fact' or dropped once partitioning decides.
          history.push(entry)`, `          projectInstructions.push({
            kind: 'user-message',
            role: 'constraint',
            source: event.data.source,
            content,
          })`),
  },
  '0.2.2': {
    directory: 'current',
    hash: '72968d3c2a78818e6aeb73c799ef45f9ab2ce56b9814636f0619e8ee94890070',
    localesHash: '4e25cd6742910bbbfcf07ff29844d06c7a5f5ee9f978985cc92a26287b31e4cc',
    protectedFunctions: ['json', 'parseLoggedArguments', 'sameJson', 'isRecord', 'loggedSchema', 'isAborted', 'isBrowserPrompt', 'isProjectInstruction', 'isCheckpoint', 'isDirectParentInstruction', 'creationPrompts', 'textRole', 'filteredUserEntries', 'stepIdentity', 'sameStep', 'scopedCallKey', 'scopePtcStarts', 'toolSchemaEntry', 'nativeAction', 'ptcAction', 'shownSchemaKey', 'topLevelMemberCount', 'parseDecision', 'readDecision', 'denied', 'askUser', 'failed'],
    normalizeSnapshot: source => source
      .replace('\n  multiRoot: ReviewContext,', '')
      .replace('    multiRoot,\n', ''),
    // A const enum has no runtime value in the published cordis, so the fork
    // spells the ACTIVE state as an annotated literal.
    normalizeTail: source => source.replace(
      '=== 2 /* FiberState.ACTIVE (const enum; the published cordis has no runtime value) */',
      '=== FiberState.ACTIVE'),
    // The multi-root delta rewrites the render function; pin its required behavior.
    renderSnippets: [
      'snapshot.multiRoot.environment',
      "executionFence: 'Reviewer allow and human approval remain subject to host write fences.",
      "kind: 'current-root-instructions',",
      "source: { kind: 'multi-root-workspace', snapshot: 'current' },",
      '...instructions.fresh.map(constraint => json({',
      '...history.map(entry => json(entry)),',
    ],
  },
}

function section(source, anchor) {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `missing ${anchor}`)
  const end = source.indexOf('\n/**', start)
  return source.slice(start, end < 0 ? source.length : end).trimEnd()
}

for (const baseline of Object.keys(AUTO_REVIEW_BASELINES)) {
  const config = BASELINES[baseline]
  assert.ok(config !== undefined, `no fork-gate configuration for baseline ${baseline}`)
  assert.equal(config.directory, AUTO_REVIEW_BASELINES[baseline].directory, `baseline ${baseline} directory disagrees with the development library`)
  const baselineFile = `${config.directory}/upstream.ts`
  const forkFile = `${config.directory}/fork.ts`
  const patchFile = `${config.directory}/fork.patch`
  const upstream = read(baselineFile), fork = read(forkFile)
  assert.equal(createHash('sha256').update(upstream).digest('hex'), config.hash, `${baseline}: upstream baseline drift`)
  if (config.localesHash !== undefined) {
    assert.equal(createHash('sha256').update(read(`${config.directory}/locales.ts`)).digest('hex'), config.localesHash, `${baseline}: upstream locales drift`)
  }

  // 1. Replay the reviewed patch against the pristine baseline.
  const original = upstream.split('\n'), output = []
  let cursor = 0
  const lines = read(patchFile).trimEnd().split('\n')
  for (let i = 2; i < lines.length;) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++])
    assert.ok(match, `${baseline}: invalid fork patch hunk`)
    const start = Number(match[1]) - 1
    output.push(...original.slice(cursor, start)); cursor = start
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i++]
      if (line.startsWith(' ') || line.startsWith('-')) assert.equal(original[cursor++], line.slice(1), `${baseline}: patch context drift`)
      if (line.startsWith(' ') || line.startsWith('+')) output.push(line.slice(1))
    }
  }
  output.push(...original.slice(cursor))
  assert.equal(output.join('\n'), fork, `${baseline}: fork differs from reviewed patch; review and update ${patchFile} explicitly`)

  // 2. Both forks keep the upstream owner identity only after declaring the
  //    host services the multi-root context needs.
  assert.match(fork, /export const inject = \[[^\]]*'multiRootReviewContext'/u, `${baseline}: owner does not inject multiRootReviewContext`)

  // 3. The fixed risk policy is upstream's, not ours.
  assert.equal(section(fork, 'const REVIEW_POLICY ='), section(upstream, 'const REVIEW_POLICY ='), `${baseline}: risk policy drift`)

  // 4. Every protected identity/safety function is byte-identical to upstream.
  for (const name of config.protectedFunctions) {
    assert.equal(section(fork, `function ${name}(`), section(upstream, `function ${name}(`), `${baseline}: ${name} protected upstream behavior drift`)
  }

  // 5. The snapshot keeps upstream's identity/filter behavior once the
  //    documented multi-root delta is normalized away.
  assert.equal(config.normalizeSnapshot(section(fork, 'function snapshotAutoReview(')), section(upstream, 'function snapshotAutoReview('), `${baseline}: snapshot identity/filter drift`)

  // 6. Owner registration and disposal are upstream's, after our prepended guard.
  const tail = source => config.normalizeTail === undefined ? source : config.normalizeTail(source)
  assert.equal(tail(fork.slice(fork.indexOf('    yield stopListener'))), tail(upstream.slice(upstream.indexOf('    yield stopListener'))), `${baseline}: owner registration/disposal drift`)

  // 7. The rewritten render function must keep the documented multi-root shape.
  if (config.renderSnippets !== undefined) {
    const render = section(fork, 'function reviewMessages(')
    for (const snippet of config.renderSnippets) assert.ok(render.includes(snippet), `${baseline}: review rendering lost ${snippet}`)
  }

  // 8. The bundled implementation the entry loads must be this baseline's.
  assert.ok(CONTRACT.includes(`'${baseline}': './auto-review-${config.directory}.js'`), `${baseline}: contract implementation file does not match ${config.directory}`)
}

// The hand-written declaration shipped for old lanes must not drift from the
// entry module's real export surface.
const exportsOf = source => [...source.matchAll(/export (?:declare )?(?:const|(?:async )?function) (\w+)/g)].map(token => token[1]).sort()
assert.deepEqual(exportsOf(read('api.d.ts')), exportsOf(read('entry.ts')), 'api.d.ts drifted from the entry module exports')

// Lane-gated devDependencies are owned per baseline: a package imported only
// under auto-review sources and not promised as a peer must live in some
// baseline's list, and on a baseline lane every package of that baseline must
// actually be declared (the upgrade lane strips the other baselines' lists).
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const specifier = /'@deepseek-ai\/(dsh-[\w-]+)'/gu
function* sources(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) yield* sources(path)
    else if (/\.tsx?$/u.test(item.name)) yield path
  }
}
const autoOnly = new Set(), elsewhere = new Set()
for (const dir of ['src', 'tests']) {
  for (const file of sources(join(root, dir))) {
    const target = file.split(sep).includes('auto-review') ? autoOnly : elsewhere
    for (const match of readFileSync(file, 'utf8').matchAll(specifier)) target.add(`@deepseek-ai/${match[1]}`)
  }
}
for (const name of elsewhere) autoOnly.delete(name)
const owned = new Set(Object.values(AUTO_REVIEW_BASELINES).flatMap(baseline => baseline.developmentPackages))
const devDeps = new Set(Object.keys(manifest.devDependencies ?? {}))
const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
for (const name of autoOnly) {
  if (!devDeps.has(name) || peers.has(name)) continue
  assert.ok(owned.has(name), `${name} is imported only by auto-review sources but missing from every baseline's development package list`)
}
const pin = manifest.devDependencies?.['@deepseek-ai/dsh']
const active = CONTRACT_DATA.baselineOf(pin)
if (active !== undefined) {
  for (const name of AUTO_REVIEW_BASELINES[active].developmentPackages) {
    assert.ok(devDeps.has(name), `${name} is listed for the ${active} baseline but the development pin is that baseline and it is not declared`)
  }
}
console.log('[auto-review:fork] baselines, upstream hashes, explicit deltas, policy, identity, roles, protocol and owner teardown verified')
