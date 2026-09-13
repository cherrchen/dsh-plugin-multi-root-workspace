import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('CI workflow gates', () => {
  it('probes kernel dialects before the unit suite uses the exported result', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci.indexOf('run: pnpm kernel:probe')).toBeLessThan(ci.indexOf('name: Run the unit suite'))
    const upgrade = read('.github/workflows/upgrade.yml')
    expect(upgrade.indexOf('run: pnpm kernel:probe')).toBeLessThan(upgrade.indexOf('run: pnpm test'))
  })

  it('omits the Windows runner from the matrix unless its repository switch is enabled', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain("fromJSON(vars.DSH_WINDOWS_CI == '1'")
    expect(ci).toContain("'[\"ubuntu-latest\",\"macos-latest\"]'")
  })

  it('derives the upgrade set from the package manifest', () => {
    const workflow = read('.github/workflows/upgrade.yml')
    expect(workflow).toContain('node scripts/upgrade-dsh-dependencies.mjs --apply')
    expect(workflow).not.toContain('@deepseek-ai/dsh-client-ui-renderer@')
    const script = read('scripts/upgrade-dsh-dependencies.mjs')
    expect(script).toContain('Object.keys(declared)')
    expect(script).toContain("name.startsWith('@deepseek-ai/dsh-')")
  })
})
