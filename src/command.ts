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
 * Both halves are SOFT: the command registers only where a command registry is
 * composed, and the channel only where a host Connection exists (web), so a
 * headless profile mounts this row with zero effect on the providers.
 *
 * The command's own text is English: a host-side command handler has no active
 * locale to consult (the browser owns locale state). The panel is bilingual.
 * That split is recorded in the M3 plan and the requirements as a known limit.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/command
 */

import { statSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { canonicalPath, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { PANEL_CHANNEL, type PanelRequest, type RootView, type RootsView } from './contract.ts'
import type { MultiRootRegistry } from './registry.ts'
import { availableRoots, canonicalRoot, expandRootInput, RootValidationError, resolveRootRef, type RootStatus } from './roots.ts'

/** Services this row needs before it may activate. */
export const inject = ['commands', 'sandboxPolicy', 'multiRootRegistry']

/** The command name, without the leading slash. */
export const COMMAND_NAME = 'workspace-folders'

/** One parsed command line. */
export interface FoldersCommand {
  /** The subcommand; `list` when the line named none. */
  readonly verb: 'list' | 'add' | 'remove' | 'alias' | 'reveal' | 'help'
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
    case 'reveal':
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
): string {
  const lines = [`Workspace root (primary, always writable): ${primaryRoot}`]
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
    lines.push(`  ${index + 1} ${status.path}${alias}${state}`)
  }
  const withheld = statuses.length - availableRoots(statuses).length
  if (withheld > 0) {
    lines.push(
      `${withheld} root(s) are registered but not writable right now;`
      + ` restore the directory and run /${COMMAND_NAME} list, or remove the entry.`,
    )
  }
  lines.push(`Writable additional roots: ${availableRoots(statuses).length} of ${statuses.length}.`)
  return lines.join('\n')
}

/**
 * Register the command and, where a host Connection exists, the panel channel.
 * @param ctx - the host context carrying `commands`, `sandboxPolicy`, and the registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: 'List, add, remove, alias, or reveal the additional workspace roots of this session',
    input: { hint: '[list|add [path]|remove <n|path>|alias <n|path> [name]|reveal <n|path>|help]' },
    handler: async invocation => await runCommand(ctx, invocation),
  })

  // Soft: a profile without the browser host half (headless, sdk) simply has no
  // panel to serve, and the registry is unaffected.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection')
    if (connection === undefined) return
    const dispose = connection.rpc.handle(PANEL_CHANNEL, async (endpoint, payload, signal) =>
      await dispatchPanelRequest(ctx, endpoint, payload, signal))
    return () => { void dispose() }
  })
}

/** Execute one `/workspace-folders` invocation. */
async function runCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
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
        return { kind: 'success', text: report(registry, primaryRoot) }
      case 'add': {
        const typed = unquote(parsed.rest)
        const path = typed === '' ? await pickRootPath(ctx, invocation.signal) : typed
        if (path === undefined) {
          return {
            kind: 'error',
            text: `/${COMMAND_NAME}: no directory was selected; pass an absolute path or use the Workspace Folders panel`,
          }
        }
        await registry.add(primaryRoot, { path })
        return { kind: 'success', text: report(registry, primaryRoot) }
      }
      case 'remove': {
        await registry.remove(primaryRoot, { kind: 'id', id: targetOf(registry, primaryRoot, parsed.rest).id })
        return { kind: 'success', text: report(registry, primaryRoot) }
      }
      case 'alias': {
        const { text: reference, rest: alias } = splitReference(parsed.rest)
        const target = targetOf(registry, primaryRoot, reference)
        await registry.setAlias(primaryRoot, { kind: 'id', id: target.id }, alias === '' ? undefined : unquote(alias))
        return { kind: 'success', text: report(registry, primaryRoot) }
      }
      case 'reveal': {
        const target = targetOf(registry, primaryRoot, parsed.rest)
        await revealRoot(ctx, target.path)
        return { kind: 'success', text: `revealed ${target.path}` }
      }
    }
  } catch (error: unknown) {
    return { kind: 'error', text: failureText(error) }
  }
}

/** The current report for one primary root. */
function report(registry: MultiRootRegistry, primaryRoot: string): string {
  return renderRootsReport(canonicalRoot(primaryRoot), registry.list(primaryRoot), registry.unavailable)
}

/** Render a failure the way the composer displays it. */
function failureText(error: unknown): string {
  if (error instanceof RootValidationError) return `/${COMMAND_NAME}: ${error.code}: ${error.message}`
  return `/${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`
}

/** The command's own help text. */
function helpText(): string {
  return [
    `/${COMMAND_NAME} — additional workspace roots of this session`,
    `  /${COMMAND_NAME} list`,
    `  /${COMMAND_NAME} add [absolute path]   (no path opens the directory picker when one is composed)`,
    `  /${COMMAND_NAME} remove <n|path>`,
    `  /${COMMAND_NAME} alias <n|path> [name]  (no name clears the alias)`,
    `  /${COMMAND_NAME} reveal <n|path>`,
    'Roots are canonicalized before they are stored: `~` expands, and a duplicate, a nested directory,',
    "or this session's own workspace root is rejected.",
  ].join('\n')
}

/**
 * Split `alias`'s argument into a reference and the alias text. A quoted or
 * path-shaped first argument may contain spaces, so it is kept whole; an id
 * cannot, so the remainder is the alias.
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
  const head = match?.[1] ?? ''
  const tail = (match?.[2] ?? '').trim()
  if (/^\d+$/.test(head) || head.includes('/') || head.startsWith('~')) return { text: head, rest: tail }
  return { text: head, rest: tail }
}

/**
 * Resolve an operator reference — a 1-based number, a path, or an id — to the
 * registered root it names.
 * @param registry - the registry to read.
 * @param primaryRoot - the workspace root the registrations belong to.
 * @param text - the operator's text.
 * @returns the matched status.
 * @throws {RootValidationError} `invalid-ref` for empty text, `not-found` when nothing matches.
 */
function targetOf(registry: MultiRootRegistry, primaryRoot: string, text: string): RootStatus {
  const trimmed = text.trim()
  if (trimmed === '') throw new RootValidationError('invalid-ref', 'a root reference is required')
  const statuses = registry.list(primaryRoot)
  if (/^\d+$/.test(trimmed)) {
    return resolveRootRef(statuses, { kind: 'ordinal', ordinal: Number(trimmed) })
  }
  const asPath = unquote(trimmed)
  if (asPath === '~' || asPath.startsWith('~') || asPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(asPath)) {
    return resolveRootRef(statuses, { kind: 'path', path: asPath })
  }
  return resolveRootRef(statuses, { kind: 'id', id: trimmed })
}

/**
 * Resolve the workspace root a panel request acts on.
 *
 * A client-supplied `primaryRoot` is accepted — the browser is the operator's
 * own trusted client, and the panel names the root it displays — but it must be
 * an existing directory. Otherwise the session's immutable cwd, then the
 * deployment fallback, decides.
 */
function primaryRootOf(ctx: Context, request: PanelRequest): string {
  if (request.primaryRoot !== undefined && request.primaryRoot !== '') {
    const canonical = canonicalRoot(expandRootInput(request.primaryRoot))
    let isDirectory = false
    try {
      isDirectory = statSync(canonical).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      throw new RootValidationError('missing', `"${request.primaryRoot}" is not an existing directory`, {
        reference: request.primaryRoot,
      })
    }
    return canonical
  }
  if (request.sessionId !== undefined && request.sessionId !== '') {
    const cwd = ctx.sessions.get(request.sessionId as SessionId)?.header.cwd
    if (cwd !== undefined && cwd !== '') return canonicalPath(cwd)
  }
  const policy: SandboxExecutionPolicy = ctx.sandboxPolicy.resolve()
  return canonicalRoot(policy.workspaceRoot)
}

/** Project one status into the panel's view. */
function toRootView(status: RootStatus): RootView {
  return {
    id: status.id,
    path: status.path,
    ...(status.alias === undefined ? {} : { alias: status.alias }),
    addedAt: status.addedAt,
    state: status.state,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  }
}

/** Build the panel's view of one primary root. */
function rootsViewOf(registry: MultiRootRegistry, primaryRoot: string): RootsView {
  const unavailable = registry.unavailable
  return {
    primaryRoot: canonicalRoot(primaryRoot),
    roots: registry.list(primaryRoot).map(toRootView),
    ...(unavailable === undefined ? {} : { unavailable }),
  }
}

/** Serve one panel endpoint. */
async function dispatchPanelRequest(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  _signal: AbortSignal,
): Promise<ConnectionRpcResult<unknown>> {
  const request = (payload ?? {}) as PanelRequest
  try {
    const registry = ctx.multiRootRegistry
    const primaryRoot = primaryRootOf(ctx, request)
    switch (endpoint) {
      case 'list':
        return { ok: true, value: rootsViewOf(registry, primaryRoot) }
      case 'add': {
        if (request.path === undefined || request.path === '') {
          throw new RootValidationError('missing', 'a directory path is required')
        }
        await registry.add(primaryRoot, {
          path: request.path,
          ...(request.alias === undefined ? {} : { alias: request.alias }),
        })
        return { ok: true, value: rootsViewOf(registry, primaryRoot) }
      }
      case 'remove':
        await registry.remove(primaryRoot, { kind: 'id', id: requireId(request) })
        return { ok: true, value: rootsViewOf(registry, primaryRoot) }
      case 'alias':
        await registry.setAlias(primaryRoot, { kind: 'id', id: requireId(request) }, request.alias)
        return { ok: true, value: rootsViewOf(registry, primaryRoot) }
      case 'move':
        await registry.move(
          primaryRoot,
          { kind: 'id', id: requireId(request) },
          request.beforeId === undefined ? undefined : { kind: 'id', id: request.beforeId },
        )
        return { ok: true, value: rootsViewOf(registry, primaryRoot) }
      case 'reveal': {
        const id = requireId(request)
        const target = registry.list(primaryRoot).find(status => status.id === id)
        if (target === undefined) {
          throw new RootValidationError('not-found', `no registered root with id "${id}"`)
        }
        await revealRoot(ctx, target.path)
        return { ok: true, value: { revealed: target.path } }
      }
      default:
        return { ok: false, error: { code: 'panel/bad-request', message: `unknown endpoint "${endpoint}"`, details: {} } }
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

/** Require the identity a mutating panel request must carry. */
function requireId(request: PanelRequest): string {
  if (request.id === undefined || request.id === '') {
    throw new RootValidationError('invalid-ref', 'a root id is required')
  }
  return request.id
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
      'storage-unavailable',
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
  if (outcome.exitCode !== 0) {
    throw new RootValidationError('storage-unavailable', `the file manager exited with ${String(outcome.exitCode)}`)
  }
}
