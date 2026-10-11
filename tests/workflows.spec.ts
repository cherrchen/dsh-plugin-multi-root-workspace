import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('CI workflow gates', () => {
  it('runs every supported exact release on every enabled OS, with distinct logs', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    expect(JSON.parse(execFileSync(process.execPath, ['scripts/list-dsh-releases.mjs'], { encoding: 'utf8' })))
      .toEqual([...SUPPORTED_DSH_RELEASES])
    expect(ci.jobs.verify.needs).toBe('releases')
    expect(ci.jobs.verify.strategy.matrix.dsh).toBe('${{ fromJSON(needs.releases.outputs.versions) }}')
    expect(ci.jobs.verify.env.DSH_MATRIX_VERSION).toBe('${{ matrix.dsh }}')
    const install = ci.jobs.verify.steps.find((step: { name?: string }) => step.name === 'Install the exact matrix release')
    expect(install.run).toContain('node scripts/upgrade-dsh.mjs "$DSH_MATRIX_VERSION"')
    expect(install.run).not.toContain('${{')
    expect(read('.github/workflows/ci.yml')).toContain('name: vitest-log-${{ matrix.os }}-${{ matrix.dsh }}')
    expect(read('.github/workflows/ci.yml')).toContain('name: smoke-log-${{ matrix.os }}-${{ matrix.dsh }}')
  })
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

  it('runs the kernel probe and every smoke on Windows too', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const steps = ci.jobs.verify.steps as Array<{ name?: string; if?: string; run?: string; shell?: string }>
    // The Windows path is native (the real windows-acl runner, the pwsh tool),
    // so no verify step may still skip `windows-latest` outright.
    for (const step of steps) expect(step.if ?? '').not.toContain("matrix.os != 'windows-latest'")
    const probe = steps.find(step => step.name === 'Probe which kernel dialects this host can really run')!
    expect(probe.run).toBe('pnpm kernel:probe')
    for (const name of ['Composition gate', 'Behavior battery', 'Cross-repository journey']) {
      expect(steps.some(step => step.name === name)).toBe(true)
    }
    // The packed artifact gates run on every OS.
    expect(steps.some(step => step.run === 'pnpm pack:check')).toBe(true)
    expect(steps.some(step => (step.run ?? '').includes('pnpm smoke:packed'))).toBe(true)
  })

  it('streams and captures the behavior smoke, and uploads smoke logs unconditionally', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const steps = ci.jobs.verify.steps as Array<{ name?: string; if?: string; run?: string; shell?: string; uses?: string }>
    const behavior = steps.find(step => step.name === 'Behavior battery')!
    expect(behavior.shell).toBe('bash')
    expect(behavior.run).toContain('set -o pipefail')
    expect(behavior.run).toContain('tee smoke-behavior.log')
    const smokeUpload = steps.find(step => step.name === 'Upload the smoke logs')!
    expect(smokeUpload.if).toBe('always()')
    const testUpload = steps.find(step => step.name === 'Upload the test log')!
    expect(testUpload.if).toBe('always()')
  })

  it('ends with a gate job that fails unless every upstream job is exactly success', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const gate = ci.jobs.gate
    expect(gate).toBeDefined()
    expect(gate.needs).toEqual(['releases', 'verify'])
    expect(gate.if).toBe('always()')
    const body = (gate.steps as Array<{ run?: string }>).map(step => step.run ?? '').join('\n')
    expect(body).toContain('needs.releases.result')
    expect(body).toContain('needs.verify.result')
    // A skipped or cancelled matrix must never read as green.
    expect(body).toContain('"success"')
  })

  it('drops stale push branches and keeps main', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const push = ci.on?.push ?? ci.true?.push
    const branches = (push?.branches ?? []) as string[]
    expect(branches).toContain('main')
    expect(branches).not.toContain('feat/dsh-0.2.1-alpha.2-compat')
  })
})


describe('release workflow gating', () => {
  it('publishes only after the reusable CI gate, and verifies the pack through check-pack', () => {
    const release = parse(read('.github/workflows/release.yml'))
    // publish depends on the reusable workflow call; the gate job INSIDE
    // ci.yml is what makes that call fail on a skipped or cancelled matrix.
    expect(release.jobs.verify.uses).toBe('./.github/workflows/ci.yml')
    expect(release.jobs.publish.needs).toBe('verify')
    const body = (release.jobs.publish.steps as Array<{ run?: string }>).map(step => step.run ?? '').join('\n')
    expect(body).toContain('node scripts/check-pack.mjs')
    expect(body).not.toContain('tar -tzf')
    // The shipped runner is required, not optional: it is what confines the
    // multi-root pwsh write on Windows.
    expect(read('scripts/check-pack.mjs')).toContain('package/lib/windows-runner.js')
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
