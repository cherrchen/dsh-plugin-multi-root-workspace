/**
 * Dialect adaptation: widening a confined argv with additional workspace roots.
 *
 * The upstream kernel-sandbox provider expresses `workspace-write` as a
 * per-dialect profile built from the SINGLE policy root (plus the platform temp
 * areas). Widening that profile is the one thing this plugin must do outside the
 * filesystem fence, and it is deliberately done by OBSERVATION: the upstream
 * dialect profile builders are unreachable in the published package (only
 * `lib/index.js` and `lib/types/**` ship — see ADR-0002), and
 * `@deepseek-ai/dsh-sandbox-local`'s `runnerArgv` / `landlockLauncher` /
 * `seatbeltExec` members are TS-private, so `confine()` and the `internals` test
 * hook are the ONLY public surface.
 *
 * Every dialect is therefore handled by
 * 1. splitting the wrapped argv at the separator `confine` itself inserted,
 * 2. recognizing the dialect from STRUCTURAL markers in the profile arguments,
 * 3. cloning the grant spelling — and the insertion point — from the arguments
 *    the upstream provider actually produced, and
 * 4. failing loudly (never silently confining to the primary root alone) when
 *    the shape is not one this module knows.
 *
 * The per-dialect profile shapes this recognizes (verified against dsh
 * `0.1.5-rc.2`, recorded in `docs/reference/multi-root-workspace-research.md`
 * §10) are:
 *
 * ```text
 * seatbelt     [sandbox-exec, -p, "<SBPL>" ]                 SBPL allow-forms
 * bwrap        [bwrap, --ro-bind / /, …, --bind <root> <root>]
 * landlock     [<launcher>, --ro /, --rw /dev/null, --rw <root>]
 * windows-acl  [node, <runner>, --workspace …, --mode <mode>]
 * runnerCommand is spelled exactly like bwrap (the upstream config contract
 * appends bwrap-compatible profile arguments to the operator's runner).
 * ```
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/dialects
 */

import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { isCanonicallyUnder } from './roots.ts'
import { DialectUnrecognizedError } from './windows-runner-contract.ts'

/** The kernel runner dialects a confined argv can speak. */
export type RunnerDialect = 'seatbelt' | 'bwrap' | 'landlock' | 'windows-acl'

/**
 * Raised when a confined argv cannot be recognized or widened. The provider
 * converts this into the fail-closed `SandboxUnavailableError`: an unrecognized
 * dialect must never degrade into "the primary root was granted after all".
 *
 * The class itself lives in `windows-runner-contract.ts`: the standalone
 * Windows runner's module graph may import node builtins only, so the shared
 * error type cannot sit in a module that (even type-only) references upstream
 * packages. Re-exported here unchanged — `instanceof` identity is preserved.
 */
export { DialectUnrecognizedError }

/** One wrapped argv split into its runner/profile part and the caller's argv. */
export interface ConfinedShape {
  /** The recognized dialect. */
  dialect: RunnerDialect
  /** Everything before the separator: runner program plus profile arguments. */
  profileArgs: string[]
  /** Index of the `--` separator `confine` inserted. */
  separator: number
  /** The caller's argv, verbatim, after the separator. */
  commandArgs: string[]
}

/** The one SBPL form that carries the writable subpath grants. */
const SBPL_SUBPATH_FORM = /\(allow file-write\*\s*(?:\(subpath\s+"(?:[^"\\]|\\.)*"\)\s*)+\)/
/** One SBPL `(subpath "…")` token inside that form. */
const SBPL_SUBPATH_TOKEN = /\(subpath\s+("(?:[^"\\]|\\.)*")\)/g

/**
 * Split a `confine()` result at the separator by arithmetic, then VERIFY the
 * split: `confine` builds `[...profileArgs, '--', ...argv]`, so the separator
 * sits exactly one element before the caller's argv. A mismatch means the
 * provider no longer wraps argv the way this module assumes.
 * @param confinedArgv - the argv `confine` returned.
 * @param commandArgv - the argv the caller passed to `confine`.
 * @returns the recognized dialect and the split parts.
 */
export function splitConfined(confinedArgv: readonly string[], commandArgv: readonly string[]): ConfinedShape {
  const separator = confinedArgv.length - commandArgv.length - 1
  if (separator < 1 || confinedArgv[separator] !== '--') {
    throw new DialectUnrecognizedError(
      `confined argv is not "[...profile, --, ...argv]" (separator expected at ${separator}, got ${JSON.stringify(confinedArgv[separator])})`,
    )
  }
  const commandArgs = confinedArgv.slice(separator + 1)
  if (commandArgs.length !== commandArgv.length || commandArgs.some((argument, index) => argument !== commandArgv[index])) {
    throw new DialectUnrecognizedError('confined argv does not end with the caller\'s argv verbatim')
  }
  const profileArgs = confinedArgv.slice(0, separator)
  return { dialect: detectDialect(profileArgs), profileArgs, separator, commandArgs }
}

/**
 * Recognize the runner dialect from the profile arguments alone. Exactly one
 * marker must match; zero or several are both unrecognized.
 * @param profileArgs - everything before the separator.
 * @returns the dialect.
 */
export function detectDialect(profileArgs: readonly string[]): RunnerDialect {
  const matches: RunnerDialect[] = []
  // `sandbox-exec [-flags] -p <SBPL>`: the profile is the LAST element and `-p`
  // introduces it. Everything before is the runner invocation.
  if (profileArgs.length >= 2 && profileArgs[profileArgs.length - 2] === '-p') matches.push('seatbelt')
  if (profileArgs.includes('--mode')) matches.push('windows-acl')
  if (profileArgs.includes('--rw')) matches.push('landlock')
  if (profileArgs.includes('--ro-bind')) matches.push('bwrap')
  const [first, ...rest] = matches
  if (first === undefined) {
    throw new DialectUnrecognizedError(`unrecognized sandbox profile arguments: ${JSON.stringify(profileArgs)}`)
  }
  if (rest.length > 0) {
    throw new DialectUnrecognizedError(`ambiguous sandbox profile arguments (${matches.join(', ')}): ${JSON.stringify(profileArgs)}`)
  }
  return first
}

/**
 * Widen one dialect's profile arguments with the additional roots.
 *
 * Only `workspace-write` grants roots, mirroring the upstream mode meaning and
 * the filesystem fence: `read-only` grants nothing, and `danger-full-access`
 * never confines at all (bash and the PTY backend skip `confine` in that mode).
 *
 * A root the dialect ALREADY grants is not granted twice — that keeps this
 * function aligned with the fence's own deduplication and, on bwrap, avoids
 * binding the real `/tmp` over the ephemeral `--tmpfs /tmp` mount.
 * @param dialect - the recognized dialect.
 * @param profileArgs - the profile arguments to widen.
 * @param policy - the per-call policy (its root is the policy root, never a new grant).
 * @param additionalRoots - canonical additional roots, in scope order.
 * @returns the widened profile arguments.
 */
export function widenProfileArgs(
  dialect: RunnerDialect,
  profileArgs: readonly string[],
  policy: SandboxPolicy,
  additionalRoots: readonly string[],
): string[] {
  if (policy.mode !== 'workspace-write') {
    throw new DialectUnrecognizedError(
      `dialect "${dialect}" grants write roots only under workspace-write, got mode "${policy.mode}"`,
    )
  }
  if (additionalRoots.length === 0) return [...profileArgs]
  switch (dialect) {
    case 'seatbelt': return widenSeatbelt(profileArgs, additionalRoots)
    case 'bwrap': return widenBwrap(profileArgs, policy.workspaceRoot, additionalRoots)
    case 'landlock': return widenLandlock(profileArgs, policy.workspaceRoot, additionalRoots)
    case 'windows-acl':
      // ACL capabilities need the dedicated runner, not POSIX grant spelling.
      throw new DialectUnrecognizedError('Windows ACL widening requires widenWindowsProfile')
  }
}

/**
 * Graft writable grants onto a `read-only` profile — the B9 cell where a fixed
 * `read-write` additional root stays writable while the session mode denies
 * every other write. Each dialect appends its own grant spelling AFTER
 * upstream's deny-all baseline, so the appended form wins:
 *
 * - seatbelt: SBPL is last-match-wins — a trailing `(allow file-write*
 *   (subpath …))` overrides the blanket `(deny file-write*)` for those roots;
 * - bwrap: mounts apply in order — a `--bind W W` after `--ro-bind / /`
 *   re-mounts that subtree writable inside the read-only namespace;
 * - landlock: grants union — an extra `--rw W` widens exactly that subtree.
 *
 * `windows-acl` cannot be spelled this way and goes through
 * `widenWindowsProfile` (the standalone runner grants only the listed roots).
 * @param dialect - the recognized dialect.
 * @param profileArgs - the upstream read-only profile arguments.
 * @param additionalRoots - canonical roots the effective scope keeps writable.
 * @returns the grafted profile arguments.
 */
export function graftProfileArgs(
  dialect: RunnerDialect,
  profileArgs: readonly string[],
  additionalRoots: readonly string[],
): string[] {
  if (additionalRoots.length === 0) return [...profileArgs]
  switch (dialect) {
    case 'seatbelt': return graftSeatbelt(profileArgs, additionalRoots)
    case 'bwrap': return [...profileArgs, ...additionalRoots.flatMap(root => ['--bind', root, root])]
    case 'landlock': {
      const granted = new Set<string>()
      for (let index = 0; index + 1 < profileArgs.length; index += 1) {
        if (profileArgs[index] === '--rw') granted.add(profileArgs[index + 1] as string)
      }
      const added = additionalRoots.filter(root => !granted.has(root)).flatMap(root => ['--rw', root])
      return [...profileArgs, ...added]
    }
    case 'windows-acl':
      throw new DialectUnrecognizedError('Windows ACL read-only grafting requires widenWindowsProfile')
  }
}

/** Append a trailing allow form to the SBPL — last-match-wins overrides the blanket deny. */
function graftSeatbelt(profileArgs: readonly string[], additionalRoots: readonly string[]): string[] {
  const profile = profileArgs[profileArgs.length - 1]
  if (profile === undefined || profileArgs[profileArgs.length - 2] !== '-p') {
    throw new DialectUnrecognizedError(`seatbelt profile is not "[<sandbox-exec>, …, -p, <SBPL>]": ${JSON.stringify(profileArgs)}`)
  }
  const granted = new Set([...profile.matchAll(SBPL_SUBPATH_TOKEN)].map(token => sbplValue(token[1] as string)))
  const added = additionalRoots.filter(root => !granted.has(root))
  if (added.length === 0) return [...profileArgs]
  const widened = profile + ` (allow file-write* ${added.map(root => `(subpath ${sbplString(root)})`).join(' ')})`
  return [...profileArgs.slice(0, -1), widened]
}

/** Quote one path exactly the way the upstream Seatbelt profile builder does. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** Unquote one SBPL string literal (including its surrounding quotes). */
function sbplValue(literal: string): string {
  return literal.slice(1, -1).replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, '\\')
}

/** Append the additional roots to the SBPL form that carries the subpath grants. */
function widenSeatbelt(profileArgs: readonly string[], additionalRoots: readonly string[]): string[] {
  const profile = profileArgs[profileArgs.length - 1]
  if (profile === undefined || profileArgs[profileArgs.length - 2] !== '-p') {
    throw new DialectUnrecognizedError(`seatbelt profile is not "[<sandbox-exec>, …, -p, <SBPL>]": ${JSON.stringify(profileArgs)}`)
  }
  const form = SBPL_SUBPATH_FORM.exec(profile)
  if (form === null) {
    throw new DialectUnrecognizedError(`seatbelt profile has no "(allow file-write* (subpath …))" form to extend: ${JSON.stringify(profile)}`)
  }
  const matched = form[0] as string
  const granted = new Set([...matched.matchAll(SBPL_SUBPATH_TOKEN)].map(token => sbplValue(token[1] as string)))
  const added = additionalRoots.filter(root => !granted.has(root)).map(root => `(subpath ${sbplString(root)})`)
  if (added.length === 0) return [...profileArgs]
  // Extend the observed form in place, so the profile keeps upstream's shape
  // (one allow form listing every writable subpath).
  const widened = profile.slice(0, form.index)
    + matched.slice(0, -1)
    + ` ${added.join(' ')}`
    + ')'
    + profile.slice(form.index + matched.length)
  return [...profileArgs.slice(0, -1), widened]
}

/**
 * The observed bwrap bind flag: the flag of the `[flag, <root>, <root>]` triple
 * upstream built for the policy root.
 */
function bwrapBindFlag(profileArgs: readonly string[], workspaceRoot: string): string {
  for (let index = 2; index < profileArgs.length; index += 1) {
    if (profileArgs[index] !== workspaceRoot || profileArgs[index - 1] !== workspaceRoot) continue
    const flag = profileArgs[index - 2]
    // `--ro-bind / /` is the read-only root mount, never the writable grant.
    if (flag === undefined || !flag.startsWith('--') || flag.startsWith('--ro')) continue
    return flag
  }
  throw new DialectUnrecognizedError(
    `bwrap profile has no writable bind of the policy root ${JSON.stringify(workspaceRoot)}: ${JSON.stringify(profileArgs)}`,
  )
}

/** Append the additional roots as binds, after upstream's own root bind. */
function widenBwrap(profileArgs: readonly string[], workspaceRoot: string, additionalRoots: readonly string[]): string[] {
  const flag = bwrapBindFlag(profileArgs, workspaceRoot)
  const granted = new Set<string>()
  for (let index = 0; index + 2 < profileArgs.length; index += 1) {
    if (profileArgs[index] === flag && profileArgs[index + 1] === profileArgs[index + 2]) granted.add(profileArgs[index + 2] as string)
  }
  for (let index = 0; index + 1 < profileArgs.length; index += 1) {
    if (profileArgs[index] === '--tmpfs') granted.add(profileArgs[index + 1] as string)
  }
  const added = additionalRoots.filter(root => !granted.has(root)).flatMap(root => [flag, root, root])
  return [...profileArgs, ...added]
}

/**
 * The observed Landlock read-write flag: the flag preceding the policy root in
 * the launcher's grant arguments.
 */
function landlockReadWriteFlag(profileArgs: readonly string[], workspaceRoot: string): string {
  for (let index = 1; index < profileArgs.length; index += 1) {
    if (profileArgs[index] !== workspaceRoot) continue
    const flag = profileArgs[index - 1]
    if (flag === undefined || !flag.startsWith('--') || flag.startsWith('--ro')) continue
    return flag
  }
  throw new DialectUnrecognizedError(
    `landlock profile has no read-write grant of the policy root ${JSON.stringify(workspaceRoot)}: ${JSON.stringify(profileArgs)}`,
  )
}

/** Append the additional roots as read-write grants, after upstream's own root grant. */
function widenLandlock(profileArgs: readonly string[], workspaceRoot: string, additionalRoots: readonly string[]): string[] {
  const flag = landlockReadWriteFlag(profileArgs, workspaceRoot)
  const granted = new Set<string>()
  for (let index = 0; index + 1 < profileArgs.length; index += 1) {
    if (profileArgs[index] === flag) granted.add(profileArgs[index + 1] as string)
  }
  const added = additionalRoots.filter(root => !granted.has(root)).flatMap(root => [flag, root])
  return [...profileArgs, ...added]
}

/**
 * The bwrap mount points a workspace-write profile makes writable: every
 * `[flag, X, X]` triple whose flag is not `--ro*`, plus every `--tmpfs` target.
 * @returns writable mount targets in profile order.
 */
function bwrapWritableMounts(profileArgs: readonly string[]): string[] {
  const targets: string[] = []
  for (let index = 0; index + 2 < profileArgs.length; index += 1) {
    const flag = profileArgs[index] as string
    if (!flag.startsWith('--') || flag.startsWith('--ro')) continue
    if (flag === '--tmpfs') {
      targets.push(profileArgs[index + 1] as string)
      index += 1
      continue
    }
    if (profileArgs[index + 1] === profileArgs[index + 2]) targets.push(profileArgs[index + 2] as string)
  }
  return targets
}

/** The paths a Landlock profile grants read-write (`--rw` flag values). */
function landlockWritablePaths(profileArgs: readonly string[]): string[] {
  const granted: string[] = []
  for (let index = 0; index + 1 < profileArgs.length; index += 1) {
    if (profileArgs[index] === '--rw') granted.push(profileArgs[index + 1] as string)
  }
  return granted
}

/**
 * Deny `deniedRoots` inside an upstream `workspace-write` profile — the B9 edge
 * where an explicit `read-only` (or tool-capped) additional root sits under a
 * directory the profile grants writable (the platform temp area, which an
 * additional root may legitimately be registered beneath).
 *
 * A denied root outside every grant needs no profile work at all: the mode
 * already denies it. Per dialect:
 *
 * - seatbelt appends a trailing `(deny file-write* (subpath …))` form — last
 *   match wins over every earlier allow, and a redundant deny on an ungranted
 *   root is harmless;
 * - bwrap re-mounts the root `--ro-bind` AFTER the writable binds (a later
 *   mount wins inside the namespace); roots under a `--tmpfs` target are
 *   skipped — the tmpfs masks them entirely (an over-deny of reads, chosen
 *   over a broken `--ro-bind` whose source cannot resolve);
 * - landlock cannot subtract: a denied root under an `--rw` grant throws —
 *   union semantics have no deny primitive;
 * - windows-acl goes through `widenWindowsProfile`, whose runner-side ACL
 *   grant cannot subtract either — its caller checks the same overlap.
 * @param dialect - the recognized dialect.
 * @param profileArgs - the upstream workspace-write profile arguments.
 * @param deniedRoots - canonical roots this call must not write.
 * @returns the profile arguments with the in-profile denies applied.
 */
export function denyProfileArgs(
  dialect: RunnerDialect,
  profileArgs: readonly string[],
  deniedRoots: readonly string[],
): string[] {
  if (deniedRoots.length === 0) return [...profileArgs]
  switch (dialect) {
    case 'seatbelt': {
      const profile = profileArgs[profileArgs.length - 1]
      if (profile === undefined || profileArgs[profileArgs.length - 2] !== '-p') {
        throw new DialectUnrecognizedError(`seatbelt profile is not "[<sandbox-exec>, …, -p, <SBPL>]": ${JSON.stringify(profileArgs)}`)
      }
      // Deny only what an allow-subpath grant could reach — the mode already
      // denies the rest, and an all-restricted scope stays a passthrough.
      const granted = [...profile.matchAll(SBPL_SUBPATH_TOKEN)].map(token => sbplValue(token[1] as string))
      const covered = deniedRoots.filter(root => granted.some(target => isCanonicallyUnder(root, target)))
      if (covered.length === 0) return [...profileArgs]
      const denied = covered.map(root => `(subpath ${sbplString(root)})`).join(' ')
      return [...profileArgs.slice(0, -1), `${profile} (deny file-write* ${denied})`]
    }
    case 'bwrap': {
      const writable = bwrapWritableMounts(profileArgs)
      const binds = deniedRoots
        .filter(root => writable.some(target => isCanonicallyUnder(root, target)))
        .flatMap(root => ['--ro-bind', root, root])
      return [...profileArgs, ...binds]
    }
    case 'landlock': {
      const granted = landlockWritablePaths(profileArgs)
      const covered = deniedRoots.filter(root => granted.some(target => isCanonicallyUnder(root, target)))
      if (covered.length > 0) {
        throw new DialectUnrecognizedError(
          `landlock cannot deny [${covered.join(', ')}] inside a writable grant — its launcher only supports allowlist union`,
        )
      }
      return [...profileArgs]
    }
    case 'windows-acl':
      throw new DialectUnrecognizedError('Windows ACL deny overlap is checked by widenWindowsProfile')
  }
}

/**
 * Restrict an ambient-writable execution to everything EXCEPT `deniedRoots` —
 * the B9 cell `danger-full-access` + explicit `read-only`. The consumers of
 * this profile (shell, PTY, PTC) bypass `confine()` entirely under that mode,
 * so the process fence builds this profile from an upstream skeleton instead:
 * the caller probes `confine` once under `read-only` to obtain the runner's
 * argument prefix, and this function rewrites the file-effect part.
 *
 * - seatbelt: `(version 1) (allow default)` kept from the profile head, plus a
 *   trailing `(deny file-write* (subpath …))` — allow-default with subpath
 *   carve-outs, the inverse of the confined profiles;
 * - bwrap: `--ro-bind / /` becomes `--bind / /` (ambient writable namespace),
 *   each denied root is re-mounted `--ro-bind` after it;
 * - landlock and windows-acl cannot express "everything except" — the launcher
 *   only unions allowlists and the ACL model only grants — so both throw.
 * @param dialect - the recognized dialect.
 * @param profileArgs - the upstream read-only skeleton's profile arguments.
 * @param deniedRoots - canonical roots the execution must not write.
 * @returns the restricted profile arguments.
 */
export function restrictProfileArgs(
  dialect: RunnerDialect,
  profileArgs: readonly string[],
  deniedRoots: readonly string[],
): string[] {
  if (deniedRoots.length === 0) return [...profileArgs]
  switch (dialect) {
    case 'seatbelt': {
      const profile = profileArgs[profileArgs.length - 1]
      if (profile === undefined || profileArgs[profileArgs.length - 2] !== '-p') {
        throw new DialectUnrecognizedError(`seatbelt profile is not "[<sandbox-exec>, …, -p, <SBPL>]": ${JSON.stringify(profileArgs)}`)
      }
      const allowDefault = '(allow default)'
      const anchor = profile.indexOf(allowDefault)
      if (anchor < 0) {
        throw new DialectUnrecognizedError(`seatbelt profile has no "(allow default)" to restrict from: ${JSON.stringify(profile)}`)
      }
      const denied = deniedRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')
      const restricted = `${profile.slice(0, anchor + allowDefault.length)} (deny file-write* ${denied})`
      return [...profileArgs.slice(0, -1), restricted]
    }
    case 'bwrap': {
      const base = profileArgs.indexOf('--ro-bind')
      if (base < 1 || profileArgs[base + 1] !== '/' || profileArgs[base + 2] !== '/') {
        throw new DialectUnrecognizedError('bwrap ambient profile requires an observed root mount')
      }
      // Retain the runner invocation but do not inherit confined-mode PID,
      // proc, device or temporary mounts into the Full-access combination.
      const args = [...profileArgs.slice(0, base), '--bind', '/', '/', '--die-with-parent']
      for (const root of deniedRoots) args.push('--ro-bind', root, root)
      return args
    }
    case 'landlock':
      // A union-only Landlock profile cannot express this cell. Select the
      // mount backend for it, preserving ambient writes outside denied roots.
      // Missing/unusable bubblewrap is a runner failure, never a bare spawn.
      return ['bwrap', '--bind', '/', '/', '--die-with-parent',
        ...deniedRoots.flatMap(root => ['--ro-bind', root, root])]
    case 'windows-acl':
      throw new DialectUnrecognizedError('Windows ACL cannot express an ambient grant minus subtree denies — the restricted-token model only grants')
  }
}
