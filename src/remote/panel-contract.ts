/**
 * Browser-safe wire shapes for the panel's remote-environment section.
 *
 * The remote experiment is a separate contract on purpose: these endpoints do
 * NOT extend `PanelEndpoint`/`PanelResponseMap` (the roots contract), because a
 * host that predates the experiment must answer "remote unavailable" instead of
 * a malformed roots view, and the panel client for roots must never decode one
 * as the other. Every request still carries `sessionId`: the host derives the
 * primary root from a live session and accepts no client-named path.
 *
 * Listing is a pure read of the control plane's state, the deployment manifest
 * and the registered grants — it never opens a connection. Only an explicit
 * `add` verifies an endpoint (and therefore connects), exactly like the
 * registry's own `addRemote`.
 */
import { z } from 'zod'

/** The endpoints this module owns. */
export const REMOTE_ENDPOINTS = ['remotes', 'addRemote', 'removeRemote'] as const
export type RemoteEndpoint = typeof REMOTE_ENDPOINTS[number]

const remoteRequestSchema = z.object({
  sessionId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  rootId: z.string().min(1).optional(),
}).strict()

/** One manifest action, spelled as the deployment declares it. */
export type RemoteAction = 'read' | 'write' | 'exec'

/** One declared copy pairing. */
export interface RemoteTransferView {
  readonly direction: 'import' | 'export'
  readonly environmentId: string
  readonly rootId: string
}

/**
 * What this endpoint can do RIGHT NOW, after the session mode and the tool caps
 * are applied. `receive`/`send` are the copy directions: receiving writes the
 * remote root, sending reads it; a send whose only peers are local survives a
 * read-only session, every other direction does not.
 */
export interface RemoteCapabilitiesView {
  readonly read: boolean
  readonly write: boolean
  readonly exec: boolean
  readonly receive: boolean
  readonly send: boolean
}

/** One deployment entry with its registration state and effective capabilities. */
export interface RemoteEndpointView {
  readonly environmentId: string
  readonly rootId: string
  /** The deployment path this binding was granted for. */
  readonly path: string
  readonly platform: string
  readonly displayName?: string | undefined
  readonly state: 'unregistered' | 'registered' | 'withheld' | 'revoked'
  readonly actions: readonly RemoteAction[]
  readonly transfers: readonly RemoteTransferView[]
  readonly capabilities: RemoteCapabilitiesView
  /** Why the endpoint is not usable; a code the panel localizes. */
  readonly reason?: string | undefined
}

/** The panel's whole remote section, returned by every remote endpoint. */
export interface RemotesView {
  readonly primaryRoot: string
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** The live credential custody mode (ADR-0041); absent on pre-ADR-0041 hosts. */
  readonly custodyMode?: 'personal' | 'team' | 'hardened' | undefined
  /** The control plane's live state; only `ready` admits remote work. */
  readonly status: { readonly state: string; readonly reason?: string | undefined; readonly code?: string | undefined }
  readonly endpoints: readonly RemoteEndpointView[]
  /** Set when the state itself could not be read; the panel shows this verbatim. */
  readonly unavailable?: string | undefined
}

const transferViewSchema = z.object({
  direction: z.enum(['import', 'export']),
  environmentId: z.string(),
  rootId: z.string(),
})

const endpointViewSchema = z.object({
  environmentId: z.string(),
  rootId: z.string(),
  path: z.string(),
  platform: z.string(),
  displayName: z.string().optional(),
  state: z.enum(['unregistered', 'registered', 'withheld', 'revoked']),
  actions: z.array(z.enum(['read', 'write', 'exec'])),
  transfers: z.array(transferViewSchema),
  capabilities: z.object({
    read: z.boolean(), write: z.boolean(), exec: z.boolean(), receive: z.boolean(), send: z.boolean(),
  }),
  reason: z.string().optional(),
})

const remotesViewSchema = z.object({
  primaryRoot: z.string(),
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  // The custody mode is optional metadata: a host that predates ADR-0041
  // omits it, and a newer host may send a mode this client does not know. One
  // unreadable optional field must not invalidate the whole remote section —
  // treat it as absent and keep the endpoints/list rendering.
  custodyMode: z.preprocess(
    value => value === 'personal' || value === 'team' || value === 'hardened' ? value : undefined,
    z.enum(['personal', 'team', 'hardened']).optional(),
  ),
  status: z.object({ state: z.string(), reason: z.string().optional(), code: z.string().optional() }),
  endpoints: z.array(endpointViewSchema),
  unavailable: z.string().optional(),
})

/** One parse result, mirroring the roots contract's vocabulary. */
export type RemoteParsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * Validate a remote request body.
 * @param payload - the raw channel payload.
 * @returns the request, or the reason it is not one.
 */
export function parseRemoteRequest(payload: unknown): RemoteParsed<{ sessionId: string; environmentId?: string; rootId?: string }> {
  const parsed = remoteRequestSchema.safeParse(payload ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `the remote request is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      ...(parsed.data.environmentId === undefined ? {} : { environmentId: parsed.data.environmentId }),
      ...(parsed.data.rootId === undefined ? {} : { rootId: parsed.data.rootId }),
    },
  }
}

/**
 * Validate a `RemotesView` when it arrives.
 * @param value - the raw endpoint value.
 * @returns the view, or the reason it is not one.
 */
export function parseRemotesView(value: unknown): RemoteParsed<RemotesView> {
  const parsed = remotesViewSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `the answer is not a remotes view: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return { ok: true, value: parsed.data }
}
