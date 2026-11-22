import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AUTO_REVIEW_CONTRACT_DATA } from '../lib/auto-review-development.mjs'

/**
 * The Node version one exact DSH release requires.
 *
 * DSH 0.2.0/0.2.1 run on the 22.19 baseline like 0.1.*; 0.2.2 raises the floor
 * to Node >= 24.9.0; from 0.2.3 the upstream engine floor is
 * `^24.22.3 || >=26.13.1` (the first Node releases whose bundled undici carries
 * the November 2026 security fixes), so every later line runs on 24.22.3.
 * @param version - one exact release from the canonical contract.
 * @returns the Node version that release is installed and verified on.
 */
export const nodeForRelease = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (match === null) throw new Error(`not an exact release: ${version}`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (major === 0 && minor <= 1) return '22.19.0'
  if (major === 0 && minor === 2) {
    if (patch <= 1) return '22.19.0'
    if (patch === 2) return '24.9.0'
  }
  return '24.22.3'
}

export function planMatrix(windows) {
  const list = fileURLToPath(new URL('../list-dsh-releases.mjs', import.meta.url))
  const releases = JSON.parse(execFileSync(process.execPath, [list], { encoding: 'utf8' }))
  for (const reviewRelease of AUTO_REVIEW_CONTRACT_DATA.releases) {
    if (!releases.includes(reviewRelease)) throw new Error(`The CI plan must include every joint Auto Review release: ${reviewRelease}`)
  }
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
