import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { autoReviewRelease } from '../lib/auto-review-development.mjs'

export const nodeForRelease = version => /^(?:0\.1\.|0\.2\.[01](?:-|$))/u.test(version) ? '22.19.0' : '24.9.0'

export function planMatrix(windows) {
  const list = fileURLToPath(new URL('../list-dsh-releases.mjs', import.meta.url))
  const releases = JSON.parse(execFileSync(process.execPath, [list], { encoding: 'utf8' }))
  const reviewPin = autoReviewRelease(readFileSync(new URL('../../src/compat/auto-review-contract.ts', import.meta.url), 'utf8'))
  if (!releases.includes(reviewPin)) throw new Error('The CI plan must include the exact Auto Review baseline')
  const images = ['ubuntu-latest', 'ubuntu-22.04', 'macos-latest']
  if (windows) images.push('windows-latest')

  const byNode = Map.groupBy(releases, nodeForRelease)
  const groups = []
  for (const [node, versions] of byNode) {
    for (let start = 0; start < versions.length; start += 4) {
      groups.push({ group: groups.length + 1, node, versions: versions.slice(start, start + 4) })
    }
  }
  return images.flatMap(os => groups.map(group => ({ os, ...group })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matrix = JSON.stringify({ include: planMatrix(process.env.DSH_WINDOWS_CI === '1') })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`)
  else console.log(matrix)
}
