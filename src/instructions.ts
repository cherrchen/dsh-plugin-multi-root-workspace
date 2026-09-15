/**
 * `multi-root-instructions`: the additional roots' own instruction files, made
 * visible to the model.
 *
 * Upstream `agent-instructions` discovers instruction files by walking UP from
 * the session cwd (plus the one user-global file). In a multi-root workspace
 * that walk never reaches an additional root, so `repo-b/AGENTS.md` is
 * invisible to a model that is nevertheless allowed to write `repo-b`. This row
 * closes exactly that gap, and nothing else: the primary root's chain — nested
 * files included — and the user-global file stay upstream's business.
 *
 * Four deliberate choices:
 *
 * 1. **Not a system-prompt contribution.** Instruction text is
 *    producer-supplied context, not system authority, so it enters as a
 *    user-role message tagged `{ kind: 'plugin', form: 'instructions' }` — the
 *    position DSH's own message model reserves for it. It is also the only
 *    channel that is logged, and model-visible content must be logged.
 * 2. **Injected from `agent/pre-step`, not a session lifecycle event.**
 *    `pre-step` is an awaited waterfall, so discovery, reading and rendering all
 *    complete BEFORE the step it feeds — deterministically, on the first step.
 *    A synchronous prompt callback could not await them, and an emit-mode
 *    lifecycle listener would race the first step. It is also the one hook whose
 *    shape is identical across every supported release, which keeps the
 *    instruction feature out of the compatibility matrix (ADR-0009).
 * 3. **Discovery is pinned to the root.** `projectRoot` is the additional root,
 *    so the walk can never leave it, and every candidate is then required to be
 *    canonically INSIDE that root. That is what keeps `$DSH_HOME/AGENTS.md`, the
 *    primary root's `AGENTS.md`, and any ancestor's file from being injected a
 *    second time by this plugin.
 * 4. **Nested files are driven by the session's own tool activity.** A
 *    subdirectory's `AGENTS.md` only matters once the session has worked in that
 *    subdirectory, so the directories worth examining are derived from the
 *    session's persisted events: `tool/call` and `tool/result` are paired, and a
 *    successful `read`/`write`/`edit` makes the path from the root down to the
 *    touched file's directory relevant (ADR-0010). A file that disappears is
 *    retracted explicitly, because the text it contributed earlier is still in
 *    the conversation and silence does not withdraw it.
 *
 * The byte budget is shared: `maxBytes` bounds the WHOLE additional-root
 * snapshot, not each root, because ten roots must not quietly cost ten budgets
 * of context. Roots consume it in scope order. Retractions are exempt, because a
 * truncated withdrawal is worse than a slightly over-budget message.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/instructions
 */

import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from './compat.ts'
import { instructionsApi } from './compat/agent-instructions.ts'
import type { InstructionFile, InstructionsApi, LoadedInstructionFile } from './compat/agent-instructions.ts'
import { isCanonicallyUnder } from './roots.ts'
import type {} from './scope.ts'

/** The `plugin` attribution every message this row produces carries. */
export const PLUGIN_SOURCE = '@dsh-electron/dsh-plugin-multi-root-workspace'

/**
 * Total UTF-8 byte budget for the additional-root snapshot, matching the
 * default the upstream `agent-instructions` row is composed with so that one
 * extra workspace root costs at most as much as the primary one does.
 */
export const DEFAULT_MAX_BYTES = 65536

/** Largest instruction file this row will read; larger files are ignored. */
export const DEFAULT_MAX_SOURCE_BYTES = 32768

/** Tools whose SUCCESS makes the directories on the path to the file relevant. */
const FILE_TOUCH_TOOL_NAMES: Record<string, true> = { read: true, write: true, edit: true }

/** Cap on unanswered `tool/call` records remembered across all sessions. */
const MAX_PENDING_CALLS = 128

/** Cap on touched paths remembered per session; beyond it, touches are dropped. */
const MAX_TOUCHED_PATHS = 64

/** Cap on delivered scopes remembered per session; beyond it, nested scopes stop. */
const MAX_DELIVERED_SCOPES = 512

/** Plugin configuration for the `multi-root-instructions` row. */
export interface Config {
  /** Total budget for ALL additional roots (default {@link DEFAULT_MAX_BYTES}); non-positive disables the row. */
  readonly maxBytes?: number
  /** Per-file source cap (default {@link DEFAULT_MAX_SOURCE_BYTES}). */
  readonly maxSourceBytes?: number
  /** Ordered same-directory instruction candidates; upstream's defaults when omitted. */
  readonly instructionFileCandidates?: readonly string[]
  /** Ordered same-directory local-overlay candidates; upstream's defaults when omitted. */
  readonly localInstructionFileCandidates?: readonly string[]
}

/** One instruction file the model has already been told about. */
interface DeliveredScope {
  /** The additional root the file belongs to. */
  readonly root: string
  /** The file's absolute path. */
  readonly path: string
  /** SHA-256 of the delivered file's content, so a change is re-sent. */
  readonly digest: string
}

/** One session's delivery state: what was delivered, and what is worth looking at. */
interface SessionState {
  /** Delivered instruction files, keyed by {@link scopeKey}. */
  readonly scopes: Map<string, DeliveredScope>
  /** Absolute paths touched by a successful tool call since the last evaluation. */
  readonly touched: Set<string>
}

/** Unanswered `tool/call` records, by call id, so a result can name its tool. */
type PendingCalls = Map<string, { readonly name: string; readonly arguments: string }>

/** One root's freshly rendered instruction text. */
export interface RenderedRoot {
  /** The canonical additional root. */
  readonly root: string
  /** The rendered instruction text. */
  readonly text: string
}

/** One instruction file that is no longer present. */
export interface RemovedScope {
  /** The additional root it belonged to. */
  readonly root: string
  /** The instruction file's absolute path. */
  readonly path: string
}

/** Digest one file's content. Content-addressed, so identical content never re-sends. */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The scope identity of one candidate instruction file.
 *
 * NUL-joined, so two additional roots carrying the same relative
 * `AGENTS.md` can never collide on one key.
 * @param root - the canonical additional root.
 * @param relativeDirectory - the file's directory, relative to the root, `.` for the root itself.
 * @param fileName - the instruction file's name.
 * @returns the scope key.
 */
function scopeKey(root: string, relativeDirectory: string, fileName: string): string {
  return `${root}\0${relativeDirectory}\0${fileName}`
}

/** A directory's location within its root, spelled `.` for the root itself. */
function relativeDirectoryOf(root: string, directory: string): string {
  const suffix = relative(root, directory)
  return suffix.length === 0 ? '.' : suffix
}

/**
 * The path one RAW tool call touched.
 *
 * `arguments` is the model-produced JSON string, so the path is only known after
 * parsing it; a call that names no `file_path`, or is not one of the tools whose
 * success makes a directory relevant, touched nothing this row cares about.
 * @param name - the tool name the model called.
 * @param argumentsJson - the tool call's raw arguments, exactly as produced.
 * @returns the trimmed absolute-or-relative path, or `undefined`.
 */
export function touchedPathOfToolCall(name: string, argumentsJson: string): string | undefined {
  if (FILE_TOUCH_TOOL_NAMES[name] !== true) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  if (!('file_path' in parsed)) return undefined
  const path = parsed.file_path
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The directory a touched path's instructions would live in.
 *
 * Tool arguments are the model's raw input, so a relative `file_path` is
 * resolved against the session cwd — the base the tool layer itself uses —
 * rather than against this process's cwd. Mac's `realpath` spelling is applied
 * here so the result compares against the canonical roots.
 * @param path - a touched path, absolute or relative to the session cwd.
 * @param session - the session the touch belongs to.
 * @returns the canonical parent directory, or `undefined` when it cannot be named.
 */
function parentDirectoryOf(path: string, session: Session): string | undefined {
  const cwd = session.header.cwd
  const absolute = isAbsolute(path) ? path : cwd === undefined ? undefined : resolve(cwd, path)
  if (absolute === undefined) return undefined
  try {
    return canonicalPath(dirname(absolute))
  } catch {
    return undefined
  }
}

/** Cap warnings are emitted once per process; the cap itself is not user-facing. */
let scopeCapWarned = false

/**
 * Compose the model-facing message body for one batch of changes.
 *
 * All three halves matter. A newly visible root — or a newly touched
 * subdirectory — needs its rules; a root that left needs an explicit
 * revocation; and a file that disappeared needs an explicit withdrawal, because
 * the instructions it contributed are still sitting in the conversation history
 * and would otherwise keep applying forever. Silence is not a retraction.
 * @param rendered - roots whose instruction text is new or changed.
 * @param revoked - canonical roots that left the workspace scope.
 * @param removed - instruction files that are no longer present.
 * @returns the message text, or `undefined` when there is nothing to say.
 */
export function composeInstructionMessage(
  rendered: readonly RenderedRoot[],
  revoked: readonly string[],
  removed: readonly RemovedScope[],
): string | undefined {
  if (rendered.length === 0 && revoked.length === 0 && removed.length === 0) return undefined
  const sections: string[] = [
    'Additional workspace root instructions. The directories below are additional roots of this '
    + "session's workspace; the instruction files found at their top level, and in the subdirectories "
    + 'this session has worked in, follow, and they apply to work in those directories exactly as this '
    + 'workspace\'s own instructions apply to the session root.',
  ]
  for (const entry of rendered) {
    sections.push(`Instructions for additional workspace root ${entry.root}:\n\n${entry.text}`)
  }
  for (const root of revoked) {
    sections.push(
      `The directory ${root} is no longer an additional root of this session's workspace. Any instructions `
      + 'previously supplied for it in this conversation no longer apply, and it is no longer writable here.',
    )
  }
  // Sorted, so the same world state always renders the same text.
  for (const scope of [...removed].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    sections.push(
      `The instruction file ${scope.path} is no longer present in the additional workspace root `
      + `${scope.root}, so the instructions it supplied earlier no longer apply.`,
    )
  }
  return sections.join('\n\n')
}

/** This row is gated on the compatibility contract like every other provider. */
export const inject = ['multiRootCompat', 'multiRootScope', 'sandboxPolicy']

/**
 * Mount the additional-root instruction provider.
 *
 * `fs` is a SOFT dependency, like the scope service's prompt contribution: a
 * composition with no filesystem seam (headless probes, bare test contexts)
 * contributes nothing instead of failing to load. The same is true of the
 * upstream instruction package, which is an optional peer.
 *
 * Touch recording is registered OUTSIDE the `fs` injection, so a composition
 * without a filesystem seam still learns which directories the session worked
 * in; delivery is what needs the seam.
 * @param ctx - the row's context.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) return

  const states = new WeakMap<object, SessionState>()
  const pendingCalls: PendingCalls = new Map()
  const stateOf = (session: object): SessionState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const created: SessionState = { scopes: new Map(), touched: new Set() }
    states.set(session, created)
    return created
  }

  // The session log is the only seam that carries tool activity without
  // depending on the tool layer's own package: `tool/call` records the raw
  // arguments, `tool/result` names the call it answers, and a pairing is a
  // directory the session has worked in.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      if (pendingCalls.size >= MAX_PENDING_CALLS) {
        const oldest = pendingCalls.keys().next()
        if (!oldest.done) pendingCalls.delete(oldest.value)
      }
      pendingCalls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
      return
    }
    if (event.type !== 'tool/result') return
    const callId = event.data.message.source.callId
    const call = pendingCalls.get(callId)
    pendingCalls.delete(callId)
    if (call === undefined) return
    // A failed call never makes a directory relevant: the file may not have
    // been reached at all.
    if (event.data.error !== undefined || event.data.message.content[0]?.isError === true) return
    const path = touchedPathOfToolCall(call.name, call.arguments)
    if (path === undefined) return
    const state = stateOf(session)
    if (state.touched.size >= MAX_TOUCHED_PATHS) return
    state.touched.add(path)
  })

  ctx.inject(['fs'], (scope: Context) => {
    scope.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      // A rejected step never delivers: the touch stays queued for the step that
      // actually enters.
      if (decision.kind !== 'enter') return decision
      const seeded = await pending(scope, states, agent, config, maxBytes, signal)
      if (seeded === undefined) return decision
      signal.throwIfAborted()
      // Splice in at the same place upstream's own instruction baseline goes:
      // right after the last message claimed from the inbox, so instruction
      // context stays adjacent instead of displacing the operator's prompt.
      const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
      return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, seeded) }
    })
  })
}

/**
 * Compute the message this step should carry, if any.
 *
 * Returns `undefined` — the steady state — whenever every delivered file is
 * still current, so a long session does not re-send the same text on every step.
 * @param ctx - the injected scope, which owns `fs` and the services.
 * @param states - per-session delivery state.
 * @param agent - the agent whose step this is.
 * @param config - the row's configuration.
 * @param maxBytes - the total budget for all additional roots.
 * @param signal - the turn's cancellation signal.
 * @returns the message to inject, or `undefined`.
 */
async function pending(
  ctx: Context,
  states: WeakMap<object, SessionState>,
  agent: Agent,
  config: Config,
  maxBytes: number,
  signal: AbortSignal,
): Promise<UserMessage | undefined> {
  const session = agent.session
  const state = states.get(session) ?? { scopes: new Map(), touched: new Set() }
  const scope = ctx.multiRootScope.resolve(ctx.sandboxPolicy.resolve({ session }))

  // A root the scope no longer grants — removed, missing, or redirected — must
  // be retracted. `sanitizeAdditionalRoots` already withheld the unusable ones,
  // so "absent from the scope" is the single condition to react to.
  const granted = new Set(scope.additionalRoots)
  const revoked = [...new Set([...state.scopes.values()].map(entry => entry.root))]
    .filter(root => !granted.has(root))

  const rendered: RenderedRoot[] = []
  const gone: GoneScope[] = []
  const updates: Array<{ readonly key: string; readonly scope: DeliveredScope }> = []

  if (scope.additionalRoots.length > 0) {
    const api = await instructionsApi()
    if (api !== undefined) {
      let remaining = maxBytes
      for (const root of scope.additionalRoots) {
        if (remaining <= 0) break
        signal.throwIfAborted()
        const plan = await planRoot(ctx, api, root, config, state, session, signal)
        gone.push(...plan.gone)
        if (plan.deliveries.length === 0) continue
        const { text } = api.render(plan.deliveries.map(entry => entry.file), { maxBytes: remaining })
        if (text === '') continue
        remaining -= Buffer.byteLength(text, 'utf8')
        rendered.push({ root, text })
        for (const entry of plan.deliveries) {
          updates.push({ key: entry.key, scope: { root, path: entry.file.absolutePath, digest: digestOf(entry.file.content) } })
        }
      }
      // A touch is consumed by exactly one evaluation: its directory is examined
      // on the step that follows the tool result, not on every later step.
      state.touched.clear()
    }
  }

  const text = composeInstructionMessage(rendered, revoked, gone.map(entry => entry.scope))
  if (text !== undefined) {
    // The message is built, so the bookkeeping it was built from is now the
    // recorded truth: withdrawals are forgotten and deliveries are remembered.
    for (const root of revoked) {
      for (const [key, entry] of state.scopes) if (entry.root === root) state.scopes.delete(key)
    }
    for (const entry of gone) state.scopes.delete(entry.key)
    for (const entry of updates) state.scopes.set(entry.key, entry.scope)
  }
  // Written back even when there is nothing to say, because the touches were
  // consumed either way.
  states.set(session, state)

  if (text === undefined) return undefined
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_SOURCE, form: 'instructions' },
  })
}

/** A delivered file that vanished from a directory this step examined. */
interface GoneScope {
  /** The scope key to forget. */
  readonly key: string
  /** The withdrawal to state in the message. */
  readonly scope: RemovedScope
}

/** One candidate file to deliver, with the scope key it will be remembered under. */
interface Delivery {
  /** The scope key of the file. */
  readonly key: string
  /** The loaded candidate. */
  readonly file: LoadedInstructionFile
}

/** The change one additional root needs this step. */
interface RootPlan {
  /** Candidates that are new, or whose content changed since delivery. */
  readonly deliveries: readonly Delivery[]
  /** Delivered files that are no longer present where they were delivered from. */
  readonly gone: readonly GoneScope[]
}

/** One examined directory, with the candidates its walk reported. */
interface DirectoryWalk {
  /** That directory's location within its root. */
  readonly relativeDirectory: string
  /** What the walk found. */
  readonly read: DirectoryRead
}

/**
 * Plan one additional root's delivery for this step.
 *
 * Which directories are worth walking is the whole design of phase 2, and the
 * set is exactly three things: the root itself (top-level files, as in phase 1,
 * so a change or a removal there is noticed every step), every directory a
 * nested file was already delivered from (so a change or a removal is noticed
 * without a new touch, like upstream's own reconcile), and the parent directory
 * of every path the session has touched since the last evaluation.
 * @param ctx - the row's context, for `fs` and the logger.
 * @param api - the adapted upstream instruction surface.
 * @param root - the canonical additional root.
 * @param config - the row's configuration.
 * @param state - the session's delivery state.
 * @param session - the session, for the cwd a relative touch resolves against.
 * @param signal - the turn's cancellation signal.
 * @returns the files to send and the deliveries to withdraw.
 */
async function planRoot(
  ctx: Context,
  api: InstructionsApi,
  root: string,
  config: Config,
  state: SessionState,
  session: Session,
  signal: AbortSignal,
): Promise<RootPlan> {
  const delivered = new Map<string, DeliveredScope>()
  for (const [key, entry] of state.scopes) if (entry.root === root) delivered.set(key, entry)

  const dirs = new Set<string>([root])
  for (const entry of delivered.values()) {
    const dir = dirname(entry.path)
    if (dir !== root) dirs.add(dir)
  }
  for (const touched of state.touched) {
    const dir = parentDirectoryOf(touched, session)
    if (dir !== undefined && isCanonicallyUnder(dir, root)) dirs.add(dir)
  }

  const walks: DirectoryWalk[] = []
  for (const dir of dirs) {
    signal.throwIfAborted()
    walks.push({
      relativeDirectory: relativeDirectoryOf(root, dir),
      read: await loadDirectory(ctx.fs, api, root, config, signal, dir),
    })
  }
  // Shallow first, so the model reads the broader rules before the narrower
  // ones; discovery order is preserved within one directory.
  walks.sort((left, right) => left.relativeDirectory.split(sep).length - right.relativeDirectory.split(sep).length
    || (left.relativeDirectory < right.relativeDirectory ? -1 : left.relativeDirectory > right.relativeDirectory ? 1 : 0))

  const deliveries: Delivery[] = []
  const gone: GoneScope[] = []
  for (const walk of walks) {
    // A walk that failed to probe says nothing about what is there, so it can
    // neither deliver nor withdraw.
    if (!walk.read.probed) continue
    // The PRE-FILTER candidates, so a file skipped for size or readability is
    // not mistaken for a deleted one.
    const present = new Set<string>()
    for (const candidate of walk.read.candidates) {
      if (relativeDirectoryOf(root, dirname(candidate.absolutePath)) !== walk.relativeDirectory) continue
      present.add(basename(candidate.absolutePath))
    }
    for (const file of walk.read.files) {
      if (relativeDirectoryOf(root, dirname(file.absolutePath)) !== walk.relativeDirectory) continue
      const key = scopeKey(root, walk.relativeDirectory, basename(file.absolutePath))
      const previous = delivered.get(key)
      if (previous !== undefined && previous.digest === digestOf(file.content)) continue
      if (previous === undefined && walk.relativeDirectory !== '.') {
        if (state.scopes.size >= MAX_DELIVERED_SCOPES) {
          if (!scopeCapWarned) {
            scopeCapWarned = true
            ctx.logger.warn('multi-root workspace: additional-root instruction scopes capped at %d', MAX_DELIVERED_SCOPES)
          }
          continue
        }
      }
      deliveries.push({ key, file })
    }
    for (const [key, entry] of delivered) {
      if (relativeDirectoryOf(root, dirname(entry.path)) !== walk.relativeDirectory) continue
      if (present.has(basename(entry.path))) continue
      gone.push({ key, scope: { root, path: entry.path } })
    }
  }
  return { deliveries, gone }
}

/** A directory's candidates, and whether the walk itself succeeded. */
interface DirectoryRead {
  /** The candidates the walk reported, before this row's own filters. */
  readonly candidates: readonly InstructionFile[]
  /** The candidates that passed canonical containment, the size cap, and the read. */
  readonly files: readonly LoadedInstructionFile[]
  /** Whether the walk itself succeeded; a failed walk judges nothing. */
  readonly probed: boolean
}

/**
 * Walk from `cwd` up to `root` and read the instruction candidates it reports.
 *
 * Two filters are applied to what the walk reports, and both are load-bearing:
 *
 * - **canonical containment** drops every candidate that is not inside the root
 *   itself, which is what excludes the user-global file and any ancestor's;
 * - **the source cap** skips a file too large to be instructions, using `stat`
 *   so an oversized file is never read at all.
 *
 * The pre-filter candidates are returned alongside the loaded ones: they are how
 * a caller tells "this file is gone" from "this file could not be read".
 *
 * `displayPath` is rewritten to the absolute path on purpose: discovery
 * displays candidates relative to `projectRoot`, so every root's file would
 * otherwise render as the same ambiguous `AGENTS.md`, and the absolute spelling
 * is also the one the model must use in a tool call against a directory outside
 * the session root.
 * @param fs - the filesystem provider to read through.
 * @param api - the adapted upstream instruction surface.
 * @param root - the canonical additional root the walk stops at.
 * @param config - the row's configuration.
 * @param signal - the turn's cancellation signal.
 * @param cwd - the directory the walk starts from; always inside `root`.
 * @returns the directory read.
 */
async function loadDirectory(
  fs: FileSystem,
  api: InstructionsApi,
  root: string,
  config: Config,
  signal: AbortSignal,
  cwd: string,
): Promise<DirectoryRead> {
  const maxSourceBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  let candidates: readonly InstructionFile[]
  try {
    candidates = await api.discover({
      cwd,
      projectRoot: root,
      signal,
      // Omitted rather than passed as undefined, so upstream applies its own
      // candidate defaults (`AGENTS.md`, `CLAUDE.md`, the `.local` overlays).
      ...(config.instructionFileCandidates === undefined ? {} : { instructionFileCandidates: config.instructionFileCandidates }),
      ...(config.localInstructionFileCandidates === undefined ? {} : { localInstructionFileCandidates: config.localInstructionFileCandidates }),
    })
  } catch {
    // Discovery probes a directory that may have vanished between the scope
    // resolution and this read. A directory that cannot be discovered
    // contributes nothing; it is not a reason to fail the model's step.
    return { candidates: [], files: [], probed: false }
  }

  const files: LoadedInstructionFile[] = []
  for (const candidate of candidates) {
    if (!isCanonicallyUnder(canonicalPath(candidate.absolutePath), root)) continue
    try {
      const target = await fs.resolve(candidate.absolutePath)
      const info = await fs.stat(target, signal)
      if (info === undefined || info.type !== 'file') continue
      if (info.size !== undefined && info.size > maxSourceBytes) continue
      files.push({ ...candidate, displayPath: candidate.absolutePath, content: await fs.readText(target, signal) })
    } catch {
      continue
    }
  }
  return { candidates, files, probed: true }
}
