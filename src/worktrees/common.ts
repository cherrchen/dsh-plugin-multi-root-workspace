/**
 * The A candidate: the shared common git dir of a linked primary checkout.
 *
 * A linked checkout's own Git writes go to its admin dir (inside the common)
 * and to the shared objects/refs (also inside the common). Registering that
 * directory is what lets a confined `workspace-write` session run
 * `git add` / `git commit` without a Full-access escalation.
 *
 * The candidate is derived from the SAME complete snapshot that proved the
 * primary (pointer chain, config, HEAD, identities); it never starts Git and
 * never guesses a main checkout root. Only a canonical directory whose final
 * component is `.git` is offered (ADR-0039 §1).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/common
 */

import { basename } from 'node:path'
import { directoryIdentity } from './fs-safe.ts'
import type { FileIdentity, RepoSnapshot } from './types.ts'

/** One A candidate. */
export interface CommonCandidate {
  readonly kind: 'git-common'
  readonly key: string
  readonly path: string
  readonly common: string
  readonly adminId: string
  readonly adminGitdir: string
  readonly adminHead: string
  readonly rootIdentity: FileIdentity
  readonly adminIdentity: FileIdentity
}

/** The discovery key of one A candidate. */
export function commonDiscoveryKey(candidate: Pick<CommonCandidate, 'common'>): string {
  return `git-common\u0000${candidate.common}`
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
  const identity = directoryIdentity(repo.common)
  if (identity === undefined) return undefined
  return {
    kind: 'git-common',
    key: commonDiscoveryKey({ common: repo.common }),
    path: repo.common,
    common: repo.common,
    adminId: repo.adminId,
    adminGitdir: repo.adminGitdir,
    adminHead: repo.adminHead,
    rootIdentity: identity,
    adminIdentity: repo.adminIdentity,
  }
}
