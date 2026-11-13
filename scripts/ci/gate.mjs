import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const artifactName = ({ os, group }) => `ci-group-${os}-${group}`

export function verifyResults(plan, sha, records) {
  const expected = new Set(plan.flatMap(entry => entry.versions.map(version => `${artifactName(entry)}/${version}`)))
  if (expected.size === 0) throw new Error('The CI plan is empty')
  const errors = []
  for (const { artifact, record } of records) {
    const key = `${artifact}/${record.version}`
    if (!expected.delete(key)) errors.push(`Unexpected or duplicate result: ${key}`)
    if (record.sha !== sha || artifact !== artifactName(record) || record.status !== 'success') {
      errors.push(`Unsuccessful or mismatched result: ${key} (${record.status})`)
    }
  }
  for (const key of expected) errors.push(`Missing result: ${key}`)
  if (errors.length) throw new Error(errors.join('\n'))
  return records.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir] = process.argv.slice(2)
  const { CI_MATRIX, GITHUB_SHA, PLAN_RESULT, VERIFY_RESULT } = process.env
  if (PLAN_RESULT !== 'success' || VERIFY_RESULT !== 'success') {
    throw new Error(`CI jobs must succeed: releases=${PLAN_RESULT} verify=${VERIFY_RESULT}`)
  }
  const records = readdirSync(dir).flatMap(artifact =>
    readdirSync(join(dir, artifact)).map(version => ({
      artifact,
      record: JSON.parse(readFileSync(join(dir, artifact, version, 'result.json'), 'utf8')),
    })))
  const count = verifyResults(JSON.parse(CI_MATRIX).include, GITHUB_SHA, records)
  console.log(`Verified ${count} successful image × exact release results at ${GITHUB_SHA}`)
}
