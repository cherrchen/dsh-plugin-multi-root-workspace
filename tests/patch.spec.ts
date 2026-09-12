/**
 * Composition invariants of the bundle patch.
 *
 * The patch is the whole mechanism by which this plugin takes over `ctx.fs` and
 * `ctx.sandbox`. Two failure modes are silent upstream — an id that no longer
 * exists only warns and is skipped, and a name that does not resolve only fails
 * at boot — so this suite pins both against the PINNED upstream bundle:
 *
 * 1. every disabled id exists in `@deepseek-ai/dsh-base`'s own patch, with the
 *    provider name this plugin intends to replace;
 * 2. every inserted row name resolves to an export this package declares.
 *
 * The end-to-end counterpart (an actual composed dump, and an actual boot with
 * identity assertions) lives in `scripts/smoke-compose.mjs` and
 * `scripts/smoke-behavior.mjs`.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from './support/temp-workspace.ts'

const require = createRequire(import.meta.url)

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  insert?: Row[]
  config?: unknown
  [key: string]: unknown
}

/** Collect every row carrying an `id`, wherever the bundle nests it. */
function rowsById(value: unknown, found = new Map<string, Row>()): Map<string, Row> {
  if (Array.isArray(value)) {
    for (const entry of value) rowsById(entry, found)
    return found
  }
  if (value === null || typeof value !== 'object') return found
  const row = value as Row
  if (typeof row.id === 'string') found.set(row.id, row)
  for (const nested of Object.values(row)) rowsById(nested, found)
  return found
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'))
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
}

const patchPath = join(REPO_ROOT, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
const patchRows = readYaml(patchPath) as Row[]
const baseBundleDir = dirname(require.resolve('@deepseek-ai/dsh-base/package.json'))
const baseRows = rowsById(readYaml(join(baseBundleDir, 'cordis.patch.yml')))

describe('bundle declaration', () => {
  it('declares the patch this repository ships', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})

describe('provider replacement rows', () => {
  const disabled = patchRows.filter(row => row.disabled === true)

  it('disables exactly the two providers this plugin replaces', () => {
    expect(disabled.map(row => row.id)).toEqual(['fs-sandbox', 'sandbox'])
  })

  it('disables ids that exist in the pinned upstream bundle, pointing at the expected providers', () => {
    const expected: Record<string, string> = {
      'fs-sandbox': '@deepseek-ai/dsh-fs-sandbox',
      'sandbox': '@deepseek-ai/dsh-sandbox-local',
    }
    for (const [id, name] of Object.entries(expected)) {
      const upstream = baseRows.get(id)
      expect(upstream, `upstream row ${id} is missing from @deepseek-ai/dsh-base`).toBeDefined()
      expect(upstream?.name).toBe(name)
    }
  })

  it('leaves the bash executor and the policy service upstream', () => {
    const touched = new Set(patchRows.flatMap(row => (row.id === undefined ? [] : [row.id])))
    for (const id of ['bash-sandbox', 'sandbox-policy', 'tool-fs', 'tool-bash', 'terminal-bash']) {
      expect(touched.has(id), `${id} must stay untouched`).toBe(false)
    }
    // The bash executor stays in the tree, still platform-gated by upstream.
    expect(baseRows.get('bash-sandbox')?.name).toBe('@deepseek-ai/dsh-bash-sandbox')
    expect(baseRows.get('bash-sandbox')?.disabled).toBeDefined()
  })

  it('disables before inserting, so the replacement never collides on a service key', () => {
    const insertIndex = patchRows.findIndex(row => Array.isArray(row.insert))
    const lastDisable = patchRows.reduce((last, row, index) => (row.disabled === true ? index : last), -1)
    expect(insertIndex).toBeGreaterThan(lastDisable)
    expect(lastDisable).toBeGreaterThanOrEqual(0)
  })
})

describe('inserted rows', () => {
  const inserted = patchRows.flatMap(row => row.insert ?? [])

  it('inserts the scope service, the two providers, the registry, the user surface, and the client-graph anchor', () => {
    expect(inserted.map(row => row.id)).toEqual([
      'multi-root-fs',
      'multi-root-sandbox',
      'multi-root-scope',
      'multi-root-registry',
      'multi-root-command',
      'multi-root-client',
    ])
  })

  it('names entries that this package actually exports', () => {
    for (const row of inserted) {
      expect(typeof row.name).toBe('string')
      const name = row.name as string
      // The client-graph anchor mounts the package root itself: the web
      // client-module scan reads `dsh.client` only from a bare-package-name
      // row, so `multi-root-client` must NOT be a subpath.
      if (name === manifest.name) {
        expect(Object.keys(manifest.exports)).toContain('.')
        continue
      }
      expect(name.startsWith(`${manifest.name}/`), `${name} must be a subpath of this package`).toBe(true)
      const subpath = `.${name.slice(manifest.name.length)}`
      expect(Object.keys(manifest.exports), `${subpath} must be declared in package.json exports`).toContain(subpath)
    }
  })

  it('anchors the client graph with a bare-package-name row', () => {
    const anchor = inserted.find(row => row.id === 'multi-root-client')
    expect(anchor?.name).toBe(manifest.name)
  })
})
