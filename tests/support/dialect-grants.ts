/**
 * Test-side parsers for the grants a confined argv actually carries.
 *
 * This module is DELIBERATELY independent of `src/dialects.ts`: it re-derives
 * each dialect's writable set from the raw argv with different mechanics (scan
 * for the separator instead of computing it; regex/text parsing instead of the
 * production clone-and-splice). The parity suite then compares two independently
 * produced answers — the in-process fence's verdict and the kernel profile's
 * grant list — which is what makes it a real cross-check rather than a mirror of
 * the implementation under test.
 *
 * @module tests/support/dialect-grants
 */

import { spawnSync } from 'node:child_process'
import { sep } from 'node:path'
import type { ConfinedArgv, RunnerFailureRule } from '@deepseek-ai/dsh-sandbox'

/** The dialect a wrapped argv speaks, as recognized from its own shape. */
export type ParsedDialect = 'seatbelt' | 'bwrap' | 'landlock' | 'windows-acl' | 'unknown'

/** The writable surface one wrapped argv expresses. */
export interface ParsedGrants {
  dialect: ParsedDialect
  /** Roots a write anywhere beneath is allowed (as spelled by the dialect). */
  subpaths: string[]
  /** Exact files a write is allowed to (Seatbelt's `(literal …)` grants). */
  literals: string[]
}

/** Locate the separator by scanning, not by arithmetic. */
function separatorIndex(argv: readonly string[], commandArgv: readonly string[]): number {
  for (let index = argv.length - commandArgv.length - 1; index >= 0; index -= 1) {
    if (argv[index] !== '--') continue
    const tail = argv.slice(index + 1)
    if (tail.length === commandArgv.length && tail.every((argument, offset) => argument === commandArgv[offset])) return index
  }
  throw new Error(`no "--" separator followed by the caller's argv in ${JSON.stringify(argv)}`)
}

/** Unquote one SBPL string literal (quotes included). */
function unquote(literal: string): string {
  return literal.slice(1, -1).replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, '\\')
}

/**
 * Collect every complete `(allow file-write* …)` form in one SBPL profile by
 * walking parentheses — a scanner, so a nested `(subpath …)` never truncates a
 * form the way a naive regex would.
 */
function writeForms(profile: string): string[] {
  const forms: string[] = []
  const marker = '(allow file-write*'
  for (let start = profile.indexOf(marker); start >= 0; start = profile.indexOf(marker, start + 1)) {
    let depth = 0
    for (let index = start; index < profile.length; index += 1) {
      const character = profile[index]
      if (character === '"') {
        index += 1
        while (index < profile.length && profile[index] !== '"') index += profile[index] === '\\' ? 2 : 1
        continue
      }
      if (character === '(') depth += 1
      if (character === ')') {
        depth -= 1
        if (depth === 0) {
          forms.push(profile.slice(start, index + 1))
          break
        }
      }
    }
  }
  return forms
}

/** Read `[flag, value]` pairs of one launcher flag. */
function flagValues(profileArgs: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index + 1 < profileArgs.length; index += 1) {
    if (profileArgs[index] === flag) values.push(profileArgs[index + 1] as string)
  }
  return values
}

/** Parse one wrapped argv into the writable surface it grants. */
export function parseConfined(confinedArgv: readonly string[], commandArgv: readonly string[]): ParsedGrants {
  const profileArgs = confinedArgv.slice(0, separatorIndex(confinedArgv, commandArgv))
  const profile = profileArgs[profileArgs.length - 1]
  if (profile !== undefined && profileArgs[profileArgs.length - 2] === '-p') {
    const subpaths: string[] = []
    const literals: string[] = []
    for (const form of writeForms(profile)) {
      for (const token of form.matchAll(/\(subpath\s+("(?:[^"\\]|\\.)*")\)/g)) subpaths.push(unquote(token[1] as string))
      for (const token of form.matchAll(/\(literal\s+("(?:[^"\\]|\\.)*")\)/g)) literals.push(unquote(token[1] as string))
    }
    return { dialect: 'seatbelt', subpaths, literals }
  }
  if (profileArgs.includes('--mode')) return { dialect: 'windows-acl', subpaths: [], literals: [] }
  if (profileArgs.includes('--rw') && profileArgs.includes('--ro')) {
    return { dialect: 'landlock', subpaths: flagValues(profileArgs, '--rw'), literals: [] }
  }
  if (profileArgs.includes('--ro-bind')) {
    const bound: string[] = []
    for (let index = 0; index + 2 < profileArgs.length; index += 1) {
      if (profileArgs[index] === '--bind') bound.push(profileArgs[index + 2] as string)
    }
    return { dialect: 'bwrap', subpaths: [...bound, ...flagValues(profileArgs, '--tmpfs')], literals: [] }
  }
  return { dialect: 'unknown', subpaths: [], literals: [] }
}

/** Whether the parsed grants allow writing exactly `path` (canonical spelling). */
export function allowsWrite(grants: ParsedGrants, path: string): boolean {
  if (grants.literals.includes(path)) return true
  return grants.subpaths.some((root) => {
    if (path === root) return true
    const prefix = root.endsWith(sep) ? root : root + sep
    return path.startsWith(prefix)
  })
}

/** How a confined execution settled. */
export type ConfinedOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'denied'; detail: string }
  | { kind: 'runner-failed'; detail: string }
  | { kind: 'unavailable'; detail: string }

/**
 * Classify one confined run from its exit status and stderr, using the FACTS the
 * provider itself returned. This mirrors the upstream consumer order: a matching
 * runner-fatal line means the command never ran; otherwise a denial signature on
 * a failed run is confinement working.
 * @param result - the spawn result.
 * @param denialSignatures - the selected backend's denial dialect.
 * @param runnerFailureRules - the selected backend's structured runner-failure rules.
 * @returns the classified outcome.
 */
export function classifyOutcome(
  result: { status: number | null; stdout: string; stderr: string; spawnError?: string },
  denialSignatures: readonly string[],
  runnerFailureRules: readonly RunnerFailureRule[],
): ConfinedOutcome {
  if (result.spawnError !== undefined) return { kind: 'unavailable', detail: result.spawnError }
  const lines = result.stderr.split('\n')
  const fatal = runnerFailureRules.some(rule => lines.some(line => rule.fatalSignatures.some(signature => line.toLowerCase().includes(signature.toLowerCase()))))
  if (fatal) return { kind: 'runner-failed', detail: result.stderr.trim() }
  if (result.status === 0) return { kind: 'ok', stdout: result.stdout }
  const denied = lines.some(line => denialSignatures.some(signature => line.toLowerCase().includes(signature.toLowerCase())))
  if (denied) return { kind: 'denied', detail: result.stderr.trim() }
  return { kind: 'runner-failed', detail: `exit ${String(result.status)}: ${result.stderr.trim()}` }
}

/**
 * Spawn one confined argv exactly as the bash executor would, and classify the
 * outcome with the facts the provider returned for it.
 * @param confined - the provider's `confine` result.
 * @param cwd - working directory for the run.
 * @returns the classified outcome; `unavailable` when the runner cannot start.
 */
export function runConfined(confined: ConfinedArgv, cwd: string): ConfinedOutcome {
  const [program, ...args] = confined.argv
  if (program === undefined) return { kind: 'unavailable', detail: 'empty confined argv' }
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 20_000 })
  if (result.error !== undefined) {
    return classifyOutcome({ status: null, stdout: '', stderr: '', spawnError: String(result.error.message) }, confined.denialSignatures, confined.runnerFailureRules)
  }
  return classifyOutcome(
    { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' },
    confined.denialSignatures,
    confined.runnerFailureRules,
  )
}
