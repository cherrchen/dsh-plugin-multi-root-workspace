import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import type { BrowserCommand } from 'vitest/node'

const wheelOverRootList: BrowserCommand<[pixels: number]> = async (context, pixels) => {
  if (context.provider.name !== 'playwright') throw new Error('The layout test needs Playwright')
  const list = await context.iframe.locator('.mrfw-rootList').boundingBox()
  const body = await context.iframe.locator('.mrfw-body').boundingBox()
  if (list === null || body === null) throw new Error('The dialog list and body must be rendered')

  // Hit the part of the list still visible through the scrolling body.
  const top = Math.max(list.y, body.y)
  const bottom = Math.min(list.y + list.height, body.y + body.height)
  if (bottom <= top) throw new Error('The root list is outside the body viewport')
  await context.page.mouse.move(list.x + list.width / 2, (top + bottom) / 2)
  await context.page.mouse.wheel(0, pixels)
}

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'tests/stubs/ui-primitives.tsx'),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['tests/client-panel.browser.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium', viewport: { width: 320, height: 300 } }],
      commands: { wheelOverRootList },
      screenshotFailures: false,
    },
  },
})
