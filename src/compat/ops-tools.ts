import { realpathSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { isAbsolute as isPathAbsolute, relative as pathRelative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { MultiRootScopeService } from '../scope.ts'
import type { ToolCaller } from './tool-context.ts'
import { opsCompatibilityToken } from './ops-settings.ts'

export const OPS_TOOL_PREFIX = 'ops_'

const OPS_EXEC_RAW_NAMES = [
  'inspect_local_file', 'grep', 'glob', 'replace', 'write_file', 'edit_file', 'diff', 'stat',
  'copy', 'move', 'remove', 'read_files', 'read_table', 'read_docx', 'read_pdf',
  'batch', 'result', 'bash',
] as const

const OPS_PUBLISH_RAW_NAMES = ['discover_tools', 'load_sdk'] as const

export const OPS_EXEC_NAMES: readonly string[] = OPS_EXEC_RAW_NAMES.map(raw => OPS_TOOL_PREFIX + raw)

export type OpsToolKind = 'exec' | 'publish' | 'unknown' | 'other'

export function classifyOpsTool(name: string): OpsToolKind {
  if (typeof name !== 'string' || !name.startsWith(OPS_TOOL_PREFIX)) return 'other'
  const raw = name.slice(OPS_TOOL_PREFIX.length)
  if ((OPS_EXEC_RAW_NAMES as readonly string[]).includes(raw)) return 'exec'
  if ((OPS_PUBLISH_RAW_NAMES as readonly string[]).includes(raw)) return 'publish'
  return 'unknown'
}

export interface OpsProtectionState {
  owner: object | undefined
  entered: number
  readonly drainWaiters: Set<() => void>
}

export function createOpsProtectionState(): OpsProtectionState {
  return { owner: undefined, entered: 0, drainWaiters: new Set() }
}

export function claimOpsProtection(state: OpsProtectionState): object {
  const owner = {}
  state.owner = owner
  return owner
}

export function revokeOpsProtection(state: OpsProtectionState, token: object): void {
  if (state.owner === token) state.owner = undefined
}

export function opsProtectionReady(state: OpsProtectionState): boolean {
  return state.owner !== undefined
}

export function assertOpsProtectionReady(state: OpsProtectionState): void {
  if (state.owner === undefined) {
    throw new Error('multi-root workspace: the OPS execution protection is not installed on this scope')
  }
}

export function assertOpsProtectionOwner(state: OpsProtectionState, token: object): void {
  if (state.owner !== token) {
    throw new Error('multi-root workspace: the OPS execution protection generation was replaced during dispatch')
  }
}

export function enterOpsProtection(state: OpsProtectionState): object {
  if (state.owner === undefined) {
    throw new Error('multi-root workspace: the OPS execution protection is not installed on this scope')
  }
  state.entered += 1
  return state.owner
}

export function leaveOpsProtection(state: OpsProtectionState): void {
  state.entered -= 1
  if (state.entered === 0) {
    for (const resolve of state.drainWaiters) resolve()
    state.drainWaiters.clear()
  }
}

export async function drainOpsProtection(state: OpsProtectionState): Promise<void> {
  if (state.entered === 0) return
  await new Promise<void>(resolve => state.drainWaiters.add(resolve))
}

const OPS_RESULT_CACHE_LEAF = /^dsh-ops-results-[0-9a-f]{64}$/u

function cacheRefusal(detail: string): Error {
  return new Error(`multi-root workspace: ${detail}; refusing to prepare the OPS execution`)
}

function containsPath(root: string, path: string): boolean {
  if (root === path) return true
  const rel = pathRelative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isPathAbsolute(rel)
}

export function assertOpsPosixCacheAdmission(deniedRoots: readonly string[]): void {
  let canonicalTmp: string
  try {
    canonicalTmp = realpathSync.native(osTmpdir())
  } catch (error) {
    throw cacheRefusal(`the canonical temporary directory cannot be resolved (${(error as Error).message})`)
  }
  if (!isPathAbsolute(canonicalTmp)) throw cacheRefusal('the canonical temporary directory is not absolute')
  const rawTmp = osTmpdir()
  const spellings = new Set<string>()
  for (const root of deniedRoots) {
    if (root === '') continue
    spellings.add(root)
    try { spellings.add(realpathSync.native(root)) } catch {}
    if (containsPath(rawTmp, root) || root === rawTmp) {
      const rel = pathRelative(rawTmp, root)
      spellings.add(rel === '' ? canonicalTmp : canonicalTmp + '/' + rel)
    }
  }
  for (const deny of spellings) {
    if (containsPath(deny, canonicalTmp)) {
      throw cacheRefusal(`a deny boundary ${JSON.stringify(deny)} covers the temporary directory`)
    }
    const rel = pathRelative(canonicalTmp, deny)
    if (rel === '' || rel.startsWith('..') || isPathAbsolute(rel)) continue
    const first = rel.split('/')[0]
    if (first !== undefined && OPS_RESULT_CACHE_LEAF.test(first)) {
      throw cacheRefusal(`a deny boundary ${JSON.stringify(deny)} overlaps the OPS result cache`)
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function opsDispatchBarrier(ctx: Context, scope: MultiRootScopeService, exec: ToolCaller): string | undefined {
  if (opsCompatibilityToken(ctx) === undefined) return undefined
  const kind = classifyOpsTool(exec.name)
  if (kind === 'other' || kind === 'publish') return undefined
  if (ctx.get('multiRootCompat') === undefined || ctx.get('multiRootProviders') === undefined) return undefined
  const session = exec.agent?.session
  const policyService = ctx.get('sandboxPolicy')
  let policy: SandboxExecutionPolicy | undefined
  if (session !== undefined && policyService !== undefined) {
    try { policy = policyService.resolve({ session }) } catch { policy = undefined }
  }
  if (policy === undefined) {
    return `the OPS tool ${JSON.stringify(exec.name)} cannot be confirmed against a trusted session and policy`
  }
  if (policy.mode !== 'danger-full-access') return undefined
  const preview = scope.previewForTool(policy, exec.name)
  if (preview.authority === 'unavailable') {
    return `the multi-root registry authority is unavailable; the OPS call ${JSON.stringify(exec.name)} is refused before dispatch`
  }
  if (preview.deniedRoots.length === 0) return undefined
  if (kind === 'unknown') {
    return `the unrecognized OPS capability ${JSON.stringify(exec.name)} is refused while write boundaries apply`
  }
  if (!opsProtectionReady(scope.opsProtection)) {
    return `the OPS execution protection is not installed; the call ${JSON.stringify(exec.name)} is refused`
  }
  if (exec.name === `${OPS_TOOL_PREFIX}bash` && object(exec.arguments) && exec.arguments.run_in_background === true) {
    return 'run_in_background is refused while danger-full-access write boundaries apply'
  }
  return undefined
}
