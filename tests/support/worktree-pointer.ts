/**
 * Linked-worktree pointer helpers for the Windows lane.
 *
 * Git creates a linked checkout's `.git` as a small `gitdir:` file. On a
 * Windows runner that file can be read-only for the test process, and some
 * setups refuse an in-place rewrite with `EPERM`. The specs only need to
 * replace that pointer, so this helper clears the read-only attribute first
 * and reports a refusal instead of crashing the suite. Reading the admin path
 * from the pointer itself also avoids opening the file through the metadata
 * layer before the rewrite (which is what the feature under test does).
 *
 * @module tests/support/worktree-pointer
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The admin gitdir named by one linked checkout's `.git` pointer. */
export function linkedAdminGitdir(linked: string): string {
  const line = readFileSync(join(linked, '.git'), 'utf8').trim()
  const prefix = 'gitdir: '
  if (!line.startsWith(prefix)) throw new Error('the linked checkout .git is not a gitdir pointer')
  return line.slice(prefix.length)
}

/**
 * Replace one linked checkout's `.git` pointer.
 * @returns `false` when Windows refuses the rewrite with `EPERM`; the caller
 *   skips that case with a reason. Every other failure is rethrown.
 */
export function rewriteGitPointer(linked: string, content: string): boolean {
  const path = join(linked, '.git')
  try { chmodSync(path, 0o666) } catch { /* best effort; the write below decides */ }
  try {
    writeFileSync(path, content)
    return true
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}
