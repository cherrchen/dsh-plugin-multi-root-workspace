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
import { primaryKey } from '../roots.ts'
import type { DeploymentManifest } from './manifest.ts'
import type { RemoteEndpointRef, RemoteGrant, RemoteGrantState } from './contract.ts'

/** Which side of an operation a candidate must be able to serve. */
export type CandidateDirection = 'source' | 'destination' | 'exec'

/** One candidate query: a direction, plus the other endpoint it must pair with. */
export interface CandidateRequest {
  readonly direction: CandidateDirection
  readonly peer?: RemoteEndpointRef
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
 * @returns sorted, bounded `environmentId:rootId` candidates.
 */
export function endpointCandidates(
  manifest: DeploymentManifest,
  grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[],
  primaryRoot: string,
  request: CandidateRequest,
): string[] {
  const key = primaryKey(primaryRoot)
  const registered = new Set(grants
    .filter(grant => grant.state === 'registered')
    .map(grant => `${grant.environmentId}:${grant.rootId}`))
  const found: string[] = []
  for (const binding of manifest.bindings) {
    if (primaryKey(binding.primary) !== key) continue
    const id = `${binding.environmentId}:${binding.rootId}`
    if (!registered.has(id)) continue
    if (request.direction === 'exec') {
      if (!binding.actions.includes('exec')) continue
    } else if (request.direction === 'source') {
      if (!binding.actions.includes('read')) continue
      if (request.peer !== undefined && !paired(binding, 'export', request.peer)) continue
    } else {
      if (!binding.actions.includes('write')) continue
      if (request.peer !== undefined && !paired(binding, 'import', request.peer)) continue
    }
    if (!found.includes(id)) found.push(id)
    if (found.length >= CANDIDATE_LIMIT) break
  }
  return found.sort()
}

function paired(
  binding: DeploymentManifest['bindings'][number],
  direction: 'import' | 'export',
  peer: RemoteEndpointRef,
): boolean {
  return binding.transfers?.some(transfer => transfer.direction === direction
    && transfer.peer.environmentId === peer.environmentId
    && transfer.peer.rootId === peer.rootId) === true
}

/**
 * Read the current snapshot and answer every request from it, or return
 * `undefined` when the manifest or snapshot is unavailable. Snapshot reads
 * never open a connection; the wait is bounded so a refusal stays responsive.
 * @param registry - the Registry (or a structural test double).
 * @param primaryRoot - the session workspace root.
 * @param requests - one request per candidate list needed.
 * @returns one candidate list per request, or undefined when unavailable.
 */
export async function currentEndpointCandidates(
  registry: RemoteCandidateRegistry,
  primaryRoot: string,
  requests: readonly CandidateRequest[],
): Promise<readonly (readonly string[])[] | undefined> {
  if (typeof registry.remoteList !== 'function') return undefined
  let manifest: DeploymentManifest | undefined
  try {
    manifest = registry.remoteManifest
  } catch {
    // The snapshot read is a correction aid; an unavailable projection keeps
    // the original refusal and its generic hint.
    return undefined
  }
  if (manifest === undefined) return undefined
  const snapshot = await snapshotWithinTimeout(registry, primaryRoot)
  if (snapshot === undefined) return undefined
  try {
    return requests.map(request => endpointCandidates(manifest, snapshot.grants, primaryRoot, request))
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
