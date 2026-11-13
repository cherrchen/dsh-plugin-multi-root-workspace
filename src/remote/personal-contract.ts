/**
 * Browser-safe wire shapes for the personal-mode SSH management endpoints
 * (ADR-0041 §2/§6). Separate from the roots and remotes contracts, same
 * PANEL_CHANNEL. Every request carries `sessionId`; the host derives the
 * primary root from the live session. Unknown keys fail `panel/bad-request`.
 *
 * No endpoint ever returns secret material: credential answers are metadata
 * views only, and `sshHostKeyScan` hands back a short-lived scan token whose
 * known_hosts line stays server-side.
 */
import { z } from 'zod'

/** Personal endpoint names, relative to the panel channel. */
export const SSH_ENDPOINTS = [
  'sshState',
  'sshCredentialGenerate',
  'sshCredentialImport',
  'sshCredentialPassword',
  'sshCredentialRemove',
  'sshHostKeyScan',
  'sshEnvironmentSave',
  'sshEnvironmentRemove',
  'sshEnvironmentTest',
  'sshHelperInstall',
  'sshAccessKeyInstall',
  'sshBindingSave',
  'sshBindingRemove',
  'sshConfigLink',
] as const

export type SshEndpoint = (typeof SSH_ENDPOINTS)[number]

const sessionId = z.string().min(1)
const environmentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const label = z.string().min(1).max(128)
const revision = z.number().int().min(0)

const endpointDraft = z.object({
  hostname: z.string().min(1).max(253).refine(value => !/\s/.test(value) && !value.startsWith('-'), 'invalid hostname'),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1).max(64).refine(value => !/\s/.test(value) && !value.startsWith('-'), 'invalid user'),
})

const credentialDraft = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ssh-config'), alias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/) }),
  z.object({ kind: z.literal('managed'), credentialId: z.string().min(1), accessKeyId: z.string().min(1).optional() }),
])

/** The environment draft the client sends — never a hostKey line, never secrets. */
export const environmentDraftSchema = z.object({
  environmentId,
  displayName: z.string().max(128).optional(),
  platform: z.enum(['linux', 'darwin']),
  endpoint: endpointDraft,
  credential: credentialDraft,
  workspace: z.string().min(1).max(4096),
  // The draft carries the FULL exec stanza — the client materializes the
  // documented defaults and the host stores them verbatim (the same shape
  // `PersonalEnvironment.exec` validates on write).
  exec: z.object({
    shell: z.array(z.string().min(1)).min(1).max(8),
    env: z.record(z.string(), z.string()),
    maxTimeoutMs: z.number().int().min(1).max(3_600_000),
    stdoutLimit: z.number().int().min(1).max(16 * 1024 * 1024),
    stderrLimit: z.number().int().min(1).max(16 * 1024 * 1024),
    terminateGraceMs: z.number().int().min(0).max(60_000),
  }).strict().optional(),
  transfer: z.object({
    maxBytes: z.number().int().min(1), timeoutMs: z.number().int().min(1),
  }).optional(),
})

const requestSchemas = {
  sshState: z.object({ sessionId }).strict(),
  sshCredentialGenerate: z.object({ sessionId, label }).strict(),
  sshCredentialImport: z.object({ sessionId, label, privateKey: z.string().min(1).max(32_768), passphrase: z.string().max(1024).optional() }).strict(),
  sshCredentialPassword: z.object({ sessionId, label, password: z.string().min(1).max(4096) }).strict(),
  sshCredentialRemove: z.object({ sessionId, id: z.string().min(1) }).strict(),
  sshHostKeyScan: z.object({ sessionId, hostname: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) }).strict(),
  sshEnvironmentSave: z.object({
    sessionId, revision, environment: environmentDraftSchema,
    hostKeyToken: z.string().min(1).optional(), fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/),
  }).strict(),
  sshEnvironmentRemove: z.object({ sessionId, revision, environmentId }).strict(),
  sshEnvironmentTest: z.object({ sessionId, environmentId }).strict(),
  sshHelperInstall: z.object({ sessionId, revision, environmentId, nodePath: z.string().min(1).optional() }).strict(),
  sshAccessKeyInstall: z.object({ sessionId, revision, environmentId }).strict(),
  sshBindingSave: z.object({
    sessionId, revision,
    binding: z.object({
      environmentId,
      rootId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      path: z.string().min(1).max(4096),
      actions: z.array(z.enum(['read', 'write', 'exec'])).min(1),
      transfers: z.array(z.object({
        direction: z.enum(['import', 'export']),
        peer: z.object({ environmentId: z.literal('local'), rootId: z.string() }),
      })).optional(),
    }).strict(),
  }).strict(),
  sshBindingRemove: z.object({ sessionId, revision, environmentId, rootId: z.string().min(1) }).strict(),
  sshConfigLink: z.object({ sessionId }).strict(),
} as const

export type SshCall = { [E in SshEndpoint]: { endpoint: E } & z.infer<(typeof requestSchemas)[E]> }[SshEndpoint]

/** One parsed request, mirroring the worktree contract's vocabulary. */
export type SshParsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * Validate one personal endpoint's payload.
 * @param endpoint - the endpoint name.
 * @param payload - the raw channel payload.
 * @returns the request, or the reason it is not one.
 */
export function parseSshCall(endpoint: SshEndpoint, payload: unknown): SshParsed<SshCall> {
  const schema = requestSchemas[endpoint]
  const parsed = schema.safeParse(payload ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `the ${endpoint} request is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return { ok: true, value: { endpoint, ...(parsed.data as Record<string, unknown>) } as SshCall }
}

/** What the panel sees of one credential — never key or password bytes. */
export interface CredentialPublicView {
  readonly id: string
  readonly label: string
  readonly kind: 'key' | 'password'
  readonly publicKey?: string | undefined
  readonly fingerprint?: string | undefined
  readonly createdAt: string
  /** Set on auto-generated per-environment access keys; the UI groups them. */
  readonly purpose?: 'access-key' | undefined
  readonly environmentId?: string | undefined
}

/** What the panel sees of one personal environment (mirrors the file shape). */
export interface SshEnvironmentView {
  readonly environmentId: string
  readonly displayName?: string | undefined
  readonly platform: 'linux' | 'darwin'
  readonly endpoint: { readonly hostname: string; readonly port: number; readonly user: string }
  readonly credential:
    | { readonly kind: 'ssh-config'; readonly alias: string }
    | { readonly kind: 'managed'; readonly credentialId: string; readonly accessKeyId?: string | undefined }
  readonly hostKey: string
  readonly helper: {
    readonly nodePath: string
    readonly helperPath: string
    readonly sha256: string
    readonly protocol: number
  } | null
  readonly workspace: string
  readonly exec?: {
    readonly shell: readonly string[]
    readonly env: Record<string, string>
    readonly maxTimeoutMs: number
    readonly stdoutLimit: number
    readonly stderrLimit: number
    readonly terminateGraceMs: number
  } | undefined
  readonly transfer?: { readonly maxBytes: number; readonly timeoutMs: number } | undefined
}

/** What the panel sees of one personal binding for its primary. */
export interface SshBindingView {
  readonly environmentId: string
  readonly rootId: string
  readonly path: string
  readonly actions: readonly ('read' | 'write' | 'exec')[]
  readonly transfers?: readonly {
    readonly direction: 'import' | 'export'
    readonly peer: { readonly environmentId: string; readonly rootId: string }
  }[] | undefined
}

const environmentViewSchema = z.object({
  environmentId: z.string(),
  displayName: z.string().optional(),
  platform: z.enum(['linux', 'darwin']),
  endpoint: z.object({ hostname: z.string(), port: z.number().int(), user: z.string() }),
  credential: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ssh-config'), alias: z.string() }),
    z.object({ kind: z.literal('managed'), credentialId: z.string(), accessKeyId: z.string().optional() }),
  ]),
  hostKey: z.string(),
  helper: z.object({ nodePath: z.string(), helperPath: z.string(), sha256: z.string(), protocol: z.number() }).nullable(),
  workspace: z.string(),
  exec: z.object({
    shell: z.array(z.string()), env: z.record(z.string(), z.string()),
    maxTimeoutMs: z.number(), stdoutLimit: z.number(), stderrLimit: z.number(), terminateGraceMs: z.number(),
  }).optional(),
  transfer: z.object({ maxBytes: z.number(), timeoutMs: z.number() }).optional(),
})

const bindingViewSchema = z.object({
  environmentId: z.string(), rootId: z.string(), path: z.string(),
  actions: z.array(z.enum(['read', 'write', 'exec'])),
  transfers: z.array(z.object({
    direction: z.enum(['import', 'export']),
    peer: z.object({ environmentId: z.string(), rootId: z.string() }),
  })).optional(),
})

/** The personal-mode section state every mutation answers. */
export interface SshStateView {
  readonly mode: 'personal'
  readonly enabled: boolean
  /** Whether ~/.ssh/config includes the managed ssh_config. */
  readonly linked: boolean
  /** The personal config revision for CAS writes. */
  readonly revision: number
  readonly environments: readonly SshEnvironmentView[]
  readonly credentials: readonly CredentialPublicView[]
  /** Bindings for THIS session's primary root only. */
  readonly bindings: readonly SshBindingView[]
}

const sshStateSchema = z.object({
  mode: z.literal('personal'),
  enabled: z.boolean(),
  linked: z.boolean(),
  revision: z.number().int().min(0),
  environments: z.array(environmentViewSchema),
  credentials: z.array(z.object({
    id: z.string(), label: z.string(), kind: z.enum(['key', 'password']),
    publicKey: z.string().optional(), fingerprint: z.string().optional(), createdAt: z.string(),
    purpose: z.literal('access-key').optional(), environmentId: z.string().optional(),
  })),
  bindings: z.array(bindingViewSchema),
})

const hostKeySchema = z.object({ type: z.string(), fingerprint: z.string() })
const sshScanResultSchema = z.object({ token: z.string(), keys: z.array(hostKeySchema) })
const connectionTestSchema = z.object({
  platform: z.string(), nodePath: z.string().optional(), nodeVersion: z.string().optional(),
})

/**
 * Validate one endpoint answer when it arrives.
 * @param endpoint - the endpoint name.
 * @param value - the raw endpoint value.
 * @returns the answer, or the reason it is not one.
 */
export function parseSshAnswer(endpoint: SshEndpoint, value: unknown): SshParsed<unknown> {
  const schema = endpoint === 'sshHostKeyScan' ? sshScanResultSchema
    : endpoint === 'sshEnvironmentTest' ? connectionTestSchema
    : sshStateSchema
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `the ${endpoint} answer is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return { ok: true, value: parsed.data }
}
