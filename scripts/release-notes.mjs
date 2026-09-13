/** Generate categorized release notes from conventional commits: `node scripts/release-notes.mjs <tag>`. */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const USAGE = 'Usage: node scripts/release-notes.mjs <tag>   (e.g. v0.1.0; prints markdown to stdout)'

// Conventional commit type -> release-notes section, in output order.
const SECTIONS = [
  { types: ['feat'], title: 'Features' },
  { types: ['fix'], title: 'Bug Fixes' },
  { types: ['perf', 'refactor'], title: 'Improvements' },
  { types: ['docs'], title: 'Documentation' },
  { types: [], title: 'Other Changes' },
]

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout
}

function previousTag(tag) {
  // The newest existing tag that is not the released one; empty for the first release.
  const tags = runGit(['tag', '--sort=-creatordate']).split('\n').map((t) => t.trim()).filter((t) => t !== '' && t !== tag)
  return tags[0] ?? ''
}

function repositoryUrl() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const url = manifest.repository?.url ?? ''
  if (!url.includes('github.com')) throw new Error('package.json repository.url must point at GitHub for release note links')
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

// `%x00` separators keep subjects with unusual characters intact.
const RECORD_SEPARATOR = '\u0000'
const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/

function commits(range) {
  const output = runGit(['log', '--pretty=%H%x00%s', range])
  return output.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [hash, subject] = line.split(RECORD_SEPARATOR)
    return { hash, subject }
  })
}

function render(tag, repoUrl, list) {
  const lines = [`## ${tag}`]
  for (const section of SECTIONS) {
    const entries = list.filter((entry) => {
      const match = entry.subject.match(CONVENTIONAL)
      if (match === null) return section.types.length === 0
      if (section.types.length === 0) return !SECTIONS.some((s) => s.types.includes(match[1]))
      return section.types.includes(match[1])
    })
    if (entries.length === 0) continue
    lines.push('', `### ${section.title}`, '')
    for (const entry of entries) {
      const match = entry.subject.match(CONVENTIONAL)
      if (match === null) {
        lines.push(`- ${entry.subject} ([\`${entry.hash.slice(0, 7)}\`](${repoUrl}/commit/${entry.hash}))`)
        continue
      }
      const scope = match[2] !== undefined ? `**${match[2]}**: ` : ''
      const breaking = match[3] === '!' ? '⚠️ **Breaking:** ' : ''
      lines.push(`- ${breaking}${scope}${match[4]} ([\`${entry.hash.slice(0, 7)}\`](${repoUrl}/commit/${entry.hash}))`)
    }
  }
  return lines.join('\n') + '\n'
}

function main() {
  const tag = process.argv[2]
  if (tag === undefined || tag === '' || process.argv.includes('--help')) throw new Error(USAGE)

  const previous = previousTag(tag)
  const range = previous === '' ? tag : `${previous}..${tag}`
  const list = commits(range)
  if (list.length === 0) throw new Error(`No commits found in range ${range}`)

  const repoUrl = repositoryUrl()
  let notes = render(tag, repoUrl, list)
  if (previous !== '') {
    notes += `\n**Full Changelog**: ${repoUrl}/compare/${previous}...${tag}\n`
  }
  process.stdout.write(notes)
}

try {
  main()
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
}
