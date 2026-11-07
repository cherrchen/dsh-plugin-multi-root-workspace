/**
 * The deployment manifest: the deployment-side declaration of which remote
 * environments may bind which roots to which local primary. Parsed by the
 * Host at registry init straight off the filesystem — never through
 * `ctx.fs`/workspace paths — and only under protection checks, because the
 * Agent must not be able to widen this contract by writing a file.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, type Stats } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { isCanonicallyUnder, primaryKey } from '../roots.ts'

export class ManifestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

const connectionSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  nodePath: z.string().min(1).optional(),
  helperPath: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
}).strict()

const execSchema = z.object({
  shell: z.array(z.string().min(1)).min(1).max(8),
  env: z.record(z.string(), z.string()),
  maxTimeoutMs: z.number().int().min(1).max(3_600_000),
  stdoutLimit: z.number().int().min(1).max(16 * 1024 * 1024),
  stderrLimit: z.number().int().min(1).max(16 * 1024 * 1024),
  terminateGraceMs: z.number().int().min(0).max(60_000),
}).strict()

const environmentSchema = z.object({
  environmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  displayName: z.string().max(120).optional(),
  platform: z.string().min(1),
  account: z.string().min(1).max(64),
  hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  namespace: z.string().min(1).max(128),
  transport: z.enum(['helper', 'sftp']),
  helper: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), protocol: z.number().int().min(1) }).strict().nullable(),
  connection: connectionSchema,
  exec: execSchema.optional(),
  transfer: z.object({
    maxBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
    timeoutMs: z.number().int().min(1).max(3_600_000),
  }).strict().optional(),
  credentialIsolation: z.enum(['attested', 'unattested']),
}).strict()

const bindingSchema = z.object({
  primary: z.string().min(1),
  environmentId: z.string().min(1),
  rootId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  path: z.string().min(1).max(4096),
  actions: z.array(z.enum(['read', 'write', 'exec'])).min(1),
  transfers: z.array(z.object({
    direction: z.enum(['import', 'export']),
    peer: z.object({ environmentId: z.string().min(1), rootId: z.string().min(1) }).strict(),
  }).strict()).optional(),
}).strict()

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  configVersion: z.string().min(1).max(128),
  environments: z.array(environmentSchema),
  bindings: z.array(bindingSchema),
}).strict()

export type RemoteEnvironment = z.infer<typeof environmentSchema>
export type RemoteBinding = z.infer<typeof bindingSchema>
export type DeploymentManifest = z.infer<typeof manifestSchema>

/** Deterministic serialization: sorted object keys, array order preserved. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** sha256 of the parsed manifest's canonical JSON. */
export function manifestDigest(manifest: DeploymentManifest): string {
  return sha256hex(canonicalJson(manifest))
}

/** sha256 of `{environment, binding}` canonical JSON — what a grant is pinned to. */
export function bindingDigest(environment: RemoteEnvironment, binding: RemoteBinding): string {
  return sha256hex(canonicalJson({ environment, binding }))
}

/** The remote-path rule: POSIX absolute, normalized, bounded. */
function checkRemotePath(path: string): void {
  const bad = !path.startsWith('/') || path.includes('\0')
    || path.split('/').slice(1).some(segment => segment === '' || segment === '.' || segment === '..')
  if (bad) throw new ManifestError('invalid-manifest', `a binding path must be a normalized absolute POSIX path: ${JSON.stringify(path)}`)
}

/** Equal or nested under POSIX segment semantics. */
function pathNested(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Parse and semantically validate manifest text.
 * @param text - the raw file content.
 * @param manifestPath - used for messages only; protection lives in {@link loadDeploymentManifest}.
 * @returns the manifest plus the digest both Host sides must agree on.
 */
export function parseDeploymentManifest(text: string, manifestPath: string): { manifest: DeploymentManifest; digest: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new ManifestError('invalid-manifest', `${manifestPath}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = manifestSchema.safeParse(data)
  if (!parsed.success) {
    throw new ManifestError('invalid-manifest', `${manifestPath}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  const manifest = parsed.data
  const byId = new Map<string, RemoteEnvironment>()
  for (const environment of manifest.environments) {
    if (environment.platform === 'win32' || environment.platform === 'windows') {
      throw new ManifestError('windows-target-unsupported', `environment "${environment.environmentId}": Windows targets are unsupported in this gate`)
    }
    if (environment.platform !== 'linux' && environment.platform !== 'darwin') {
      throw new ManifestError('unsupported-platform', `environment "${environment.environmentId}": unsupported platform "${environment.platform}"`)
    }
    if ((environment.transport === 'helper') !== (environment.helper !== null)) {
      throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": helper is required exactly when transport is "helper"`)
    }
    const { nodePath, helperPath, workspace } = environment.connection
    if (environment.transport === 'helper') {
      if (nodePath === undefined || helperPath === undefined || workspace === undefined) {
        throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": helper transport requires connection.nodePath, connection.helperPath and connection.workspace`)
      }
      checkRemotePath(nodePath)
      checkRemotePath(helperPath)
      checkRemotePath(workspace)
      if (Object.keys(environment.exec?.env ?? {}).length > 64) {
        throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": exec.env carries more than 64 keys`)
      }
      if (environment.exec !== undefined && !environment.exec.shell[0]!.startsWith('/')) {
        throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": exec.shell[0] must be an absolute path`)
      }
    } else {
      if (nodePath !== undefined || helperPath !== undefined || workspace !== undefined) {
        throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": sftp transport allows only connection.host`)
      }
      if (environment.exec !== undefined) {
        throw new ManifestError('invalid-manifest', `environment "${environment.environmentId}": exec is only allowed for helper transport`)
      }
    }
    // A transfer is served by the SFTP subsystem over the environment's own
    // alias, so a helper environment may declare one too: the build machine
    // receives sources through SFTP and executes through the helper (G5).
    // `exec` stays helper-only, and a transfer still requires every SFTP
    // publish guarantee at open time (`openSftp`).
    if (byId.has(environment.environmentId)) throw new ManifestError('duplicate-environment', `duplicate environmentId "${environment.environmentId}"`)
    byId.set(environment.environmentId, environment)
  }
  const seen = new Set<string>()
  const byPrimary = new Map<string, RemoteBinding[]>()
  for (const binding of manifest.bindings) {
    if (!isAbsolute(binding.primary)) throw new ManifestError('invalid-manifest', `binding primary must be an absolute local path: ${JSON.stringify(binding.primary)}`)
    checkRemotePath(binding.path)
    const environment = byId.get(binding.environmentId)
    if (environment === undefined) throw new ManifestError('unknown-environment', `binding "${binding.rootId}" names unknown environment "${binding.environmentId}"`)
    const key = `${primaryKey(binding.primary)} ${binding.environmentId} ${binding.rootId}`
    if (seen.has(key)) throw new ManifestError('duplicate-binding', `duplicate binding ${key}`)
    seen.add(key)
    if (new Set(binding.actions).size !== binding.actions.length) {
      throw new ManifestError('invalid-manifest', `binding "${binding.rootId}" repeats an action`)
    }
    const primary = primaryKey(binding.primary)
    const list = byPrimary.get(primary) ?? []
    list.push(binding)
    byPrimary.set(primary, list)
  }
  for (const list of byPrimary.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const left = list[i]!, right = list[j]!
        if (byId.get(left.environmentId)!.namespace === byId.get(right.environmentId)!.namespace && pathNested(left.path, right.path)) {
          throw new ManifestError('alias-conflict', `bindings "${left.rootId}" and "${right.rootId}" share a namespace and overlap at "${left.path}" / "${right.path}"`)
        }
      }
    }
  }
  return { manifest, digest: manifestDigest(manifest) }
}

/** Both the file and its parent must be owned by us (or root) and not group/world-writable. */
function checkTrust(info: Stats, what: string): void {
  const uid = process.getuid!()
  if ((info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) {
    throw new ManifestError('manifest-untrusted', `the deployment manifest ${what} must be owned by the current user (or root) and not be group/world-writable`)
  }
}

/**
 * Read and validate the manifest under its protection checks: absolute path,
 * regular non-symlink file in a trusted directory, never inside a bound local
 * primary. Any failure is a `ManifestError` — the caller maps it to the
 * `config-invalid` remote state.
 */
export function loadDeploymentManifest(path: string): { manifest: DeploymentManifest; digest: string } {
  if (!isAbsolute(path)) throw new ManifestError('manifest-untrusted', `the deployment manifest path must be absolute: ${JSON.stringify(path)}`)
  if (typeof process.getuid !== 'function') throw new ManifestError('manifest-untrusted', 'deployment manifest protection checks require a POSIX host')
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    throw new ManifestError('manifest-unreadable', `cannot read the deployment manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new ManifestError('manifest-untrusted', 'the deployment manifest must be a regular file, not a symlink')
  checkTrust(info, 'file')
  const parent = lstatSync(dirname(path))
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new ManifestError('manifest-untrusted', 'the deployment manifest directory must not be a symlink')
  checkTrust(parent, 'directory')
  const { manifest, digest } = parseDeploymentManifest(readFileSync(path, 'utf8'), path)
  const canonical = canonicalPath(path)
  for (const binding of manifest.bindings) {
    if (isCanonicallyUnder(canonical, canonicalPath(binding.primary))) {
      throw new ManifestError('manifest-untrusted', 'the deployment manifest must not lie inside a bound local primary root')
    }
  }
  return { manifest, digest }
}
