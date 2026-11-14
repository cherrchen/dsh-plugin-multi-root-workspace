import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'
import { waitForMainCI } from '../scripts/verify-release-ci.mjs'
import { planMatrix, nodeForRelease } from '../scripts/ci/plan.mjs'
import { artifactName, verifyResults } from '../scripts/ci/gate.mjs'
import ubuntuOnly from '../scripts/ci/ubuntu-only.json' with { type: 'json' }

const read = (path: string): string => readFileSync(path, 'utf8')

describe('CI workflow gates', () => {
  it.each([true, false])('schedules each exact release once per enabled image (Windows: %s)', windows => {
    const matrix = planMatrix(windows)
    const images = ['ubuntu-latest', 'ubuntu-22.04', 'macos-latest', ...(windows ? ['windows-latest'] : [])]
    const releasesByNode = Map.groupBy(SUPPORTED_DSH_RELEASES, nodeForRelease)
    const groupsPerImage = [...releasesByNode.values()].reduce((count, versions) => count + Math.ceil(versions.length / 4), 0)
    expect([...new Set(matrix.map(entry => entry.os))]).toEqual(images)
    for (const os of images) {
      const groups = matrix.filter(entry => entry.os === os)
      expect(groups.flatMap(entry => entry.versions).sort()).toEqual([...SUPPORTED_DSH_RELEASES].sort())
      expect(new Set(groups.map(artifactName)).size).toBe(groups.length)
      expect(groups.length).toBe(groupsPerImage)
      for (const group of groups) {
        expect(group.versions.length).toBeGreaterThan(0)
        expect(group.versions.length).toBeLessThanOrEqual(4)
        expect(new Set(group.versions.map(nodeForRelease))).toEqual(new Set([group.node]))
      }
    }
  })

  it('keeps the 22 and 24 Node lanes and expands the plan in the read-only workflow', () => {
    for (const version of ['0.1.5-rc.2', '0.2.0', '0.2.1-rc.5']) expect(nodeForRelease(version)).toBe('22.19.0')
    for (const version of ['0.2.2-rc.2', '0.2.2', '0.2.10', '1.0.0']) expect(nodeForRelease(version)).toBe('24.9.0')
    const ci = parse(read('.github/workflows/ci.yml'))
    expect(ci.on.workflow_dispatch).toBeNull()
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(ci.jobs.verify.strategy).toEqual({
      'fail-fast': false,
      matrix: '${{ fromJSON(needs.releases.outputs.matrix) }}',
    })
    expect(ci.jobs.verify.steps.find((step: { uses?: string }) => step.uses === 'actions/setup-node@v4').with['node-version'])
      .toBe('${{ matrix.node }}')
    expect(ci.jobs.releases.steps.find((step: { id?: string }) => step.id === 'contract').env.DSH_WINDOWS_CI)
      .toBe('${{ vars.DSH_WINDOWS_CI }}')
    const upgrade = read('.github/workflows/upgrade.yml')
    expect(upgrade).toContain('node-version: 24.9.0')
    expect(upgrade.indexOf('run: pnpm kernel:probe')).toBeLessThan(upgrade.indexOf('run: pnpm test'))
  })

  it('keeps native and mixed suites, and runs all install and journey smokes on every image', () => {
    expect(ubuntuOnly).toEqual(expect.arrayContaining(['tests/client-*.spec.{ts,tsx}', 'tests/workflows.spec.ts']))
    for (const prefix of ['authority-', 'registry', 'shared-', 'windows-', 'worktrees-git', 'working-directory',
      'parity-matrix', 'sandbox-multi-root', 'tool-access', 'upstream-additional-roots', 'skills-linux',
      'skills-windows', 'lsp-workspaces', 'profile-isolation', 'auto-review/']) {
      expect(ubuntuOnly.some(pattern => pattern.startsWith('tests/' + prefix))).toBe(false)
    }
    const runner = read('scripts/ci/run-group.mjs')
    expect(runner).toContain("['registry:probe', '--required']")
    expect(runner.indexOf("['kernel:probe']")).toBeLessThan(runner.indexOf("await step('vitest'"))
    expect(runner).toContain('{ ...env, GITHUB_ENV: probe }')
    for (const script of ['smoke:compose', 'smoke:behavior', 'smoke:journey', 'pack:check', 'smoke:packed', 'smoke:auto-review']) {
      expect(runner).toContain("['" + script + "'")
    }
  })

  it('derives the upgrade set from the package manifest', () => {
    const workflow = read('.github/workflows/upgrade.yml')
    expect(workflow).toContain('node scripts/upgrade-dsh.mjs')
    expect(workflow).not.toContain('@deepseek-ai/dsh-client-ui-renderer@')
    const script = read('scripts/upgrade-dsh.mjs')
    expect(script).toContain('manifest.devDependencies')
    expect(script).toContain("name.startsWith('@deepseek-ai/dsh-')")
  })

  it('checks exact installations before building and runs shared static checks once', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const commands = ci.jobs.releases.steps.flatMap((step: { run?: string }) => step.run ? [step.run] : [])
    expect(commands).toEqual([
      'node scripts/ci/plan.mjs', 'pnpm install --frozen-lockfile', 'pnpm compat:check', 'pnpm lint',
      'pnpm docs:check',
    ])
    const runner = read('scripts/ci/run-group.mjs')
    expect(runner).toContain("version === pin ? '--frozen-lockfile' : '--no-frozen-lockfile'")
    expect(runner).toContain("['scripts/upgrade-dsh.mjs', version]")
    expect(runner.indexOf("['compat:check']")).toBeLessThan(runner.indexOf("['build']"))
    expect(runner).toContain("if (full && jointRelease) await step('auto-review-fork'")
    expect(runner).toContain("if (jointRelease) await step('smoke-auto-review'")
    expect(runner).toContain("const jointRelease = AUTO_REVIEW_CONTRACT_DATA.releases.includes(version)")
    expect(runner).not.toContain('DSH_MULTI_ROOT_COMPAT')
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

  it('serializes Windows versions and cleans up the broker before uploading even after failure', () => {
    const ci = parse(read('.github/workflows/ci.yml'))
    const steps = ci.jobs.verify.steps as Array<{ name?: string; if?: string; uses?: string }>
    const install = steps.findIndex(step => step.name === 'Install the B9 deny-token broker')
    const verify = steps.findIndex(step => step.name === 'Verify exact releases in isolated checkouts')
    const uninstall = steps.findIndex(step => step.name === 'Uninstall the B9 broker and revoke installation rights')
    const upload = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4')
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(verify)
    expect(verify).toBeLessThan(uninstall)
    expect(uninstall).toBeLessThan(upload)
    expect(steps[uninstall]!.if).toBe("always() && runner.os == 'Windows'")
    expect(steps[upload]!.if).toBe('always()')
    const runner = read('scripts/ci/run-group.mjs')
    expect(runner).toContain('const concurrent = full ? 2 : 1')
    expect(runner).toContain("['smoke:packed'], 15")
  })

  it('ends with an always-run gate requiring success of both jobs and every planned combination', () => {
    const gate = parse(read('.github/workflows/ci.yml')).jobs.gate
    expect(gate.needs).toEqual(['releases', 'verify'])
    expect(gate.if).toBe('always()')
    expect(gate.steps.at(-1).env).toEqual({
      CI_MATRIX: '${{ needs.releases.outputs.matrix }}',
      PLAN_RESULT: '${{ needs.releases.result }}',
      VERIFY_RESULT: '${{ needs.verify.result }}',
    })
    const plan = planMatrix(true)
    const sha = 'a'.repeat(40)
    const records = plan.flatMap(entry => entry.versions.map(version => ({
      artifact: artifactName(entry),
      record: { ...entry, version, sha, status: 'success' },
    })))
    expect(verifyResults(plan, sha, records)).toBe(SUPPORTED_DSH_RELEASES.length * 4)
    const [first, ...rest] = records
    expect(() => verifyResults(plan, sha, rest)).toThrow('Missing result')
    expect(() => verifyResults(plan, sha, [...records, first])).toThrow('duplicate result')
    expect(() => verifyResults(plan, sha, records.map(result => ({
      ...result, record: { ...result.record, status: 'cancelled' },
    })))).toThrow('Unsuccessful or mismatched result')
    expect(() => verifyResults(plan, 'b'.repeat(40), records)).toThrow('Unsuccessful or mismatched result')
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
    const resolveTag = release.jobs.verify.steps
      .find((step: { id?: string }) => step.id === 'tag') as { run: string }
    expect(resolveTag.run).toContain('git fetch --force --no-tags origin')
    expect(resolveTag.run).toContain('${GITHUB_REF}^{tag}')
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

  it('restores the annotated tag object that checkout points at the commit', () => {
    const release = parse(read('.github/workflows/release.yml'))
    const resolve = release.jobs.verify.steps
      .find((step: { id?: string }) => step.id === 'tag') as { run: string }
    const dir = mkdtempSync(join(tmpdir(), 'dsh-release-tag-'))
    try {
      const origin = join(dir, 'origin.git')
      execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' })
      const work = join(dir, 'work')
      execFileSync('git', ['init', '-q', work], { stdio: 'pipe' })
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: work, stdio: 'pipe' }).toString().trim()
      git('config', 'user.email', 'ci@example.com')
      git('config', 'user.name', 'CI')
      git('config', 'commit.gpgsign', 'false')
      git('config', 'tag.gpgsign', 'false')
      git('remote', 'add', 'origin', origin)
      writeFileSync(join(work, 'file.txt'), 'release\n')
      git('add', '.')
      git('commit', '-q', '-m', 'release')
      const commit = git('rev-parse', 'HEAD')
      git('tag', '-a', 'v0.1.19', '-m', 'v0.1.19')
      git('push', '-q', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v0.1.19')
      // actions/checkout re-points the tag ref at the commit it checked out.
      git('update-ref', 'refs/tags/v0.1.19', commit)
      expect(() => git('rev-parse', '--verify', 'refs/tags/v0.1.19^{tag}')).toThrow()
      const output = join(dir, 'github-output')
      writeFileSync(output, '')
      execFileSync('bash', ['-e', '-c', resolve.run], {
        cwd: work,
        env: {
          ...process.env,
          GITHUB_REF: 'refs/tags/v0.1.19',
          GITHUB_SHA: commit,
          GITHUB_OUTPUT: output,
        },
        stdio: 'pipe',
      })
      expect(readFileSync(output, 'utf8').trim()).toBe(`commit=${commit}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
