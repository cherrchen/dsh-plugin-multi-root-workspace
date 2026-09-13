/** Bump package.json version: `pnpm release <patch|minor|major|prerelease|<version>> [--pre <id>] [--tag]`. */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const USAGE = `Usage:
  node scripts/bump-version.mjs <patch|minor|major|prerelease|<semver>> [--pre <id>] [--tag]

Examples:
  node scripts/bump-version.mjs patch              # 0.1.0 -> 0.1.1
  node scripts/bump-version.mjs minor              # 0.1.0 -> 0.2.0
  node scripts/bump-version.mjs 1.2.3              # set an exact version
  node scripts/bump-version.mjs prerelease --pre rc  # 0.2.0 -> 0.2.0-rc.1
  node scripts/bump-version.mjs patch --tag        # bump, then commit + tag v<version>`

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.[0-9a-zA-Z-]+)*))?$/

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`)
  }
  // No output trim: `git status --porcelain` status codes are two columns
  // wide and the first line may legitimately begin with a space (" M ...").
  return result.stdout
}

function parseArgs(argv) {
  const positional = []
  const options = { pre: undefined, tag: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tag') options.tag = true
    else if (arg === '--pre') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--pre requires an identifier (e.g. --pre rc)\n\n' + USAGE)
      options.pre = value
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n\n${USAGE}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) throw new Error('Exactly one version argument is required\n\n' + USAGE)
  return { bump: positional[0], ...options }
}

function nextVersion(current, bump, pre) {
  if (bump === 'prerelease') {
    const match = current.match(SEMVER)
    if (match === null) throw new Error(`Current version ${current} is not valid semver`)
    const [, major, minor, patch, existing] = match
    if (existing === undefined) {
      return `${major}.${minor}.${Number(patch) + 1}-${pre ?? '1'}.1`
    }
    const [id, num] = existing.split('.')
    const nextId = pre ?? id
    if (nextId !== id) return `${major}.${minor}.${patch}-${nextId}.1`
    return `${major}.${minor}.${patch}-${id}.${Number(num ?? 0) + 1}`
  }

  if (bump === 'patch' || bump === 'minor' || bump === 'major') {
    const match = current.match(SEMVER)
    if (match === null) throw new Error(`Current version ${current} is not valid semver`)
    let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (bump === 'major') { major += 1; minor = 0; patch = 0 }
    else if (bump === 'minor') { minor += 1; patch = 0 }
    else patch += 1
    const suffix = pre !== undefined ? `-${pre}` : ''
    return `${major}.${minor}.${patch}${suffix}`
  }

  if (!SEMVER.test(bump)) {
    throw new Error(`Invalid version or bump kind: ${bump}\n\n${USAGE}`)
  }
  if (bump === current) throw new Error(`Version is already ${bump}`)
  return bump
}

function rewriteVersion(newVersion) {
  const manifestPath = new URL('../package.json', import.meta.url)
  const text = readFileSync(manifestPath, 'utf8')
  const replaced = text.replace(/^(  "version": ")[^"]*(",?)$/m, `$1${newVersion}$2`)
  if (replaced === text) throw new Error('Could not find the "version" field in package.json')
  writeFileSync(manifestPath, replaced)
}

function commitAndTag(version) {
  // Only the release rewrite may be dirty, and untracked files are never
  // committed (they cannot ride along into the release commit).
  const status = runGit(['status', '--porcelain'])
  const foreign = status.split('\n').filter((line) => {
    if (line.trim() === '' || line.startsWith('??')) return false
    const [xy, file] = [line.slice(0, 2), line.slice(3)]
    if (file === 'package.json') return xy === ' D' || xy === 'D ' || xy === 'MD'
    return true
  })
  if (foreign.length > 0) {
    throw new Error('Refusing to tag: the working tree has changes other than package.json:\n' + foreign.join('\n'))
  }
  const tag = `v${version}`
  runGit(['add', 'package.json'])
  runGit(['commit', '-m', `chore(release): ${tag}`])
  runGit(['tag', '-a', tag, '-m', tag])
  console.log(`Committed package.json and created annotated tag ${tag}.`)
  console.log(`Publish it with: git push origin main --follow-tags`)
}

function main() {
  let bump, pre, tag
  try {
    ;({ bump, pre, tag } = parseArgs(process.argv.slice(2)))
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const updated = nextVersion(manifest.version, bump, pre)
    if (tag) {
      // Fail before touching the file if the tag is taken.
      const tagToCheck = `v${updated}`
      if (runGit(['tag', '-l', tagToCheck]).trim() !== '') {
        throw new Error(`Tag ${tagToCheck} already exists`)
      }
    }
    rewriteVersion(updated)
    console.log(`${manifest.version} -> ${updated}`)
    if (tag) commitAndTag(updated)
    else console.log('package.json updated (not committed). Next: commit, then tag v' + updated + ' or rerun with --tag.')
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  }
}

main()
