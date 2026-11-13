/** Read-only verification of the main push CI for an annotated tag's commit. */
import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const workflowPath = '.github/workflows/ci.yml'
const pendingStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending'])

async function list(get, path, key, params = new URLSearchParams()) {
  const results = []
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams(params)
    query.set('page', String(page))
    query.set('per_page', '100')
    const response = await get(`${path}?${query}`)
    if (!Array.isArray(response[key]) || !Number.isSafeInteger(response.total_count)) {
      throw new Error(`Invalid Actions API response for ${path}`)
    }
    results.push(...response[key])
    if (results.length === response.total_count) return results
    if (response[key].length !== 100 || results.length > response.total_count) break
  }
  throw new Error(`Could not read all Actions API results for ${path}`)
}

export async function waitForMainCI(commit, {
  get,
  report = console.log,
  pause = () => sleep(30_000),
  now = Date.now,
  timeoutMs = 90 * 60_000,
}) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Expected a full commit SHA')
  const deadline = now() + timeoutMs
  const workflow = await get('/actions/workflows/ci.yml')
  if (workflow.path !== workflowPath || !Number.isSafeInteger(workflow.id)) {
    throw new Error('Could not identify ci.yml in this repository')
  }
  const matches = run => run.workflow_id === workflow.id
    && run.path?.split('@')[0] === workflowPath
    && run.event === 'push'
    && run.head_branch === 'main'
    && run.head_sha === commit

  let runId
  let reportedAttempt
  report(`Looking for ci.yml push to main at ${commit}`)
  while (now() < deadline) {
    let run
    if (runId === undefined) {
      const params = new URLSearchParams({ branch: 'main', event: 'push', head_sha: commit })
      const runs = await list(get, `/actions/workflows/${workflow.id}/runs`, 'workflow_runs', params)
      run = runs.filter(matches).sort((a, b) => b.id - a.id)[0]
    } else {
      run = await get(`/actions/runs/${runId}`)
      if (run.id !== runId || !matches(run)) throw new Error(`CI run ${runId} no longer matches the tag commit`)
    }
    if (run !== undefined) {
      if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        throw new Error('Missing CI run ID or attempt')
      }
      runId = run.id
      const attempt = run.run_attempt
      const link = `${run.html_url}/attempts/${attempt}`
      if (attempt !== reportedAttempt) {
        report(`Matched CI run ${runId}, attempt ${attempt}: ${link}`)
        reportedAttempt = attempt
      }
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(`CI run ${runId}, attempt ${attempt} concluded ${run.conclusion}`)
        }
        const jobs = await list(get, `/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs')
        const gates = jobs.filter(job => job.name === 'gate')
        if (gates.length !== 1 || gates[0].run_id !== runId || gates[0].run_attempt !== attempt
          || gates[0].head_sha !== commit || gates[0].status !== 'completed' || gates[0].conclusion !== 'success') {
          throw new Error(`CI run ${runId}, attempt ${attempt} has no successful final gate`)
        }
        // A rerun may have started between reading the run and listing its jobs.
        const current = await get(`/actions/runs/${runId}`)
        if (current.id !== runId || !matches(current)) throw new Error(`CI run ${runId} changed identity`)
        if (current.run_attempt === attempt && current.status === 'completed' && current.conclusion === 'success'
          && now() < deadline) {
          report(`Verified CI run ${runId}, attempt ${attempt}, gate ${gates[0].id}: ${link}`)
          return { runId, attempt, link }
        }
      } else if (!pendingStatuses.has(run.status)) {
        throw new Error(`Unexpected status ${run.status} for CI run ${runId}`)
      }
    }
    await pause()
  }
  throw new Error(`Timed out waiting for successful main push CI at ${commit}${runId === undefined ? '' : ` (run ${runId})`}`)
}

async function main() {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN, GITHUB_STEP_SUMMARY } = process.env
  if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GH_TOKEN) throw new Error('Missing Actions API configuration')
  const get = async path => {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GH_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Actions API ${path}: HTTP ${response.status}`)
    return response.json()
  }
  await waitForMainCI(process.argv[2], {
    get,
    report(message) {
      console.log(message)
      if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${message}\n\n`)
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
