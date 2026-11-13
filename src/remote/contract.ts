/**
 * Shared types of the remote-environments control plane (G1a; off by default).
 * Remote grants authorize remote paths only: they never become local roots,
 * never enter `setAdditionalRoots`, and carry no access/mode knob — SSH root
 * authority always follows the current Session, capped at workspace-write.
 */
import type { RemoteBinding, RemoteEnvironment } from './manifest.ts'

export type RemotePurpose = 'read' | 'write' | 'exec' | 'transfer'

/** A model/host-facing remote endpoint: environment + deployment root id. */
export interface RemoteEndpointRef {
  readonly environmentId: string
  readonly rootId: string
}

/** The states a remote grant may occupy against the current manifest. */
export type RemoteGrantState = 'registered' | 'withheld' | 'revoked'

/** One durable remote registration. No connection, key, or admission handle. */
export interface RemoteGrant {
  readonly environmentId: string
  readonly rootId: string
  readonly displayPath: string
  /** The endpoint identity the verifier proved at registration. */
  readonly verifiedTarget: { readonly kind: 'object' | 'path'; readonly value: string }
  readonly configVersion: string
  readonly bindingDigest: string
  readonly addedAt: string
}

/** One endpoint carried by an `admit` decision; local endpoints have no remote identity. */
export interface AdmittedRemoteEndpoint {
  readonly environmentId: string
  readonly rootId: string
  readonly displayPath: string
  readonly verifiedTarget: { readonly kind: 'object' | 'path'; readonly value: string } | null
  readonly bindingDigest: string | null
  readonly configVersion: string | null
}

/** The owner's `remote-admit` reply, and the proof a Host-side body runs under. */
export interface RemoteAdmission {
  readonly decision: 'admit'
  readonly epoch: string
  readonly revision: number
  readonly primary: string
  readonly endpoints: readonly AdmittedRemoteEndpoint[]
}

/** The `remote-snapshot`/`remote-add`/`remote-remove` reply: grants with their live state. */
export interface RemoteSnapshotReply {
  readonly epoch: string
  readonly revision: number
  readonly primary: string
  readonly manifestDigest: string
  readonly grants: readonly (RemoteGrant & { readonly state: RemoteGrantState })[]
}

export class RemoteAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteAdmissionError'
  }
}

export type RemoteStateKind =
  | 'disabled'
  | 'platform-deferred'
  | 'config-invalid'
  | 'storage-failed'
  | 'owner-without-remote-protocol'
  | 'epoch-mismatch'
  | 'config-digest-mismatch'
  | 'ready'

/** The operator-facing picture of the remote control plane. */
export interface RemoteStatus {
  readonly state: RemoteStateKind
  readonly reason?: string
  /** Stable diagnostic code for a state whose raw reason is not user-facing. */
  readonly code?: string
}

/** The session fields remote admission keys on — header cwd only, never effective cwd. */
export interface RemoteOperationSession {
  readonly id: string
  readonly header: { readonly cwd: string }
}

export interface RemoteOperationRequest {
  readonly session: RemoteOperationSession | undefined
  readonly toolName: string
  readonly purpose: RemotePurpose
  readonly endpoints: readonly RemoteEndpointRef[]
}

export interface RemoteOperationIdentity {
  readonly operationId: string
  readonly purpose: RemotePurpose
  readonly toolName: string
  readonly sessionId: string
  readonly primaryRoot: string
  readonly authorityEpoch: string | undefined
  readonly revision: number
  readonly effectiveMode: 'read-only' | 'workspace-write'
}

/** Host-local operation context after ordered remote admission; never a wire permit. */
export interface RemoteOperation {
  readonly identity: RemoteOperationIdentity
  /** Only readable during this operation's callback. */
  readonly endpoints: readonly AdmittedRemoteEndpoint[]
}

/** Injected by the Host; G1a ships none, so remote adds are refused by default. */
export interface RemoteEndpointVerifier {
  verify(
    environment: RemoteEnvironment,
    binding: RemoteBinding,
    signal: AbortSignal,
  ): Promise<{ readonly platform: 'linux' | 'darwin'; readonly target: { readonly kind: 'object' | 'path'; readonly value: string } }>
}
