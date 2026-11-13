import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import ubuntuOnly from './scripts/ci/ubuntu-only.json' with { type: 'json' }

const baseline = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).devDependencies['@deepseek-ai/dsh'] === '0.2.1-rc.2'

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
      ...(baseline ? [] : ['tests/auto-review/**']),
      ...(process.env.DSH_CI_NATIVE_TESTS === '1' ? ubuntuOnly : []),
    ],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.e2e.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
