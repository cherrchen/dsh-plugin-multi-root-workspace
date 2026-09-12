/**
 * Filesystem fixtures for the fence tests.
 *
 * The fixture root deliberately lives inside the repository rather than in the
 * platform temp area: `writableRoots()` grants `/tmp` and `tmpdir()`
 * automatically, so a workspace placed there could never demonstrate a
 * containment denial. {@link assertOutsideTempGrants} pins that property so a
 * future move of the fixture root cannot silently weaken the suite.
 *
 * @module tests/support/temp-workspace
 */

import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Repository root (this file lives in `tests/support/`). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix))
}

/**
 * A writable parent outside the automatic temporary write grants.
 *
 * Prefers the repository (always writable here and never a temp grant), then
 * the temp directory's parent, then home.
 * @returns an existing directory that can host fixture siblings.
 */
function fixtureParent(): string {
  const candidates = [join(REPO_ROOT, '.dsh-smoke'), dirname(canonicalPath(tmpdir())), homedir()]
  for (const candidate of candidates) {
    if (candidate === parse(candidate).root) continue
    try {
      mkdirSync(candidate, { recursive: true })
      accessSync(candidate, constants.W_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('no writable fixture parent outside the temporary write grants')
}

/**
 * Reject a workspace that an automatic temporary grant already covers.
 * @param workspace - allocated workspace path.
 */
export function assertOutsideTempGrants(workspace: string): void {
  const path = canonicalPath(workspace)
  for (const root of writableRoots({ mode: 'workspace-write', workspaceRoot: '/tmp' })) {
    if (contains(root, path)) {
      throw new Error(`fixture workspace ${workspace} must be outside temporary writable root ${root}`)
    }
  }
}

/** One allocated fixture tree: a primary root and a sibling outside it. */
export interface FixtureWorkspace {
  /** The fixture's private parent directory (removed by {@link dispose}). */
  base: string
  /** The primary root the policy points at. */
  workspace: string
  /** A sibling directory outside the primary root (the denial target). */
  outside: string
  /** Remove the whole fixture tree. */
  dispose: () => void
}

/**
 * Allocate a fixture tree with a primary root and an outside sibling.
 * @param label - short label used in the directory name.
 * @returns the fixture, with a `dispose` that removes the tree.
 */
export function createFixtureWorkspace(label: string): FixtureWorkspace {
  const base = mkdtempSync(join(fixtureParent(), `dsh-mr-${label}-`))
  const workspace = join(base, 'ws')
  const outside = join(base, 'out')
  mkdirSync(workspace)
  mkdirSync(outside)
  assertOutsideTempGrants(workspace)
  return {
    base,
    workspace,
    outside,
    dispose: () => { rmSync(base, { recursive: true, force: true }) },
  }
}
