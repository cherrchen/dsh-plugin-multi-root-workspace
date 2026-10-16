/**
 * Profile pnpm import isolation — the host-side maintenance behind
 * `/workspace-folders isolate-profiles` (branch review Phase C2, finding R4).
 *
 * Why it exists: a Windows deny ACE applies to the file OBJECT, not to one
 * hardlink name. The pnpm profile defaults upstream writes (`initProfile` in
 * dsh-app-boot) never set `packageImportMethod`, so `dsh plugin add` imports
 * the store into `<home>/profiles/<name>/node_modules` BY HARDLINK. Denying
 * `$DSH_HOME` then rewrites security descriptors shared with every other name
 * of the same objects — including the global pnpm store and other projects
 * linking it. The C1 preflight therefore refuses such a home before any ACL
 * write; this module is the remediation it points at: it detects the confirmed
 * profiles, writes `packageImportMethod: copy` conservatively, and scans the
 * whole home for the multi-link files that still need a reinstall.
 *
 * Boundaries of the subset it touches:
 * - profile identification is conservative — only a directory under
 *   `profiles/` whose `package.json` parses to an object carrying
 *   `dsh.profile` as an object counts; everything else is enumerated but
 *   never written;
 * - the YAML handling is a strict SUBSET scanner, not a parser substitute —
 *   the runtime cannot depend on a YAML package, so anything ambiguous is
 *   reported as a conflict and refused instead of guessed;
 * - every write is atomic (temp sibling + rename) and never crosses a reparse
 *   point;
 * - the whole-home scan never descends a reparse point: with plain `lstat` a
 *   symlink/junction reports as a link, and other reparse flavours still fall
 *   under the runner's own Win32-attribute preflight, which remains the
 *   authoritative gate;
 * - the command sets configuration — it never deletes `node_modules`, never
 *   runs pnpm, and never repairs ACLs or ownership written in the past.
 *
 * @module profile-isolation
 */

import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from './windows-runner-contract.ts'

/** `pnpm-workspace.yaml` — the only file the maintenance verb ever writes. */
const WORKSPACE_YAML = 'pnpm-workspace.yaml'

/**
 * Mirrors `PROFILE_PNPM_WORKSPACE` written by `initProfile` in
 * `@deepseek-ai/dsh-app-boot`; that constant is not exported, so the template
 * is duplicated here and must stay in sync with upstream.
 */
export const PROFILE_PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** How many example paths a report keeps before it only counts the rest. */
const SAMPLE_CAP = 20

/**
 * A top-level key line the subset scanner accepts. The value is deliberately
 * not validated here — its shape decides the entry kind.
 */
const TOP_LEVEL_KEY = /^([A-Za-z0-9][A-Za-z0-9._-]*|'(?:[^']|'')+'|"(?:[^"\\]|\\.)*")\s*:/

/** YAML double-quoted single-character escapes (the multi-hex forms follow). */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\x0b', f: '\f',
  r: '\r', e: '\x1b', '"': '"', "'": "'", '\\': '\\', '/': '/', N: '\x85',
  _: '\xa0', L: '\u2028', P: '\u2029', ' ': ' ',
}

/** One accepted top-level `key: value` line, located in the source text. */
export interface WorkspaceYamlEntry {
  /** The unquoted scalar when the value is one; `undefined` for block/complex. */
  readonly value: string | undefined
  /**
   * `scalar` — a same-line plain or quoted scalar; `block` — the value is
   * empty, so a nested block (or an explicit comment) follows; `complex` —
   * the value opens with a YAML node property or collection marker
   * (`&`, `*`, `!`, `|`, `>`, `{`, `[`) or is a malformed scalar the subset
   * refuses to interpret.
   */
  readonly kind: 'scalar' | 'block' | 'complex'
  /** 1-based line number the key sits on. */
  readonly line: number
  /** UTF-16 code-unit offset where the value token begins. */
  readonly valueStart: number
  /** UTF-16 code-unit offset just past the value token (before ` #comment` or EOL). */
  readonly valueEnd: number
}

/**
 * Unquote a single-quoted or double-quoted YAML token.
 * @param token - the token including its quotes.
 * @param fail - the rejection callback for escapes outside the subset.
 * @returns the unquoted text.
 */
function unquoteYamlToken(token: string, fail: (what: string) => never): string {
  if (token.startsWith("'")) {
    return token.slice(1, -1).replaceAll("''", "'")
  }
  const inner = token.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!
    if (char !== '\\') {
      out += char
      continue
    }
    const escape = inner[i + 1]
    if (escape === undefined) fail('a backslash ends the quoted token')
    if (escape === 'x' || escape === 'u' || escape === 'U') {
      const digits = escape === 'x' ? 2 : escape === 'u' ? 4 : 8
      const hex = inner.slice(i + 2, i + 2 + digits)
      if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) {
        fail(`\\${escape} wants ${digits} hex digits, got ${JSON.stringify(hex)}`)
      }
      out += String.fromCodePoint(Number.parseInt(hex, 16))
      i += 1 + digits
      continue
    }
    const mapped = DOUBLE_QUOTED_ESCAPES[escape]
    if (mapped === undefined) fail(`unsupported escape \\${escape}`)
    out += mapped
    i += 1
  }
  return out
}

/**
 * Locate the first `#` starting a comment in a plain (unquoted) value: the
 * marker must be preceded by separation whitespace per YAML's comment rule.
 * @param value - the value text after `key:`.
 * @returns the comment offset inside `value`, or `-1`.
 */
function plainCommentStart(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '#' && i > 0 && (value[i - 1] === ' ' || value[i - 1] === '\t')) return i
  }
  return -1
}

/**
 * Read the top-level `key: value` lines of a `pnpm-workspace.yaml` text.
 *
 * This is a strict subset scanner, deliberately NOT a YAML parser: it accepts
 * only top-level `key:` lines (plain or quoted keys) plus indented nested
 * content it never interprets, and throws — naming the file and the 1-based
 * line — on tabs in indentation, `%` / `---` / `...` directives, duplicate
 * top-level keys, or any other non-indented content line outside the key
 * form. A `#` preceded by whitespace ends a plain scalar; quoted scalars are
 * unquoted for the reported value. `valueStart`/`valueEnd` are the UTF-16
 * offsets of the value token itself, so a caller can replace exactly the
 * scalar while comments and line endings survive untouched.
 *
 * @param text - the yaml text to scan.
 * @param path - the file name used in rejection messages.
 * @returns the top-level entries keyed by their unquoted names.
 */
export function parseWorkspaceYamlKeys(text: string, path = WORKSPACE_YAML): ReadonlyMap<string, WorkspaceYamlEntry> {
  const fail = (line: number, what: string): never => {
    throw new Error(`${path}:${line}: ${what}`)
  }
  const entries = new Map<string, WorkspaceYamlEntry>()
  let cursor = 0
  let line = 0
  while (cursor <= text.length) {
    line += 1
    const lineStart = cursor
    const newline = text.indexOf('\n', cursor)
    const lineEnd = newline < 0 ? text.length : newline
    const raw = lineEnd > lineStart && text[lineEnd - 1] === '\r'
      ? text.slice(lineStart, lineEnd - 1)
      : text.slice(lineStart, lineEnd)
    cursor = newline < 0 ? text.length + 1 : lineEnd + 1
    const indentation = /^[ \t]*/.exec(raw)![0]
    const content = raw.slice(indentation.length)
    if (content === '') continue
    if (indentation.includes('\t')) fail(line, 'tab in indentation')
    if (content.startsWith('#')) continue
    if (indentation.length > 0) continue // nested block content is accepted unchecked
    if (content.startsWith('%')) fail(line, 'a `%` directive is outside the supported subset')
    if (/^-{3}(?:\s|$)/.test(content)) fail(line, 'a `---` document marker is outside the supported subset')
    if (/^\.{3}(?:\s|$)/.test(content)) fail(line, 'a `...` document end is outside the supported subset')
    const match = TOP_LEVEL_KEY.exec(content)
      ?? fail(line, 'a top-level line must read `key: value`, `key:`, or a comment')
    const keyToken = match[1]!
    const key = keyToken.startsWith("'") || keyToken.startsWith('"')
      ? unquoteYamlToken(keyToken, what => fail(line, what))
      : keyToken
    if (entries.has(key)) fail(line, `duplicate top-level key ${JSON.stringify(key)}`)
    const colon = content.indexOf(':', keyToken.length)
    const separation = /^[ \t]*/.exec(content.slice(colon + 1))![0].length
    const valueStart = lineStart + colon + 1 + separation
    const value = content.slice(colon + 1 + separation)
    if (value === '' || value.startsWith('#')) {
      // No value on the line — a nested block (or nothing) follows.
      entries.set(key, { value: undefined, kind: 'block', line, valueStart, valueEnd: valueStart })
      continue
    }
    const head = value[0]!
    if ('&*!|>{['.includes(head)) {
      const tokenLength = /^[^\s]+/.exec(value)![0].length
      entries.set(key, { value: undefined, kind: 'complex', line, valueStart, valueEnd: valueStart + tokenLength })
      continue
    }
    if (head === "'" || head === '"') {
      // Find the closing quote: `''` escapes inside `'…'`, `\.` inside `"…"`.
      let close = -1
      for (let i = 1; i < value.length; i += 1) {
        if (head === "'" && value[i] === "'" && value[i + 1] === "'") { i += 1; continue }
        if (head === '"' && value[i] === '\\') { i += 1; continue }
        if (value[i] === head) { close = i; break }
      }
      if (close < 0) {
        entries.set(key, { value: undefined, kind: 'complex', line, valueStart, valueEnd: valueStart + value.length })
        continue
      }
      const trailing = value.slice(close + 1)
      let scalar: string | undefined
      try {
        scalar = unquoteYamlToken(value.slice(0, close + 1), what => { throw new Error(what) })
      } catch { scalar = undefined }
      if (!/^\s*(#|$)/.test(trailing)) {
        entries.set(key, { value: undefined, kind: 'complex', line, valueStart, valueEnd: valueStart + close + 1 })
      } else if (scalar === undefined) {
        entries.set(key, { value: undefined, kind: 'complex', line, valueStart, valueEnd: valueStart + close + 1 })
      } else {
        entries.set(key, { value: scalar, kind: 'scalar', line, valueStart, valueEnd: valueStart + close + 1 })
      }
      continue
    }
    const commentAt = plainCommentStart(value)
    const scalarText = (commentAt < 0 ? value : value.slice(0, commentAt)).replace(/[ \t]+$/, '')
    entries.set(key, { value: scalarText, kind: 'scalar', line, valueStart, valueEnd: valueStart + scalarText.length })
  }
  return entries
}

/** What one confirmed profile's `pnpm-workspace.yaml` says about imports. */
export interface ProfileYamlReport {
  /**
   * `absent` — `packageImportMethod` is not configured (the file may still
   * exist); `copy` — it is a same-line scalar `copy`; `conflict` — it exists
   * but is not a plain `copy` scalar, or the yaml exists but is a reparse
   * point / non-file; `unreadable` — the file cannot be read or the subset
   * scanner rejected it.
   */
  readonly state: 'absent' | 'copy' | 'conflict' | 'unreadable'
  /** Human-readable reason for `conflict`/`unreadable`. */
  readonly detail?: string
}

/** One confirmed profile and its yaml verdict. */
export interface ProfileReport {
  /** The profile directory name under `profiles/`. */
  readonly name: string
  /** The profile's absolute path under the canonical home. */
  readonly path: string
  /** The `packageImportMethod` verdict for its workspace yaml. */
  readonly yaml: ProfileYamlReport
}

/** The read-only whole-home scan accompanying every report. */
export interface HomeScan {
  /** Directories successfully listed (including the home itself). */
  readonly directories: number
  /** Non-directory entries inspected — plain files and reparse leaves alike. */
  readonly files: number
  /** Plain files carrying more than one name (`st_nlink > 1`). */
  readonly multiLinkTotal: number
  /** Up to {@link SAMPLE_CAP} absolute paths of multi-link files. */
  readonly multiLinkPaths: readonly string[]
  /** Entries `lstat`/`readdir` failed on (first {@link SAMPLE_CAP}). */
  readonly uninspectable: readonly { path: string; reason: string }[]
  /** Total uninspectable entries — may exceed the retained paths. */
  readonly uninspectableTotal: number
}

/** The read-only verdict for one canonical home. */
export interface IsolateReport {
  /** The canonical DSH home the report covers. */
  readonly home: string
  /** Confirmed profiles only; non-profile entries are listed separately. */
  readonly profiles: readonly ProfileReport[]
  /** `profiles/` entries that are not confirmed profiles — never written. */
  readonly nonProfileEntries: readonly string[]
  /** The whole-home link/uninspectable counts. */
  readonly scan: HomeScan
  /** True whenever anything could not be inspected — never a clean result. */
  readonly incomplete: boolean
}

/** The per-profile outcome of one `--apply` run. */
export interface ProfileAction {
  readonly name: string
  /**
   * `written` — the yaml was created or gained the key; `replaced` — a
   * same-line scalar was swapped in place; `noop` — already `copy`;
   * `refused` — a conflict/unreadable file the command will not guess at.
   */
  readonly action: 'written' | 'replaced' | 'noop' | 'refused'
  readonly detail?: string
}

/** The report of one `--apply` run: the read verdict plus the actions. */
export interface ApplyReport extends IsolateReport {
  readonly actions: readonly ProfileAction[]
}

/** Internal discovery record carrying what a report hides. */
interface DiscoveredProfile {
  readonly name: string
  readonly path: string
  readonly yamlPath: string
  /** The yaml text when it read cleanly; `undefined` when absent/failed. */
  readonly yamlText: string | undefined
  /** The parsed `packageImportMethod` entry when the scanner saw one. */
  readonly entry: WorkspaceYamlEntry | undefined
  readonly yaml: ProfileYamlReport
}

interface InspectedHome {
  readonly home: string
  readonly profiles: readonly DiscoveredProfile[]
  readonly nonProfileEntries: readonly string[]
  readonly scan: {
    directories: number
    files: number
    multiLinkTotal: number
    multiLinkPaths: string[]
    uninspectable: { path: string; reason: string }[]
    uninspectableTotal: number
  }
}

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Judge whether one directory is a confirmed DSH profile: a `package.json`
 * that parses to an object whose `dsh.profile` is itself an object.
 */
function isConfirmedProfile(dir: string): boolean {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return false // missing or corrupt — this dir is not ours to touch
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const dsh = (manifest as { dsh?: unknown }).dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return false
  const profile = (dsh as { profile?: unknown }).profile
  return profile !== null && typeof profile === 'object' && !Array.isArray(profile)
}

/** Classify one confirmed profile's `pnpm-workspace.yaml`. */
function inspectYaml(dir: string): Pick<DiscoveredProfile, 'yamlPath' | 'yamlText' | 'entry' | 'yaml'> {
  const yamlPath = join(dir, WORKSPACE_YAML)
  let stat
  try { stat = lstatSync(yamlPath) } catch { stat = undefined }
  if (stat !== undefined && stat.isSymbolicLink()) {
    return { yamlPath, yamlText: undefined, entry: undefined, yaml: { state: 'conflict', detail: `${WORKSPACE_YAML} is a reparse point — refusing to follow it` } }
  }
  if (stat !== undefined && !stat.isFile()) {
    return { yamlPath, yamlText: undefined, entry: undefined, yaml: { state: 'conflict', detail: `${WORKSPACE_YAML} exists but is not a plain file` } }
  }
  if (stat === undefined) {
    return { yamlPath, yamlText: undefined, entry: undefined, yaml: { state: 'absent' } }
  }
  let text: string
  try { text = readFileSync(yamlPath, 'utf8') } catch (error) {
    return { yamlPath, yamlText: undefined, entry: undefined, yaml: { state: 'unreadable', detail: describeError(error) } }
  }
  let keys: ReadonlyMap<string, WorkspaceYamlEntry>
  try { keys = parseWorkspaceYamlKeys(text, yamlPath) } catch (error) {
    return { yamlPath, yamlText: text, entry: undefined, yaml: { state: 'unreadable', detail: describeError(error) } }
  }
  const entry = keys.get('packageImportMethod')
  if (entry === undefined) return { yamlPath, yamlText: text, entry, yaml: { state: 'absent' } }
  if (entry.kind === 'scalar' && entry.value === 'copy') {
    return { yamlPath, yamlText: text, entry, yaml: { state: 'copy' } }
  }
  const detail = entry.kind === 'scalar'
    ? `packageImportMethod is ${JSON.stringify(entry.value)}`
    : 'packageImportMethod has a block or complex value'
  return { yamlPath, yamlText: text, entry, yaml: { state: 'conflict', detail } }
}

/**
 * Discover the confirmed profiles and scan the whole home. Shared by the
 * read-only report and `--apply` so both look at exactly the same world.
 * @param home - the DSH home (canonicalized inside).
 * @returns the inspected home, profiles, skipped entries, and scan counts.
 */
function inspectHome(home: string): InspectedHome {
  const canonical = canonicalPath(home)
  let stat
  try { stat = lstatSync(canonical) } catch (error) {
    throw new Error(`the DSH home ${canonical} cannot be inspected: ${describeError(error)}`)
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`the DSH home ${canonical} is a reparse point — refusing to work through it`)
  }
  if (!stat.isDirectory()) throw new Error(`the DSH home ${canonical} is not a directory`)

  const scan: InspectedHome['scan'] = {
    directories: 0, files: 0, multiLinkTotal: 0, multiLinkPaths: [],
    uninspectable: [], uninspectableTotal: 0,
  }
  const uninspectable = (path: string, error: unknown): void => {
    scan.uninspectableTotal += 1
    if (scan.uninspectable.length < SAMPLE_CAP) {
      scan.uninspectable.push({ path, reason: describeError(error) })
    }
  }
  const walk = (dir: string): void => {
    scan.directories += 1
    let names: string[]
    try { names = readdirSync(dir) } catch (error) { uninspectable(dir, error); return }
    for (const name of names) {
      const entryPath = join(dir, name)
      let entry
      try { entry = lstatSync(entryPath) } catch (error) { uninspectable(entryPath, error); continue }
      if (entry.isSymbolicLink()) {
        // A reparse point is a leaf: it counts, and is never followed.
        scan.files += 1
        continue
      }
      if (entry.isDirectory()) { walk(entryPath); continue }
      scan.files += 1
      if (entry.nlink > 1) {
        scan.multiLinkTotal += 1
        if (scan.multiLinkPaths.length < SAMPLE_CAP) scan.multiLinkPaths.push(entryPath)
      }
    }
  }
  walk(canonical)

  const profilesDir = join(canonical, 'profiles')
  const profiles: DiscoveredProfile[] = []
  const nonProfileEntries: string[] = []
  let listing: string[] = []
  try {
    const profilesStat = lstatSync(profilesDir)
    if (profilesStat.isSymbolicLink()) {
      throw new Error(`${profilesDir} is a reparse point — refusing to work through it`)
    }
    if (profilesStat.isDirectory()) listing = readdirSync(profilesDir)
    else nonProfileEntries.push(profilesDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // No profiles directory at all — zero profiles is a valid answer.
    } else if (error instanceof Error && error.message.includes('reparse point')) {
      throw error
    } else {
      uninspectable(profilesDir, error)
    }
  }
  for (const name of listing) {
    const dir = join(profilesDir, name)
    let entry
    try { entry = lstatSync(dir) } catch (error) { uninspectable(dir, error); continue }
    if (entry.isSymbolicLink() || !entry.isDirectory() || !isConfirmedProfile(dir)) {
      // Reparse points and non-profile directories are enumerated, never touched.
      nonProfileEntries.push(dir)
      continue
    }
    profiles.push({ name, path: dir, ...inspectYaml(dir) })
  }
  return { home: canonical, profiles, nonProfileEntries, scan }
}

const toReport = (inspected: InspectedHome): IsolateReport => ({
  home: inspected.home,
  profiles: inspected.profiles.map(({ name, path, yaml }) => ({ name, path, yaml })),
  nonProfileEntries: inspected.nonProfileEntries,
  scan: { ...inspected.scan },
  incomplete: inspected.scan.uninspectableTotal > 0,
})

/**
 * Read-only inspection of a DSH home: confirmed profiles under `profiles/`,
 * each one's `packageImportMethod` verdict, and a whole-home `lstat` scan
 * counting directories, files, multi-link files, and uninspectable entries.
 * Nothing is written. The report is `incomplete` — never clean — whenever any
 * entry could not be inspected.
 * @param home - the DSH home to inspect (canonicalized).
 * @returns the isolation report.
 */
export function isolateReport(home: string): IsolateReport {
  return toReport(inspectHome(home))
}

/**
 * Write `packageImportMethod: copy` into every fixable confirmed profile.
 * A missing file receives the upstream profile template plus the copy line;
 * a missing key is appended; a same-line non-`copy` scalar is replaced by
 * byte range so comments and CRLF survive; a block/complex/duplicate-key or
 * unreadable file is refused untouched. Every write lands atomically through
 * a sibling temp file + rename, and the command never descends or writes
 * through a reparse point.
 * @param home - the DSH home to migrate (canonicalized).
 * @returns the read verdict plus one action per confirmed profile.
 */
export function applyIsolateConfig(home: string): ApplyReport {
  const inspected = inspectHome(home)
  const actions: ProfileAction[] = []
  for (const profile of inspected.profiles) {
    const yaml = profile.yaml
    if (yaml.state === 'copy') {
      actions.push({ name: profile.name, action: 'noop', detail: 'packageImportMethod: copy is already set' })
      continue
    }
    if (yaml.state === 'unreadable' || yaml.state === 'conflict' && profile.entry?.kind !== 'scalar') {
      actions.push({ name: profile.name, action: 'refused', ...(yaml.detail === undefined ? {} : { detail: yaml.detail }) })
      continue
    }
    const next = yaml.state === 'conflict'
      // Replace exactly the scalar token — comments and line endings survive.
      ? profile.yamlText!.slice(0, profile.entry!.valueStart) + 'copy' + profile.yamlText!.slice(profile.entry!.valueEnd)
      : profile.yamlText === undefined
        ? PROFILE_PNPM_WORKSPACE + 'packageImportMethod: copy\n'
        : `${profile.yamlText.endsWith('\n') ? profile.yamlText : `${profile.yamlText}\n`}packageImportMethod: copy\n`
    try {
      writeAtomically(profile.yamlPath, next)
      actions.push({
        name: profile.name,
        action: yaml.state === 'conflict' ? 'replaced' : 'written',
        detail: 'packageImportMethod: copy',
      })
    } catch (error) {
      actions.push({ name: profile.name, action: 'refused', detail: `write failed: ${describeError(error)}` })
    }
  }
  return { ...toReport(inspected), actions }
}

/**
 * Atomically replace (or create) a `pnpm-workspace.yaml`: the new text lands
 * in a sibling temp file which is renamed into place, so a failure leaves the
 * original untouched. A reparse point or non-file at the target is refused —
 * the write never crosses it.
 */
function writeAtomically(path: string, text: string): void {
  let target
  try { target = lstatSync(path) } catch { target = undefined }
  if (target !== undefined && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error(`refusing to write through ${path}: not a plain file`)
  }
  const temp = `${path}.mrw-${process.pid}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* the temp may never have existed */ }
    throw error
  }
}

const isInside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`) || path.startsWith(dir.endsWith('\\') ? dir : `${dir}\\`)

const isPlainDir = (path: string): boolean => {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() } catch { return false }
}

const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * The remediation steps the user must run by hand — this command writes
 * configuration only. For every confirmed profile whose dependencies still
 * need re-installing as copies (config changed under it, or links were seen
 * inside it), the steps say: quit the hosts using it, remove its
 * `node_modules` yourself, reinstall from its lockfile. Refused profiles get
 * a manual-resolution line instead of automated steps.
 * @param report - the {@link ApplyReport} (or a check report) to explain.
 * @returns the guidance lines, in English.
 */
export function remediationSteps(report: IsolateReport): string[] {
  const actions = 'actions' in report ? (report as ApplyReport).actions : undefined
  const actionOf = (name: string): ProfileAction['action'] | undefined =>
    actions?.find(action => action.name === name)?.action
  const needsWork: ProfileReport[] = []
  const manual: ProfileReport[] = []
  for (const profile of report.profiles) {
    const action = actionOf(profile.name)
    const refused = action === 'refused'
      || (action === undefined && profile.yaml.state === 'unreadable')
      || (action === undefined && profile.yaml.state === 'conflict')
    if (refused) { manual.push(profile); continue }
    const nodeModules = join(profile.path, 'node_modules')
    const hasModules = isPlainDir(nodeModules)
    const linksSeen = report.scan.multiLinkPaths.some(path => isInside(path, nodeModules))
      || (hasModules && report.scan.multiLinkTotal > report.scan.multiLinkPaths.length)
    if (!hasModules && !linksSeen) continue // nothing installed yet — config alone suffices
    needsWork.push(profile)
  }
  const lines: string[] = []
  if (needsWork.length > 0) {
    lines.push('Profiles that still carry hardlinked dependencies — configuration is set, the objects on disk are not yet copies:')
    for (const profile of needsWork) {
      lines.push(`  profile ${JSON.stringify(profile.name)} — quit every DSH host using it, then in PowerShell:`)
      lines.push(`    Remove-Item -Recurse -Force ${powershellQuote(join(profile.path, 'node_modules'))}`)
      lines.push(`    pnpm --dir ${powershellQuote(profile.path)} install`)
    }
    lines.push('  The command never deletes node_modules and never runs pnpm — the reinstall is yours, per the profile lockfile, while no host is running.')
  }
  for (const profile of manual) {
    lines.push(`  profile ${JSON.stringify(profile.name)} was refused — resolve its ${WORKSPACE_YAML} by hand, then apply the same reinstall steps.`)
  }
  lines.push('Setting the config does not isolate existing dependencies: hardlinks stay hardlinks until the reinstall replaces them.')
  lines.push('Copy import does not repair Administrators ownership or deny ACEs already written onto the pnpm store or other projects; review those separately — no automatic reset exists.')
  lines.push('Profiles created later need the same configuration — re-run this check after adding one.')
  return lines
}
