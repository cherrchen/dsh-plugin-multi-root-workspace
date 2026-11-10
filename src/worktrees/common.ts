/**
 * The A candidate: the main checkout of a linked primary's repository.
 *
 * A linked checkout's Git writes go to its admin dir (inside the common) and to
 * the shared objects/refs (also inside the common). The common is normally the
 * main checkout's `.git` directory, so registering the MAIN CHECKOUT grants
 * both the Git metadata and the source tree; `.git` is no longer a root of its
 * own (ADR-0039 §1, nineteenth revision).
 *
 * The candidate is derived from the SAME complete snapshot that proved the
 * primary (pointer chain, config, HEAD, identities); it never starts Git. The
 * main root is `dirname(common)` and is only offered when `<main>/.git` is a
 * real directory that canonicalizes back to the common. For a
 * `--separate-git-dir` store this derivation is ambiguous (the store's parent
 * is not necessarily the main checkout); the prompt discloses that, and the
 * default pool never offers A because `<main>` contains the primary
 * (`primary-overlap`).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/common
 */

import { basename, dirname, join } from 'node:path'
import { samePath } from '../roots.ts'
import { canonicalExisting, directoryIdentity } from './fs-safe.ts'
import type { FileIdentity, RepoSnapshot } from './types.ts'

/** One A candidate: the main checkout root of the primary's repository. */
export interface CommonCandidate {
  readonly kind: 'main-checkout'
  readonly key: string
  /** Canonical main checkout root — the directory the prompt offers. */
  readonly path: string
  /** Canonical shared common git dir — the identity anchor. */
  readonly common: string
  readonly adminId: string
  readonly adminGitdir: string
  readonly adminHead: string
  /** Identity of the main checkout root. */
  readonly rootIdentity: FileIdentity
  readonly adminIdentity: FileIdentity
}

/** The discovery key of one A candidate; the common is the stable anchor. */
export function commonDiscoveryKey(candidate: Pick<CommonCandidate, 'common'>): string {
  return `main-checkout\u0000${candidate.common}`
}

/**
 * Build the A candidate for one primary snapshot, when it is one.
 * @param repo - the primary's complete snapshot.
 * @returns the candidate, or `undefined` when this primary is not a linked checkout.
 */
export function commonCandidate(repo: RepoSnapshot): CommonCandidate | undefined {
  if (repo.shape !== 'linked') return undefined
  if (basename(repo.common) !== '.git') return undefined
  if (repo.adminId === undefined || repo.adminGitdir === undefined || repo.adminHead === undefined) return undefined
  if (repo.adminIdentity === undefined) return undefined
  const mainRoot = dirname(repo.common)
  try {
    // `<main>/.git` must be the same real directory as the common. This is the
    // strongest structural binding available: a `.git` file (separate git dir,
    // submodule) or a symlink is refused, and a replaced directory is caught
    // again by the owner.
    const dotGit = join(mainRoot, '.git')
    if (directoryIdentity(dotGit) === undefined) return undefined
    if (!samePath(canonicalExisting(dotGit), repo.common)) return undefined
    const identity = directoryIdentity(mainRoot)
    if (identity === undefined) return undefined
    return {
      kind: 'main-checkout',
      key: commonDiscoveryKey({ common: repo.common }),
      path: mainRoot,
      common: repo.common,
      adminId: repo.adminId,
      adminGitdir: repo.adminGitdir,
      adminHead: repo.adminHead,
      rootIdentity: identity,
      adminIdentity: repo.adminIdentity,
    }
  } catch {
    // A missing, unreadable, or replaced `.git` is not an A candidate.
    return undefined
  }
}
