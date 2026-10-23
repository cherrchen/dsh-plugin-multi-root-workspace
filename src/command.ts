/**
 * The user-facing surface: the `/workspace-folders` command and the panel's
 * RPC channel.
 *
 * They share one module because they are one thing — the operator-facing edge
 * over `ctx.multiRootRegistry`. The command serves the text surfaces (the
 * composer, headless diagnostics) and the channel serves the browser panel;
 * both resolve the same canonical workspace root, call the same registry, and
 * report the same `RootValidationCode` values.
 *
 * Both are also the two places a READ happens, so both go through the same
 * revalidation entry point: `registry.refresh()` re-stats every registered
 * directory, re-resolves it against the directory it was granted for, and
 * republishes the scope BEFORE the list is rendered. Listing is therefore
 * enough to notice that a directory disappeared (and enough to bring a
 * restored one back) — which is what the panel's "Retry" button and the
 * command's `list` both promise.
 *
 * Both halves are SOFT: the command registers only where a command registry is
 * composed, and the channel only where a host Connection and web server exist
 * (web), so a headless profile mounts this row with zero effect on the
 * providers.
 *
 * The command's own text is English: a host-side command handler has no active
 * locale to consult (the browser owns locale state). The panel is bilingual.
 * That split is recorded in the M3 plan and the requirements as a known limit.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/command
 */

import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { effectiveRootAccess } from './contract.ts'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
// Type-only: loads the `workspaceRegistry` Context augmentation this module's
// optional lookup is typed against (the service itself stays a sibling lookup).
import type {} from '@deepseek-ai/dsh-workspace'
import {
  PANEL_CHANNEL,
  parsePanelCall,
  type PanelCall,
  type RevealedView,
  type RootEntryView,
  type RootView,
  type RootsView,
} from './contract.ts'
import type { MultiRootRegistry } from './registry.ts'
import { effectiveDirectory } from './compat/session-directory.ts'
import {
  availableRoots,
  canonicalRoot,
  entryRootRef,
  RootValidationError,
  resolveRootRef,
  type RootAccess,
  type RootRef,
  type RootStatus,
} from './roots.ts'
import {
  applyIsolateConfig,
  isolateReport,
  remediationSteps,
  type ApplyReport,
  type IsolateReport,
} from './profile-isolation.ts'

/** Services this row needs before it may activate. */
export const inject = ['commands', 'sandboxPolicy', 'multiRootRegistry']

/** The command name, without the leading slash. */
export const COMMAND_NAME = 'workspace-folders'

/** One parsed command line. */
export interface FoldersCommand {
  /** The subcommand; `list` when the line named none. */
  readonly verb: 'list' | 'add' | 'remove' | 'alias' | 'alias-id' | 'skills' | 'access' | 'reveal' | 'isolate-profiles' | 'help'
  /** Everything after the verb, verbatim (paths may contain spaces). */
  readonly rest: string
}

/**
 * Parse the text that follows `/workspace-folders`.
 * @param rawInput - the verbatim `rawInput` of the command invocation.
 * @returns the subcommand and its remaining text.
 * @throws {RootValidationError} `invalid-ref` for an unknown subcommand.
 */
export function parseFoldersCommand(rawInput: string): FoldersCommand {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { verb: 'list', rest: '' }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  const verb = match?.[1] ?? ''
  const rest = (match?.[2] ?? '').trim()
  switch (verb) {
    case 'list':
    case 'add':
    case 'remove':
    case 'alias':
    case 'alias-id':
    case 'skills':
    case 'access':
    case 'reveal':
    case 'isolate-profiles':
    case 'help':
      return { verb, rest }
    default:
      throw new RootValidationError('invalid-ref', `unknown subcommand "${verb}"; try /${COMMAND_NAME} help`)
  }
}

/** Strip one layer of matching quotes from an operator-supplied path. */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

/**
 * Render the roots report the command returns. Additional roots are numbered
 * from 1, which is the numbering every other subcommand accepts; the workspace
 * root is never numbered because it cannot be removed.
 * @param primaryRoot - the canonical workspace root.
 * @param statuses - the registry's status list.
 * @param unavailable - the store failure, when the registry could not read it.
 * @returns the report text.
 */
export function renderRootsReport(
  primaryRoot: string,
  statuses: readonly RootStatus[],
  unavailable?: string,
  limit?: number,
  mode?: SandboxMode,
): string {
  const lines = [`Workspace root (primary; access follows the current sandbox mode): ${primaryRoot}`]
  if (unavailable !== undefined) {
    lines.push(`Root registry unavailable: ${unavailable}`)
    return lines.join('\n')
  }
  if (statuses.length === 0) {
    lines.push(`No additional roots. Add one with /${COMMAND_NAME} add <absolute path>.`)
    return lines.join('\n')
  }
  for (const [index, status] of statuses.entries()) {
    const alias = status.alias === undefined ? '' : ` [${status.alias}]`
    const state = status.state === 'available' ? '' : ` (${status.state}: ${status.detail ?? 'unavailable'})`
    lines.push(`  ${index + 1} ${status.path}${alias} (${status.access})${state}${typeof status.aliasId === 'string' ? ` Skills: ${status.skillsEnabled === true ? 'on' : 'off'} /${status.aliasId}:` : ''}`)
  }
  const withheld = statuses.length - availableRoots(statuses).length
  if (withheld > 0) {
    lines.push(
      `${withheld} root(s) are registered but not writable right now;`
      + ` restore the directory and run /${COMMAND_NAME} list, or remove the entry.`,
    )
  }
  if (limit !== undefined) {
    lines.push(`${statuses.length} of ${limit} additional roots.`)
    if (statuses.length > limit) {
      lines.push(
        `Warning: the store exceeds the configured limit of ${limit};`
        + ' every stored root stays granted, only new adds are refused.',
      )
    }
  }
  // "Writable" is mode-relative under the three-state contract (B9): an
  // `inherit` root is writable only when the session is not read-only, while
  // a fixed `read-write` root stays writable under every mode.
  const writable = statuses.filter(status => status.state === 'available'
    && status.access !== 'read-only'
    && (mode !== 'read-only' || status.access === 'read-write')).length
  lines.push(`Writable additional roots${mode === undefined ? '' : ' under the current mode'}: ${writable} of ${statuses.length}.`)
  return lines.join('\n')
}

/** The command-row config: the canonical DSH home `isolate-profiles` inspects. */
export interface CommandConfig {
  /** `$DSH_HOME` as the host resolved it — an absolute path, or the verb fails. */
  readonly dshHome?: string
}

/**
 * Register the command and, where a host Connection exists, the panel channel.
 * @param ctx - the host context carrying `commands`, `sandboxPolicy`, and the registry.
 * @param config - the row's config; `dshHome` feeds `isolate-profiles` only.
 */
export function apply(ctx: Context, config: CommandConfig = {}): void {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: 'List, add, remove, alias, or reveal the additional workspace roots of this session, or isolate DSH profile imports',
    input: { hint: '[list|add [path] [--inherit|--read-only|--read-write]|remove <n|path>|alias <n|path> [name]|alias-id <n|path> <id>|skills <n|path> on|off|access <n|path> <level>|reveal <n|path>|isolate-profiles [--apply]|help]' },
    handler: async invocation => await runCommand(ctx, invocation, config),
  })

  // Soft: a profile without the browser host half (headless, sdk) simply has no
  // panel to serve, and the registry is unaffected.
  //
  // `webServer` MUST be in the dependency list so this callback only runs once
  // the route table exists, and the service MUST be read off `ctx.root`:
  // `connection.rpc.handle` resolves `webServer` as a property of the context
  // the service was READ from, and cordis property resolution from a plugin
  // fiber can only see that fiber's own injected services — a sibling row's
  // `webServer` is invisible, the registration dies with `cannot get property
  // "webServer" without inject`, and every panel request then falls through to
  // the static SPA fallback as HTTP 405. Reading at the root (what the upstream
  // connection tests do) resolves against the shared service store instead.
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const connection = connectionCtx.root.get('connection')
    if (connection === undefined) {
      ctx.logger.warn('multi-root: connection resolved without the service; the panel channel is not mounted')
      return
    }
    const dispose = connection.rpc.handle(PANEL_CHANNEL, async (endpoint, payload) =>
      await dispatchPanelRequest(ctx, endpoint, payload))
    return () => { void dispose() }
  })
}

/** Execute one `/workspace-folders` invocation. */
async function runCommand(ctx: Context, invocation: CommandInvocation, config: CommandConfig): Promise<CommandResult> {
  let parsed: FoldersCommand
  try {
    parsed = parseFoldersCommand(invocation.rawInput)
  } catch (error: unknown) {
    return { kind: 'error', text: failureText(error) }
  }
  const policy = ctx.sandboxPolicy.resolve({ session: invocation.agent.session })
  const primaryRoot = policy.workspaceRoot
  const registry = ctx.multiRootRegistry

  try {
    switch (parsed.verb) {
      case 'help':
        return { kind: 'success', text: helpText() }
      case 'list':
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      case 'add': {
        const { text: rest, access } = splitAddAccess(parsed.rest)
        const typed = unquote(rest)
        const path = typed === '' ? await pickRootPath(ctx, invocation.signal) : typed
        if (path === undefined) {
          return {
            kind: 'error',
            text: `/${COMMAND_NAME}: no directory was selected; pass an absolute path or use the Workspace Folders panel`,
          }
        }
        await registry.add(primaryRoot, { path, ...(access === undefined ? {} : { access }) })
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      }
      case 'remove': {
        const { ref } = await targetOf(registry, primaryRoot, parsed.rest)
        await registry.removeAt(primaryRoot, ref)
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      }
      case 'alias': {
        const { text: reference, rest: alias } = splitReference(parsed.rest)
        const { ref } = await targetOf(registry, primaryRoot, reference)
        await registry.setAlias(primaryRoot, ref, alias === '' ? undefined : unquote(alias))
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      }
      case 'alias-id':
      case 'skills': {
        const { text: reference, rest: value } = splitReference(parsed.rest)
        const { ref } = await targetOf(registry, primaryRoot, reference)
        if (parsed.verb === 'alias-id') await registry.setAliasId(primaryRoot, ref, unquote(value))
        else {
          if (value !== 'on' && value !== 'off') throw new RootValidationError('invalid-ref', 'skills requires on or off')
          await registry.setSkillsEnabled(primaryRoot, ref, value === 'on')
        }
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      }
      case 'access': {
        const { text: reference, rest: level } = splitReference(parsed.rest)
        const access = parseAccessLevel(level)
        const { ref } = await targetOf(registry, primaryRoot, reference)
        await registry.setAccess(primaryRoot, ref, access)
        return { kind: 'success', text: await report(registry, primaryRoot, policy.mode) }
      }
      case 'reveal': {
        const { status: target } = await targetOf(registry, primaryRoot, parsed.rest)
        await revealRoot(ctx, target.path)
        return { kind: 'success', text: `revealed ${target.path}` }
      }
      case 'isolate-profiles': {
        if (parsed.rest !== '' && parsed.rest !== '--apply') {
          throw new RootValidationError(
            'invalid-ref',
            `isolate-profiles accepts only --apply or nothing, got "${parsed.rest}"`,
          )
        }
        const home = isolateHome(config)
        const report = parsed.rest === '--apply' ? applyIsolateConfig(home) : isolateReport(home)
        return { kind: 'success', text: renderIsolateReport(report) }
      }
    }
  } catch (error: unknown) {
    return { kind: 'error', text: failureText(error) }
  }
}

/**
 * The current report for one primary root, after re-checking every registered
 * directory. The refresh is what makes the report describe the present rather
 * than the moment the process started.
 */
async function report(registry: MultiRootRegistry, primaryRoot: string, mode?: SandboxMode): Promise<string> {
  const statuses = await registry.refresh(primaryRoot)
  return renderRootsReport(canonicalRoot(primaryRoot), statuses, registry.unavailable, registry.limit, mode)
}

/** Render a failure the way the composer displays it. */
function failureText(error: unknown): string {
  if (error instanceof RootValidationError) return `/${COMMAND_NAME}: ${error.code}: ${error.message}`
  return `/${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The DSH home `isolate-profiles` inspects — the row config's `dshHome`,
 * an absolute path. Missing or invalid is a verb failure, not a guess: the
 * home is the protected root the deny writer scans, and a wrong guess would
 * either read the wrong tree or pretend a home was checked when none was.
 */
function isolateHome(config: CommandConfig): string {
  const home = config.dshHome
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new RootValidationError(
      'config-invalid',
      `isolate-profiles needs this row's dshHome config to be an absolute path, got ${JSON.stringify(home)}`,
    )
  }
  return home
}

/**
 * Render the `isolate-profiles` report: one line per confirmed profile, the
 * whole-home scan counts, then — on `--apply` — the per-profile action and
 * the remediation steps. An incomplete scan is always called out, because an
 * uninspectable entry is not evidence the home is clean.
 */
function renderIsolateReport(report: IsolateReport | ApplyReport): string {
  const lines: string[] = [
    `/${COMMAND_NAME} isolate-profiles — pnpm import isolation for the DSH home`,
    `DSH home: ${report.home}`,
  ]
  if (report.profiles.length === 0) {
    lines.push('No confirmed profiles under profiles/ (a profile is a directory whose package.json has dsh.profile as an object).')
  }
  for (const profile of report.profiles) {
    const yaml = profile.yaml
    const state = yaml.state === 'copy'
      ? 'packageImportMethod: copy — isolated on the next install'
      : yaml.state === 'absent'
        ? 'packageImportMethod is unset — pnpm defaults to hardlinks'
        : yaml.state === 'conflict'
          ? `conflict: ${yaml.detail ?? 'needs a manual fix'}`
          : `unreadable: ${yaml.detail ?? 'cannot be read'}`
    lines.push(`  ${profile.name}: ${state}`)
  }
  if (report.nonProfileEntries.length > 0) {
    lines.push(`${report.nonProfileEntries.length} entr(ies) under profiles/ are not confirmed profiles and were left untouched:`)
    for (const entry of report.nonProfileEntries) lines.push(`    ${entry}`)
  }
  const scan = report.scan
  lines.push(`Home scan: scanned ${scan.directories} dirs/${scan.files} files, ${scan.multiLinkTotal} multi-link files, ${scan.uninspectableTotal} uninspectable`)
  for (const path of scan.multiLinkPaths) lines.push(`    multi-link: ${path}`)
  if (scan.multiLinkTotal > scan.multiLinkPaths.length) {
    lines.push(`    … and ${scan.multiLinkTotal - scan.multiLinkPaths.length} more multi-link file(s)`)
  }
  for (const entry of scan.uninspectable) lines.push(`    uninspectable: ${entry.path} (${entry.reason})`)
  if (report.scan.uninspectableTotal > scan.uninspectable.length) {
    lines.push(`    … and ${scan.uninspectableTotal - scan.uninspectable.length} more uninspectable entr(ies)`)
  }
  if (report.incomplete) {
    lines.push(`INCOMPLETE: ${scan.uninspectableTotal} entr(ies) could not be inspected — this report must not be read as clean.`)
  }
  const stuck = report.profiles.filter(profile =>
    profile.yaml.state === 'unreadable' || (profile.yaml.state === 'conflict'))
  if (stuck.length > 0) {
    lines.push('Profiles listed as conflict/unreadable are refused by --apply: fix or remove their pnpm-workspace.yaml by hand, then re-run.')
  }
  if ('actions' in report) {
    lines.push('Apply results:')
    for (const action of (report as ApplyReport).actions) {
      lines.push(`  ${action.name}: ${action.action}${action.detail === undefined ? '' : ` — ${action.detail}`}`)
    }
    lines.push(...remediationSteps(report))
  } else {
    lines.push(`This was a read-only check; run /${COMMAND_NAME} isolate-profiles --apply to write packageImportMethod: copy into every fixable profile.`)
    lines.push('A configured profile still needs its dependencies reinstalled to become copies — the check reports, --apply configures, the reinstall is yours.')
  }
  return lines.join('\n')
}

/** The command's own help text. */
function helpText(): string {
  return [
    `/${COMMAND_NAME} — additional workspace roots of this session`,
    `  /${COMMAND_NAME} list`,
    `  /${COMMAND_NAME} add [absolute path] [--inherit|--read-only|--read-write]   (no path opens the directory picker when one is composed)`,
    `  /${COMMAND_NAME} remove <n|path>`,
    `  /${COMMAND_NAME} alias <n|path> [name]  (no name clears the alias)`,
    `  /${COMMAND_NAME} access <n|path> inherit|read-only|read-write`,
    `  /${COMMAND_NAME} skills <n|path> on|off`,
    `  /${COMMAND_NAME} alias-id <n|path> <kebab-case>`,
    `  /${COMMAND_NAME} reveal <n|path>`,
    `  /${COMMAND_NAME} isolate-profiles [--apply]   (report or set packageImportMethod: copy for every profile under $DSH_HOME)`,
    'Roots are canonicalized before they are stored: `~` expands, and a duplicate, a nested directory,',
    "or this session's own workspace root is rejected.",
    'Access levels: `inherit` follows the session mode; `read-only` refuses writes under every mode;',
    '`read-write` stays writable even in a read-only session.',
    '`isolate-profiles` exists because a Windows deny ACE applies to the file object, not one hardlink name:',
    'profiles whose dependencies are hardlinked into the pnpm store make `$DSH_HOME` unsafe to deny;',
    'the check scans the whole home (links > 1, uninspectable entries) and --apply rewrites the yaml atomically,',
    'but the existing hardlinks are replaced only by the reinstall the report prints.',
  ].join('\n')
}

/**
 * Split `add`'s argument into the path text and the access flag. Either flag
 * is accepted as the first or the last token, so a path containing the flag
 * spelling (quoted or unquoted) is never mistaken for the flag.
 *
 * The access is TRI-STATE on purpose: it stays `undefined` when the operator
 * named no level. `registry.add` revives a withheld record with its stored
 * access unless a level is given explicitly, so forwarding a default here
 * would silently change the registration's authority.
 */
function splitAddAccess(text: string): { text: string; access: RootAccess | undefined } {
  const trimmed = text.trim()
  for (const access of ['read-only', 'read-write', 'inherit'] as const) {
    const flag = `--${access}`
    if (trimmed === flag) return { text: '', access }
    if (trimmed.startsWith(`${flag} `) || trimmed.startsWith(`${flag}\t`)) {
      return { text: trimmed.slice(flag.length).trim(), access }
    }
    if (new RegExp(`\\s${flag}$`).test(trimmed)) {
      return { text: trimmed.slice(0, -flag.length).trim(), access }
    }
  }
  return { text: trimmed, access: undefined }
}

/** Parse the access level an `access` subcommand must end with. */
function parseAccessLevel(text: string): RootAccess {
  const trimmed = text.trim()
  if (trimmed === 'read-only' || trimmed === 'read-write' || trimmed === 'inherit') return trimmed
  throw new RootValidationError('invalid-ref', `the access level must be inherit, read-only, or read-write, got "${trimmed || 'nothing'}"`)
}

/**
 * Split `alias`'s argument into a reference and the alias text.
 *
 * The reference is the first whitespace-delimited token, except when it opens
 * with a quote: a quoted path may contain spaces, so the whole quoted span is
 * the reference and the remainder is the alias.
 */
function splitReference(text: string): { text: string; rest: string } {
  const trimmed = text.trim()
  if (trimmed === '') throw new RootValidationError('invalid-ref', 'a root reference is required')
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0] ?? ''
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return { text: trimmed.slice(0, end + 1), rest: trimmed.slice(end + 1).trim() }
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  return { text: match?.[1] ?? '', rest: (match?.[2] ?? '').trim() }
}

/**
 * Resolve an operator reference — a 1-based number, a path, or an id — to the
 * registered root it names.
 * @param registry - the registry to read.
 * @param primaryRoot - the workspace root the registrations belong to.
 * @param text - the operator's text.
 * @returns the matched status, after re-checking the registered directories.
 * @throws {RootValidationError} `invalid-ref` for empty text, `not-found` when nothing matches.
 */
async function targetOf(
  registry: MultiRootRegistry,
  primaryRoot: string,
  text: string,
): Promise<{ readonly status: RootStatus; readonly ref: RootRef }> {
  const trimmed = text.trim()
  if (trimmed === '') throw new RootValidationError('invalid-ref', 'a root reference is required')
  // A reference must name a root that exists RIGHT NOW: an ordinal points at a
  // position, and a path is resolved against the current canonical spelling.
  const statuses = await registry.refresh(primaryRoot)
  let status: RootStatus
  if (/^\d+$/.test(trimmed)) {
    const ordinal = Number(trimmed)
    status = resolveRootRef(statuses, { kind: 'ordinal', ordinal })
    return { status, ref: entryRootRef(status, ordinal) }
  }
  const asPath = unquote(trimmed)
  if (asPath === '~' || asPath.startsWith('~') || asPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(asPath)) {
    status = resolveRootRef(statuses, { kind: 'path', path: asPath })
  } else {
    status = resolveRootRef(statuses, { kind: 'id', id: trimmed })
  }
  const ordinal = statuses.indexOf(status) + 1
  return { status, ref: entryRootRef(status, ordinal) }
}

/**
 * Derive the primary root a panel request may act on.
 *
 * The browser names a live session; the host looks that session up and uses
 * its immutable cwd. There is no client-supplied path and no deployment-default
 * fallback: a panel call without a real host session has no workspace to
 * manage. Property access would demand an injected `sessions` dependency this
 * row does not name, so the lookup stays an explicit sibling `get` (the same
 * pattern as `directoryPicker` / `subprocess`).
 *
 * @param ctx - the host context that may carry `sessions`.
 * @param sessionId - the id the panel sent; already required by the wire schema.
 * @returns the canonical cwd of that session.
 * @throws {RootValidationError} `session-not-found` when the service is absent,
 *   the id does not name a live session, or that session has no cwd.
 */
export function resolvePanelPrimaryRoot(ctx: Context, sessionId: string): string {
  const session = ctx.get('sessions')?.get(sessionId as SessionId)
  const cwd = session?.header.cwd
  if (session === undefined || cwd === undefined || cwd === '') {
    throw new RootValidationError('session-not-found', `session "${sessionId}" is not an active host session`, {
      reference: sessionId,
    })
  }
  return canonicalPath(cwd)
}

/** Project one status into the panel's view. */
function toRootView(status: RootStatus, index: number): RootView {
  return {
    ordinal: index + 1,
    id: status.id,
    path: status.path,
    ...(typeof status.aliasId === 'string' ? { aliasId: status.aliasId } : {}),
    skillsEnabled: status.skillsEnabled === true,
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    addedAt: status.addedAt,
    state: status.state,
    access: status.access,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  }
}

/**
 * Resolve the display name of the primary root from the host's workspace
 * registry — the title the operator set in the workspace browser, falling back
 * to nothing (the panel then shows the path's basename).
 *
 * The registry is an optional sibling service, read through the explicit
 * lookup like `sessions`/`subprocess`: property access would demand an
 * injected dependency this row does not name. Membership wins over cwd, which
 * mirrors the host's own session→workspace resolution.
 */
async function primaryNameOf(ctx: Context, primaryRoot: string, request: PanelCall): Promise<string | undefined> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const sessionId = request.sessionId
    if (sessionId !== undefined && sessionId !== '') {
      const member = registry.list().find(workspace => workspace.sessionIds.includes(sessionId as SessionId))
      if (member !== undefined) return member.title
    }
    const resolved = await registry.resolveByPath(primaryRoot)
    return resolved?.title
  } catch (error: unknown) {
    // A name is decoration, never a reason to fail the endpoint: an unreadable
    // registry leaves the panel on the basename fallback.
    ctx.logger.warn('multi-root: workspace title lookup failed; the panel falls back to the path basename', error)
    return undefined
  }
}

/**
 * Build the panel's view of one primary root, after re-checking every
 * registered directory — the panel's read path is the same revalidation the
 * command uses, so "the list the operator sees" is always the list the scope
 * currently enforces.
 */
async function rootsViewOf(ctx: Context, registry: MultiRootRegistry, primaryRoot: string, request: PanelCall): Promise<RootsView> {
  const statuses = await registry.refresh(primaryRoot)
  const unavailable = registry.unavailable
  const primaryName = await primaryNameOf(ctx, primaryRoot, request)
  const session = ctx.get('sessions')?.get(request.sessionId as SessionId)
  const effectiveCwd = session === undefined ? undefined : effectiveDirectory(ctx, session)
  // Session origin and policy are host-derived; the request carries neither.
  if (session === undefined) throw new RootValidationError('session-not-found', 'the panel session closed during the request')
  const policy = ctx.sandboxPolicy.resolve({ session })
  const scope = ctx.get('multiRootScope')
  return {
    primaryRoot: canonicalRoot(primaryRoot),
    ...(primaryName === undefined ? {} : { primaryName }),
    ...(effectiveCwd === undefined ? {} : { effectiveCwd }),
    mode: policy.mode,
    cappedTools: scope?.toolCaps() ?? [],
    toolAccessInvalid: scope?.toolAccessInvalid ?? false,
    roots: statuses.map((status, index) => ({ ...toRootView(status, index),
      effectiveAccess: status.state === 'available' ? effectiveRootAccess(status.access, policy.mode) : 'unavailable',
    })),
    limit: registry.limit,
    count: statuses.length,
    ...(unavailable === undefined ? {} : { unavailable }),
  }
}

/**
 * Serve one panel endpoint.
 *
 * The payload is validated before anything acts on it: it arrived from a
 * browser, and the host is the side that must not be surprised by a shape it
 * did not expect (see `contract.ts`, which owns the schema both halves share).
 * A malformed request is reported as `panel/bad-request` rather than throwing
 * through the channel.
 */
async function dispatchPanelRequest(
  ctx: Context,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<unknown>> {
  try {
    const parsed = parsePanelCall(endpoint, payload)
    if (!parsed.ok) {
      return { ok: false, error: { code: 'panel/bad-request', message: parsed.message, details: {} } }
    }
    const request = parsed.value
    const registry = ctx.multiRootRegistry
    const primaryRoot = resolvePanelPrimaryRoot(ctx, request.sessionId)
    switch (request.endpoint) {
      case 'list':
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'add': {
        if (request.path === undefined || request.path === '') {
          throw new RootValidationError('missing', 'a directory path is required')
        }
        await registry.add(primaryRoot, {
          path: request.path,
          ...(request.alias === undefined ? {} : { alias: request.alias }),
          ...(request.access === undefined ? {} : { access: request.access }),
        })
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      }
      case 'setSkillsEnabled':
        if (request.skillsEnabled === undefined) throw new RootValidationError('invalid-ref', 'skillsEnabled is required')
        await registry.setSkillsEnabled(primaryRoot, requireEntry(request), request.skillsEnabled)
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'setAliasId':
        if (request.aliasId === undefined) throw new RootValidationError('invalid-alias-id', 'aliasId is required')
        await registry.setAliasId(primaryRoot, requireEntry(request), request.aliasId)
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'setAccess': {
        if (request.access === undefined) {
          throw new RootValidationError('invalid-ref', 'an access level is required')
        }
        await registry.setAccess(primaryRoot, requireEntry(request), request.access)
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      }
      case 'remove':
        await registry.removeAt(primaryRoot, requireEntry(request))
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'alias':
        await registry.setAlias(primaryRoot, requireEntry(request), request.alias)
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'move':
        await registry.move(
          primaryRoot,
          requireEntry(request),
          request.beforeEntry !== undefined
            ? entryRefOf(request.beforeEntry)
            : request.beforeId === undefined ? undefined : { kind: 'id', id: request.beforeId },
        )
        return { ok: true, value: await rootsViewOf(ctx, registry, primaryRoot, request) }
      case 'reveal': {
        const ref = requireEntry(request)
        // The reference is resolved against the re-checked list, so revealing a
        // root whose directory changed still targets the current spelling.
        const target = resolveRootRef(await registry.refresh(primaryRoot), ref)
        await revealRoot(ctx, target.path)
        // The ONE endpoint that does not answer with a roots view: it reports
        // what it revealed, and the panel leaves its list as it is.
        const value: RevealedView = { revealed: target.path }
        return { ok: true, value }
      }
    }
  } catch (error: unknown) {
    if (error instanceof RootValidationError) {
      return { ok: false, error: { code: error.code, message: error.message, details: {} } }
    }
    return {
      ok: false,
      error: { code: 'panel/internal', message: error instanceof Error ? error.message : String(error), details: {} },
    }
  }
}

/** Convert a validated wire snapshot to the registry's exact-entry reference. */
function entryRefOf(entry: RootEntryView): RootRef {
  return { kind: 'entry', ...entry }
}

/** Require the exact list row a mutating panel request must carry. */
function requireEntry(request: PanelCall): RootRef {
  if (request.entry !== undefined) return entryRefOf(request.entry)
  if (request.id !== undefined && request.id !== '') return { kind: 'id', id: request.id }
  throw new RootValidationError('invalid-ref', 'an exact root entry is required')
}

/**
 * Open the composed directory picker when one exists, and answer `undefined`
 * otherwise (the command then reports the missing affordance).
 *
 * Only the `native` capability can answer a host-side command: the `browse`
 * capability is an in-app dialog that only the browser panel can render.
 */
async function pickRootPath(ctx: Context, signal: AbortSignal): Promise<string | undefined> {
  const picker = ctx.get('directoryPicker')
  if (picker === undefined) return undefined
  const capability = picker.capability()
  if (capability.kind !== 'native') return undefined
  const picked = await capability.pick(signal)
  return picked ?? undefined
}

/** The per-platform argv that reveals one directory in the OS file manager. */
export function revealArgv(platform: NodeJS.Platform, path: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return ['open', '-R', path]
    case 'win32':
      return ['explorer', `/select,${path}`]
    default:
      return ['xdg-open', path]
  }
}

/**
 * Whether the file manager's exit code means the reveal was accepted.
 * `explorer.exe` answers 1 even when it successfully selected the item, so on
 * Windows both 0 and 1 are success; the other managers honor the usual 0.
 */
export function revealAccepted(platform: NodeJS.Platform, exitCode: number | null): boolean {
  return exitCode === 0 || (platform === 'win32' && exitCode === 1)
}

/**
 * Reveal one directory in the OS file manager through `ctx.subprocess`.
 *
 * This runs no confined command and grants the agent nothing: it is an
 * operator action taken from the panel or the command line, and the process is
 * the platform's own file manager. Failures are reported to the caller.
 */
async function revealRoot(ctx: Context, path: string): Promise<void> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new RootValidationError(
      'reveal-unavailable',
      'revealing a root needs a process runtime, which this composition does not mount',
    )
  }
  const argv = revealArgv(process.platform, path)
  const [program = '', ...args] = argv
  const executable = await subprocess.resolveExecutable(program)
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd: path,
    // The file manager's own chatter is collected boundedly and never shown:
    // all this action reports is whether the platform accepted the request.
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 3000,
  })
  const outcome = await handle.done
  await handle.waitForExit()
  if (!revealAccepted(process.platform, outcome.exitCode)) {
    throw new RootValidationError('reveal-unavailable', `the file manager exited with ${String(outcome.exitCode)}`)
  }
}
