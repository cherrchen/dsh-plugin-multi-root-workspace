import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it } from 'vitest'
import { denyProfileArgs, restrictProfileArgs } from '../src/dialects.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'

const CASES = ['full-access bwrap', 'full-access Landlock fallback', 'workspace-write bwrap'] as const
type ProfileCase = typeof CASES[number]

function profile(kind: ProfileCase, root: string, parent: string): string[] {
  const skeleton = ['bwrap', '--ro-bind', '/', '/']
  if (kind === 'workspace-write bwrap') {
    return denyProfileArgs('bwrap', [...skeleton, '--bind', parent, parent], [root])
  }
  return restrictProfileArgs(kind === 'full-access bwrap' ? 'bwrap' : 'landlock',
    kind === 'full-access bwrap' ? skeleton : ['/landlock-run', '--ro', '/'], [root])
}

describe('a vanished deny root retains mandatory process protection', () => {
  it.each(CASES)('%s cannot skip the missing source', kind => {
    const fixture = createFixtureWorkspace('missing-deny')
    try {
      const root = canonicalPath(fixture.outside)
      rmSync(root, { recursive: true })
      const args = profile(kind, root, canonicalPath(fixture.base))
      expect(args.slice(-3)).toEqual(['--ro-bind', root, root])
      expect(args).not.toContain('--ro-bind-try')
    } finally { fixture.dispose() }
  })

  for (const kind of CASES) it(kind + ' fails before executing a command that recreates the root', test => {
    if (process.platform !== 'linux') {
      test.skip('native bubblewrap execution requires Linux')
      return
    }
    // Establish an executable runner first, so setup failure cannot masquerade
    // as protection of the missing root. CI-probed bwrap must not skip.
    const probe = spawnSync('bwrap', ['--bind', '/', '/', '--', 'true'], { encoding: 'utf8', timeout: 10_000 })
    if (probe.error || probe.status !== 0) {
      test.skip(requireKernelRunner('bwrap', probe.error?.message ?? probe.stderr))
      return
    }
    const fixture = createFixtureWorkspace('missing-deny-native')
    try {
      const root = canonicalPath(fixture.outside)
      const marker = join(canonicalPath(fixture.workspace), 'command-started')
      const args = profile(kind, root, canonicalPath(fixture.base))
      // Delete AFTER building the profile: the mount itself must enforce the
      // denial, including disappearance between profile creation and launch.
      rmSync(root, { recursive: true })
      const command = ['--', process.execPath, '-e',
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "started"); fs.mkdirSync(process.argv[2], {recursive:true}); fs.writeFileSync(process.argv[2]+"/bypass", "written")',
        marker, root]
      const result = spawnSync(args[0]!, [...args.slice(1), ...command], { encoding: 'utf8', timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(root)
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(root)).toBe(false)

      // Restoring the root makes the same profile usable; ambient writes work,
      // while writing the registered read-only tree still fails.
      mkdirSync(root)
      const restored = spawnSync(args[0]!, [...args.slice(1), ...command], { encoding: 'utf8', timeout: 10_000 })
      expect(restored.error).toBeUndefined()
      expect(restored.status).not.toBe(0)
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(join(root, 'bypass'))).toBe(false)
    } finally { fixture.dispose() }
  })
})
