/**
 * The remote control plane: deployment manifest, remote grant domain, the
 * remote-1 listener/client, and the owner-side admission evaluation. One
 * object owned by `MultiRootRegistry`; it shares the registry's lease,
 * medium, and operation queue but never the v1 records.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { openAuthorityStorage } from '../compat/authority-storage.ts'
import type { storeIdentity } from '../authority/native.ts'
import type {
  AdmittedRemoteEndpoint, RemoteAdmission, RemoteEndpointRef, RemoteEndpointVerifier,
  RemoteGrant, RemotePurpose, RemoteSnapshotReply, RemoteStatus,
} from './contract.ts'
import { RemoteAdmissionError } from './contract.ts'
import { bindingDigest, loadDeploymentManifest, ManifestError, type DeploymentManifest } from './manifest.ts'
import { findBinding, grantState, remoteDomainSpec, REMOTE_TABLE_NAME, type PersistedRemoteGrants } from './records.ts'
import { RemoteClient, RemoteServer } from './protocol.ts'

export interface RemoteConfig {
  readonly enabled?: boolean
  readonly manifestPath?: string
}

type Medium = ReturnType<typeof storeIdentity>

/** Evaluate the row config once at construction; failures map to a remote-only state. */
export class RemoteControlPlane {
  readonly enabled: boolean
  /** The validated deployment manifest; undefined unless remote is enabled and valid. */
  manifest: DeploymentManifest | undefined
  manifestDigest: string | undefined
  private state: RemoteStatus
  private domain: { close(): Promise<void> } | undefined
  private table: KvTable<string, PersistedRemoteGrants> | undefined
  private server: RemoteServer | undefined
  client: RemoteClient | undefined
  private revision = 0
  verifier: RemoteEndpointVerifier | undefined

  constructor(config: RemoteConfig | undefined, private readonly logger: { warn(message: string): unknown }) {
    this.enabled = config?.enabled === true
    if (!this.enabled) { this.state = { state: 'disabled' }; return }
    if (process.platform === 'win32') { this.state = { state: 'platform-deferred' }; return }
    const path = config?.manifestPath
    try {
      if (path === undefined || path.trim() === '') throw new ManifestError('manifest-untrusted', 'remoteEnvironments.manifestPath is required when the remote experiment is enabled')
      const loaded = loadDeploymentManifest(path)
      this.manifest = loaded.manifest
      this.manifestDigest = loaded.digest
      // Enabled and valid, but nothing remote has been connected/opened yet.
      this.state = { state: 'owner-without-remote-protocol' }
    } catch (error) {
      this.state = { state: 'config-invalid', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  get status(): RemoteStatus { return this.state }

  private setState(state: RemoteStatus['state'], reason?: string): void {
    this.state = reason === undefined ? { state } : { state, reason }
  }

  private grantsOf(key: string): readonly RemoteGrant[] {
    try {
      return this.table?.get(key)?.grants ?? []
    } catch (error) {
      this.setState('storage-failed', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async persistGrants(key: string, grants: readonly RemoteGrant[]): Promise<void> {
    try {
      await this.table!.put(key, { grants: [...grants] })
      this.revision++
    } catch (error) {
      this.setState('storage-failed', `remote grant store write failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** Owner-side snapshot; called inside the registry's operation queue. */
  snapshot(key: string, epoch: string): RemoteSnapshotReply {
    return {
      epoch, revision: this.revision, primary: key, manifestDigest: this.manifestDigest!,
      grants: this.grantsOf(key).map(grant => ({ ...grant, state: grantState(this.manifest!, key, grant) })),
    }
  }

  /**
   * Owner-side add; called inside the queue AFTER the verifier ran outside it.
   * Re-checks the binding against the current manifest: a manifest or record
   * change during the verify window is refused rather than written.
   */
  async commitAdd(key: string, ref: RemoteEndpointRef, digest: string, verifiedTarget: RemoteGrant['verifiedTarget'], epoch: string): Promise<RemoteSnapshotReply> {
    const found = findBinding(this.manifest!, key, ref)
    if (found === undefined || bindingDigest(found.environment, found.binding) !== digest) {
      throw new RemoteAdmissionError('binding-changed', 'the deployment binding changed while the endpoint was being verified; retry the add')
    }
    const grants = this.grantsOf(key)
    const existing = grants.findIndex(grant => grant.environmentId === ref.environmentId && grant.rootId === ref.rootId)
    const record: RemoteGrant = {
      environmentId: ref.environmentId, rootId: ref.rootId, displayPath: found.binding.path,
      verifiedTarget, configVersion: this.manifest!.configVersion, bindingDigest: digest, addedAt: new Date().toISOString(),
    }
    if (existing !== -1 && grants[existing]!.bindingDigest === digest) return this.snapshot(key, epoch)
    const next = [...grants]
    if (existing === -1) next.push(record)
    else next[existing] = record
    await this.persistGrants(key, next)
    return this.snapshot(key, epoch)
  }

  /** Owner-side remove; called inside the queue. */
  async remove(key: string, ref: RemoteEndpointRef, epoch: string): Promise<RemoteSnapshotReply> {
    const grants = this.grantsOf(key)
    const next = grants.filter(grant => !(grant.environmentId === ref.environmentId && grant.rootId === ref.rootId))
    if (next.length === grants.length) throw new RemoteAdmissionError('endpoint-not-registered', `no remote grant is registered for ${ref.environmentId}:${ref.rootId}`)
    await this.persistGrants(key, next)
    return this.snapshot(key, epoch)
  }

  /**
   * Owner-side admission; called inside the queue, same ordering point as
   * `captureSnapshot`/`admit` on the v1 side.
   */
  admit(key: string, request: { purpose: RemotePurpose; endpoints: readonly RemoteEndpointRef[]; manifestDigest: string }, epoch: string): RemoteAdmission {
    if (request.manifestDigest !== this.manifestDigest) {
      throw new RemoteAdmissionError('config-digest-mismatch', 'the deployment manifest digest does not match the owner\'s')
    }
    const manifest = this.manifest!
    const grants = this.grantsOf(key)
    const admitted = (ref: RemoteEndpointRef): AdmittedRemoteEndpoint => {
      if (ref.environmentId === 'local') {
        return { environmentId: 'local', rootId: ref.rootId, displayPath: ref.rootId, verifiedTarget: null, bindingDigest: null, configVersion: null }
      }
      const grant = grants.find(candidate => candidate.environmentId === ref.environmentId && candidate.rootId === ref.rootId)
      if (grant === undefined) throw new RemoteAdmissionError('endpoint-not-registered', `no remote grant is registered for ${ref.environmentId}:${ref.rootId}`)
      const state = grantState(manifest, key, grant)
      if (state === 'revoked') throw new RemoteAdmissionError('endpoint-revoked', `the remote grant for ${ref.environmentId}:${ref.rootId} was revoked`)
      if (state === 'withheld') throw new RemoteAdmissionError('endpoint-withheld', `the remote grant for ${ref.environmentId}:${ref.rootId} is withheld pending re-registration`)
      return {
        environmentId: ref.environmentId, rootId: ref.rootId, displayPath: grant.displayPath,
        verifiedTarget: grant.verifiedTarget, bindingDigest: grant.bindingDigest, configVersion: grant.configVersion,
      }
    }
    let endpoints: AdmittedRemoteEndpoint[]
    if (request.purpose === 'transfer') {
      if (request.endpoints.length !== 2) throw new RemoteAdmissionError('invalid-arguments', 'a transfer requires exactly two endpoints')
      const [source, destination] = request.endpoints as [RemoteEndpointRef, RemoteEndpointRef]
      if (source.environmentId === 'local' && destination.environmentId === 'local') {
        throw new RemoteAdmissionError('transfer-pair-not-allowed', 'a remote transfer requires at least one remote endpoint')
      }
      // Registered-with-state before pairing, so a revoked endpoint wins over a pairing error.
      endpoints = [admitted(source), admitted(destination)]
      if (source.environmentId !== 'local' && !findBinding(manifest, key, source)!.binding.transfers?.some(
        transfer => transfer.direction === 'export' && transfer.peer.environmentId === destination.environmentId && transfer.peer.rootId === destination.rootId,
      )) throw new RemoteAdmissionError('transfer-pair-not-allowed', 'the source binding does not export to this destination')
      if (destination.environmentId !== 'local' && !findBinding(manifest, key, destination)!.binding.transfers?.some(
        transfer => transfer.direction === 'import' && transfer.peer.environmentId === source.environmentId && transfer.peer.rootId === source.rootId,
      )) throw new RemoteAdmissionError('transfer-pair-not-allowed', 'the destination binding does not import from this source')
      // The transfer contract is read/export on the source and create/import on
      // the destination: a declared pairing does not widen a binding that never
      // declared the matching action (ADR-0034, "双端准入").
      if (source.environmentId !== 'local' && !findBinding(manifest, key, source)!.binding.actions.includes('read')) {
        throw new RemoteAdmissionError('action-not-allowed', 'the source binding does not allow "read"')
      }
      if (destination.environmentId !== 'local' && !findBinding(manifest, key, destination)!.binding.actions.includes('write')) {
        throw new RemoteAdmissionError('action-not-allowed', 'the destination binding does not allow "write"')
      }
    } else {
      if (request.endpoints.length !== 1 || request.endpoints[0]!.environmentId === 'local') {
        throw new RemoteAdmissionError('invalid-arguments', `${request.purpose} requires exactly one remote endpoint`)
      }
      const ref = request.endpoints[0]!
      const binding = findBinding(manifest, key, ref)
      const endpoint = admitted(ref)
      if (!binding!.binding.actions.includes(request.purpose)) {
        throw new RemoteAdmissionError('action-not-allowed', `the binding for ${ref.environmentId}:${ref.rootId} does not allow "${request.purpose}"`)
      }
      endpoints = [endpoint]
    }
    return { decision: 'admit', epoch, revision: this.revision, primary: key, endpoints }
  }

  /** Verify outside the queue; the queued recheck is {@link commitAdd}. */
  async verifiedAddTarget(
    key: string,
    ref: RemoteEndpointRef,
    signal: AbortSignal,
  ): Promise<{ digest: string; verifiedTarget: RemoteGrant['verifiedTarget'] }> {
    const found = findBinding(this.manifest!, key, ref)
    if (found === undefined) throw new RemoteAdmissionError('binding-not-authorized', `no deployment binding authorizes ${ref.environmentId}:${ref.rootId} for this primary root`)
    if (this.verifier === undefined) throw new RemoteAdmissionError('endpoint-unverifiable', 'no remote endpoint verifier is configured; remote endpoints cannot be registered')
    const verified = await this.verifier.verify(found.environment, found.binding, signal)
    if (verified.platform !== found.environment.platform) {
      throw new RemoteAdmissionError('platform-mismatch', `the endpoint reports platform "${verified.platform}" but the manifest declares "${found.environment.platform}"`)
    }
    if (verified.target === undefined || (verified.target.kind !== 'object' && verified.target.kind !== 'path') || typeof verified.target.value !== 'string' || verified.target.value === '' || verified.target.value.length > 512) {
      throw new RemoteAdmissionError('endpoint-unverifiable', 'the endpoint verifier did not return a usable target identity')
    }
    return { digest: bindingDigest(found.environment, found.binding), verifiedTarget: verified.target }
  }

  /**
   * Open the remote domain and the remote-1 listener under the held lease.
   * Failures degrade the remote side only — the local registry commits normally.
   */
  async openOwner(ctx: Context, medium: Medium, epoch: string, dispatch: (method: string, args: unknown[]) => Promise<unknown>): Promise<void> {
    if (!this.enabled || this.manifest === undefined) return
    // A retryable v1 failure keeps this handle open; never stack a second one.
    await this.closeOwner()
    try {
      const domain = await openAuthorityStorage(ctx, medium.root, remoteDomainSpec)
      try {
        this.server = await RemoteServer.listen(medium.remoteEndpoint!, { store: medium.id, epoch, manifestDigest: this.manifestDigest! }, dispatch as never)
      } catch (error) {
        // The listener is for followers; a failure must not block owner-side ops.
        this.logger.warn(`multi-root-workspace: remote-1 listener failed (${error instanceof Error ? error.message : String(error)}); followers cannot reach the remote plane`)
      }
      this.domain = domain
      this.table = domain.table(REMOTE_TABLE_NAME) as KvTable<string, PersistedRemoteGrants>
      this.setState('ready')
    } catch (error) {
      this.setState('storage-failed', error instanceof Error ? error.message : String(error))
    }
  }

  /** The v1 store failed: stop serving remote admission too. */
  ownerFailed(reason: string): void {
    this.server?.close(); this.server = undefined
    if (this.enabled) this.setState('storage-failed', reason)
  }

  async closeOwner(): Promise<void> {
    this.server?.close(); this.server = undefined
    const domain = this.domain
    this.domain = undefined; this.table = undefined
    if (domain !== undefined) { try { await domain.close() } catch { /* teardown must not throw */ } }
  }

  /**
   * Follower-side: adopt the remote-1 channel of the just-connected v1 epoch.
   * Never throws — failures become the remote state.
   */
  async connectFollower(medium: Medium, epoch: string): Promise<void> {
    if (!this.enabled || this.manifest === undefined) return
    try {
      const adopted: { client: RemoteClient | undefined } = { client: undefined }
      const client = await RemoteClient.connect(medium.remoteEndpoint!, medium.id, this.manifestDigest!, () => {
        if (adopted.client === undefined) return
        if (this.client === adopted.client) this.client = undefined
        adopted.client = undefined
        this.setState('owner-without-remote-protocol', 'the remote channel closed')
      })
      adopted.client = client
      if (client.epoch !== epoch) { client.close(); adopted.client = undefined; this.setState('epoch-mismatch', 'the remote-1 epoch differs from the v1 authority epoch'); return }
      this.client = client
      this.setState('ready')
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code === 'config-digest-mismatch') this.setState('config-digest-mismatch', 'the owner serves a different deployment manifest')
      else this.setState('owner-without-remote-protocol', error instanceof Error ? error.message : String(error))
    }
  }

  /** The v1 client died: the remote channel dies with it; a new epoch needs a new hello. */
  dropFollower(): void {
    this.client?.close(); this.client = undefined
    if (this.enabled && this.manifest !== undefined && this.state.state === 'ready') {
      this.setState('owner-without-remote-protocol', 'the remote channel closed with the registry connection')
    }
  }

  /** Follower-side remote-1 request; AuthorityRpcError propagates with its code. */
  async remoteRequest(method: 'remote-snapshot' | 'remote-add' | 'remote-remove' | 'remote-admit', args: readonly unknown[]): Promise<unknown> {
    const client = this.client
    if (client === undefined) throw new RemoteAdmissionError('owner-without-remote-protocol', 'the remote control plane has no live remote-1 channel')
    try {
      return await client.request(method, args)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      throw new RemoteAdmissionError(typeof code === 'string' ? code : 'remote-unavailable', error instanceof Error ? error.message : String(error))
    }
  }
}
