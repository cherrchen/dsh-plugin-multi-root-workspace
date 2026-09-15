/**
 * `multi-root-instructions`: the additional roots' own instruction files, made
 * visible to the model.
 *
 * Upstream `agent-instructions` discovers instruction files by walking UP from
 * the session cwd (plus the one user-global file). In a multi-root workspace
 * that walk never reaches an additional root, so `repo-b/AGENTS.md` is
 * invisible to a model that is nevertheless allowed to write `repo-b`. This row
 * closes exactly that gap, and nothing else: the primary root's chain and the
 * user-global file stay upstream's business.
 *
 * Three deliberate choices:
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
 * 3. **Discovery is pinned to the root itself.** `cwd` and `projectRoot` are
 *    both the additional root, and every candidate is then required to be
 *    canonically INSIDE that root. That is what keeps `$DSH_HOME/AGENTS.md`,
 *    the primary root's `AGENTS.md`, and any ancestor's file from being
 *    injected a second time by this plugin.
 *
 * The byte budget is shared: `maxBytes` bounds the WHOLE additional-root
 * snapshot, not each root, because ten roots must not quietly cost ten budgets
 * of context. Roots consume it in scope order.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/instructions
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './compat.ts'
import { instructionsApi } from './compat/agent-instructions.ts'
import type { InstructionFile, LoadedInstructionFile } from './compat/agent-instructions.ts'
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

/** What the model was last told about one additional root. */
interface RootInstructionState {
  /** Digest of the delivered text, so unchanged instructions are not re-sent. */
  readonly digest: string
}

/** One session's per-root delivery state, keyed by canonical root. */
type SessionState = Map<string, RootInstructionState>

/** One root's freshly rendered instruction text. */
export interface RenderedRoot {
  /** The canonical additional root. */
  readonly root: string
  /** The rendered instruction text. */
  readonly text: string
  /** Digest of {@link RenderedRoot.text}. */
  readonly digest: string
}

/** Digest one rendered text. Content-addressed, so identical text never re-sends. */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Compose the model-facing message body for one batch of changes.
 *
 * Both halves matter. A newly visible root needs its rules; a root that left
 * needs an explicit revocation, because the instructions it contributed are
 * still sitting in the conversation history and would otherwise keep applying
 * forever. Silence is not a retraction.
 * @param rendered - roots whose instruction text is new or changed.
 * @param revoked - canonical roots that left the workspace scope.
 * @returns the message text, or `undefined` when there is nothing to say.
 */
export function composeInstructionMessage(
  rendered: readonly RenderedRoot[],
  revoked: readonly string[],
): string | undefined {
  if (rendered.length === 0 && revoked.length === 0) return undefined
  const sections: string[] = [
    'Additional workspace root instructions. The directories below are additional roots of this '
    + "session's workspace; the instruction files found at their top level follow, and they apply to work "
    + 'in those directories exactly as this workspace\'s own instructions apply to the session root.',
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
 * @param ctx - the row's context.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) return

  const states = new WeakMap<object, SessionState>()

  ctx.inject(['fs'], (scope: Context) => {
    scope.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
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
 * Returns `undefined` — the steady state — whenever every root's instructions
 * are already in the conversation unchanged, so a long session does not re-send
 * the same text on every step.
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
  const state = states.get(session) ?? new Map<string, RootInstructionState>()
  const scope = ctx.multiRootScope.resolve(ctx.sandboxPolicy.resolve({ session }))

  // A root the scope no longer grants — removed, missing, or redirected — must
  // be retracted. `sanitizeAdditionalRoots` already withheld the unusable ones,
  // so "absent from the scope" is the single condition to react to.
  const granted = new Set(scope.additionalRoots)
  const revoked = [...state.keys()].filter(root => !granted.has(root))

  const rendered: RenderedRoot[] = []
  if (scope.additionalRoots.length > 0) {
    const api = await instructionsApi()
    if (api !== undefined) {
      let remaining = maxBytes
      for (const root of scope.additionalRoots) {
        if (remaining <= 0) break
        signal.throwIfAborted()
        const files = await load(ctx.fs, api, root, config, signal)
        if (files.length === 0) continue
        const { text } = api.render(files, { maxBytes: remaining })
        if (text === '') continue
        remaining -= Buffer.byteLength(text, 'utf8')
        const digest = digestOf(text)
        if (state.get(root)?.digest === digest) continue
        rendered.push({ root, text, digest })
      }
    }
  }

  const text = composeInstructionMessage(rendered, revoked)
  if (text === undefined) return undefined

  for (const root of revoked) state.delete(root)
  for (const entry of rendered) state.set(entry.root, { digest: entry.digest })
  states.set(session, state)

  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_SOURCE, form: 'instructions' },
  })
}

/**
 * Discover and read one additional root's top-level instruction files.
 *
 * Two filters are applied, and both are load-bearing:
 *
 * - **canonical containment** drops every candidate that is not inside the root
 *   itself, which is what excludes the user-global file and any ancestor's;
 * - **the source cap** skips a file too large to be instructions, using `stat`
 *   so an oversized file is never read at all.
 *
 * `displayPath` is rewritten to the absolute path on purpose: discovery
 * displays candidates relative to `projectRoot`, so every root's file would
 * otherwise render as the same ambiguous `AGENTS.md`, and the absolute spelling
 * is also the one the model must use in a tool call against a directory outside
 * the session root.
 * @param fs - the filesystem provider to read through.
 * @param api - the adapted upstream instruction surface.
 * @param root - the canonical additional root.
 * @param config - the row's configuration.
 * @param signal - the turn's cancellation signal.
 * @returns the loaded files, in discovery order.
 */
async function load(
  fs: FileSystem,
  api: NonNullable<Awaited<ReturnType<typeof instructionsApi>>>,
  root: string,
  config: Config,
  signal: AbortSignal,
): Promise<LoadedInstructionFile[]> {
  const maxSourceBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  let candidates: readonly InstructionFile[]
  try {
    candidates = await api.discover({
      cwd: root,
      projectRoot: root,
      signal,
      // Omitted rather than passed as undefined, so upstream applies its own
      // candidate defaults (`AGENTS.md`, `CLAUDE.md`, the `.local` overlays).
      ...(config.instructionFileCandidates === undefined ? {} : { instructionFileCandidates: config.instructionFileCandidates }),
      ...(config.localInstructionFileCandidates === undefined ? {} : { localInstructionFileCandidates: config.localInstructionFileCandidates }),
    })
  } catch {
    // Discovery probes a directory that may have vanished between the scope
    // resolution and this read. A root that cannot be discovered contributes
    // nothing; it is not a reason to fail the model's step.
    return []
  }

  const loaded: LoadedInstructionFile[] = []
  for (const candidate of candidates) {
    if (!isCanonicallyUnder(canonicalPath(candidate.absolutePath), root)) continue
    try {
      const target = await fs.resolve(candidate.absolutePath)
      const info = await fs.stat(target, signal)
      if (info === undefined || info.type !== 'file') continue
      if (info.size !== undefined && info.size > maxSourceBytes) continue
      loaded.push({ ...candidate, displayPath: candidate.absolutePath, content: await fs.readText(target, signal) })
    } catch {
      continue
    }
  }
  return loaded
}
