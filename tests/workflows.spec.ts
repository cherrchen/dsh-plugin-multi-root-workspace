import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
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
    expect(workflow).toContain('node scripts/upgrade-dsh.mjs')
    expect(workflow).not.toContain('@deepseek-ai/dsh-client-ui-renderer@')
    const script = read('scripts/upgrade-dsh.mjs')
    expect(script).toContain('manifest.devDependencies')
    expect(script).toContain("name.startsWith('@deepseek-ai/dsh-')")
  })

  it('checks the compatibility contract before anything it would invalidate', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci.indexOf('run: pnpm compat:check')).toBeGreaterThan(-1)
    expect(ci.indexOf('run: pnpm compat:check')).toBeLessThan(ci.indexOf('run: pnpm lint'))
  })

  it('runs the upgrade lane weekly, not only on demand', () => {
    const upgrade = read('.github/workflows/upgrade.yml')
    expect(upgrade).toContain('schedule:')
    expect(upgrade).toMatch(/cron: '[^']+'/u)
    expect(upgrade).toContain('workflow_dispatch:')
  })

  it('relaxes the gate ONLY in the upgrade lane, and only to warn', () => {
    const upgrade = read('.github/workflows/upgrade.yml')
    expect(upgrade).toContain('DSH_MULTI_ROOT_COMPAT: warn')
    // The main lane must never relax it: that is what makes its green a claim
    // about a release the allowlist actually names.
    expect(read('.github/workflows/ci.yml')).not.toContain('DSH_MULTI_ROOT_COMPAT')
  })

  it('never promotes a release from the upgrade lane itself', () => {
    const upgrade = read('.github/workflows/upgrade.yml')
    // A job that edited the allowlist would recreate the over-promise this
    // whole contract removes (ADR-0009): green is evidence, not authorization.
    expect(upgrade).not.toContain('SUPPORTED_DSH_RELEASES =')
    expect(upgrade).not.toContain('git commit')
    expect(upgrade).not.toContain('git push')
    expect(upgrade).toContain('contents: read')
  })

  it('keeps compat:check out of the upgrade lane, where it must fail by design', () => {
    // The candidate is deliberately not on the allowlist, so the static gate
    // would refuse the tree the lane exists to exercise. Naming it in the
    // promotion instructions is fine; running it as a step is not.
    expect(read('.github/workflows/upgrade.yml')).not.toContain('run: pnpm compat:check')
  })
})


describe('upgrade workflow input handling', () => {
  const workflow = parse(read('.github/workflows/upgrade.yml'))
  const steps = workflow.jobs.upgrade.steps as Array<{ name?: string; run?: string; env?: Record<string, string> }>
  it('keeps GitHub expressions out of every shell program', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
  })
  it('rejects shell syntax and multiline output injection before writing candidate output', () => {
    const resolve = steps.find(step => step.name === 'Resolve the candidate release')!
    expect(resolve.env?.REQUESTED_VERSION).toBe('${{ inputs.version }}')
    for (const input of ["'; echo INJECTED; version='", '$(echo INJECTED)', '0.1.6-alpha.1\nother=value']) {
      expect(() => execFileSync('bash', ['-e', '-c', resolve.run!], {
        env: { ...process.env, REQUESTED_VERSION: input, GITHUB_OUTPUT: '/dev/null', GITHUB_STEP_SUMMARY: '/dev/null' },
        stdio: 'pipe',
      })).toThrow()
    }
  })
})
