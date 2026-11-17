import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import ubuntuOnly from './scripts/ci/ubuntu-only.json' with { type: 'json' }
import { AUTO_REVIEW_BASELINES, AUTO_REVIEW_CONTRACT_DATA } from './scripts/lib/auto-review-development.mjs'

const pin = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).devDependencies['@deepseek-ai/dsh']
// Only the baseline this development pin belongs to is collected. Both
// generations live in the tree so the published artifact can serve either host,
// but a lane compiles, imports and executes only its own.
const activeBaseline = AUTO_REVIEW_CONTRACT_DATA.baselineOf(pin)
const autoReviewExclude = [
  ...(activeBaseline === '0.2.1' ? [] : ['tests/auto-review/legacy/**']),
  ...(activeBaseline === '0.2.2' ? [] : ['tests/auto-review/current/**']),
  // The review-context suite mounts host services that only a baseline lane's
  // development packages provide.
  ...(activeBaseline === undefined ? ['tests/auto-review/ops-context.spec.ts'] : []),
]

export default defineConfig({
  resolve: {
    alias: {
      // The host's published primitives barrel carries bare `.module.css`
      // imports and host-side dependencies the jsdom suite cannot resolve; the
      // stand-in keeps the same DOM shape (see tests/stubs/ui-primitives.tsx).
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'tests/stubs/ui-primitives.tsx'),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      'node_modules/**',
      ...autoReviewExclude,
      ...(process.env.DSH_CI_NATIVE_TESTS === '1' ? ubuntuOnly : []),
    ],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.e2e.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
