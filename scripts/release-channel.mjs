/** Derive the npm dist-tag and GitHub release channel from `package.json`'s version.
 *
 * A stable version publishes under `latest` and creates a normal GitHub
 * release. A prerelease publishes under its own identifier (`0.1.24-beta.1`
 * -> `beta`, `0.2.0-rc.2` -> `rc`) and creates a GitHub prerelease, so the
 * stable line keeps both the npm `latest` tag and the GitHub "latest release".
 *
 * The CLI form writes GitHub Actions step outputs:
 *
 *   node scripts/release-channel.mjs >> "$GITHUB_OUTPUT"
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
// npm dist-tags are URL-safe identifiers and must not read as a version, so a
// numeric or otherwise unusable prerelease identifier falls back to `next`.
const USABLE_TAG = /^[a-z][a-z0-9._-]*$/

export function isPrerelease(version) {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`Not a valid semver version: ${version}`)
  return match[4] !== undefined
}

export function distTagFor(version) {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`Not a valid semver version: ${version}`)
  if (match[4] === undefined) return 'latest'
  const identifier = match[4].split('.')[0]
  return USABLE_TAG.test(identifier) ? identifier : 'next'
}

function main() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = manifest.version
  console.log(`tag=${distTagFor(version)}`)
  console.log(`prerelease=${isPrerelease(version) ? 'true' : 'false'}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
