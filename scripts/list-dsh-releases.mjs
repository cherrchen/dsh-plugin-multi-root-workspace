/** Emit the CI version axis from the canonical contract, without a build. */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/compat/dsh-version.ts', import.meta.url), 'utf8')
const array = /export const SUPPORTED_DSH_RELEASES = \[([^\]]*)\]/u.exec(source)
if (array === null) throw new Error('SUPPORTED_DSH_RELEASES must remain an array literal')
const releases = [...array[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
if (releases.length === 0 || new Set(releases).size !== releases.length
  || releases.some(version => !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(version))) {
  throw new Error('The compatibility matrix needs unique exact versions')
}
console.log(JSON.stringify(releases))
