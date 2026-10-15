/**
 * Boot-time probe for the agent-PTY marker contract.
 *
 * `multi-root-process-fence` tells an agent terminal from the user's own by
 * one env fact: every supported `dsh-terminal-bash` backend stamps
 * `DSH_PTY_SESSION_ID` (alongside `DSH_SESSION_ID`) into the PTY spawn spec,
 * while the panel's terminal controller stamps only `DSH_SESSION_ID`. That
 * marker is the ONLY discriminator — a backend that ever stops stamping it
 * would reclassify agent PTYs as user terminals and pass them through
 * unconfined under a restricted `danger-full-access`, which is a silent
 * fail-open on a security boundary.
 *
 * The marker is an env key inside upstream's emitted code, not an exported
 * symbol, so the honest structural probe is content: the installed backend
 * package must still write the marker. This module is called from the
 * `multi-root-compat` gate (`src/compat.ts`) BEFORE the service registers —
 * like the version verdict it is a precondition, not a diagnostic, and a
 * breach refuses the composition the same way `mixed`/`incomplete` do: it is
 * not relaxable by `DSH_MULTI_ROOT_COMPAT=warn`.
 *
 * Resolution follows the optional-peer precedent (`agent-instructions.ts`):
 * the backend is not a peer of this plugin, so the plugin anchor is tried
 * first (flat layouts) and the `@deepseek-ai/dsh` host anchor second — the
 * same `HOST_RESOLVED_PACKAGES` pattern as `dsh-version.ts` — because the
 * backend rides inside the harness meta package's own dependency tree.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/pty-marker
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The env key that identifies an agent-launched PTY spawn spec. */
export const AGENT_PTY_MARKER = 'DSH_PTY_SESSION_ID'

/** The upstream package whose backend owns the marker stamp. */
const TERMINAL_BACKEND = '@deepseek-ai/dsh-terminal-bash'

/** The harness meta package the backend rides inside (its dependency). */
const HOST_ANCHOR = '@deepseek-ai/dsh/package.json'

/** Scan budget: enough for any plausible backend layout, bounded forever. */
const MAX_SOURCE_FILES = 256
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/**
 * What the probe established about the installed backend.
 *
 * - `stamped` — the marker assignment is present in the installed code.
 * - `uninstalled` — no `dsh-terminal-bash` resolves; an installation without
 *   the backend can never launch an agent PTY, so the contract holds vacuously.
 * - `unverifiable` — the package resolves but the marker cannot be confirmed:
 *   absent from the emitted code, or the code cannot be read. Either way the
 *   fence's agent/user split is unproven, and the gate must refuse rather
 *   than guess — "cannot verify" is not "nothing is stamped".
 */
export type AgentPtyMarkerVerdict = 'stamped' | 'uninstalled' | 'unverifiable'

/**
 * Raised when the installed terminal backend does not uphold the marker
 * contract. Thrown from `apply` like `DshCompatUnsupportedError`, so it
 * surfaces as a plugin load failure with the diagnosis attached.
 */
export class PtyMarkerContractError extends Error {
  /** The resolved backend path when one was found. */
  readonly backend: string | undefined

  constructor(message: string, backend?: string) {
    super(message)
    this.name = 'PtyMarkerContractError'
    this.backend = backend
  }
}

/** The filesystem seams the probe needs — injectable so tests stay pure. */
export interface AgentPtyMarkerIo {
  /**
   * Resolve the backend package's install root, or `undefined` when it is not
   * installed anywhere the contract can see. A resolution failure that is not
   * "module not found" must THROW — the package may exist and be malformed,
   * which is `unverifiable`, not `uninstalled`.
   */
  resolveBackendRoot(): string | undefined
  /** Every emitted `.js` file under the package root, bounded by the caps. */
  listSources(root: string): string[]
  /** One file's contents; throws when the file cannot be read. */
  read(path: string): string
}

/**
 * Resolve the backend package root through the two anchors the contract can
 * reach: this module first (flat layouts where the backend is a direct
 * install), then the `@deepseek-ai/dsh` host manifest (pnpm-style layouts
 * where it is the meta package's own dependency — the
 * `HOST_RESOLVED_PACKAGES` precedent). A resolution failure that is not a
 * genuine NOT_FOUND propagates: a resolvable-but-broken specifier is not
 * evidence of absence.
 */
function resolveBackendRoot(): string | undefined {
  const self = createRequire(import.meta.url)
  const anchors = [self]
  try {
    anchors.push(createRequire(self.resolve(HOST_ANCHOR)))
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error
  }
  for (const anchor of anchors) {
    try {
      return dirname(anchor.resolve(`${TERMINAL_BACKEND}/package.json`))
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
  }
  return undefined
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND'
}

/** Recursively collect `.js` sources under the package root, within budget. */
function listSources(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_SOURCE_FILES) return
      const path = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
    }
  }
  visit(root)
  return files
}

const defaultIo: AgentPtyMarkerIo = {
  resolveBackendRoot,
  listSources,
  read: path => readFileSync(path, 'utf8'),
}

/**
 * Judge the installed terminal backend against the marker contract.
 *
 * Never throws: every outcome — absent package, unreadable source, missing
 * marker — is folded into the verdict so the caller's reaction is a policy
 * decision in one place.
 * @param io - filesystem seams; tests inject them, production uses real fs.
 * @returns the verdict.
 */
export function agentPtyMarkerVerdict(io: AgentPtyMarkerIo = defaultIo): AgentPtyMarkerVerdict {
  let root: string | undefined
  try {
    root = io.resolveBackendRoot()
  } catch {
    return 'unverifiable'
  }
  if (root === undefined) return 'uninstalled'
  let files: string[]
  try {
    files = io.listSources(root)
  } catch {
    return 'unverifiable'
  }
  let remaining = MAX_TOTAL_BYTES
  for (const file of files) {
    let content: string
    try {
      content = io.read(file)
    } catch {
      return 'unverifiable'
    }
    if (content.length > remaining) return 'unverifiable'
    if (content.includes(AGENT_PTY_MARKER)) return 'stamped'
    remaining -= content.length
  }
  return 'unverifiable'
}

/**
 * Enforce the contract: refuse when the marker cannot be confirmed.
 *
 * @param io - filesystem seams; tests inject them.
 * @throws {PtyMarkerContractError} on `unverifiable`.
 */
export function assertAgentPtyMarker(io: AgentPtyMarkerIo = defaultIo): void {
  const verdict = agentPtyMarkerVerdict(io)
  if (verdict !== 'unverifiable') return
  let backend: string | undefined
  try { backend = io.resolveBackendRoot() } catch { /* detail stays absent */ }
  throw new PtyMarkerContractError(
    `multi-root workspace: the installed ${TERMINAL_BACKEND} does not stamp ${AGENT_PTY_MARKER} `
    + 'on agent PTY spawns, or its sources cannot be verified. That marker is the only fact that '
    + 'separates an agent terminal from the user\'s own — without it the process fence cannot '
    + 'confine a restricted danger-full-access agent PTY without confining the user\'s terminal too. '
    + 'The plugin refuses to run rather than let agent terminals pass unconfined. '
    + 'See docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md.',
    backend,
  )
}
