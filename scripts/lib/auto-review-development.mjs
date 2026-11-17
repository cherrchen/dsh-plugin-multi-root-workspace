/**
 * Development-only facts about the optional Auto Review baselines: where each
 * frozen upstream source generation lives, which packages only its fork and its
 * upstream regression suite import, and a text reader for the joint contract.
 *
 * Ordinary matrix lanes omit the development packages: several did not exist in
 * older releases, and a single committed manifest can hold only one version of
 * each package. This is dependency ownership per baseline, not a second runtime
 * support allowlist (that lives in `src/compat/auto-review-contract.ts`).
 *
 * @module scripts/lib/auto-review-development
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The contract file every reader below parses. */
export const AUTO_REVIEW_CONTRACT = fileURLToPath(new URL('../../src/compat/auto-review-contract.ts', import.meta.url))

/**
 * Per-baseline implementation locations and the development packages only the
 * fork and its upstream regression suite need.
 */
export const AUTO_REVIEW_BASELINES = {
  '0.2.2': {
    directory: 'current',
    tsconfig: 'tsconfig.auto-review-current.json',
    developmentPackages: [
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-agent-loop-testkit',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-compaction',
      '@deepseek-ai/dsh-fs-observation-policy',
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-llm-deepseek-api-key',
      '@deepseek-ai/dsh-permission-presets',
      '@deepseek-ai/dsh-ptc-runtime-node',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-executor-native',
      '@deepseek-ai/dsh-tool-executor-ptc',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-testkit',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-working-directory',
      '@deepseek-ai/dsh-util-values',
    ],
  },
  '0.2.1': {
    directory: 'legacy',
    tsconfig: 'tsconfig.auto-review-legacy.json',
    developmentPackages: [
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-agent-loop-testkit',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-compaction',
      '@deepseek-ai/dsh-fs-observation-policy',
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-llm-deepseek-api-key',
      '@deepseek-ai/dsh-permission-presets',
      '@deepseek-ai/dsh-ptc-runtime-node',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-working-directory',
      '@deepseek-ai/dsh-util-values',
    ],
  },
}

/** Every baseline id, in the order the fork gate and CI plan process them. */
export const AUTO_REVIEW_BASELINE_IDS = Object.keys(AUTO_REVIEW_BASELINES)

function readArray(source, name, file) {
  const match = new RegExp(String.raw`export const ${name} = \[([^\]]*)\]`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is not declared as an array literal in ${file}`)
  const entries = [...match[1].matchAll(/'([^']+)'/gu)].map(token => token[1])
  if (entries.length === 0) throw new Error(`${name} is empty in ${file}`)
  return entries
}

function maybeArray(source, name) {
  return new RegExp(String.raw`export const ${name} = \[([^\]]*)\]`, 'u').test(source) ? readArray(source, name, AUTO_REVIEW_CONTRACT) : []
}

function readString(source, name) {
  const value = new RegExp(String.raw`export const ${name} = '([^']+)'`, 'u').exec(source)?.[1]
  if (value === undefined) throw new Error(`${name} is not declared in ${AUTO_REVIEW_CONTRACT}`)
  return value
}

/**
 * Read the joint contract out of its TypeScript source.
 * @param source - the contract file text.
 * @returns every supported release, its baseline, and the baseline's compile pin.
 */
export function readAutoReviewContract(source = readFileSync(AUTO_REVIEW_CONTRACT, 'utf8')) {
  const byBaseline = {
    '0.2.1': readArray(source, 'AUTO_REVIEW_LEGACY_RELEASES', AUTO_REVIEW_CONTRACT),
    '0.2.2': maybeArray(source, 'AUTO_REVIEW_CURRENT_RELEASES'),
  }
  const compilePins = {
    '0.2.1': readString(source, 'AUTO_REVIEW_LEGACY_COMPILE_PIN'),
    '0.2.2': byBaseline['0.2.2'].length === 0 ? undefined : readString(source, 'AUTO_REVIEW_CURRENT_COMPILE_PIN'),
  }
  const releases = [...byBaseline['0.2.1'], ...byBaseline['0.2.2']]
  if (new Set(releases).size !== releases.length) throw new Error('Auto Review releases appear in more than one baseline')
  const baselineOf = release => AUTO_REVIEW_BASELINE_IDS.find(id => byBaseline[id].includes(release))
  for (const [id, list] of Object.entries(byBaseline)) {
    if (list.length === 0) continue
    if (!list.includes(compilePins[id])) throw new Error(`baseline ${id} compile pin must be one of its releases`)
  }
  return { releases, byBaseline, compilePins, baselineOf }
}

/** The joint contract as committed today. */
export const AUTO_REVIEW_CONTRACT_DATA = readAutoReviewContract()
