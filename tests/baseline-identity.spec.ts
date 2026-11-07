import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertSameRuntime, baselineSource } from '../scripts/lib/baseline-identity.mjs'
import { REPO_ROOT } from './support/temp-workspace.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function snapshot() {
  const parent = join(REPO_ROOT, '.dsh-smoke'); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'g0-identity-')); roots.push(root)
  for (const dir of ['src', 'scripts', 'tests']) mkdirSync(join(root, dir))
  return root
}

it('rejects a different runtime in either direction and accepts the same entry', () => {
  const root = snapshot()
  const old = join(root, 'old.js'); const modern = join(root, 'modern.js')
  writeFileSync(old, 'old'); writeFileSync(modern, 'modern')
  expect(assertSameRuntime(old, old)).toBe(realpathSync(old))
  expect(() => assertSameRuntime(old, modern)).toThrow('G0_RUNTIME_MISMATCH')
  expect(() => assertSameRuntime(modern, old)).toThrow('G0_RUNTIME_MISMATCH')
})

it('hashes the actual nested snapshot, including untracked files, without borrowing parent Git identity', () => {
  const root = snapshot()
  writeFileSync(join(root, 'src', 'index.ts'), 'first')
  const first = baselineSource(root)
  expect(first).toMatchObject({ kind: 'content-snapshot', sha: null, dirty: null, sourceFiles: 1 })
  writeFileSync(join(root, 'src', 'index.ts'), 'second')
  expect(baselineSource(root).sourceSha256).not.toBe(first.sourceSha256)
  mkdirSync(join(root, 'scripts', 'node_modules'))
  writeFileSync(join(root, 'scripts', 'node_modules', 'dependency.js'), 'ignored')
  expect(baselineSource(root).sourceFiles).toBe(1)
})

it('refuses an empty source tree instead of hashing the empty array', () => {
  expect(() => baselineSource(snapshot())).toThrow('G0_EMPTY_SOURCE')
})
