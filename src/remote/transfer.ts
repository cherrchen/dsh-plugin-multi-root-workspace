/**
 * `remote_copy` as a staged pipeline: admission → bound source open → remote
 * preflight → EXCL staging + streamed verify → re-admission → no-replace publish
 * → staged cleanup (ADR-0034).
 *
 * Three directions exist, and each has its own endpoint pair:
 *
 * - `local → sftp`: the bound local source is streamed into the remote staging
 *   file.
 * - `sftp → local`: the remote source is streamed into the LOCAL binary write
 *   port (`local-sink.ts`), which only opens under a Registry-issued
 *   destination authority and publishes with a local no-replace link.
 * - `sftp → sftp`: the Host relays the bounded stream from the source staging
 *   read to the destination staging write; neither remote side ever receives
 *   the other's credentials.
 *
 * Every refusal before staging is a clean `failed`; a lost connection that may
 * have published is `unknown` and never replayed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { openMetadataRoot, type NativeHandle } from '../worktrees/native-io.ts'
import {
  SftpClient,
  SftpConnectionLost,
  SftpStatusError,
  P_READ,
  P_WRITE,
  P_CREAT,
  P_EXCL,
  SSH_FX_NO_SUCH_FILE,
  SSH_FX_FAILURE,
} from './sftp.ts'
import { environmentDigest, type RemoteEnvironment, type DeploymentManifest } from './manifest.ts'
import type { MultiRootRegistry } from '../registry.ts'
import { samePath } from '../roots.ts'
import type { AdmittedLocalRoot, AdmittedRemoteEndpoint, RemoteOperationRequest, RemoteOperationSession } from './contract.ts'
import {
  checkTransferRelativePath,
  LocalBinarySink,
  LocalTransferError,
  type LocalDestinationAuthority,
} from './local-sink.ts'

const NAME = 'remote_copy'
const CHUNK = 64 * 1024
const REGULAR_FILE = 0o100000

/** A transfer refusal with a stable code the result reports verbatim. */
export class RemoteCopyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteCopyError'
  }
}

/** One endpoint of a copy: `environmentId: 'local'` or a manifest environment. */
export interface RemoteCopyEndpoint {
  readonly environmentId: string
  readonly rootId: string
  readonly relativePath: string
}

export interface RemoteCopyRequest {
  readonly session: RemoteOperationSession
  readonly from: RemoteCopyEndpoint
  readonly to: RemoteCopyEndpoint
}

export type RemoteCopyStage = 'admission' | 'source' | 'preflight' | 'staging' | 'verify' | 'publish' | 'cleanup'
export type RemoteCopyStaging = 'none' | 'removed' | 'residual' | 'unknown'

export interface RemoteCopyResult {
  readonly status: 'committed' | 'failed' | 'cancelled' | 'partial' | 'unknown'
  readonly code?: string
  readonly operationId: string
  readonly from: string
  readonly to: string
  readonly bytes: number
  readonly sha256: string
  readonly stage: RemoteCopyStage
  readonly staging: RemoteCopyStaging
  readonly reconcileId?: string
}

/**
 * The connection manager a copy needs: the verified deployment plus the
 * managed SFTP sessions. Structural on purpose — the SSH stack implements it,
 * and a test composition can stand in without pretending to be the real one.
 */
export interface RemoteConnectionManager {
  readonly deployment: DeploymentManifest
  openSftp(environmentId: string, signal?: AbortSignal): Promise<{ client: SftpClient; generation: string }>
  sftpGenerationOf(environmentId: string): string
  openTransferSftp?(environmentId: string, signal: AbortSignal, expectedDigest?: string): Promise<{
    client: SftpClient; generation: string; live(): boolean; dispose(): Promise<void>
  }>
}

export interface RemoteCopyDeps {
  readonly manager: RemoteConnectionManager
  /** Awaited between stages; test-only injection for revocation/mutation. */
  readonly onStage?: (stage: RemoteCopyStage) => void | Promise<void>
  /** Test-only: an injected SFTP client instead of the managed session. */
  readonly sftpFor?: (environment: RemoteEnvironment) => { client: SftpClient; generation: string } | undefined
  readonly generationFor?: (environmentId: string) => string
}

interface Admitted {
  readonly epoch: string
  readonly authorizationFingerprint: string
  readonly effectiveMode: 'read-only' | 'workspace-write'
  readonly operationId: string
  readonly source: AdmittedRemoteEndpoint
  readonly destination: AdmittedRemoteEndpoint
}

interface CopyBudget {
  readonly maxBytes: number
  readonly timeoutMs: number
}

/** Grace for an interrupted wire request to answer before its shared session is broken. */
const PENDING_GRACE_MS = 1_000

/** One total I/O budget, plus a bounded, cancellation-independent cleanup window. */
class TransferIO {
  private readonly deadline: number
  private cleanupDeadline: number | undefined
  constructor(timeoutMs: number, private readonly signal: AbortSignal) { this.deadline = Date.now() + timeoutMs }

  async run<T>(action: () => Promise<T>, onInterrupt?: (reason: 'cancelled' | 'transfer-timeout') => void, cleanup = false): Promise<T> {
    if (cleanup) this.cleanupDeadline ??= Date.now() + 1_000
    const remaining = (cleanup ? this.cleanupDeadline! : this.deadline) - Date.now()
    const aborted = () => !cleanup && this.signal.aborted
    const failure = () => new RemoteCopyError(aborted() ? 'cancelled' : 'transfer-timeout', 'transfer I/O interrupted')
    if (aborted() || remaining <= 0) throw failure()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (body: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.signal.removeEventListener('abort', interrupt)
        body()
      }
      const interrupt = () => finish(() => {
        try { onInterrupt?.(aborted() ? 'cancelled' : 'transfer-timeout') } catch { /* failure still settles the operation */ }
        reject(failure())
      })
      const timer = setTimeout(interrupt, remaining)
      if (!cleanup) this.signal.addEventListener('abort', interrupt, { once: true })
      Promise.resolve().then(() => { if (settled) throw failure(); return action() }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
  }

  clients(client: SftpClient): { client: SftpClient; cleanupClient: SftpClient } {
    let broken = false
    const wrap = (cleanup: boolean) => new Proxy(client, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function' || key === 'dispose') return typeof value === 'function' ? value.bind(target) : value
        return async (...args: unknown[]) => {
          if (broken) throw new SftpConnectionLost('the interrupted SFTP generation cannot be reused')
          let interrupted: 'cancelled' | 'transfer-timeout' | undefined
          let started = false
          let pendingTimeout: ReturnType<typeof setTimeout> | undefined
          const invalidate = () => {
            broken = true
            try { target.dispose?.() } catch { /* the stale generation still cannot be reused */ }
          }
          try {
            return await this.run(async () => {
              started = true
              try {
                const answer: unknown = await Reflect.apply(value, target, args)
                if (interrupted !== undefined && key === 'open' && Buffer.isBuffer(answer)) {
                  void this.run(() => target.close(answer), invalidate, true).catch(() => {})
                }
                return answer
              } finally { clearTimeout(pendingTimeout) }
            }, reason => {
              interrupted = reason
              if (started) {
                // Abandon only this waiter. The unanswered wire request keeps
                // a bounded grace to answer: a late reply keeps the shared
                // session coherent, and only a still-pending request breaks
                // the generation. Cancellation keeps the request's own
                // remaining budget; a transfer whose budget already ran out
                // gets the short pending grace.
                pendingTimeout = setTimeout(invalidate, reason === 'cancelled'
                  ? Math.max(0, this.deadline - Date.now())
                  : PENDING_GRACE_MS)
                pendingTimeout.unref()
              }
            }, cleanup)
          } catch (error) {
            // CREATE or LINK may already have happened. Never report a clean
            // refusal, delete an unverified name, or retry publication.
            if (started && (broken || interrupted !== undefined) && (key === 'hardlink' || (key === 'open' && (Number(args[1]) & P_CREAT) !== 0))) {
              throw new SftpConnectionLost('the SFTP mutation acknowledgement was lost')
            }
            throw error
          }
        }
      },
    })
    return { client: wrap(false), cleanupClient: wrap(true) }
  }
}

/** SHA-256 + byte count; the digest is finalized lazily so failures can report it. */
class Digest {
  private readonly hash = createHash('sha256')
  private finalized: string | undefined
  bytes = 0

  update(chunk: Uint8Array): void {
    this.hash.update(chunk)
    this.bytes += chunk.length
  }

  get sha256(): string {
    if (this.finalized === undefined) this.finalized = this.hash.digest('hex')
    return this.finalized
  }
}

/** Which SFTP connection a loss came from, so the result can stay truthful. */
class EndpointLoss extends Error {
  constructor(readonly side: 'source' | 'destination', cause: SftpConnectionLost) {
    super(cause.message)
    this.name = 'EndpointLoss'
  }
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'transfer-failed'
}

const posixJoin = (parent: string, name: string) => `${parent.replace(/\/+$/, '')}/${name}`
const posixParent = (path: string) => {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/** Equal or descending, on POSIX segment semantics (both sides are absolute). */
const isPosixUnder = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root.replace(/\/+$/, '')}/`)

const isRegular = (permissions: number | undefined): boolean =>
  permissions !== undefined && (permissions & 0o170000) === REGULAR_FILE
const isDirectory = (permissions: number | undefined): boolean =>
  permissions !== undefined && (permissions & 0o170000) === 0o040000
const isSymlink = (permissions: number | undefined): boolean =>
  permissions !== undefined && (permissions & 0o170000) === 0o120000

export interface RemotePathProbe {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ permissions?: number; size?: number }>
}

export async function assertRemoteParent(client: RemotePathProbe, root: string, parent: string): Promise<void> {
  if (!isPosixUnder(parent, root)) {
    throw new RemoteCopyError('target-escapes-root', `${parent} leaves the granted remote root`)
  }
  const rootReal = await client.realpath(root)
  if (rootReal !== root) {
    throw new RemoteCopyError('root-redirected', `the granted remote root now resolves to "${rootReal}"`)
  }
  const parentReal = await client.realpath(parent)
  if (parentReal !== parent) {
    throw new RemoteCopyError('destination-symlinked', `the destination parent resolves to "${parentReal}"`)
  }
  const relative = parent === root ? '' : parent.slice(root.replace(/\/+$/, '').length + 1)
  const chain = [root.replace(/\/+$/, '') || '/']
  for (const segment of relative === '' ? [] : relative.split('/')) {
    chain.push(posixJoin(chain[chain.length - 1]!, segment))
  }
  for (const entry of chain) {
    const attrs = await client.lstat(entry).catch((error: unknown) => {
      if (error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE) {
        throw new RemoteCopyError('destination-parent-missing', `${entry} does not exist`)
      }
      throw error
    })
    if (isSymlink(attrs.permissions)) throw new RemoteCopyError('destination-symlinked', `${entry} is a symlink`)
    if (!isDirectory(attrs.permissions)) throw new RemoteCopyError('destination-parent-not-directory', `${entry} is not a directory`)
  }
}

async function assertRemoteStaging(client: RemotePathProbe, path: string, written: number, expectedBytes: number): Promise<void> {
  const [attrs, real] = await Promise.all([client.lstat(path), client.realpath(path)])
  if (real !== path || !isRegular(attrs.permissions) || attrs.size !== written || attrs.size !== expectedBytes) {
    throw new RemoteCopyError('staging-changed', `the remote staging object ${path} changed`)
  }
}

/** Result factory — every field stays truthful for the report. */
function result(status: RemoteCopyResult['status'], partial: Omit<RemoteCopyResult, 'status'>): RemoteCopyResult {
  return { status, ...partial }
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                   */
/* -------------------------------------------------------------------------- */

function snapshotEndpoint(endpoint: AdmittedRemoteEndpoint): AdmittedRemoteEndpoint {
  return {
    environmentId: endpoint.environmentId,
    rootId: endpoint.rootId,
    displayPath: endpoint.displayPath,
    bindingDigest: endpoint.bindingDigest,
    environmentDigest: endpoint.environmentDigest,
    verifiedTarget: endpoint.verifiedTarget === null ? null : { ...endpoint.verifiedTarget },
    configVersion: endpoint.configVersion,
    localRoot: endpoint.localRoot === null || endpoint.localRoot === undefined ? null : { ...endpoint.localRoot },
  }
}

function sameEndpoint(left: AdmittedRemoteEndpoint, right: AdmittedRemoteEndpoint): boolean {
  return left.environmentId === right.environmentId
    && left.rootId === right.rootId
    && left.displayPath === right.displayPath
    && left.bindingDigest === right.bindingDigest
    && left.configVersion === right.configVersion
    && (left.verifiedTarget === null ? right.verifiedTarget === null : right.verifiedTarget !== null
      && left.verifiedTarget.kind === right.verifiedTarget.kind && left.verifiedTarget.value === right.verifiedTarget.value)
    && (left.localRoot === null || left.localRoot === undefined
      ? right.localRoot === null || right.localRoot === undefined
      : right.localRoot !== null && right.localRoot !== undefined
        && left.localRoot.rootId === right.localRoot.rootId && left.localRoot.path === right.localRoot.path && left.localRoot.access === right.localRoot.access
        && left.localRoot.incarnation === right.localRoot.incarnation)
}

function sameAdmission(left: Admitted, right: Admitted): boolean {
  return right.epoch === left.epoch
    && right.authorizationFingerprint === left.authorizationFingerprint
    && right.effectiveMode === left.effectiveMode
    && sameEndpoint(left.source, right.source)
    && sameEndpoint(left.destination, right.destination)
}

async function admit(registry: MultiRootRegistry, request: RemoteCopyRequest, toolName: string): Promise<Admitted> {
  const endpoints: RemoteOperationRequest['endpoints'] = [
    { environmentId: request.from.environmentId, rootId: request.from.rootId },
    { environmentId: request.to.environmentId, rootId: request.to.rootId },
  ]
  return await registry.withRemoteOperation({ session: request.session, toolName, purpose: 'transfer', endpoints }, operation => {
    const [source, destination] = operation.endpoints
    if (source === undefined || destination === undefined) {
      throw new RemoteCopyError('invalid-arguments', 'the transfer admission returned fewer than two endpoints')
    }
    return {
      epoch: operation.identity.authorityEpoch ?? 'none',
      authorizationFingerprint: operation.identity.authorizationFingerprint,
      effectiveMode: operation.identity.effectiveMode,
      operationId: operation.identity.operationId ?? randomUUID(),
      source: snapshotEndpoint(source),
      destination: snapshotEndpoint(destination),
    } satisfies Admitted
  })
}

/* -------------------------------------------------------------------------- */
/* Environment and connection helpers                                          */
/* -------------------------------------------------------------------------- */

function environmentOf(manager: RemoteConnectionManager, environmentId: string): RemoteEnvironment {
  const environment = manager.deployment.environments.find(entry => entry.environmentId === environmentId)
  if (environment === undefined) throw new RemoteCopyError('unknown-environment', `no environment "${environmentId}" is deployed`)
  // The transfer adapter is the environment's SFTP subsystem, independent of
  // how execution reaches it: a helper environment with a `transfer` block
  // serves copies through SFTP (G5's build machine).
  if (environment.transfer === undefined) throw new RemoteCopyError('transfer-unavailable', `environment "${environmentId}" declares no transfer block`)
  return environment
}

function budgetFor(...environments: readonly (RemoteEnvironment | undefined)[]): CopyBudget {
  const blocks = environments.filter((environment): environment is RemoteEnvironment => environment !== undefined).map(environment => environment.transfer!)
  if (blocks.length === 0) throw new RemoteCopyError('transfer-unavailable', 'a transfer requires at least one remote endpoint')
  return {
    maxBytes: Math.min(...blocks.map(block => block.maxBytes)),
    timeoutMs: Math.min(...blocks.map(block => block.timeoutMs)),
  }
}

interface RemoteEndpoint {
  readonly environmentId: string
  readonly root: string
  readonly client: SftpClient
  readonly cleanupClient: SftpClient
  readonly generation: string
  generationNow(): string
}

async function openSftpEndpoint(ctx: CopyContext, environment: RemoteEnvironment, admission: AdmittedRemoteEndpoint): Promise<RemoteEndpoint> {
  const { deps, io } = ctx
  let client: SftpClient | undefined
  let generation = 'stale'
  let owned: { live(): boolean; dispose(): Promise<void> } | undefined
  if (deps.sftpFor !== undefined) {
    const injected = deps.sftpFor(environment)
    client = injected?.client
    generation = injected?.generation ?? 'stale'
  } else {
    const openingSignal = new AbortController()
    const opened = await io.run(
      async () => {
        const live = environmentOf(deps.manager, environment.environmentId)
        if (environmentDigest(live) !== admission.environmentDigest) {
          throw new RemoteCopyError('admission-changed', 'the transfer environment changed before opening SFTP')
        }
        if (deps.manager.openTransferSftp === undefined) return await deps.manager.openSftp(environment.environmentId, openingSignal.signal)
        const endpoint = await deps.manager.openTransferSftp(environment.environmentId, openingSignal.signal, admission.environmentDigest ?? undefined)
        if (openingSignal.signal.aborted) {
          await endpoint.dispose()
          openingSignal.signal.throwIfAborted()
        }
        owned = endpoint
        ctx.disposeEndpoints.push(() => endpoint.dispose())
        return endpoint
      },
      () => openingSignal.abort(),
    ).catch((error: unknown) => {
      throw new RemoteCopyError(codeOf(error), `cannot open the SFTP session for "${environment.environmentId}": ${error instanceof Error ? error.message : String(error)}`)
    })
    client = opened.client
    generation = opened.generation
  }
  if (client === undefined) throw new RemoteCopyError('transfer-unavailable', `no SFTP session is available for "${environment.environmentId}"`)
  return {
    environmentId: environment.environmentId,
    root: admission.displayPath,
    ...io.clients(client),
    generation,
    generationNow: () => owned !== undefined ? (owned.live() ? generation : 'stale')
      : deps.generationFor?.(environment.environmentId) ?? deps.manager.sftpGenerationOf(environment.environmentId),
  }
}

/* -------------------------------------------------------------------------- */
/* Local source (read side of local → remote)                                  */
/* -------------------------------------------------------------------------- */

interface BoundLocalSource {
  readonly handle: NativeHandle
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/**
 * The local source root: `primary` or an `available` registered aliasId. The
 * owner-admitted record carries the grant — a follower never reads a local
 * endpoint off its stale projection alone; the projection must still agree.
 */
function localRoot(registry: MultiRootRegistry, session: RemoteOperationSession, rootId: string, admitted: AdmittedLocalRoot | null | undefined): string {
  const primary = session.header.cwd
  if (rootId === 'primary') return admitted?.path ?? primary
  const status = registry.list(primary).find(entry => entry.aliasId === rootId)
  if (status === undefined || status.state !== 'available') {
    throw new RemoteCopyError('local-root-unavailable', `local root "${rootId}" is not an available registered root of this primary`)
  }
  if (admitted === undefined || admitted === null) {
    if (registry.authority?.kind === 'follower') {
      throw new RemoteCopyError('local-authority-unavailable', 'a follower reads a local source only against the owner-admitted record')
    }
    return status.path
  }
  if (admitted.rootId !== rootId || !samePath(admitted.path, status.path) || admitted.access !== status.access || admitted.incarnation !== status.id) {
    throw new RemoteCopyError('admission-changed', `the admitted local root "${rootId}" does not match this host's projection`)
  }
  return admitted.path
}

/** Walk from a pinned directory handle, refusing symlinks at every component. */
function openLocalSource(root: string, relativePath: string, maxBytes: number, registered: boolean): BoundLocalSource {
  if (process.platform === 'win32') throw new RemoteCopyError('local-platform-unsupported', 'local transfer requires POSIX directory handles')
  let rootReal: string
  try { rootReal = realpathSync(root) } catch {
    throw new RemoteCopyError('local-root-unavailable', 'the granted local root is unavailable')
  }
  if (registered && !samePath(rootReal, root)) {
    throw new RemoteCopyError('local-root-redirected', 'the granted local root changed')
  }
  const handles: NativeHandle[] = []
  const descend = (segments: readonly string[]): NativeHandle => {
    for (const name of segments) handles.push(handles.at(-1)!.directory().child(name))
    return handles.at(-1)!
  }
  try {
    handles.push(openMetadataRoot('/'))
    const rootHandle = descend(rootReal.split('/').filter(Boolean))
    if (rootHandle.info().kind !== 'directory' || !samePath(rootHandle.canonical(), rootReal)) {
      throw new RemoteCopyError('local-root-redirected', 'the granted local root changed during open')
    }
    const handle = descend(relativePath.split('/'))
    if (handle.info().kind !== 'file') throw new RemoteCopyError('source-not-regular', 'the local source is not a regular file')
    if (!samePath(handle.canonical(), join(rootReal, relativePath))) {
      throw new RemoteCopyError('source-escapes-root', 'the local source moved during open')
    }
    const { size, nlink, mtimeMs, ctimeMs } = handle.posixFileState!()
    if (nlink !== 1) throw new RemoteCopyError('source-multilinked', 'the local source has multiple links')
    if (size > maxBytes) throw new RemoteCopyError('source-too-large', 'the local source exceeds the transfer budget')
    handles.pop()
    return { handle, size, mtimeMs, ctimeMs }
  } finally {
    for (const handle of handles.reverse()) handle.close()
  }
}

/* -------------------------------------------------------------------------- */
/* Remote source (read side of sftp → local and sftp → sftp)                   */
/* -------------------------------------------------------------------------- */

/** One bound remote source object: regular, inside the granted path, size-capped. */
class RemoteSource {
  private constructor(
    readonly endpoint: RemoteEndpoint,
    readonly target: string,
    readonly handle: Buffer,
    readonly size: number,
    readonly mtime: number | undefined,
  ) {}

  static async bind(endpoint: RemoteEndpoint, relativePath: string, maxBytes: number): Promise<RemoteSource> {
    const target = posixJoin(endpoint.root, relativePath)
    const parent = posixParent(target)
    if (!isPosixUnder(parent, endpoint.root)) throw new RemoteCopyError('source-escapes-root', `${relativePath} leaves the granted remote root`)
    let parentReal: string
    try { parentReal = await endpoint.client.realpath(parent) } catch (error) {
      throw new RemoteCopyError(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE ? 'source-unreadable' : 'source-open-failed', `cannot resolve the parent of ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (parentReal !== parent) throw new RemoteCopyError('source-symlinked', `a parent of ${relativePath} resolves to "${parentReal}"`)
    let targetReal: string
    try { targetReal = await endpoint.client.realpath(target) } catch (error) {
      throw new RemoteCopyError(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE ? 'source-unreadable' : 'source-open-failed', `cannot resolve ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (targetReal !== target) throw new RemoteCopyError('source-symlinked', `${relativePath} resolves to "${targetReal}"`)
    const before = await endpoint.client.lstat(target).catch((error: unknown) => {
      throw new RemoteCopyError(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE ? 'source-unreadable' : 'source-open-failed', `cannot stat ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!isRegular(before.permissions)) throw new RemoteCopyError('source-not-regular', `${relativePath} is not a regular file`)
    const size = before.size ?? 0
    if (size > maxBytes) throw new RemoteCopyError('source-too-large', `${relativePath} is ${size} bytes, limit is ${maxBytes}`)
    const handle = await endpoint.client.open(target, P_READ).catch((error: unknown) => {
      throw new RemoteCopyError('source-open-failed', `cannot open ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    })
    try {
      // Re-stat after open: the opened object must still be the observed one.
      const after = await endpoint.client.lstat(target)
      if (!isRegular(after.permissions) || after.size !== before.size || after.mtime !== before.mtime) {
        throw new RemoteCopyError('source-changed', `${relativePath} changed between stat and open`)
      }
      return new RemoteSource(endpoint, target, handle, size, before.mtime)
    } catch (error) {
      await endpoint.cleanupClient.close(handle).catch(() => {})
      throw error
    }
  }

  async read(offset: number): Promise<Buffer> {
    return await this.endpoint.client.read(this.handle, offset, CHUNK)
  }

  /**
   * The source object must still be the same regular file at the same
   * canonical location after the whole stream was read. The second realpath
   * pass catches a parent directory that was replaced with a symlink after the
   * source was bound; the attrs catch content/version drift.
   */
  async assertStable(bytes: number): Promise<void> {
    const parent = posixParent(this.target)
    const [parentReal, targetReal, after] = await Promise.all([
      this.endpoint.client.realpath(parent).catch(() => undefined),
      this.endpoint.client.realpath(this.target).catch(() => undefined),
      this.endpoint.client.lstat(this.target).catch(() => undefined),
    ])
    if (parentReal !== parent || targetReal !== this.target || after === undefined
      || !isRegular(after.permissions) || after.size !== this.size || after.mtime !== this.mtime || bytes !== this.size) {
      throw new RemoteCopyError('source-changed', `${this.target} changed while it was being read`)
    }
  }

  async close(): Promise<void> { await this.endpoint.cleanupClient.close(this.handle).catch(() => {}) }
}

/* -------------------------------------------------------------------------- */
/* Remote destination staging                                                  */
/* -------------------------------------------------------------------------- */

/** One remote staging object; publication is the no-replace hardlink. */
class RemoteStage {
  private handle: Buffer | undefined
  private written = 0

  constructor(
    readonly endpoint: RemoteEndpoint,
    readonly target: string,
    readonly parent: string,
    readonly path: string,
    handle: Buffer,
  ) { this.handle = handle }

  /** Preflight the target and create this operation's EXCL staging name. */
  static async begin(endpoint: RemoteEndpoint, target: string, operationId: string): Promise<RemoteStage> {
    if (target.slice(target.lastIndexOf('/') + 1).startsWith('.dsh-staging-')) {
      throw new RemoteCopyError('reserved-name', `${target} uses the transfer staging prefix`)
    }
    const parent = posixParent(target)
    await assertRemoteParent(endpoint.client, endpoint.root, parent)
    try {
      await endpoint.client.lstat(target)
      throw new RemoteCopyError('target-exists', `${target} already exists`)
    } catch (error) {
      if (error instanceof RemoteCopyError) throw error
      if (!(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE)) throw error
    }
    const path = posixJoin(parent, `.dsh-staging-${operationId}`)
    let handle: Buffer
    try { handle = await endpoint.client.open(path, P_WRITE | P_CREAT | P_EXCL, 0o600) } catch (error) {
      if (error instanceof SftpConnectionLost) throw error
      throw new RemoteCopyError('staging-unavailable', `cannot create the remote staging object: ${error instanceof Error ? error.message : String(error)}`)
    }
    return new RemoteStage(endpoint, target, parent, path, handle)
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.handle === undefined) throw new RemoteCopyError('staging-closed', 'the remote staging handle is already closed')
    if (offset !== this.written) throw new RemoteCopyError('staging-changed', `non-contiguous staging write at offset ${offset}`)
    await this.endpoint.client.write(this.handle, offset, data)
    this.written += data.length
  }

  async finish(): Promise<void> {
    if (this.handle === undefined) throw new RemoteCopyError('staging-closed', 'the remote staging handle is already closed')
    await this.endpoint.client.fsync(this.handle)
    await this.closeHandle()
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) await this.endpoint.cleanupClient.close(handle).catch(() => {})
  }

  /** Read the staged bytes back from the server; never trusts the sender's hash. */
  async verify(expected: string, expectedBytes: number): Promise<boolean> {
    await assertRemoteParent(this.endpoint.client, this.endpoint.root, this.parent)
    await assertRemoteStaging(this.endpoint.client, this.path, this.written, expectedBytes)
    const handle = await this.endpoint.client.open(this.path, P_READ)
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for (let offset = 0; offset < expectedBytes;) {
        const data = await this.endpoint.client.read(handle, offset, Math.min(CHUNK, expectedBytes - offset))
        if (data.length === 0) break
        hash.update(data)
        bytes += data.length
        offset += data.length
      }
      if (bytes === expectedBytes && (await this.endpoint.client.read(handle, expectedBytes, 1)).length !== 0) {
        bytes = -1
      }
    } finally { await this.endpoint.cleanupClient.close(handle).catch(() => {}) }
    if (bytes === expectedBytes) {
      await assertRemoteParent(this.endpoint.client, this.endpoint.root, this.parent)
      await assertRemoteStaging(this.endpoint.client, this.path, this.written, expectedBytes)
    }
    return bytes === expectedBytes && hash.digest('hex') === expected
  }

  async checkPublishable(): Promise<void> {
    await assertRemoteParent(this.endpoint.client, this.endpoint.root, this.parent)
    try {
      await this.endpoint.client.lstat(this.target)
      throw new RemoteCopyError('target-exists', `${this.target} appeared before publication`)
    } catch (error) {
      if (error instanceof RemoteCopyError) throw error
      if (!(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE)) throw error
    }
    try { await assertRemoteStaging(this.endpoint.client, this.path, this.written, this.written) } catch (error) {
      if (error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE) {
        throw new RemoteCopyError('staging-changed', 'the remote staging name disappeared before publication')
      }
      throw error
    }
  }

  /**
   * Publish with the server-side hardlink and remove this operation's staging.
   * A connection loss propagates (`SftpConnectionLost`); the caller reports
   * `unknown` and never retries.
   */
  async publish(): Promise<'removed' | 'residual'> {
    await this.checkPublishable()
    try { await this.endpoint.client.hardlink(this.path, this.target) } catch (error) {
      if (error instanceof SftpConnectionLost) throw error
      if (error instanceof SftpStatusError) {
        if (error.code === SSH_FX_FAILURE) throw new RemoteCopyError('target-exists', `${this.target} appeared before publication`)
        throw new RemoteCopyError('publish-failed', `cannot publish ${this.target}: ${error.message}`)
      }
      throw error
    }
    return await this.cleanup()
  }

  /** Only this operation's exact name, only while the same SFTP generation lives. */
  async cleanup(): Promise<'removed' | 'residual'> {
    if (this.endpoint.generationNow() !== this.endpoint.generation) return 'residual'
    try { await assertRemoteParent(this.endpoint.cleanupClient, this.endpoint.root, this.parent) } catch { return 'residual' }
    try { await this.endpoint.cleanupClient.remove(this.path); return 'removed' } catch (error) {
      return error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE ? 'removed' : 'residual'
    }
  }

  async close(): Promise<void> { await this.closeHandle() }
}

/* -------------------------------------------------------------------------- */
/* Direction runners                                                           */
/* -------------------------------------------------------------------------- */

interface CopyContext {
  readonly disposeEndpoints: (() => Promise<void>)[]
  readonly registry: MultiRootRegistry
  readonly deps: RemoteCopyDeps
  readonly request: RemoteCopyRequest
  readonly toolName: string
  readonly signal: AbortSignal
  readonly io: TransferIO
  readonly prepared: Admitted
  readonly stage: (stage: RemoteCopyStage) => void | Promise<void>
  readonly fail: (code: string, stage: RemoteCopyStage, extra?: Partial<RemoteCopyResult>) => RemoteCopyResult
  readonly base: { readonly operationId: string; readonly from: string; readonly to: string }
}

async function copyLocalToRemote(ctx: CopyContext, destinationEnvironment: RemoteEnvironment): Promise<RemoteCopyResult> {
  const budget = budgetFor(destinationEnvironment)
  let source: BoundLocalSource
  try {
    const root = localRoot(ctx.registry, ctx.request.session, ctx.request.from.rootId, ctx.prepared.source.localRoot)
    source = openLocalSource(root, ctx.request.from.relativePath, budget.maxBytes, ctx.request.from.rootId !== 'primary' || ctx.prepared.source.localRoot !== null)
  }
  catch (error) { return ctx.fail(codeOf(error), 'source') }
  let endpoint: RemoteEndpoint | undefined
  try { endpoint = await openSftpEndpoint(ctx, destinationEnvironment, ctx.prepared.destination) }
  catch (error) { source.handle.close(); return ctx.fail(codeOf(error), 'preflight') }
  const digest = new Digest()
  const target = posixJoin(endpoint.root, ctx.request.to.relativePath)
  let staging: RemoteStage | undefined
  let stagingStatus: RemoteCopyStaging = 'none'
  let committed = false
  try {
    try { staging = await RemoteStage.begin(endpoint, target, ctx.prepared.operationId) }
    catch (error) { return ctx.fail(codeOf(error), 'preflight', error instanceof SftpConnectionLost ? { status: 'unknown', staging: 'unknown', reconcileId: ctx.prepared.operationId } : {}) }
    stagingStatus = 'residual'
    await ctx.stage('preflight')
    const deadline = Date.now() + budget.timeoutMs
    for (let offset = 0;;) {
      if (ctx.signal.aborted) throw new RemoteCopyError('cancelled', 'transfer aborted')
      if (Date.now() > deadline) throw new RemoteCopyError('transfer-timeout', `staging exceeded ${budget.timeoutMs}ms`)
      const chunk = Buffer.alloc(CHUNK)
      const read = source.handle.read(chunk, offset)
      if (read === 0) break
      digest.update(chunk.subarray(0, read))
      await staging.write(offset, chunk.subarray(0, read))
      offset += read
    }
    await staging.finish()
    await ctx.stage('staging')
    const after = source.handle.posixFileState!()
    if (digest.bytes !== source.size || after.size !== source.size || after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs) {
      stagingStatus = await staging.cleanup()
      return ctx.fail('source-changed', 'staging', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    if (!(await staging.verify(digest.sha256, digest.bytes))) {
      stagingStatus = await staging.cleanup()
      return ctx.fail('verify-mismatch', 'verify', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    await ctx.stage('verify')
    const again = await ctx.io.run(() => admit(ctx.registry, ctx.request, ctx.toolName)).catch(() => undefined)
    if (ctx.signal.aborted || again === undefined || !sameAdmission(ctx.prepared, again) || endpoint.generationNow() !== endpoint.generation) {
      stagingStatus = await staging.cleanup()
      return result('cancelled', { ...ctx.base, code: ctx.signal.aborted ? 'cancelled' : 'admission-changed', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: stagingStatus })
    }
    let published: 'removed' | 'residual'
    try { published = await staging.publish() } catch (error) {
      if (error instanceof SftpConnectionLost) {
        return result('unknown', { ...ctx.base, code: 'connection-lost', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: 'unknown', reconcileId: ctx.prepared.operationId })
      }
      stagingStatus = await staging.cleanup().catch(() => 'unknown' as RemoteCopyStaging)
      return ctx.fail(codeOf(error), 'publish', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    stagingStatus = published
    committed = true
    await ctx.stage('cleanup')
    return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
  } catch (error) {
    if (committed) return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
    if (error instanceof SftpConnectionLost) {
      return result('unknown', { ...ctx.base, code: 'connection-lost', bytes: digest.bytes, sha256: digest.sha256, stage: 'staging', staging: staging === undefined ? 'none' : stagingStatus, reconcileId: ctx.prepared.operationId })
    }
    if (staging !== undefined) stagingStatus = await staging.cleanup().catch(() => 'unknown' as RemoteCopyStaging)
    return ctx.fail(error instanceof RemoteCopyError ? error.code : 'transfer-failed', 'staging', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
  } finally {
    source.handle.close()
    await staging?.close()
  }
}

async function copyRemoteToLocal(ctx: CopyContext, sourceEnvironment: RemoteEnvironment): Promise<RemoteCopyResult> {
  const budget = budgetFor(sourceEnvironment)
  let authority: LocalDestinationAuthority
  try {
    authority = ctx.registry.localTransferDestination(
      ctx.request.session.header.cwd, ctx.request.to.rootId, ctx.prepared.effectiveMode, ctx.toolName,
      ctx.prepared.destination.localRoot,
    )
  } catch (error) { return ctx.fail(codeOf(error), 'admission') }
  let endpoint: RemoteEndpoint
  try { endpoint = await openSftpEndpoint(ctx, sourceEnvironment, ctx.prepared.source) }
  catch (error) { return ctx.fail(codeOf(error), 'preflight') }
  const digest = new Digest()
  let source: RemoteSource | undefined
  let sink: LocalBinarySink | undefined
  let stagingStatus: RemoteCopyStaging = 'none'
  let committed = false
  try {
    try { source = await RemoteSource.bind(endpoint, ctx.request.from.relativePath, budget.maxBytes) }
    catch (error) { return ctx.fail(codeOf(error), 'source') }
    await ctx.stage('source')
    try { sink = LocalBinarySink.open(authority, ctx.request.to.relativePath, ctx.prepared.operationId, budget.maxBytes) }
    catch (error) { return ctx.fail(codeOf(error), 'preflight', error instanceof SftpConnectionLost ? { status: 'unknown', staging: 'unknown', reconcileId: ctx.prepared.operationId } : {}) }
    stagingStatus = 'residual'
    await ctx.stage('preflight')
    const deadline = Date.now() + budget.timeoutMs
    for (let offset = 0;;) {
      if (ctx.signal.aborted) throw new RemoteCopyError('cancelled', 'transfer aborted')
      if (Date.now() > deadline) throw new RemoteCopyError('transfer-timeout', `staging exceeded ${budget.timeoutMs}ms`)
      let chunk: Buffer
      try { chunk = await source.read(offset) } catch (error) {
        if (error instanceof SftpConnectionLost) throw new EndpointLoss('source', error)
        throw error
      }
      if (chunk.length === 0) break
      digest.update(chunk)
      sink.write(chunk)
      offset += chunk.length
    }
    sink.finish()
    await ctx.stage('staging')
    try { await source.assertStable(digest.bytes) } catch (error) {
      if (error instanceof SftpConnectionLost) throw new EndpointLoss('source', error)
      throw error
    }
    if (!sink.verify(digest.sha256)) {
      stagingStatus = sink.cleanup()
      return ctx.fail('verify-mismatch', 'verify', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    await ctx.stage('verify')
    const again = await ctx.io.run(() => admit(ctx.registry, ctx.request, ctx.toolName)).catch(() => undefined)
    let authorityAgain: LocalDestinationAuthority | undefined
    try {
      authorityAgain = ctx.registry.localTransferDestination(
        ctx.request.session.header.cwd, ctx.request.to.rootId, ctx.prepared.effectiveMode, ctx.toolName,
        again?.destination.localRoot,
      )
    } catch { authorityAgain = undefined }
    if (ctx.signal.aborted || again === undefined || authorityAgain === undefined || !sameAdmission(ctx.prepared, again)
      || authorityAgain.root !== authority.root || endpoint.generationNow() !== endpoint.generation) {
      stagingStatus = sink.cleanup()
      return result('cancelled', { ...ctx.base, code: ctx.signal.aborted ? 'cancelled' : 'admission-changed', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: stagingStatus })
    }
    try { stagingStatus = sink.publish() } catch (error) {
      if (error instanceof LocalTransferError && error.code === 'publish-unverified') {
        return result('unknown', { ...ctx.base, code: 'publish-unverified', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: 'residual', reconcileId: ctx.prepared.operationId })
      }
      stagingStatus = sink.cleanup()
      return ctx.fail(codeOf(error), 'publish', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    committed = true
    await ctx.stage('cleanup')
    return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
  } catch (error) {
    if (committed) return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
    if (sink !== undefined) stagingStatus = sink.cleanup()
    const code = error instanceof EndpointLoss ? 'source-connection-lost' : codeOf(error)
    return ctx.fail(code, 'staging', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
  } finally {
    await source?.close()
    sink?.close()
  }
}

async function copyRemoteToRemote(ctx: CopyContext): Promise<RemoteCopyResult> {
  let sourceEnvironment: RemoteEnvironment
  let destinationEnvironment: RemoteEnvironment
  try {
    sourceEnvironment = environmentOf(ctx.deps.manager, ctx.request.from.environmentId)
    destinationEnvironment = environmentOf(ctx.deps.manager, ctx.request.to.environmentId)
  } catch (error) { return ctx.fail(codeOf(error), 'preflight') }
  const budget = budgetFor(sourceEnvironment, destinationEnvironment)
  let from: RemoteEndpoint
  let to: RemoteEndpoint
  try {
    from = await openSftpEndpoint(ctx, sourceEnvironment, ctx.prepared.source)
    to = await openSftpEndpoint(ctx, destinationEnvironment, ctx.prepared.destination)
  } catch (error) { return ctx.fail(codeOf(error), 'preflight') }
  const digest = new Digest()
  let source: RemoteSource | undefined
  let stage: RemoteStage | undefined
  let stagingStatus: RemoteCopyStaging = 'none'
  let committed = false
  const target = posixJoin(to.root, ctx.request.to.relativePath)
  try {
    try { source = await RemoteSource.bind(from, ctx.request.from.relativePath, budget.maxBytes) }
    catch (error) { return ctx.fail(codeOf(error), 'source') }
    await ctx.stage('source')
    try { stage = await RemoteStage.begin(to, target, ctx.prepared.operationId) }
    catch (error) { return ctx.fail(codeOf(error), 'preflight', error instanceof SftpConnectionLost ? { status: 'unknown', staging: 'unknown', reconcileId: ctx.prepared.operationId } : {}) }
    stagingStatus = 'residual'
    await ctx.stage('preflight')
    const deadline = Date.now() + budget.timeoutMs
    for (let offset = 0;;) {
      if (ctx.signal.aborted) throw new RemoteCopyError('cancelled', 'transfer aborted')
      if (Date.now() > deadline) throw new RemoteCopyError('transfer-timeout', `staging exceeded ${budget.timeoutMs}ms`)
      let chunk: Buffer
      try { chunk = await source.read(offset) } catch (error) {
        if (error instanceof SftpConnectionLost) throw new EndpointLoss('source', error)
        throw error
      }
      if (chunk.length === 0) break
      digest.update(chunk)
      try { await stage.write(offset, chunk) } catch (error) {
        if (error instanceof SftpConnectionLost) throw new EndpointLoss('destination', error)
        throw error
      }
      offset += chunk.length
    }
    try { await stage.finish() } catch (error) {
      if (error instanceof SftpConnectionLost) throw new EndpointLoss('destination', error)
      throw error
    }
    await ctx.stage('staging')
    try { await source.assertStable(digest.bytes) } catch (error) {
      if (error instanceof SftpConnectionLost) throw new EndpointLoss('source', error)
      throw error
    }
    let verified: boolean
    try { verified = await stage.verify(digest.sha256, digest.bytes) } catch (error) {
      if (error instanceof SftpConnectionLost) throw new EndpointLoss('destination', error)
      throw error
    }
    if (!verified) {
      stagingStatus = await stage.cleanup()
      return ctx.fail('verify-mismatch', 'verify', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    await ctx.stage('verify')
    const again = await ctx.io.run(() => admit(ctx.registry, ctx.request, ctx.toolName)).catch(() => undefined)
    if (ctx.signal.aborted || again === undefined || !sameAdmission(ctx.prepared, again)
      || from.generationNow() !== from.generation || to.generationNow() !== to.generation) {
      stagingStatus = await stage.cleanup()
      return result('cancelled', { ...ctx.base, code: ctx.signal.aborted ? 'cancelled' : 'admission-changed', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: stagingStatus })
    }
    try { stagingStatus = await stage.publish() } catch (error) {
      if (error instanceof SftpConnectionLost) {
        return result('unknown', { ...ctx.base, code: 'connection-lost', bytes: digest.bytes, sha256: digest.sha256, stage: 'publish', staging: 'unknown', reconcileId: ctx.prepared.operationId })
      }
      stagingStatus = await stage.cleanup().catch(() => 'unknown' as RemoteCopyStaging)
      return ctx.fail(codeOf(error), 'publish', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
    }
    committed = true
    await ctx.stage('cleanup')
    return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
  } catch (error) {
    if (committed) return result('committed', { ...ctx.base, bytes: digest.bytes, sha256: digest.sha256, stage: 'cleanup', staging: stagingStatus })
    if (error instanceof EndpointLoss && error.side === 'destination') {
      return result('unknown', { ...ctx.base, code: 'destination-connection-lost', bytes: digest.bytes, sha256: digest.sha256, stage: 'staging', staging: 'unknown', reconcileId: ctx.prepared.operationId })
    }
    if (stage !== undefined) stagingStatus = await stage.cleanup().catch(() => 'unknown' as RemoteCopyStaging)
    const code = error instanceof EndpointLoss ? 'source-connection-lost' : codeOf(error)
    return ctx.fail(code, 'staging', { bytes: digest.bytes, sha256: digest.sha256, staging: stagingStatus })
  } finally {
    await source?.close()
    await stage?.close()
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const endpointLabel = (endpoint: RemoteCopyEndpoint): string =>
  endpoint.environmentId === 'local' ? `${endpoint.rootId}:${endpoint.relativePath}` : `${endpoint.environmentId}/${endpoint.rootId}:${endpoint.relativePath}`

/** `runRemoteCopy` — the staged, direction-aware copy. */
export async function runRemoteCopy(
  registry: MultiRootRegistry, deps: RemoteCopyDeps, request: RemoteCopyRequest, toolName: string, signal: AbortSignal,
): Promise<RemoteCopyResult> {
  const budgets = deps.manager.deployment.environments
    .filter(env => env.environmentId === request.from.environmentId || env.environmentId === request.to.environmentId)
    .flatMap(env => env.transfer === undefined ? [] : [env.transfer.timeoutMs])
  const io = new TransferIO(budgets.length === 0 ? 60_000 : Math.min(...budgets), signal)
  const stage = async (name: RemoteCopyStage) => { await io.run(async () => { await deps.onStage?.(name) }) }
  let operationId = 'none'
  const base = () => ({ operationId, from: endpointLabel(request.from), to: endpointLabel(request.to) })
  const fail = (code: string, stageName: RemoteCopyStage, extra: Partial<RemoteCopyResult> = {}): RemoteCopyResult =>
    result('failed', { ...base(), code, bytes: 0, sha256: '', stage: stageName, staging: 'none', ...extra })
  if (signal.aborted) return fail('cancelled', 'admission')
  const sourceLocal = request.from.environmentId === 'local'
  const destinationLocal = request.to.environmentId === 'local'
  try {
    checkTransferRelativePath(request.from.relativePath)
    checkTransferRelativePath(request.to.relativePath)
  } catch (error) { return fail(codeOf(error), 'admission') }
  if (sourceLocal && destinationLocal) return fail('direction-unsupported', 'admission')

  let prepared: Admitted
  try { prepared = await io.run(() => admit(registry, request, toolName)) }
  catch (error) { return fail(codeOf(error), 'admission') }
  operationId = prepared.operationId
  try { await stage('admission') } catch (error) { return fail(codeOf(error), 'admission') }
  if (signal.aborted) return fail('cancelled', 'admission')
  const ctx: CopyContext = {
    registry, deps, request, toolName, signal, io, prepared, stage, fail, disposeEndpoints: [],
    base: { operationId, from: endpointLabel(request.from), to: endpointLabel(request.to) },
  }
  try {
    if (sourceLocal) {
      let destinationEnvironment: RemoteEnvironment
      try { destinationEnvironment = environmentOf(deps.manager, request.to.environmentId) }
      catch (error) { return fail(codeOf(error), 'admission') }
      return await copyLocalToRemote(ctx, destinationEnvironment)
    }
    if (destinationLocal) {
      let sourceEnvironment: RemoteEnvironment
      try { sourceEnvironment = environmentOf(deps.manager, request.from.environmentId) }
      catch (error) { return fail(codeOf(error), 'admission') }
      return await copyRemoteToLocal(ctx, sourceEnvironment)
    }
    return await copyRemoteToRemote(ctx)
  } finally {
    await Promise.allSettled(ctx.disposeEndpoints.map(dispose => dispose()))
  }
}

/** Build the `remote_copy` tool registration — the optional broker-attested remote tools row registers it. */
export function remoteCopyTool(options: { registry: MultiRootRegistry; deps: RemoteCopyDeps }) {
  const endpoint = (required: boolean) => ({
    type: 'object',
    properties: {
      environmentId: { type: 'string' },
      rootId: { type: 'string' },
      relativePath: { type: 'string' },
    },
    required: required ? ['environmentId', 'rootId', 'relativePath'] : ['rootId', 'relativePath'],
    additionalProperties: false,
  })
  return {
    name: NAME,
    description: 'Copy one file between a local root and a registered remote SFTP environment, or between two registered remote environments, without overwriting (remote runs relay through this Host).',
    parameters: {
      type: 'object',
      properties: { from: endpoint(false), to: endpoint(true) },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args: unknown, copy: RemoteCopyResult) => [{ type: 'text', text: JSON.stringify(copy) }] },
    execute: async (args: unknown, exec: { agent?: { session?: RemoteOperationSession }; name: string; signal: AbortSignal }): Promise<RemoteCopyResult> => {
      const { from, to } = args as { from: { environmentId?: string; rootId: string; relativePath: string }; to: { environmentId: string; rootId: string; relativePath: string } }
      const source = { environmentId: from.environmentId ?? 'local', rootId: from.rootId, relativePath: from.relativePath }
      const session = exec.agent?.session
      if (session === undefined) {
        return result('failed', {
          code: 'session-unavailable', operationId: 'none',
          from: endpointLabel(source), to: endpointLabel(to as RemoteCopyEndpoint),
          bytes: 0, sha256: '', stage: 'admission', staging: 'none',
        })
      }
      return await runRemoteCopy(options.registry, options.deps, { session, from: source, to }, exec.name, exec.signal)
    },
  }
}
