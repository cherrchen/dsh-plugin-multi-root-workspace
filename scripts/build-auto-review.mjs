/** Keep the baseline forks' implementation types out of other lanes. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { AUTO_REVIEW_BASELINES, AUTO_REVIEW_CONTRACT_DATA } from './lib/auto-review-development.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const pin = manifest.devDependencies['@deepseek-ai/dsh']
const baseline = AUTO_REVIEW_CONTRACT_DATA.baselineOf(pin)
const compileHere = baseline !== undefined && AUTO_REVIEW_CONTRACT_DATA.compilePins[baseline] === pin
if (compileHere) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', AUTO_REVIEW_BASELINES[baseline].tsconfig, '--noEmit'], { stdio: 'inherit' })
} else {
  console.log('[auto-review] joint contract implementation typecheck skipped on this lane; the public Loader API and JS artifacts are retained')
}
mkdirSync('lib/types/auto-review', { recursive: true })
copyFileSync('src/auto-review/api.d.ts', 'lib/types/auto-review/entry.d.ts')
