/**
 * Bounded endpoint candidates for correcting a failed remote tool call.
 *
 * The lookup reads the Registry's snapshot for the CURRENT session's primary
 * root and the live deployment manifest: it opens no SSH connection, consumes
 * no admission, and grants nothing. A candidate only helps the model spell a
 * retry; every retry is admitted formally again. When no snapshot can be read
 * the caller keeps the original refusal and falls back to a generic hint.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-endpoint-candidates
 */
import type { MultiRootRegistry } from '../registry.ts'
import { effectiveRootAccess } from '../contract.ts'
import { primaryKey } from '../roots.ts'
import type { DeploymentManifest, RemoteBinding } from './manifest.ts'
import type { RemoteEndpointRef, RemoteGrant, RemoteGrantState, RemoteOperationSession } from './contract.ts'

/** Which side of an operation a candidate must be able to serve. */
export type CandidateDirection = 'source' | 'destination' | 'exec'

/** One candidate query: a direction, plus the other endpoint it must pair with. */
export interface CandidateRequest {
  readonly direction: CandidateDirection
  readonly peer?: RemoteEndpointRef
}

interface CopyCandidateScope {
  readonly source: readonly string[]
  readonly destination: readonly string[]
  readonly remoteDestination: boolean
}

/** The Registry reads the candidate lookup needs; a fake may implement both. */
export interface RemoteCandidateRegistry {
  remoteList(primaryRoot: string): Promise<{ readonly grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[] }>
  readonly remoteManifest: DeploymentManifest | undefined
}

/** How many `environmentId:rootId` candidates one hint may carry. */
export const CANDIDATE_LIMIT = 6

/** How long a failure may wait for the Registry snapshot before using the generic hint. */
const SNAPSHOT_TIMEOUT_MS = 1_000

/** Bound on local root ids echoed in a hint. */
const LOCAL_CANDIDATE_LIMIT = 8

/**
 * Filter the manifest's bindings for this primary root into candidates that
 * can serve one direction: registered with the live grant state, allowed by
 * the binding's actions, and paired with the known peer when one is given.
 * @param manifest - the live deployment manifest.
 * @param grants - the owner snapshot's grants with their states.
 * @param primaryRoot - the session workspace root (any spelling).
 * @param request - direction plus optional known peer.
 * @param copy - local endpoints and remote write capability for this call.
 * @returns sorted, bounded `environmentId:rootId` candidates.
 */
export function endpointCandidates(
  manifest: DeploymentManifest,
  grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[],
  primaryRoot: string,
  request: CandidateRequest,
  copy?: CopyCandidateScope,
): string[] {
  const key = primaryKey(primaryRoot)
  const registered = new Set(grants
    .filter(grant => grant.state === 'registered')
    .map(grant => `${grant.environmentId}:${grant.rootId}`))
  const bindings = manifest.bindings.filter(binding => primaryKey(binding.primary) === key && registered.has(endpointId(binding)))
  const { direction, peer } = request
  if (direction === 'exec') {
    return bindings.filter(binding => binding.actions.includes('exec')).map(endpointId).sort().slice(0, CANDIDATE_LIMIT)
  }
  const source = direction === 'source'
  const ownAction = source ? 'read' : 'write'
  const ownPair = source ? 'export' : 'import'
  const peerDirection = source ? 'destination' : 'source'
  const remote = bindings.filter(binding => binding.actions.includes(ownAction))
  if (peer === undefined) return remote.map(endpointId).sort().slice(0, CANDIDATE_LIMIT)

  if (source && peer.environmentId !== 'local' && copy?.remoteDestination === false) return []
  if (peer.environmentId === 'local') {
    if (copy !== undefined && !copy[peerDirection].includes(peer.rootId)) return []
    if (!source && copy?.remoteDestination === false) return []
    return remote.filter(binding => paired(binding, ownPair, peer)).map(endpointId).sort().slice(0, CANDIDATE_LIMIT)
  }

  const peerBinding = bindings.find(binding => endpointId(binding) === endpointId(peer))
  if (!peerBinding?.actions.includes(source ? 'write' : 'read')) return []
  const peerPair = source ? 'import' : 'export'
  const found = (copy?.[direction] ?? [])
    .map(rootId => ({ environmentId: 'local', rootId }))
    .filter(local => paired(peerBinding, peerPair, local))
    .map(endpointId)
  if (source || copy?.remoteDestination !== false) {
    for (const binding of remote) {
      if (paired(binding, ownPair, peer) && paired(peerBinding, peerPair, binding)) found.push(endpointId(binding))
    }
  }
  return found.sort().slice(0, CANDIDATE_LIMIT)
}

const endpointId = ({ environmentId, rootId }: RemoteEndpointRef): string => `${environmentId}:${rootId}`

function paired(
  binding: RemoteBinding,
  direction: 'import' | 'export',
  peer: RemoteEndpointRef,
): boolean {
  return binding.transfers?.some(transfer => transfer.direction === direction
    && transfer.peer.environmentId === peer.environmentId
    && transfer.peer.rootId === peer.rootId) === true
}

/** Advisory local endpoints, narrowed by the same mode and cap as admission. */
export function copyCandidateScope(
  registry: Pick<MultiRootRegistry, 'list' | 'remoteToolPolicy'>,
  session: RemoteOperationSession,
  toolName: string,
): CopyCandidateScope | undefined {
  try {
    const policy = registry.remoteToolPolicy(session, toolName)
    if (policy === undefined) return undefined
    const writable = policy.effectiveMode === 'workspace-write'
    const source: string[] = []
    const destination: string[] = []
    if (process.platform !== 'win32') {
      source.push('primary')
      if (writable) destination.push('primary')
      for (const root of registry.list(session.header.cwd)) {
        const aliasId = root.aliasId
        if (root.state !== 'available' || typeof aliasId !== 'string' || aliasId === '') continue
        source.push(aliasId)
        if (!policy.capped && effectiveRootAccess(root.access, policy.effectiveMode) === 'read-write') destination.push(aliasId)
      }
    }
    return { source, destination, remoteDestination: writable && !policy.capped }
  } catch {
    return undefined
  }
}

/**
 * Read the current snapshot and answer every request from it, or return
 * `undefined` when the manifest or snapshot is unavailable. Snapshot reads
 * never open a connection; the wait is bounded so a refusal stays responsive.
 * @param registry - the Registry (or a structural test double).
 * @param primaryRoot - the session workspace root.
 * @param requests - one request per candidate list needed.
 * @param copy - local endpoints and remote write capability for copy hints.
 * @returns one candidate list per request, or undefined when unavailable.
 */
export async function currentEndpointCandidates(
  registry: RemoteCandidateRegistry,
  primaryRoot: string,
  requests: readonly CandidateRequest[],
  copy?: CopyCandidateScope,
): Promise<readonly (readonly string[])[] | undefined> {
  if (typeof registry.remoteList !== 'function') return undefined
  const snapshot = await snapshotWithinTimeout(registry, primaryRoot)
  if (snapshot === undefined) return undefined
  try {
    const manifest = registry.remoteManifest
    return manifest === undefined ? undefined : requests.map(request => endpointCandidates(manifest, snapshot.grants, primaryRoot, request, copy))
  } catch {
    // Filtering runs on the failure path: any unexpected projection error must
    // leave the original refusal and its generic hint intact.
    return undefined
  }
}

function snapshotWithinTimeout(
  registry: RemoteCandidateRegistry,
  primaryRoot: string,
): Promise<{ readonly grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[] } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), SNAPSHOT_TIMEOUT_MS)
    timer.unref()
  })
  let read: Promise<{ readonly grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[] } | undefined>
  try {
    read = Promise.resolve(registry.remoteList(primaryRoot)).catch(() => undefined)
  } catch {
    read = Promise.resolve(undefined)
  }
  return Promise.race([read, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/**
 * Local root ids usable as a copy endpoint in this workspace: the literal
 * `primary` plus every available registered root's aliasId, bounded.
 * @param registry - the Registry (or a structural test double).
 * @param primaryRoot - the session workspace root.
 * @returns the ids in registry order, `primary` first.
 */
export function localRootCandidates(registry: Pick<MultiRootRegistry, 'list'>, primaryRoot: string): string[] {
  const ids = ['primary']
  try {
    for (const status of registry.list(primaryRoot)) {
      if (status.state !== 'available') continue
      const aliasId = typeof status.aliasId === 'string' ? status.aliasId : undefined
      if (aliasId !== undefined && aliasId !== '' && !ids.includes(aliasId)) ids.push(aliasId)
    }
  } catch {
    // A local registry read must not turn a copy refusal into a throw; the
    // literal "primary" hint still stands.
  }
  return ids.slice(0, LOCAL_CANDIDATE_LIMIT)
}
