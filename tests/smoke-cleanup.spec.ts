import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { removeBehaviorHome, removeScratchTree } from '../scripts/lib/smoke-cleanup.mjs'

describe('smoke scratch cleanup ownership', () => {
  it('removes a nested tree and accepts an already removed tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-cleanup-'))
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'marker'), 'payload')
    await removeBehaviorHome(root)
    expect(existsSync(root)).toBe(false)
    await removeScratchTree(root)
  })

  it('leaves the whole home to its explicit parent, including unrelated residue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-cleanup-'))
    try {
      writeFileSync(join(root, 'ordinary.txt'), 'not an addon')
      await removeBehaviorHome(root, true)
      expect(existsSync(join(root, 'ordinary.txt'))).toBe(true)
    } finally { await removeScratchTree(root) }
    expect(existsSync(root)).toBe(false)
  })

  it('removes a directory link without following it outside the scratch tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smoke-cleanup-'))
    const outside = mkdtempSync(join(tmpdir(), 'smoke-outside-'))
    try {
      writeFileSync(join(outside, 'keep'), 'keep')
      symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      await removeScratchTree(root)
      expect(existsSync(join(outside, 'keep'))).toBe(true)
    } finally {
      await removeScratchTree(root)
      await removeScratchTree(outside)
    }
  })

  it.skipIf(process.platform !== 'win32').each(['defer', 'strict'])(
    'bounds cleanup of a real mapped addon in a deep installed tree (%s)', async mode => {
      const root = mkdtempSync(join(tmpdir(), 'smoke-mapped-'))
      try {
        const result = spawnSync(process.execPath, [
          fileURLToPath(new URL('./support/smoke-cleanup-child.mjs', import.meta.url)), root, mode,
        ], { encoding: 'utf8', timeout: 10_000 })
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.stdout).toContain('native addon is mapped')
        if (mode === 'defer') {
          expect(result.status, result.stderr).toBe(0)
          expect(result.stdout).toContain('deferred scratch home cleanup to parent after exit')
        } else {
          expect(result.status).not.toBe(0)
          expect(result.stderr).toContain('scratch cleanup failed for')
          expect(result.stderr).toContain('koffi.node')
        }
        // The parent is strict even when the battery failed. After close the
        // DLL is unmapped and must actually be removable, with no residue.
        await removeScratchTree(root)
        expect(existsSync(root)).toBe(false)
      } finally { await removeScratchTree(root) }
    },
  )
})
