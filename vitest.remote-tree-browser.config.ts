import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// GUI evidence for the remote file tree — real Chromium over the same stub
// alias as vitest.panel-browser.config.ts. Run: pnpm vitest run --config
// vitest.remote-tree-browser.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'tests/stubs/ui-primitives.tsx'),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['tests/client-remote-tree.browser.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
})
