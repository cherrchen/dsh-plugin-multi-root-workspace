/**
 * Path-containment mechanics for the multi-root filesystem fence.
 *
 * This is a local implementation of the upstream helper
 * `isPathUnder` from `@deepseek-ai/dsh-fs-sandbox` (source path
 * `packages/fs/fs-sandbox/src/containment.ts`, verified byte-identical between
 * dsh `0.1.2-rc.1` and `0.1.5-rc.2` at master `c291e7961a`).
 *
 * Why a copy instead of an import: the published package ships only
 * `lib/index.js` and `lib/types/**\/*.d.ts`, so `exports["./src/*"]` resolves to
 * files that do not exist in an installed tree (deep imports succeed only where
 * the package directory happens to be a symlink into a source checkout). The
 * coupling policy — entry-point imports only — is recorded in
 * `docs/decisions/ADR-0002-upstream-coupling-policy.md`; behavioral equality
 * with the upstream fence is pinned by the differential suite in
 * `tests/fs-parity.spec.ts`.
 *
 * Canonical spellings take the fast lexical path; filesystem identity supplies
 * the conservative fallback for alias-equivalent roots such as Windows 8.3
 * names and casing.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/containment
 */

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

const MISSING_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return MISSING_CODES.has(code)
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase()
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive)
  const comparableRoot = comparablePath(root, caseSensitive)
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Determine whether a canonical target is a writable root or lies beneath it.
 * The lexical fast path handles normal canonical spellings. When spellings
 * differ, walk the target's existing ancestors and compare filesystem identity
 * with the root; this recognizes Windows long-name/8.3 aliases and casing
 * without weakening containment to a textual approximation.
 * @param path - canonical target key, which may end in a missing suffix.
 * @param root - canonical writable root.
 * @param caseSensitive - whether lexical comparison preserves case; defaults
 *   to the host filesystem convention used by supported platforms.
 * @returns whether the target is the root or a descendant of it.
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true

  const rootInfo = await statIfPresent(root)
  if (!rootInfo) return false

  let ancestor = path
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}
