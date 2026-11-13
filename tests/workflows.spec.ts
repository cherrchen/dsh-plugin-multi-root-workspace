import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'
import { waitForMainCI } from '../scripts/verify-release-ci.mjs'

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
    expect(ci).toContain("'[\"ubuntu-latest\",\"ubuntu-22.04\",\"macos-latest\"]'")
  })

  it('runs 0.2.2+ matrix releases on Node 24 while older releases stay on 22', () => {
    const ci = read('.github/workflows/ci.yml')
    // Releases through 0.2.1 run on Node 22; 0.2.2 declares engines
    // node >=24.9 — so the expression names the releases that keep 22.19.0
    // and defaults every newer release (a stable 0.2.2 included) to 24.9.0.
    expect(ci).toContain("node-version: ${{ (startsWith(matrix.dsh, '0.1.') || startsWith(matrix.dsh, '0.2.0') || startsWith(matrix.dsh, '0.2.1')) && '22.19.0' || '24.9.0' }}")
    const upgrade = read('.github/workflows/upgrade.yml')
    // The upgrade lane probes the newest prerelease, which requires 24.9.
    expect(upgrade).toContain('node-version: 24.9.0')
    expect(upgrade).not.toContain('node-version: 22.19.0')
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

  it('bounds packed smoke while preserving time for logs and broker cleanup', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const packed = ci.jobs.verify.steps.find((step: { name?: string }) => step.name === 'Packed smoke')
    expect(packed['timeout-minutes']).toBe(15)
    expect(ci.jobs.verify['timeout-minutes']).toBe(45)
    const uninstall = ci.jobs.verify.steps.find((step: { name?: string }) =>
      step.name === 'Uninstall the B9 broker and revoke installation rights')
    expect(uninstall.if).toBe("always() && runner.os == 'Windows'")
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
  it('publishes the verified commit and verifies the pack through check-pack', () => {
    const release = parse(read('.github/workflows/release.yml'))
    expect(parse(read('.github/workflows/ci.yml')).on.workflow_call).toBeUndefined()
    expect(release.on.push.tags).toEqual(['v*'])
    expect(release.on.workflow_dispatch).toBeUndefined()
    expect(release.jobs.verify.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(release.jobs.verify.steps.find((step: { id?: string }) => step.id === 'tag').run)
      .toContain('${GITHUB_REF}^{tag}')
    expect(release.jobs.verify.steps.some((step: { run?: string }) =>
      step.run?.includes('node scripts/verify-release-ci.mjs'))).toBe(true)
    expect(release.jobs.publish.steps[0].with.ref).toBe('${{ needs.verify.outputs.commit }}')
    expect(release.jobs.publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' })
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

describe('main push CI evidence for release', () => {
  const commit = 'a'.repeat(40)
  const path = '.github/workflows/ci.yml'
  const run = {
    id: 73, workflow_id: 42, path, event: 'push', head_branch: 'main', head_sha: commit,
    run_attempt: 2, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/73',
  }
  const gate = { id: 82, name: 'gate', run_id: 73, run_attempt: 2, head_sha: commit, status: 'completed', conclusion: 'success' }
  const runsPath = '/actions/workflows/42/runs?branch=main&event=push&head_sha=' + commit + '&page=1&per_page=100'
  const jobsPath = '/actions/runs/73/attempts/2/jobs?page=1&per_page=100'

  function fakeApi({
    listings = [[run]], details = [run], jobs = [gate],
  }: { listings?: Array<Array<typeof run>>; details?: Array<typeof run>; jobs?: Array<typeof gate> } = {}) {
    const calls: string[] = []
    const log: string[] = []
    let time = 0
    let listing = 0
    let detail = 0
    const result = waitForMainCI(commit, {
      now: () => time,
      timeoutMs: 4,
      pause: async () => { time++ },
      report: (message: string) => { log.push(message) },
      async get(url: string) {
        calls.push(url)
        if (url === '/actions/workflows/ci.yml') return { id: 42, path }
        if (url === runsPath) {
          const workflow_runs = listings[Math.min(listing++, listings.length - 1)]!
          return { workflow_runs, total_count: workflow_runs.length }
        }
        if (url === jobsPath) return { jobs, total_count: jobs.length }
        if (url === '/actions/runs/73') return details[Math.min(detail++, details.length - 1)]
        throw new Error('Unexpected request ' + url)
      },
    })
    return { result, calls, log }
  }

  it('accepts an already successful run and gate for the exact attempt immediately', async () => {
    const { result, calls, log } = fakeApi()
    await expect(result).resolves.toMatchObject({ runId: 73, attempt: 2 })
    expect(calls).toEqual(['/actions/workflows/ci.yml', runsPath, jobsPath, '/actions/runs/73'])
    expect(log.join('\n')).toContain('https://github.com/o/r/actions/runs/73/attempts/2')
  })

  it('waits when the tag arrives before main CI appears and completes', async () => {
    const running = { ...run, status: 'in_progress', conclusion: '' }
    const { result, calls } = fakeApi({ listings: [[], [running]], details: [running, run] })
    await expect(result).resolves.toMatchObject({ attempt: 2 })
    expect(calls.filter(url => url === runsPath)).toHaveLength(2)
    expect(calls.filter(url => url === jobsPath)).toHaveLength(1)
  })

  it('rejects other SHAs, PRs, dispatches, branches and workflows even if the API returns them', async () => {
    const { result, calls } = fakeApi({ listings: [[
      { ...run, head_sha: 'b'.repeat(40) }, { ...run, event: 'pull_request' },
      { ...run, event: 'workflow_dispatch' }, { ...run, head_branch: 'feature' },
      { ...run, workflow_id: 43 }, { ...run, path: '.github/workflows/other.yml' },
    ]] })
    await expect(result).rejects.toThrow('Timed out')
    expect(calls).not.toContain(jobsPath)
  })

  it.each(['failure', 'cancelled', 'skipped'])('blocks a CI run concluded %s', async conclusion => {
    const { result, calls } = fakeApi({ listings: [[{ ...run, conclusion }]] })
    await expect(result).rejects.toThrow('concluded ' + conclusion)
    expect(calls).not.toContain(jobsPath)
  })

  it.each([[], [{ ...gate, conclusion: 'failure' }], [{ ...gate, conclusion: 'cancelled' }],
    [{ ...gate, conclusion: 'skipped' }], [{ ...gate, run_attempt: 1 }], [gate, gate],
  ].map(jobs => ({ jobs })))('blocks missing, unsuccessful, stale or duplicate gates ($jobs)', async ({ jobs }) => {
    await expect(fakeApi({ jobs }).result).rejects.toThrow('no successful final gate')
  })

  it('does not authorize a previous success after a rerun has started', async () => {
    const { result } = fakeApi({ details: [{ ...run, run_attempt: 3, status: 'in_progress' }] })
    await expect(result).rejects.toThrow('Timed out')
  })

  it('fails closed on an API error', async () => {
    await expect(waitForMainCI(commit, {
      report() {},
      async get() { throw new Error('Actions API unavailable') },
    })).rejects.toThrow('Actions API unavailable')
  })
})
