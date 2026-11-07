/** Bind G0 evidence to one installation and to the files actually inspected. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')

/** An override may spell the same CLI differently, but must not select another tree. */
export function assertSameRuntime(localCli, requestedCli = localCli) {
  if (realpathSync(localCli) !== realpathSync(requestedCli)) {
    throw new Error('G0_RUNTIME_MISMATCH: DSH_CLI must resolve to this checkout\'s installed dsh; use an independent installation snapshot to test another pin')
  }
  return realpathSync(localCli)
}

export function baselineRuntime(root, override) {
  const local = createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh/lib/bin.js')
  return assertSameRuntime(local, override || local)
}

/** Hash content even when a snapshot is nested inside an unrelated Git worktree. */
export function baselineSource(root) {
  const files = []
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (['node_modules', '.git', '.DS_Store'].includes(entry.name)) continue
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(name)
      else if (entry.isSymbolicLink()) files.push([name, sha256(`symlink:${readlinkSync(join(root, name))}`)])
      else if (entry.isFile()) files.push([name, sha256(readFileSync(join(root, name)))])
    }
  }
  for (const directory of ['src', 'scripts', 'tests']) walk(directory)
  if (files.length === 0) throw new Error('G0_EMPTY_SOURCE: src/scripts/tests contain no source files')
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  let provenance = { kind: 'content-snapshot', sha: null, dirty: null }
  try {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) === realpathSync(root)) {
      provenance = { kind: 'git-worktree', sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' }
    }
  } catch { /* An exported snapshot has content provenance, never an ancestor's commit. */ }
  return { ...provenance, sourceFiles: files.length, sourceSha256: sha256(JSON.stringify(files)) }
}
