/** Keep the exact-version fork's types out of ordinary old-runtime lanes. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { autoReviewRelease } from './lib/auto-review-development.mjs'
const release = autoReviewRelease(readFileSync(new URL('../src/compat/auto-review-contract.ts', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
if (manifest.devDependencies['@deepseek-ai/dsh'] === release) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.auto-review.json', '--noEmit'], {stdio:'inherit'})
} else {
  console.log('[auto-review] exact-version implementation typecheck skipped; public Loader API and JS artifact are retained')
}
mkdirSync('lib/types/auto-review', {recursive:true})
copyFileSync('src/auto-review/api.d.ts', 'lib/types/auto-review/entry.d.ts')
