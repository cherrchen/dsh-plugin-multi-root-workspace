/**
 * The model-facing capability projection for the explicit remote tools (G5).
 *
 * It is a runtime-context contribution, not a tool list: the environment names
 * and paths are deployment facts the model needs in order to choose an
 * explicit target, and the refusal vocabulary it may see back. Nothing here
 * creates a connection, registers a grant, or grants a path: the registry's
 * ordered admission still decides every operation, and an endpoint that is not
 * registered stays unusable. Remote paths and remote output are DATA — never a
 * local path reference — which the text states so a model cannot mistake one
 * for the other.
 */
import type { RemoteBinding, RemoteEnvironment } from './manifest.ts'
import type { RemoteStatus } from './contract.ts'

/** The runtime-context contribution name the tools row owns. */
export const REMOTE_CONTEXT_NAME = 'multi-root:remote'

const ACTION_ORDER = ['read', 'write', 'exec'] as const

function peer(environmentId: string, rootId: string): string {
  return `${environmentId}/${rootId}`
}

/**
 * Render one deployment entry. Only manifest facts the operator already
 * declared reach the model: environment id, root id, bound path, platform and
 * actions. The connection host, account, keys and digests never do.
 */
function renderBinding(binding: RemoteBinding, environment: RemoteEnvironment): string {
  const actions = ACTION_ORDER.filter(action => binding.actions.includes(action))
  const parts = [`actions ${actions.join(', ')}`]
  const transfers = binding.transfers ?? []
  const imports = transfers.filter(transfer => transfer.direction === 'import').map(transfer => peer(transfer.peer.environmentId, transfer.peer.rootId))
  const exports = transfers.filter(transfer => transfer.direction === 'export').map(transfer => peer(transfer.peer.environmentId, transfer.peer.rootId))
  if (imports.length > 0) parts.push(`accepts copies from ${imports.join(', ')}`)
  if (exports.length > 0) parts.push(`sends copies to ${exports.join(', ')}`)
  return `- ${peer(binding.environmentId, binding.rootId)} at ${JSON.stringify(binding.path)} (${environment.platform}): ${parts.join('; ')}`
}

/**
 * Render the remote topology for one session.
 * @param options.bindings - the manifest bindings for this session's primary root, in manifest order.
 * @param options.environments - every manifest environment (looked up by id).
 * @param options.mode - the session's sandbox mode.
 * @param options.status - the live remote control-plane state.
 * @returns the stable contribution; empty when this project has no bindings.
 */
export function renderRemoteCapabilities(options: {
  readonly bindings: readonly RemoteBinding[]
  readonly environments: readonly RemoteEnvironment[]
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly status: RemoteStatus
}): string {
  if (options.bindings.length === 0) return ''
  const byId = new Map(options.environments.map(environment => [environment.environmentId, environment]))
  const lines = options.bindings.flatMap(binding => {
    const environment = byId.get(binding.environmentId)
    return environment === undefined ? [] : [renderBinding(binding, environment)]
  })
  if (lines.length === 0) return ''
  const state = options.status.state === 'ready'
    ? ''
    : ` The remote control plane is ${options.status.state}${options.status.reason === undefined ? '' : ` (${options.status.reason})`}, so every remote tool call is refused with remote-unavailable until the host resolves it.`
  const mode = options.mode === 'read-only'
    ? ' This session is read-only: remote writes, commands, and copies whose destination is remote are refused.'
    : ''
  return 'Remote environments are reachable only through the explicit remote_copy and remote_bash tools; they are not local workspace roots, '
    + 'and a remote path or remote output is data, never a local path to read, reveal, or download. '
    + "This project's deployment declares:\n"
    + lines.join('\n')
    + `. A tool is usable only for an endpoint registered for this project; endpoint-not-registered, endpoint-withheld or endpoint-revoked in a result means this project cannot use that endpoint.${state}${mode}`
}
