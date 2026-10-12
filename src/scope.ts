/**
 * The multi-root workspace scope: the plugin's single home for the question
 * "which directories belong to this workspace".
 *
 * The primary root is never stored here — it is the session's immutable cwd as
 * resolved by the upstream `ctx.sandboxPolicy` service. This service owns the
 * additional roots, the canonical key that indexes them, and the one model-facing
 * statement of that topology, so every enforcing provider (fs fence,
 * kernel-sandbox dialects) and the prompt snapshot all resolve the same scope.
 *
 * The root table is still filled by the registry's own API (tests and smoke
 * scripts today; plugin storage in M3). Keeping the empty case on the same code
 * path as the populated one is deliberate — the pass-through safety net must
 * exercise the real provider wiring, not a stub that later gets replaced.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/scope
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { statSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { RootAccess } from './roots.ts'
import { aroundTool } from './compat/tool-context.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootScope: MultiRootScopeService
  }
}

/** One configured additional root, as the registry persists it. */
export interface AdditionalWorkspaceRoot {
  /** Stable registry identity (opaque; M3 brands it). */
  id: string
  /** Canonical absolute directory, as spelled in the registration. */
  path: string
  /**
   * The canonical directory this registration was granted for (the `realpath`
   * captured when the operator registered it). The root is granted only while
   * `canonicalPath(path)` still equals this value: re-resolving a path is NOT
   * re-authorizing it, because whoever can replace the directory (or a symlink
   * in its chain) could otherwise move the grant to a directory no operator
   * ever registered.
   */
  recordedPath: string
  /**
   * The write authority the registration carries (B9 three-state).
   * `read-only` roots remain workspace members — instructions, LSP,
   * workspace-file routing, and reads all still see them — but they are never
   * part of `writableRoots` and never reach a write grant, under ANY mode.
   * `inherit` follows the session mode; fixed `read-write` stays writable even
   * under a read-only session.
   */
  access: RootAccess
  /** Optional display alias. */
  alias?: string
}

/** One granted workspace member, with the authority fact the enforcement reads. */
export interface ScopeRoot {
  /** Canonical absolute directory. */
  readonly path: string
  /** The write authority the registration carries. */
  readonly access: RootAccess
  /** Optional display alias. */
  readonly alias?: string
  /** Stable registry identity. */
  readonly id: string
}

/**
 * The resolved scope of one confined call. `primaryRoot` equals the policy's
 * workspace root; `additionalRoots` are canonical, deduplicated, never equal
 * to the primary root.
 */
export interface FilesystemScope {
  /** The session's workspace root (`session.header.cwd`, canonical). */
  primaryRoot: string
  /** Every granted member — ANY access level — canonical, in registry order. */
  additionalRoots: readonly string[]
  /** The granted members with their access, in registry order. */
  roots: readonly ScopeRoot[]
  /**
   * The members a write may reach under THIS call — the effective access
   * (registration policy × session mode) narrowed by the tool cap.
   */
  writableRoots: readonly string[]
  /**
   * The members THIS call must not write — `additionalRoots` minus
   * `writableRoots`. It is the deny set enforcement reads: explicit
   * `read-only` roots under `danger-full-access` (and wherever another grant,
   * such as the platform temp area, would otherwise cover the same path), and
   * every member when the call is tool-capped. Read access is unaffected —
   * these are all still workspace members.
   */
  deniedRoots: readonly string[]
}

/**
 * Canonicalize and sanitize one root list against a primary root: drop the
 * primary itself, duplicates, missing/non-directory paths, and any root whose
 * current resolution no longer matches the directory it was registered for;
 * preserve registry order.
 *
 * The last rule is the security-relevant one. `canonicalPath` is `realpath`, so
 * a registered directory that has since been replaced by a symlink resolves to
 * a different directory — granting that would hand out a directory nobody
 * registered, on nothing more than a local replace. A registration whose
 * resolution moved is therefore withheld here (the registry reports it as
 * `redirected`), and it comes back only when the path resolves to the recorded
 * directory again.
 *
 * @param primaryRoot - the canonical primary root to exclude.
 * @param roots - candidate roots, in registry order.
 * @returns the sanitized additional roots.
 */
export function sanitizeAdditionalRoots(
  primaryRoot: string,
  roots: readonly AdditionalWorkspaceRoot[],
): string[] {
  return sanitizeMembers(primaryRoot, roots).map(root => root.path)
}

/** The member-level form of {@link sanitizeAdditionalRoots}: same rules, with access kept. */
function sanitizeMembers(
  primaryRoot: string,
  roots: readonly AdditionalWorkspaceRoot[],
): ScopeRoot[] {
  const seen = new Set<string>([primaryRoot])
  const result: ScopeRoot[] = []
  for (const root of roots) {
    const recorded = root.recordedPath
    if (typeof recorded !== 'string' || recorded === '') continue
    const canonical = canonicalPath(root.path)
    if (canonical !== recorded) continue
    try {
      if (!statSync(canonical).isDirectory()) continue
    } catch {
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    result.push({
      path: canonical,
      access: root.access,
      id: root.id,
      ...(root.alias === undefined ? {} : { alias: root.alias }),
    })
  }
  return result
}

/**
 * The name of the runtime-context contribution that tells the model which extra
 * roots belong to this session's workspace.
 */
export const MULTI_ROOT_CONTEXT_NAME = 'multi-root:scope'

/**
 * The B9 effective-access rule (ADR-0017's nine-cell matrix): whether a root
 * with this registration policy is writable under this session mode.
 * `read-write` is writable everywhere; `inherit` follows the mode;
 * `read-only` never is.
 */
function effectivelyWritable(mode: SandboxMode, access: RootAccess): boolean {
  if (access === 'read-write') return true
  if (access === 'read-only') return false
  return mode !== 'read-only'
}

/**
 * Render the workspace topology the model is told about. Pure: the text
 * depends only on its inputs, so two consecutive assemblies of the same
 * session state produce the same contribution byte for byte. Only granted
 * members are ever listed — withheld, missing, or invalid roots never reach
 * `roots` in the first place — and no host internals (ids, SIDs, store or
 * lease paths) are ever named.
 * @param options.platform - the host platform (`process.platform` of the contribution).
 * @param options.mode - the session's sandbox mode.
 * @param options.primaryRoot - the canonical session workspace root.
 * @param options.roots - the granted additional members, in registry order.
 * @param options.cappedTools - sorted tool names that can never write an additional root.
 * @param options.toolAccessInvalid - invalid host config caps every additional-root write.
 * @returns the stable topology text; empty when there are no additional roots.
 */
export function renderWorkspaceRootsContext(options: {
  readonly platform: string
  readonly mode: SandboxMode
  readonly primaryRoot: string
  readonly roots: readonly ScopeRoot[]
  readonly cappedTools: readonly string[]
  readonly toolAccessInvalid?: boolean
}): string {
  const { platform, mode, primaryRoot, roots, cappedTools } = options
  if (roots.length === 0) return ''
  const members = JSON.stringify(roots.map(root => root.path))
  const readOnly = roots.filter(root => root.access === 'read-only').map(root => root.path)
  if (mode === 'read-only') {
    // Fixed read-write roots keep their grant even in a read-only session.
    const writable = options.toolAccessInvalid ? [] : roots.filter(root => root.access === 'read-write').map(root => root.path)
    if (writable.length === 0) {
      return `Current DSH workspace roots: ${members} are additional roots of this session's workspace and are readable; `
        + 'nothing is writable in read-only mode.'
    }
    const readable = roots.filter(root => root.access !== 'read-write').map(root => root.path)
    let text = `Current DSH workspace roots: ${JSON.stringify(writable)} are additional roots that stay writable even in read-only mode`
    if (readable.length > 0) text += `, and ${JSON.stringify(readable)} are readable additional roots`
    return text + ' of this session\'s workspace; everything else is read-only.'
  }
  if (mode === 'danger-full-access') {
    // The refused set mirrors the scope's deny set: explicit read-only roots
    // always, and every member when the call is tool-capped.
    const refused = options.toolAccessInvalid ? roots.map(root => root.path) : readOnly
    return `Current DSH workspace roots: ${members} are additional roots of this session's workspace; `
      + 'danger-full-access mode has no sandbox isolation'
      + (refused.length > 0
        ? `, except writes under the additional roots ${JSON.stringify(refused)} are still refused${options.toolAccessInvalid === true ? ' because toolAccess is invalid' : ''}.`
        : '.')
  }
  const writable = options.toolAccessInvalid ? [] : roots.filter(root => root.access !== 'read-only').map(root => root.path)
  const groups: string[] = []
  if (options.toolAccessInvalid) groups.push(`${members} are readable additional roots (all additional-root writes are refused because toolAccess is invalid)`)
  if (writable.length > 0) groups.push(`${JSON.stringify(writable)} are writable additional roots`)
  if (!options.toolAccessInvalid && readOnly.length > 0) groups.push(`${JSON.stringify(readOnly)} are read-only additional roots (writes are refused)`)
  let text = `Current DSH workspace roots: ${groups.join(' and ')} of this session's workspace. `
    + `The session origin remains the primary root (${JSON.stringify(primaryRoot)}); `
    + 'changing the working directory does not change these grants. '
    + 'Grant changes apply to later operations and newly started processes, not to processes already running.'
  if (platform === 'win32' && !options.toolAccessInvalid) {
    text += ' Writable additional roots are enforced for shell processes by the upstream Windows ACL '
      + 'restricted-token sandbox, whose enforcement is reported as partial; reads are not confined by it.'
  }
  if (cappedTools.length > 0) {
    text += ` The tools ${JSON.stringify(cappedTools)} cannot write additional roots even where they are writable.`
  }
  return text
}

/**
 * Plugin configuration for the `multi-root-scope` row.
 */
export interface Config {
  /**
   * Per-tool write caps: a listed tool may never write ANY additional root
   * (the primary root and upstream behaviour are unchanged). `read-only` is
   * the only legal value — a cap restricts, it can never widen past the
   * root's own access.
   */
  readonly toolAccess?: Record<string, 'read-only'>
}

/** The tool-dispatch cap carried across async boundaries by the waterfall. */
const toolCapStore = new AsyncLocalStorage<{ readonly capped: boolean }>()

/**
 * The `ctx.multiRootScope` service. Providers ask it — never the filesystem —
 * what the current scope is, which is what keeps the fs fence and every kernel
 * dialect on one permission world (requirement §13).
 */
export class MultiRootScopeService extends Service {
  /** Additional roots keyed by canonical primary root; empty until roots are registered. */
  private readonly rootsByPrimary = new Map<string, readonly AdditionalWorkspaceRoot[]>()
  private readonly listeners = new Set<() => void>()
  /** Validated `toolAccess` row config; empty when no tool is capped. */
  private readonly caps: Record<string, 'read-only'>
  /** A malformed `toolAccess` refuses every additional-root write (fail closed). */
  private readonly capsInvalid: boolean

  /** Observe registry publications; consumers still resolve authority from scopeOf(). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The sorted names of the tools `toolAccess` caps — read-only for the
   * prompt contribution. An invalid config is not enumerated (it caps every
   * call but is not a listable tool set).
   */
  toolCaps(): readonly string[] {
    return Object.keys(this.caps).sort()
  }

  /** Whether malformed toolAccess caps every call, including unknown tools. */
  get toolAccessInvalid(): boolean {
    return this.capsInvalid
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'multiRootScope')

    const toolAccess = config.toolAccess
    if (toolAccess === undefined) {
      this.caps = {}
      this.capsInvalid = false
    } else if (typeof toolAccess !== 'object' || toolAccess === null || Array.isArray(toolAccess)
      || Object.values(toolAccess).some(value => value !== 'read-only')) {
      // Fail closed and loud: a row that cannot be parsed must never grant on
      // a guess, so every additional-root write is refused for the session.
      this.caps = {}
      this.capsInvalid = true
      ctx.logger.error(
        'multi-root-workspace: invalid toolAccess config '
        + `(expected an object mapping tool names to "read-only", got ${JSON.stringify(toolAccess)}); `
        + 'no additional root is writable',
      )
    } else {
      this.caps = { ...toolAccess }
      this.capsInvalid = false
    }

    // The cap rides the tool dispatch across every await: a capped tool stays
    // capped inside nested calls, and an uncapped outer call is narrowed by a
    // capped inner dispatch (nesting only ever narrows). The tool name is read
    // once at entry — never from model-supplied arguments.
    aroundTool(ctx, (exec, next) => {
      const parent = toolCapStore.getStore()
      return toolCapStore.run({ capped: parent?.capped === true || this.caps[exec.name] === 'read-only' }, next)
    })

    // The prompt contribution is a SOFT dependency: a composition without a
    // system-prompt seam (bare test contexts, headless probes) simply never
    // contributes topology instead of failing to load. The callback's own scoped
    // context is the one that may read the injected services — the service's own
    // ctx has no inject map for them.
    ctx.inject(['systemPrompt', 'sandboxPolicy'], (scope: Context) => {
      scope.systemPrompt.context({
        name: MULTI_ROOT_CONTEXT_NAME,
        // Immediately after the sandbox policy sentence this topology extends.
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
        text: (assembly) => {
          const session = assembly.agent?.session
          if (session === undefined) return ''
          const policy = scope.sandboxPolicy.resolve({ session })
          const resolved = this.resolve(policy)
          if (resolved.roots.length === 0) return ''
          // The session view lists root access, never the tool-ambient cap:
          // the text describes the workspace, not one call's permissions.
          return renderWorkspaceRootsContext({
            platform: process.platform,
            mode: policy.mode,
            primaryRoot: resolved.primaryRoot,
            roots: resolved.roots,
            cappedTools: this.toolCaps(),
            toolAccessInvalid: this.toolAccessInvalid,
          })
        },
      })
    })
  }

  /**
   * Resolve the scope of one confined call.
   * @param policy - the upstream policy whose workspace root is the primary root.
   * @returns the canonical scope; `additionalRoots` is empty when none are registered.
   */
  resolve(policy: SandboxExecutionPolicy): FilesystemScope {
    const primaryRoot = canonicalPath(policy.workspaceRoot)
    const roots = this.membersOf(primaryRoot)
    const writable = this.capped()
      ? []
      : roots.filter(root => effectivelyWritable(policy.mode, root.access)).map(root => root.path)
    const writableSet = new Set(writable)
    return {
      primaryRoot,
      additionalRoots: roots.map(root => root.path),
      roots,
      writableRoots: writable,
      deniedRoots: roots.filter(root => !writableSet.has(root.path)).map(root => root.path),
    }
  }

  /**
   * Whether THIS call's additional-root writes are capped. Inside a tool
   * dispatch the AsyncLocalStorage store answers; outside any dispatch (user
   * PTY, panel, an unknown async boundary) the answer is fail-closed: capped
   * whenever `toolAccess` names any tool, because an operation whose tool
   * identity is unknown gets the most restrictive configured cap. Membership
   * is never affected — only writability.
   */
  private capped(): boolean {
    if (this.capsInvalid) return true
    const store = toolCapStore.getStore()
    if (store !== undefined) return store.capped
    return Object.keys(this.caps).length > 0
  }

  /**
   * The additional roots registered for one canonical primary root — every
   * granted member, ANY access level (a read-only root is still a member of
   * the workspace for instructions, LSP, routing, and reads).
   * @param primaryRoot - canonical primary root (or any spelling thereof).
   * @returns the canonical additional roots; empty when none are registered.
   */
  scopeOf(primaryRoot: string): readonly string[] {
    return this.membersOf(primaryRoot).map(root => root.path)
  }

  /**
   * The additional roots a WRITE may reach for one primary root under
   * `workspace-write` — the members whose effective access is writable there
   * (`inherit` and fixed `read-write`). Tool caps are per-call and do not
   * apply to this diagnostic projection.
   * @param primaryRoot - canonical primary root (or any spelling thereof).
   * @returns the canonical writable roots; empty when none qualify.
   */
  writableOf(primaryRoot: string): readonly string[] {
    return this.membersOf(primaryRoot).filter(root => root.access !== 'read-only').map(root => root.path)
  }

  /**
   * Whether ANY registered primary currently publishes an explicit `read-only`
   * member. The PTY seam resolves its caller through an environment marker;
   * when that lookup fails this flag is the difference between pass-through
   * (nothing to deny anywhere on the store) and fail closed.
   * @returns whether at least one primary holds a restricted root.
   */
  hasActiveDenyRoots(): boolean {
    for (const members of this.rootsByPrimary.values()) {
      if (members.some(root => root.access === 'read-only')) return true
    }
    return false
  }

  /** The sanitized members of one primary root, in registry order. */
  private membersOf(primaryRoot: string): readonly ScopeRoot[] {
    const key = canonicalPath(primaryRoot)
    const registered = this.rootsByPrimary.get(key)
    if (registered === undefined) return []
    return sanitizeMembers(key, registered)
  }

  /**
   * Replace the roots registered for one primary root.
   *
   * M1 uses this from tests and smoke scripts only; M3 feeds it from plugin
   * storage. It is a plain setter so the transition swaps the data source
   * without touching any provider.
   * @param primaryRoot - canonical primary root to register roots under.
   * @param roots - the additional roots, in display order.
   */
  setAdditionalRoots(primaryRoot: string, roots: readonly AdditionalWorkspaceRoot[]): void {
    const key = canonicalPath(primaryRoot)
    if (roots.length === 0) {
      this.rootsByPrimary.delete(key)
    } else {
      this.rootsByPrimary.set(key, [...roots])
    }
    for (const listener of this.listeners) listener()
  }
}

export default MultiRootScopeService
