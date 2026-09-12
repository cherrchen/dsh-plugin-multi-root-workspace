/**
 * The built browser artifact and the manifest declarations that make the host
 * serve it.
 *
 * The Web client accepts exactly one artifact shape — a CJS closure factory
 * registered under the package name through `window.__ModuleLoader__.load` —
 * and discovers it from `exports["./client"]` on a package whose `dsh.client`
 * platform is `web`. Both are asserted here against the BUILT bytes, so a
 * build-config regression fails in this repository instead of in a browser.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './support/temp-workspace.ts'

const PACKAGE_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'
const clientPath = join(REPO_ROOT, 'lib', 'client.js')

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
  files: string[]
  dsh?: { client?: { platform?: string; inject?: string[]; external?: string[] } }
}

describe('the client bundle artifact', () => {
  it('exists where the manifest points', () => {
    expect(statSync(clientPath).isFile()).toBe(true)
    const entry = manifest.exports['./client'] as { default?: string } | undefined
    expect(entry?.default).toBe('./lib/client.js')
  })

  it('registers itself through the module loader under the exact package name', () => {
    const source = readFileSync(clientPath, 'utf8')
    expect(source).toContain('window.__ModuleLoader__.load(')
    expect(source).toContain(`id: ${JSON.stringify(PACKAGE_NAME)}`)
    expect(source).toContain('factory: (require) => {')
    expect(source.trimEnd().endsWith('//# sourceMappingURL=client.js.map')).toBe(true)
  })

  it('exports the cordis plugin surface the client graph loads', () => {
    const source = readFileSync(clientPath, 'utf8')
    expect(source).toContain('exports.apply = apply')
    expect(source).toContain('exports.inject = inject')
  })

  it('imports only module-table words, so nothing else needs a shared identity', () => {
    const source = readFileSync(clientPath, 'utf8')
    const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]).sort()
    expect(required).toEqual(['react', 'react/jsx-runtime'])
  })

  it('inlines its own contract instead of importing the host half', () => {
    const source = readFileSync(clientPath, 'utf8')
    expect(source).not.toContain(`require("${PACKAGE_NAME}`)
    expect(source).not.toContain('node:fs')
    expect(source).toContain('/multi-root-workspace')
  })

  it('ships every file the runtime reads from the package', () => {
    for (const file of ['lib/client.js', 'lib/index.js', 'cordis.patch.yml']) {
      expect(manifest.files.some(pattern => matches(pattern, file)), `${file} must be published`).toBe(true)
    }
  })
})

describe('the dsh.client declaration', () => {
  it('declares the web platform and the client packages it needs', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ])
  })

  it('requests no module-table rows beyond the seeded platform words', () => {
    // Anything else would have to be a row this package cannot answer for
    // itself; the panel inlines everything it owns.
    expect(manifest.dsh?.client?.external).toBeUndefined()
  })
})

/** Whether one `files` glob covers a published path. */
function matches(pattern: string, file: string): boolean {
  const globstar = String.fromCharCode(0)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, '[^/]*')
    .split(globstar)
    .join('.*')
  return new RegExp(`^${escaped}$`).test(file)
}
