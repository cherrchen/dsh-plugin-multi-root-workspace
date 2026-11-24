import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { profileContextOverlays } from '../scripts/lib/profile-context.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Every smoke/probe script below scripts/, recursively. */
function scriptFiles(dir = join(root, 'scripts')): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return scriptFiles(path)
    return entry.name.endsWith('.mjs') ? [path] : []
  })
}

it('exposes both launch-time overlay spellings', () => {
  expect(Object.keys(profileContextOverlays()).sort()).toEqual(['overlayPaths', 'overlays'])
  expect(profileContextOverlays()).toEqual({ overlays: [], overlayPaths: [] })
})

it('gives every in-process profileContext fixture the shared overlay fields', () => {
  const providers = scriptFiles().filter(file => readFileSync(file, 'utf8').includes(".provide('profileContext'"))
  // profile-boot's default, smoke-auto-review and probe-multi-root-skills at least.
  expect(providers.length).toBeGreaterThanOrEqual(3)
  for (const file of providers) expect(readFileSync(file, 'utf8'), file).toContain('profileContextOverlays')
})
