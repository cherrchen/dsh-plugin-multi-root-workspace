/**
 * `remote_copy` as a staged pipeline: admission → bound local open → remote
 * preflight → EXCL staging + streamed verify → re-admission → hardlink publish
 * → staged cleanup (ADR-0034). Only direction local → remote(sftp); the other
 * directions are `direction-unsupported`. Every refusal before staging is a
 * clean `failed`; a lost connection after the publish was sent is `unknown`
 * and never retried.
 */
import { createHash, randomUUID } from 'node:crypto'
import { openSync, fstatSync, lstatSync, realpathSync, readSync, closeSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { SftpClient, SftpStatusError, SftpConnectionLost, P_WRITE, P_CREAT, P_EXCL, SSH_FX_NO_SUCH_FILE } from './sftp.ts'
import type { SshEnvironmentManager } from './ssh-environment.ts'
import type { RemoteEnvironment } from './manifest.ts'
import type { MultiRootRegistry } from '../registry.ts'
import type { RemoteOperationRequest, RemoteOperationSession } from './contract.ts'

const NAME = 'remote_copy'

export class RemoteCopyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteCopyError'
  }
}

export interface RemoteCopyRequest {
  readonly session: RemoteOperationSession
  readonly from: { readonly environmentId: 'local'; readonly rootId: string; readonly relativePath: string }
  readonly to: { readonly environmentId: string; readonly rootId: string; readonly relativePath: string }
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

export interface RemoteCopyDeps {
  readonly manager: SshEnvironmentManager
  /** Awaited between stages; test-only injection for revocation/mutation. */
  readonly onStage?: (stage: RemoteCopyStage) => void | Promise<void>
  /** Test-only: an injected SFTP client instead of the managed session. */
  readonly sftpFor?: (environment: RemoteEnvironment) => { client: SftpClient; generation: string } | undefined
  readonly generationFor?: (environmentId: string) => string
}

interface Admitted {
  readonly epoch: string
  readonly effectiveMode: string
  readonly operationId: string
  readonly toDisplayPath: string
  readonly toBindingDigest: string | null
  readonly toVerifiedTarget: string | null
}

const posixJoin = (parent: string, name: string) => `${parent.replace(/\/$/, '')}/${name}`

function checkRelativePath(relativePath: string, code: string): void {
  const bad = relativePath === '' || relativePath.startsWith('/') || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (bad) throw new RemoteCopyError(code, `relative path must be a normalized relative POSIX path with a filename: ${JSON.stringify(relativePath)}`)
}

async function admit(registry: MultiRootRegistry, request: RemoteCopyRequest, toolName: string, _signal: AbortSignal): Promise<Admitted> {
  const endpoints: RemoteOperationRequest['endpoints'] = [
    { environmentId: 'local', rootId: request.from.rootId },
    { environmentId: request.to.environmentId, rootId: request.to.rootId },
  ]
  return await registry.withRemoteOperation({ session: request.session, toolName, purpose: 'transfer', endpoints }, operation => {
    const to = operation.endpoints[1]
    if (to === undefined) throw new RemoteCopyError('invalid-arguments', 'the transfer admission returned no destination endpoint')
    return {
      epoch: operation.identity.authorityEpoch ?? 'none',
      effectiveMode: operation.identity.effectiveMode,
      operationId: operation.identity.operationId ?? randomUUID(),
      toDisplayPath: to.displayPath,
      toBindingDigest: to.bindingDigest,
      toVerifiedTarget: to.verifiedTarget === null ? null : `${to.verifiedTarget.kind}:${to.verifiedTarget.value}`,
    } satisfies Admitted
  })
}

/** The local source root: 'primary' or an `available` registered aliasId. */
function localRoot(registry: MultiRootRegistry, session: RemoteOperationSession, rootId: string): string {
  const primary = session.header.cwd
  if (rootId === 'primary') return primary
  const status = registry.list(primary).find(entry => entry.aliasId === rootId)
  if (status === undefined || status.state !== 'available') {
    throw new RemoteCopyError('local-root-unavailable', `local root "${rootId}" is not an available registered root of this primary`)
  }
  return status.path
}

interface BoundSource { readonly fd: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly path: string }

/** Open the source bound to a single verified inode; refusal leaves no fd open. */
function openSource(root: string, relativePath: string, maxBytes: number): BoundSource {
  const rootReal = realpathSync(root)
  const path = `${rootReal}/${relativePath}`
  const fd = openSync(path, constants.O_RDONLY | (constants as unknown as { O_NOFOLLOW: number }).O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    const seen = lstatSync(path)
    if (!opened.isFile()) throw new RemoteCopyError('source-not-regular', `${relativePath} is not a regular file`)
    if (opened.nlink !== 1) throw new RemoteCopyError('source-multilinked', `${relativePath} has ${opened.nlink} links`)
    if (opened.dev !== seen.dev || opened.ino !== seen.ino) throw new RemoteCopyError('source-escapes-root', `${relativePath} changed between open and stat`)
    const parentReal = realpathSync(dirname(path))
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}/`)) {
      throw new RemoteCopyError('source-escapes-root', `${relativePath} resolves outside the granted local root`)
    }
    if (opened.size > maxBytes) throw new RemoteCopyError('source-too-large', `${relativePath} is ${opened.size} bytes, limit is ${maxBytes}`)
    return { fd, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, path }
  } catch (error) { closeSync(fd); throw error }
}

/** Result factory — keeps every field truthful for the report. */
function result(status: RemoteCopyResult['status'], partial: Omit<RemoteCopyResult, 'status'>): RemoteCopyResult {
  return { status, ...partial }
}

/** `runRemoteCopy` — the staged local→remote(sftp) copy. */
export async function runRemoteCopy(
  registry: MultiRootRegistry, deps: RemoteCopyDeps, request: RemoteCopyRequest, toolName: string, signal: AbortSignal,
): Promise<RemoteCopyResult> {
  const fail = (code: string, stage: RemoteCopyStage, extra: Partial<RemoteCopyResult> = {}): RemoteCopyResult =>
    result('failed', { code, operationId: extra.operationId ?? 'none', from: `${request.from.rootId}:${request.from.relativePath}`, to: `${request.to.environmentId}/${request.to.rootId}:${request.to.relativePath}`, bytes: 0, sha256: '', stage, staging: 'none', ...extra })
  const stage = deps.onStage ?? (() => undefined)
  if (request.from.environmentId !== 'local') return fail('direction-unsupported', 'admission')
  try {
    checkRelativePath(request.from.relativePath, 'invalid-relative-path')
    checkRelativePath(request.to.relativePath, 'invalid-relative-path')
  } catch (error) { return fail((error as RemoteCopyError).code, 'admission') }

  // 1. Admission A — session policy, tool cap and the manifest import pairing.
  let prepared: Admitted
  try { prepared = await admit(registry, request, toolName, signal) }
  catch (error) { return fail((error as { code?: string }).code ?? 'admission-failed', 'admission') }
  const { operationId } = prepared
  const base = { operationId, from: `${request.from.rootId}:${request.from.relativePath}`, to: `${request.to.environmentId}/${request.to.rootId}:${request.to.relativePath}` }
  await stage('admission')

  const environment = deps.manager.deployment.environments.find(e => e.environmentId === request.to.environmentId)!
  if (environment.transfer === undefined) return result('failed', { ...base, code: 'transfer-unavailable', bytes: 0, sha256: '', stage: 'source', staging: 'none' })

  // 2. Bound local open — one inode, inside the granted root, under the cap.
  let source: BoundSource
  try { source = openSource(localRoot(registry, request.session, request.from.rootId), request.from.relativePath, environment.transfer.maxBytes) }
  catch (error) { return result('failed', { ...base, code: (error as RemoteCopyError).code ?? 'source-unreadable', bytes: 0, sha256: '', stage: 'source', staging: 'none' }) }
  await stage('source')

  const hash = createHash('sha256')
  let digest = ''
  const sha = () => { if (digest === '') digest = hash.digest('hex'); return digest }
  let bytes = 0
  let staging: RemoteCopyStaging = 'none'
  let client: SftpClient | undefined
  let generation = 'stale'
  if (deps.sftpFor !== undefined) {
    const injected = deps.sftpFor(environment)
    client = injected?.client; generation = injected?.generation ?? 'stale'
  } else {
    const opened = await deps.manager.openSftp(request.to.environmentId).catch(() => undefined)
    client = opened?.client; generation = opened?.generation ?? 'stale'
  }
  if (client === undefined) {
    closeSync(source.fd)
    return result('failed', { ...base, code: 'transfer-unavailable', bytes: 0, sha256: '', stage: 'preflight', staging: 'none' })
  }
  const generationNow = () => deps.generationFor?.(request.to.environmentId) ?? deps.manager.sftpGenerationOf(request.to.environmentId)
  const target = posixJoin(prepared.toDisplayPath, request.to.relativePath)
  const stagingPath = posixJoin(dirname(target), `.dsh-staging-${operationId}`)
  const removeStaging = async () => {
    if (generationNow() !== generation) { staging = 'residual'; return }
    await client.remove(stagingPath).then(() => { staging = 'removed' }, () => {})
  }
  try {
    // 3. Remote preflight — target must not exist; parent stays inside the binding.
    if (!dirname(target).startsWith(prepared.toDisplayPath.replace(/\/$/, ''))) {
      return result('failed', { ...base, code: 'target-escapes-root', bytes: 0, sha256: '', stage: 'preflight', staging: 'none' })
    }
    try { await client.lstat(target); return result('failed', { ...base, code: 'target-exists', bytes: 0, sha256: '', stage: 'preflight', staging: 'none' }) }
    catch (error) { if (!(error instanceof SftpStatusError && error.code === SSH_FX_NO_SUCH_FILE)) throw error }
    await stage('preflight')

    // 4. Staging — EXCL create, bounded stream, fsync, source re-check, readback.
    const handle = await client.open(stagingPath, P_WRITE | P_CREAT | P_EXCL, 0o600)
    staging = 'residual'
    try {
      const deadline = Date.now() + environment.transfer.timeoutMs
      for (let offset = 0;;) {
        if (signal.aborted) throw new RemoteCopyError('cancelled', 'transfer aborted')
        if (Date.now() > deadline) throw new RemoteCopyError('transfer-timeout', `staging exceeded ${environment.transfer.timeoutMs}ms`)
        const chunk = Buffer.alloc(32 * 1024)
        const read = readSync(source.fd, chunk, 0, chunk.length, offset)
        if (read === 0) break
        hash.update(chunk.subarray(0, read)); bytes += read
        await client.write(handle, offset, chunk.subarray(0, read))
        offset += read
      }
      await client.fsync(handle)
    } finally { await client.close(handle).catch(() => {}) }
    await stage('staging')
    const after = fstatSync(source.fd)
    if (bytes !== source.size || after.size !== source.size || after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs) {
      await removeStaging()
      return result('failed', { ...base, code: 'source-changed', bytes, sha256: sha(), stage: 'staging', staging })
    }

    const back = await client.open(stagingPath, 1)
    const verify = createHash('sha256')
    try { for (let offset = 0;;) { const data = await client.read(back, offset, 64 * 1024); if (data.length === 0) break; verify.update(data); offset += data.length } }
    finally { await client.close(back).catch(() => {}) }
    if (verify.digest('hex') !== sha()) {
      await removeStaging()
      return result('failed', { ...base, code: 'verify-mismatch', bytes, sha256: sha(), stage: 'verify', staging })
    }
    await stage('verify')

    // 5. Admission B — the identical admission; epoch, endpoint pin and SFTP
    //    generation must all still be the ones staging prepared under.
    const again = await admit(registry, request, toolName, signal).catch(() => undefined)
    if (again === undefined || again.epoch !== prepared.epoch || again.toBindingDigest !== prepared.toBindingDigest || again.toVerifiedTarget !== prepared.toVerifiedTarget || generationNow() !== generation) {
      await removeStaging()
      return result('cancelled', { ...base, code: 'admission-changed', bytes, sha256: sha(), stage: 'publish', staging })
    }

    // 6. Publish — hardlink is the no-replace primitive; a sent request that
    //    loses the connection reports unknown and is never replayed.
    try { await client.hardlink(stagingPath, target) }
    catch (error) {
      if (error instanceof SftpConnectionLost) {
        return result('unknown', { ...base, code: 'connection-lost', bytes, sha256: sha(), stage: 'publish', staging: 'unknown', reconcileId: operationId })
      }
      if (error instanceof SftpStatusError) {
        await removeStaging()
        return result('failed', { ...base, code: error.code === 4 ? 'target-exists' : 'publish-failed', bytes, sha256: sha(), stage: 'publish', staging })
      }
      throw error
    }

    // 7. Cleanup — only this operation's staging name, only while the same
    //    generation is alive; a removal failure never un-commits the copy.
    if (generationNow() === generation) await client.remove(stagingPath).then(() => { staging = 'removed' }, () => { staging = 'residual' })
    else staging = 'residual'
    await stage('cleanup')
    return result('committed', { ...base, bytes, sha256: sha(), stage: 'cleanup', staging })
  } catch (error) {
    if (error instanceof SftpConnectionLost) {
      return result('unknown', { ...base, code: 'connection-lost', bytes, sha256: sha(), stage: 'staging', staging, reconcileId: operationId })
    }
    if (staging === 'residual') await removeStaging()
    return result('failed', { ...base, code: (error as RemoteCopyError).code ?? 'transfer-failed', bytes, sha256: sha(), stage: 'staging', staging })
  } finally { try { closeSync(source.fd) } catch { /* already closed */ } }
}

/** Build the `remote_copy` tool registration — nothing registers it in any production path. */
export function remoteCopyTool(options: { registry: MultiRootRegistry; deps: RemoteCopyDeps }) {
  return {
    name: NAME,
    description: 'Copy one file from a local root into a registered remote SFTP environment (no overwrite).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: { rootId: { type: 'string' }, relativePath: { type: 'string' } }, required: ['rootId', 'relativePath'], additionalProperties: false },
        to: { type: 'object', properties: { environmentId: { type: 'string' }, rootId: { type: 'string' }, relativePath: { type: 'string' } }, required: ['environmentId', 'rootId', 'relativePath'], additionalProperties: false },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (copy: RemoteCopyResult) => [{ type: 'text', text: JSON.stringify(copy) }] },
    execute: async (args: unknown, exec: { agent?: { session?: RemoteOperationSession }; name: string; signal: AbortSignal }): Promise<RemoteCopyResult> => {
      const { from, to } = args as { from: { rootId: string; relativePath: string }; to: { environmentId: string; rootId: string; relativePath: string } }
      const session = exec.agent?.session
      if (session === undefined) return result('failed', { code: 'session-unavailable', operationId: 'none', from: `${from.rootId}:${from.relativePath}`, to: `${to.environmentId}/${to.rootId}:${to.relativePath}`, bytes: 0, sha256: '', stage: 'admission', staging: 'none' })
      return await runRemoteCopy(options.registry, options.deps, {
        session, from: { environmentId: 'local', ...from }, to,
      }, exec.name, exec.signal)
    },
  }
}
