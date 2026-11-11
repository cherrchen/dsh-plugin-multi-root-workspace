/**
 * The plugin's own Git config snapshot parser.
 *
 * Git is never started (ADR-0039 §2.4): the config file is opened through the
 * trusted-fd path in `fs-safe.ts` and parsed here. The parser deliberately
 * understands MORE syntax than the plugin consumes, because a config this
 * parser cannot understand must be inactive rather than silently misread.
 *
 * Refused layouts (all of them inactive, never warnings):
 *
 * - any `include.*` / `includeIf.*` — following an include is exactly the
 *   external-file read the ADR forbids;
 * - non-empty `core.worktree`;
 * - `extensions.worktreeConfig` (an admin-local `config.worktree` could
 *   include a path after this snapshot was verified);
 * - `core.repositoryformatversion` other than 0 (this includes
 *   `git worktree add --relative-paths`, which upgrades the format);
 * - `extensions.relativeWorktrees`;
 * - `extensions.objectFormat` other than `sha1`;
 * - `core.splitIndex` / `core.sparseCheckout` / `index.sparse`;
 * - a malformed file.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/worktrees/config
 */

import type { ConfigSnapshot } from './types.ts'

/** One parsed config entry; keys are case-folded, values keep their spelling. */
export interface ConfigEntry {
  readonly section: string
  readonly subsection?: string
  readonly key: string
  /** `null` means the key appeared without `=` (Git's implicit true). */
  readonly value: string | null
}

/** A parser verdict. */
export type ConfigParseResult =
  | { readonly ok: true; readonly entries: readonly ConfigEntry[] }
  | { readonly ok: false; readonly detail: string }

/** A snapshot verdict. */
export type ConfigSnapshotResult =
  | { readonly ok: true; readonly config: ConfigSnapshot }
  | { readonly ok: false; readonly reason: 'unsupported-config'; readonly detail: string }

/** Whether a line continues onto the next one (an ODD number of backslashes). */
function continues(line: string): boolean {
  let backslashes = 0
  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index--) backslashes++
  return backslashes % 2 === 1
}

/** Interpret the escapes Git accepts inside a double-quoted value. */
function unescape(value: string): string | undefined {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character !== '\\') { result += character; continue }
    const next = value[++index]
    if (next === undefined) return undefined
    switch (next) {
      case 'n': result += '\n'; break
      case 't': result += '\t'; break
      case 'b': result += '\b'; break
      case '\\': result += '\\'; break
      case '"': result += '"'; break
      default: return undefined
    }
  }
  return result
}

/**
 * Parse the right-hand side of a key line.
 *
 * Only a double-quoted span interprets backslash escapes; outside quotes a
 * backslash is literal (Git does not unescape unquoted values). A comment
 * starts at `#` / `;` only at the start of the value or after whitespace —
 * `core.worktree = C:\\repo` must keep its literal spelling.
 * @param raw - everything after the key.
 * @returns the value, `null` for an implicit true, or `undefined` on a syntax error.
 */
function parseValue(raw: string): string | null | undefined {
  let index = 0
  while (raw[index] === ' ' || raw[index] === '\t') index++
  if (index >= raw.length || raw[index] === '#' || raw[index] === ';') return null
  if (raw[index] !== '=') return undefined
  index++
  while (raw[index] === ' ' || raw[index] === '\t') index++
  let result = ''
  let quoted = false
  let previousWasSpace = true
  for (; index < raw.length; index++) {
    const character = raw[index]!
    if (quoted) {
      if (character === '"') { quoted = false; previousWasSpace = false; continue }
      if (character === '\\') {
        const next = raw[index + 1]
        if (next === undefined) return undefined
        const decoded = unescape(character + next)
        if (decoded === undefined) return undefined
        result += decoded
        previousWasSpace = false
        index++
        continue
      }
      result += character
      previousWasSpace = character === ' ' || character === '\t'
      continue
    }
    if (character === '"') { quoted = true; previousWasSpace = false; continue }
    if ((character === '#' || character === ';') && previousWasSpace) break
    result += character
    previousWasSpace = character === ' ' || character === '\t'
  }
  if (quoted) return undefined
  return result.trimEnd()
}

/**
 * Parse a Git config document.
 * @param text - the decoded file contents.
 * @returns the entries, or one syntax diagnostic.
 */
export function parseGitConfig(text: string): ConfigParseResult {
  if (text.includes('\u0000')) return { ok: false, detail: 'config contains NUL' }
  const lines: string[] = []
  let pending = ''
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    pending = pending === '' ? line : `${pending}\n${line}`
    if (continues(pending)) { pending = pending.slice(0, -1); continue }
    lines.push(pending)
    pending = ''
  }
  if (pending !== '') lines.push(pending)
  const entries: ConfigEntry[] = []
  let section: string | undefined
  let subsection: string | undefined
  for (const [lineNumber, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (trimmed.startsWith('[')) {
      const match = /^\[\s*([A-Za-z0-9][A-Za-z0-9.-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:[#;].*)?$/.exec(trimmed)
      if (match === null) return { ok: false, detail: `line ${lineNumber + 1}: malformed section header` }
      const name = match[1]!.toLowerCase()
      const dot = name.indexOf('.')
      if (match[2] === undefined && dot > 0) {
        section = name.slice(0, dot)
        subsection = name.slice(dot + 1)
      } else {
        section = name
        if (match[2] === undefined) {
          subsection = undefined
        } else {
          const decoded = unescape(match[2])
          if (decoded === undefined) return { ok: false, detail: `line ${lineNumber + 1}: malformed subsection` }
          subsection = decoded
        }
      }
      continue
    }
    if (section === undefined) return { ok: false, detail: `line ${lineNumber + 1}: key outside a section` }
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*([\s\S]*)$/.exec(trimmed)
    if (match === null) return { ok: false, detail: `line ${lineNumber + 1}: malformed key` }
    const value = parseValue(match[2] ?? '')
    if (value === undefined) return { ok: false, detail: `line ${lineNumber + 1}: malformed value` }
    entries.push({
      section,
      ...(subsection === undefined ? {} : { subsection }),
      key: match[1]!.toLowerCase(),
      value,
    })
  }
  return { ok: true, entries }
}

/** The last value Git would see for a plain section/key pair. */
function lastValue(entries: readonly ConfigEntry[], section: string, key: string): string | null | undefined {
  let found: string | null | undefined
  for (const entry of entries) {
    if (entry.section !== section || entry.subsection !== undefined || entry.key !== key) continue
    found = entry.value
  }
  return found
}

/** Parse Git's boolean spelling; `undefined` when the spelling is not one. */
function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return true
  switch (value.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case '1': return true
    case 'false': case 'no': case 'off': case '0': case '': return false
    default: return undefined
  }
}

/**
 * Read one boolean key with an explicit default for ABSENCE.
 * @returns the value, or `undefined` when a present value is not a boolean.
 */
function booleanValue(entries: readonly ConfigEntry[], section: string, key: string, fallback: boolean): boolean | undefined {
  const raw = lastValue(entries, section, key)
  return raw === undefined ? fallback : parseBoolean(raw)
}

/**
 * Build the activation snapshot from one parsed config.
 * @param text - the common config file contents.
 * @param platform - the platform the rules run for (macOS defaults differ).
 * @returns the snapshot, or the refusal that makes the layout inactive.
 */
export function snapshotGitConfig(text: string, platform: NodeJS.Platform = process.platform): ConfigSnapshotResult {
  const parsed = parseGitConfig(text)
  if (!parsed.ok) return { ok: false, reason: 'unsupported-config', detail: parsed.detail }
  for (const entry of parsed.entries) {
    if (entry.section === 'include' || entry.section === 'includeif') {
      return { ok: false, reason: 'unsupported-config', detail: 'config uses include/includeIf, which would read files outside the snapshot' }
    }
  }
  const versionText = lastValue(parsed.entries, 'core', 'repositoryformatversion')
  const version = versionText === undefined || versionText === null ? 0 : Number(versionText)
  if (!Number.isInteger(version) || version !== 0) {
    return { ok: false, reason: 'unsupported-config', detail: `core.repositoryformatversion=${String(versionText)} is not supported (only 0)` }
  }
  const objectFormat = (lastValue(parsed.entries, 'extensions', 'objectformat') ?? '').trim().toLowerCase()
  if (objectFormat !== '' && objectFormat !== 'sha1') {
    return { ok: false, reason: 'unsupported-config', detail: `extensions.objectFormat=${objectFormat} is not supported` }
  }
  const worktreeConfig = booleanValue(parsed.entries, 'extensions', 'worktreeconfig', false)
  if (worktreeConfig === undefined) return { ok: false, reason: 'unsupported-config', detail: 'extensions.worktreeConfig is not a boolean' }
  if (worktreeConfig) return { ok: false, reason: 'unsupported-config', detail: 'extensions.worktreeConfig=true is not supported' }
  const relativeWorktrees = booleanValue(parsed.entries, 'extensions', 'relativeworktrees', false)
  if (relativeWorktrees === undefined) return { ok: false, reason: 'unsupported-config', detail: 'extensions.relativeWorktrees is not a boolean' }
  if (relativeWorktrees) return { ok: false, reason: 'unsupported-config', detail: 'extensions.relativeWorktrees=true is not supported' }
  const worktree = lastValue(parsed.entries, 'core', 'worktree')
  if (worktree !== undefined && worktree !== null && worktree.trim() !== '') {
    return { ok: false, reason: 'unsupported-config', detail: 'core.worktree is set; the checkout would live outside its git dir' }
  }
  const bare = booleanValue(parsed.entries, 'core', 'bare', false)
  const ignoreCase = booleanValue(parsed.entries, 'core', 'ignorecase', false)
  const splitIndex = booleanValue(parsed.entries, 'core', 'splitindex', false)
  const sparseCheckout = booleanValue(parsed.entries, 'core', 'sparsecheckout', false)
  const indexSparse = booleanValue(parsed.entries, 'index', 'sparse', false)
  const precompose = booleanValue(parsed.entries, 'core', 'precomposeunicode', platform === 'darwin')
  if (bare === undefined) return { ok: false, reason: 'unsupported-config', detail: 'core.bare is not a boolean' }
  if (ignoreCase === undefined) return { ok: false, reason: 'unsupported-config', detail: 'core.ignoreCase is not a boolean' }
  if (splitIndex === undefined) return { ok: false, reason: 'unsupported-config', detail: 'core.splitIndex is not a boolean' }
  if (sparseCheckout === undefined) return { ok: false, reason: 'unsupported-config', detail: 'core.sparseCheckout is not a boolean' }
  if (indexSparse === undefined) return { ok: false, reason: 'unsupported-config', detail: 'index.sparse is not a boolean' }
  if (precompose === undefined) return { ok: false, reason: 'unsupported-config', detail: 'core.precomposeUnicode is not a boolean' }
  if (splitIndex) return { ok: false, reason: 'unsupported-config', detail: 'core.splitIndex=true is not supported' }
  if (sparseCheckout) return { ok: false, reason: 'unsupported-config', detail: 'core.sparseCheckout=true is not supported' }
  if (indexSparse) return { ok: false, reason: 'unsupported-config', detail: 'index.sparse=true is not supported' }
  return {
    ok: true,
    config: {
      repositoryFormatVersion: 0,
      objectFormat: 'sha1',
      bare,
      ignoreCase,
      precomposeUnicode: precompose,
      worktreeConfig,
      relativeWorktrees,
      splitIndex,
      sparseCheckout,
      indexSparse,
    },
  }
}
