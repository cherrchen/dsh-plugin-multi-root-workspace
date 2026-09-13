/** Upgrade/report every direct DSH dependency declared by this package. */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
const names = Object.keys(declared)
  .filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  .sort()

if (process.argv.includes('--apply')) {
  const version = process.env.DSH_UPGRADE_VERSION
  if (version === undefined || version.trim() === '') throw new Error('DSH_UPGRADE_VERSION is required with --apply')
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(command, ['add', '-D', '-E', ...names.map(name => `${name}@${version}`)], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
} else {
  const current = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const versions = Object.fromEntries(names.map(name => [name, current.devDependencies?.[name]
    ?? current.dependencies?.[name]
    ?? current.peerDependencies?.[name]]))
  console.log(JSON.stringify(versions, null, 2))
}
