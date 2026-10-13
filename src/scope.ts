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
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { RootAccess } from './roots.ts'
import { aroundTool } from './compat/tool-context.ts'
import { effectiveRootAccess } from './contract.ts'

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
  /** Registry withheld the positive grant; retain its recorded deny boundary. */
  withheld?: boolean
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
   * Registered boundaries THIS call must not write, including missing and
   * redirected registrations. Negative restrictions never create a grant.
   * It is the deny set enforcement reads: explicit
   * `read-only` roots under `danger-full-access` (and wherever another grant,
   * such as the platform temp area, would otherwise cover the same path), and
   * every member when the call is tool-capped. Read access is unaffected —
   * these are all still workspace members.
   */
  deniedRoots: readonly string[]
  /**
   * Whether this process holds the registry authority for the store. While it
   * is `unavailable` — contended, storage-failed, config-invalid, or torn
   * down — the empty root table is NOT evidence that nothing is restricted:
   * the registrations this process cannot see may carry explicit `read-only`
   * boundaries, so `danger-full-access` enforcement degrades to upstream
   * `workspace-write` semantics instead of trusting the empty deny set.
   * A composition with no registry at all never reports `unavailable` — it can
   * never have registered roots.
   */
  authority: 'available' | 'unavailable'
  /**
   * The canonical DSH home directory, present exactly when this scope appended
   * it to `deniedRoots` — i.e. under `danger-full-access` while restrictions
   * apply (a non-empty deny set or an unavailable authority). `$DSH_HOME`
   * holds the store, the lease, the profiles and the user's own config: an
   * ambient Full-access process must not edit them, so once the workspace
   * carries ANY deny boundary the home joins it. Zero additional roots with a
   * healthy authority never set this — the empty scope stays upstream-exact.
   * Never set under `workspace-write` or `read-only`: those modes already
   * confine writes by containment, so denying home adds nothing but the cost
   * of a stale `FsTarget` re-resolution on every write.
   */
  protectedHome?: string
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
    if (root.withheld) continue
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
 * The deterministic sentence the model hears while the registry authority is
 * unavailable under `danger-full-access` — the mode's enforcement is then the
 * upstream `workspace-write` one, which the prompt must not leave implicit.
 */
export const REGISTRY_UNAVAILABLE_NOTE = 'The DSH multi-root registry is not available in this process, '
  + 'so danger-full-access is temporarily enforced as workspace-write: writes are limited to the primary root '
  + 'and the platform temp area.'

/**
 * The B9 effective-access rule (ADR-0017's nine-cell matrix): whether a root
 * with this registration policy is writable under this session mode.
 * `read-write` is writable everywhere; `inherit` follows the mode;
 * `read-only` never is.
 */
function effectivelyWritable(mode: SandboxMode, access: RootAccess): boolean {
  return effectiveRootAccess(access, mode) !== 'read-only'
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
 * @param options.authority - the registry-authority fact; `unavailable` under
 *   `danger-full-access` downgrades enforcement to `workspace-write`, which the
 *   model must hear even when there is no topology to describe.
 * @param options.protectedHome - the canonical DSH home when the scope appended
 *   it to the deny set (`danger-full-access` with restrictions); stated by path
 *   so the model can place the refusal.
 * @returns the stable topology text; empty when there are no additional roots
 *   and no downgrade to report.
 */
export function renderWorkspaceRootsContext(options: {
  readonly platform: string
  readonly mode: SandboxMode
  readonly primaryRoot: string
  readonly roots: readonly ScopeRoot[]
  readonly cappedTools: readonly string[]
  readonly toolAccessInvalid?: boolean
  readonly authority?: 'available' | 'unavailable'
  readonly protectedHome?: string
}): string {
  const { platform, mode, primaryRoot, roots, cappedTools } = options
  const authorityNote = options.authority === 'unavailable' && mode === 'danger-full-access'
    ? REGISTRY_UNAVAILABLE_NOTE
    : ''
  const homeNote = options.protectedHome !== undefined && mode === 'danger-full-access'
    ? `Writes under the DSH home directory at ${JSON.stringify(options.protectedHome)} are refused.`
    : ''
  // The leading notes (downgrade, protected home) precede the topology text;
  // they are also the whole contribution when there are no roots to describe.
  const lead = [authorityNote, homeNote].filter(note => note !== '').join(' ')
  if (roots.length === 0) return lead
  const prefix = lead === '' ? '' : `${lead} `
  const members = JSON.stringify(roots.map(root => root.path))
  const readOnly = roots.filter(root => root.access === 'read-only').map(root => root.path)
  const capNote = cappedTools.length === 0 ? ''
    : ` The tools ${JSON.stringify(cappedTools)} cannot write additional roots even where they are writable.`
  if (mode === 'read-only') {
    // Fixed read-write roots keep their grant even in a read-only session.
    const writable = options.toolAccessInvalid ? [] : roots.filter(root => root.access === 'read-write').map(root => root.path)
    if (writable.length === 0) {
      return prefix + `Current DSH workspace roots: ${members} are additional roots of this session's workspace and are readable; `
        + 'nothing is writable in read-only mode.' + capNote
    }
    const readable = roots.filter(root => root.access !== 'read-write').map(root => root.path)
    let text = `Current DSH workspace roots: ${JSON.stringify(writable)} are additional roots that stay writable even in read-only mode`
    if (readable.length > 0) text += `, and ${JSON.stringify(readable)} are readable additional roots`
    return prefix + text + ' of this session\'s workspace; everything else is read-only.' + capNote
  }
  if (mode === 'danger-full-access') {
    // The refused set mirrors the scope's deny set: explicit read-only roots
    // always, and every member when the call is tool-capped.
    const refused = options.toolAccessInvalid ? roots.map(root => root.path) : readOnly
    return prefix + `Current DSH workspace roots: ${members} are additional roots of this session's workspace; `
      + 'danger-full-access mode has no sandbox isolation'
      + (refused.length > 0
        ? `, except writes under the additional roots ${JSON.stringify(refused)} are still refused${options.toolAccessInvalid === true ? ' because toolAccess is invalid' : ''}.`
        : '.') + capNote
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
  return prefix + text + capNote
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
  /**
   * The resolved DSH home directory (`$DSH_HOME` / `~/.dsh`), which the patch
   * row fills from `dshHomePath()`. Under `danger-full-access` it joins the
   * deny set exactly while restrictions apply — a non-empty derived deny set
   * or an unavailable registry authority — so an ambient agent process cannot
   * overwrite the store, the lease file, profiles, or the user's own config.
   * Absent or invalid (non-string, empty, relative) means the boundary simply
   * does not exist: bare test compositions carry no home.
   */
  readonly dshHome?: string
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
  /**
   * The registry-authority fact the registry row publishes. Defaults to
   * `available`: a composition without a registry row can never have
   * registered roots, so nothing is unknown there. The registry sets it false
   * the moment it cannot prove the store is its own — before the lease is
   * acquired, while contended or storage-failed, and at teardown — and true
   * only after the accepted records have been published.
   */
  private registryAuthority: 'available' | 'unavailable' = 'available'
  /** Validated `toolAccess` row config; empty when no tool is capped. */
  private readonly caps: Record<string, 'read-only'>
  /** A malformed `toolAccess` refuses every additional-root write (fail closed). */
  private readonly capsInvalid: boolean
  /**
   * The configured DSH home boundary; `undefined` when the row carries no
   * `dshHome` (bare test compositions) or one that is not an absolute string —
   * an invalid value is logged at construction and ignored rather than
   * treated as evidence.
   */
  private readonly dshHome: string | undefined

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

    const dshHome = config.dshHome
    if (dshHome !== undefined && (typeof dshHome !== 'string' || dshHome.trim() === '' || !isAbsolute(dshHome))) {
      ctx.logger.error(
        'multi-root-workspace: invalid dshHome config '
        + `(expected an absolute path, got ${JSON.stringify(dshHome)}); the DSH-home deny boundary is disabled`,
      )
    } else {
      this.dshHome = dshHome
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
          // Zero roots normally contributes nothing — except while the
          // registry authority is unavailable (Full-access is enforced as
          // workspace-write and the model must hear that downgrade), or the
          // scope appended the DSH-home boundary (withheld roots can deny
          // without granting membership).
          if (resolved.roots.length === 0 && resolved.authority !== 'unavailable'
            && resolved.protectedHome === undefined) return ''
          // The session view lists root access, never the tool-ambient cap:
          // the text describes the workspace, not one call's permissions.
          return renderWorkspaceRootsContext({
            platform: process.platform,
            mode: policy.mode,
            primaryRoot: resolved.primaryRoot,
            roots: resolved.roots,
            cappedTools: this.toolCaps(),
            toolAccessInvalid: this.toolAccessInvalid,
            authority: resolved.authority,
            ...(resolved.protectedHome === undefined ? {} : { protectedHome: resolved.protectedHome }),
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
    const capped = this.capped()
    const writable = capped
      ? []
      : roots.filter(root => effectivelyWritable(policy.mode, root.access)).map(root => root.path)
    const registered = this.rootsByPrimary.get(primaryRoot) ?? []
    // Use the recorded spelling, never re-resolve it into a replacement grant.
    // A disappeared directory must not become writable merely because it left
    // membership; explicit removal is what withdraws the negative boundary.
    const denied = registered.filter(root => typeof root.recordedPath === 'string'
      && root.recordedPath !== '' && root.recordedPath !== primaryRoot
      && (capped || !effectivelyWritable(policy.mode, root.access)))
      .map(root => root.recordedPath)
    const deniedRoots = [...new Set(denied)]
    // The DSH home joins the deny set only while restrictions apply under
    // Full-access: a non-empty derived deny set, or an authority that cannot
    // prove the set is empty. Zero roots with a healthy authority stay
    // upstream-exact; confined modes never see it (containment already
    // excludes the home). When the primary root sits inside the home the deny
    // wins — the workspace is unwritable under Full-access rather than the
    // boundary silently dropped.
    let protectedHome: string | undefined
    if (this.dshHome !== undefined && policy.mode === 'danger-full-access'
      && (deniedRoots.length > 0 || this.registryAuthority === 'unavailable')) {
      const home = canonicalPath(this.dshHome)
      if (!deniedRoots.includes(home)) {
        deniedRoots.push(home)
        protectedHome = home
      }
    }
    return {
      primaryRoot,
      additionalRoots: roots.map(root => root.path),
      roots,
      writableRoots: writable,
      deniedRoots,
      authority: this.registryAuthority,
      ...(protectedHome === undefined ? {} : { protectedHome }),
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
   * member. The PTY seam resolves its caller through the agent-PTY
   * environment markers; when that lookup fails this flag is the difference
   * between pass-through (nothing to deny anywhere on the store) and fail
   * closed. An unavailable registry authority answers `true` by itself: a
   * terminal whose session cannot be resolved must not inherit a deny set
   * this process cannot see.
   * @returns whether at least one primary holds a restricted root, or the
   *   registry cannot prove none does.
   */
  hasActiveDenyRoots(): boolean {
    if (this.registryAuthority === 'unavailable') return true
    for (const members of this.rootsByPrimary.values()) {
      if (members.some(root => root.access === 'read-only') || (members.length > 0 && this.capped())) return true
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

  /**
   * Publish the registry-authority fact. This is the REGISTRY's write port —
   * the counterpart of {@link setAdditionalRoots}: the registry marks the
   * scope `unavailable` the moment it stops being the store's authority
   * (before acquisition, on contention or storage failure, at teardown) and
   * `available` only once its stored records have been published. Nothing
   * else may call it, and it never touches the root table.
   * @param available - whether this process holds the registry authority.
   */
  setRegistryAuthority(available: boolean): void {
    this.registryAuthority = available ? 'available' : 'unavailable'
    for (const listener of this.listeners) listener()
  }
}

export default MultiRootScopeService
