/**
 * Owner-side re-verification of one prompt's snapshot.
 *
 * The prompt's `expected` is captured when the candidate is enqueued; the
 * Registry owner re-runs the COMPLETE check inside its serialized queue right
 * before it writes (ADR-0039 §6.3): the full primary activation judgment
 * (ancestor chain included), the candidate's own activation judgment, the
 * primary/common/admin HEAD syntax, and the checkout/admin directory
 * identities. Any difference is `worktree/prompt-stale`.
 *
 * This module starts no Git process and reads no commit object.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/owner
 */

import { basename } from 'node:path'
import { primaryKey, samePath } from '../roots.ts'
import { directoryIdentity } from './fs-safe.ts'
import { resolveRepo, identityMatches } from './repository.ts'
import type { FileIdentity, PromptExpected, RepoSnapshot } from './types.ts'

/** One owner verdict. */
export type ExpectedVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string }

function stale(detail: string): ExpectedVerdict { return { ok: false, detail } }

function sameOptionalPath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return samePath(left, right)
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return identityMatches(left, right)
}

function primaryMatches(repo: RepoSnapshot, expected: PromptExpected['primary']): boolean {
  return repo.shape === expected.shape
    && samePath(repo.canonical, expected.canonical)
    && samePath(repo.common, expected.common)
    && (repo.adminId ?? '') === (expected.adminId ?? '')
    && sameOptionalPath(repo.adminGitdir, expected.adminGitdir)
    && (repo.adminHead ?? '') === (expected.adminHead ?? '')
    && sameIdentity(repo.rootIdentity, expected.rootIdentity)
    && sameIdentity(repo.adminIdentity, expected.adminIdentity)
}

/**
 * Whether one workspace's primary checkout still passes the complete
 * activation judgment. Cleanup and sidecar mutations use this before they
 * write: an inactive workspace has no dedicated worktree actions (ADR-0039
 * §4.4 / §6.4).
 * @param primaryRoot - the Registry key's workspace root.
 * @returns whether the primary still activates, or why it does not.
 */
export function verifyWorkspaceActive(primaryRoot: string): ExpectedVerdict {
  const primary = resolveRepo(primaryRoot)
  if (!primary.ok) return stale('the primary checkout no longer activates: ' + primary.reason + ': ' + primary.detail)
  return { ok: true }
}

/**
 * Re-verify one prompt expectation against the current filesystem.
 * @param primaryRoot - the Registry key's workspace root.
 * @param expected - the snapshot captured at enqueue time.
 * @returns whether it still holds, or why it does not.
 */
export function verifyPromptExpected(primaryRoot: string, expected: PromptExpected): ExpectedVerdict {
  if (expected.primaryKey !== primaryKey(primaryRoot) || primaryKey(expected.primaryRoot) !== primaryKey(primaryRoot)) {
    return stale('the prompt was captured for another workspace')
  }
  const primary = resolveRepo(primaryRoot)
  if (!primary.ok) return stale('the primary checkout no longer activates: ' + primary.reason + ': ' + primary.detail)
  if (!primaryMatches(primary.repo, expected.primary)) return stale('the primary checkout changed while the prompt was open')
  if (expected.candidate.kind === 'git-common') {
    if (primary.repo.shape !== 'linked' || basename(primary.repo.common) !== '.git') return stale('the primary no longer has an eligible shared common')
    if (!samePath(primary.repo.common, expected.candidate.canonical)) return stale('the shared common git dir changed')
    if (!samePath(primary.repo.common, expected.candidate.common)) return stale('the candidate common does not belong to this workspace')
    if ((primary.repo.adminId ?? '') !== (expected.candidate.adminId ?? '')) return stale('the linked admin changed')
    if (!sameOptionalPath(primary.repo.adminGitdir, expected.candidate.adminGitdir)) return stale('the linked admin moved')
    if ((primary.repo.adminHead ?? '') !== (expected.candidate.adminHead ?? '')) return stale('the admin HEAD changed')
    if (!sameIdentity(primary.repo.adminIdentity, expected.candidate.adminIdentity)) return stale('the linked admin was replaced')
    const identity = directoryIdentity(primary.repo.common)
    if (!sameIdentity(identity, expected.candidate.rootIdentity)) return stale('the shared common git dir was replaced')
    return { ok: true }
  }
  // B is only a sibling checkout of the SAME common. Without this binding a
  // forged expectation could register a worktree of an unrelated repository
  // (even one whose admin name happens to match), so both the primary's common
  // and the candidate's own common must agree.
  if (!samePath(primary.repo.common, expected.candidate.common)) {
    return stale('the candidate worktree does not belong to this workspace common')
  }
  const candidate = resolveRepo(expected.candidate.canonical)
  if (!candidate.ok) return stale('the candidate checkout no longer activates: ' + candidate.reason + ': ' + candidate.detail)
  const repo = candidate.repo
  if (repo.shape !== 'linked') return stale('the candidate is no longer a linked checkout')
  if (!samePath(repo.canonical, expected.candidate.canonical)) return stale('the candidate canonical path changed')
  if (!samePath(repo.common, expected.candidate.common)) return stale('the candidate common git dir changed')
  if (!samePath(repo.common, primary.repo.common)) return stale('the candidate moved to another common git dir')
  if ((repo.adminId ?? '') !== (expected.candidate.adminId ?? '')) return stale('the candidate admin changed')
  if (!sameOptionalPath(repo.adminGitdir, expected.candidate.adminGitdir)) return stale('the candidate admin moved')
  if ((repo.adminHead ?? '') !== (expected.candidate.adminHead ?? '')) return stale('the candidate admin HEAD changed')
  if (!sameIdentity(repo.rootIdentity, expected.candidate.rootIdentity)) return stale('the candidate directory was replaced')
  if (!sameIdentity(repo.adminIdentity, expected.candidate.adminIdentity)) return stale('the candidate admin directory was replaced')
  return { ok: true }
}
