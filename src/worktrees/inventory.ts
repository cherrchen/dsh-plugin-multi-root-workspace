/**
 * Controlled enumeration of the worktrees that share one common git dir.
 *
 * `git worktree list` is never run (ADR-0039 §3.1): the admin entries under
 * `<common>/worktrees` are enumerated one by one, every pointer is read through
 * the trusted-fd path, and every candidate must resolve through the SAME full
 * activation snapshot the primary uses. A candidate that fails any check is
 * simply absent — never a prompt, never a write.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/inventory
 */

import { basename, dirname, join } from 'node:path'
import { samePath } from '../roots.ts'
import {
  lstatEntry,
  readDirectory,
  readPointerLine,
  resolvePointerTarget,
  SafeIoError,
} from './fs-safe.ts'
import { resolveRepo } from './repository.ts'
import type { FileIdentity, RepoSnapshot } from './types.ts'

/** One worktree the inventory proved. */
export interface InventoryCandidate {
  readonly kind: 'worktree'
  /** `adminId + NUL + canonical root + NUL + canonical admin gitdir target`. */
  readonly key: string
  readonly path: string
  readonly common: string
  readonly adminId: string
  readonly adminGitdir: string
  /** The canonical path the admin `gitdir` pointer names (the candidate's `.git` file). */
  readonly adminGitdirTarget: string
  readonly adminHead: string
  readonly rootIdentity: FileIdentity
  readonly adminIdentity: FileIdentity
  readonly repo: RepoSnapshot
}

/** The inventory verdict. */
export interface InventoryResult {
  readonly candidates: readonly InventoryCandidate[]
  /** True when the admin cap was exceeded or an entry could not be listed. */
  readonly degraded: boolean
}

/** A valid `worktrees/<id>` name. */
function validAdminId(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

/** Read `<admin>/gitdir`, resolve it against the admin dir, and return its target. */
function adminTarget(admin: string): string {
  const pointer = join(admin, 'gitdir')
  const entry = lstatEntry(pointer)
  if (entry === undefined) throw new SafeIoError('missing', `${pointer} does not exist`)
  if (entry === 'symlink' || entry !== 'file') throw new SafeIoError('not-file', `${pointer} is not a regular file`)
  return resolvePointerTarget(admin, readPointerLine(pointer))
}

/**
 * Enumerate every worktree of one common git dir. The watcher cap is applied by
 * the workspace, NOT here: discovery must never silently drop a candidate just
 * because the host cannot afford one watcher per admin.
 * @param common - canonical common git dir.
 * @param platform - platform override for tests.
 * @returns every candidate that passed the full snapshot, and whether listing degraded.
 */
export function inventoryWorktrees(
  common: string,
  platform: NodeJS.Platform = process.platform,
): InventoryResult {
  const directory = join(common, 'worktrees')
  const entry = lstatEntry(directory)
  if (entry === undefined) return { candidates: [], degraded: false }
  if (entry === 'symlink' || entry !== 'directory') return { candidates: [], degraded: true }
  let names: string[]
  try {
    names = readDirectory(directory)
  } catch {
    return { candidates: [], degraded: true }
  }
  names = names.filter(validAdminId).sort()
  const degraded = false
  const candidates: InventoryCandidate[] = []
  for (const name of names) {
    const admin = join(directory, name)
    try {
      const adminEntry = lstatEntry(admin)
      if (adminEntry === undefined || adminEntry === 'symlink' || adminEntry !== 'directory') continue
      const target = adminTarget(admin)
      if (basename(target) !== '.git') continue
      const root = dirname(target)
      const result = resolveRepo(root, { platform })
      if (!result.ok) continue
      const repo = result.repo
      if (repo.shape !== 'linked') continue
      // The candidate must resolve through the SAME admin entry that was just
      // enumerated, in the SAME common. Comparing only the admin NAME lets one
      // repository plant an admin entry whose `gitdir` points at an unrelated
      // repository's linked checkout with the same name.
      if (!samePath(repo.common, common)) continue
      if (!samePath(repo.adminGitdir ?? '', admin)) continue
      if (!samePath(repo.canonical, dirname(target))) continue
      if (repo.adminId !== name) continue
      if (repo.adminGitdir === undefined || repo.adminHead === undefined || repo.adminIdentity === undefined) continue
      candidates.push({
        kind: 'worktree',
        key: `${name}\u0000${repo.canonical}\u0000${target}`,
        path: repo.canonical,
        common: repo.common,
        adminId: name,
        adminGitdir: repo.adminGitdir,
        adminGitdirTarget: target,
        adminHead: repo.adminHead,
        rootIdentity: repo.rootIdentity,
        adminIdentity: repo.adminIdentity,
        repo,
      })
    } catch {
      // An unreadable admin is skipped, never guessed at.
    }
  }
  return { candidates, degraded }
}
