/**
 * Personal custody (ADR-0049 §2): global SSH environments and Workspace
 * bindings have separate protected stores. Their snapshot feeds the shared
 * remote admission plane. POSIX only.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { isCanonicallyUnder } from '../../roots.ts'
import { bindingSchema, ManifestError, parseDeploymentManifest, type DeploymentManifest } from '../manifest.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from '../../registry-lease.ts'

const hostName = z.string().min(1).max(253).regex(/^\S+$/).refine(value => !value.startsWith('-'), 'hostname must not start with "-"')
const hostUser = z.string().min(1).max(64).regex(/^\S+$/).refine(value => !value.startsWith('-'), 'user must not start with "-"')
const aliasName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)

const credentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ssh-config'), alias: aliasName }).strict(),
  z.object({ kind: z.literal('managed'), credentialId: z.string().regex(/^[0-9a-f]{12}$/), accessKeyId: z.string().regex(/^[0-9a-f]{12}$/).optional() }).strict(),
])

const helperSchema = z.object({
  nodePath: z.string().min(1),
  helperPath: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  protocol: z.number().int().min(1),
  /** 1 = `helperPath` is `helper-entry.mjs`, which verifies the installed file set at launch. Absent on legacy installs. */
  integrity: z.literal(1).optional(),
}).strict()

export const personalEnvironmentSchema = z.object({
  environmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  displayName: z.string().max(120).optional(),
  identityId: z.string().uuid().optional(),
  platform: z.enum(['linux', 'darwin']),
  endpoint: z.object({
    hostname: hostName,
    port: z.number().int().min(1).max(65535).default(22),
    user: hostUser,
  }).strict(),
  credential: credentialSchema,
  hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  helper: helperSchema.nullable(),
  exec: z.object({
    shell: z.array(z.string().min(1)).min(1).max(8),
    env: z.record(z.string(), z.string()),
    maxTimeoutMs: z.number().int().min(1).max(3_600_000),
    stdoutLimit: z.number().int().min(1).max(16 * 1024 * 1024),
    stderrLimit: z.number().int().min(1).max(16 * 1024 * 1024),
    terminateGraceMs: z.number().int().min(0).max(60_000),
  }).strict().optional(),
  transfer: z.object({
    maxBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
    timeoutMs: z.number().int().min(1).max(3_600_000),
  }).strict().optional(),
}).strict()

const revisionSchema = z.number().int().min(0)
const environmentsSchema = z.object({
  schemaVersion: z.literal(2),
  revision: revisionSchema,
  environments: z.array(personalEnvironmentSchema),
}).strict()
const workspaceBindingsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  bindings: z.array(bindingSchema),
}).strict()
const legacyConfigSchema = workspaceBindingsSchema.extend({
  environments: z.array(personalEnvironmentSchema.extend({ workspace: z.string().min(1).max(4096) })),
})
const personalConfigSchema = environmentsSchema.extend({ bindings: z.array(bindingSchema) })

export type PersonalEnvironment = z.infer<typeof personalEnvironmentSchema>
export type PersonalConfig = z.infer<typeof personalConfigSchema>

/**
 * Convert the personal config into the shared manifest shape, then run the
 * SAME semantic validation the deployment manifest goes through.
 */
export function toDeploymentManifest(config: PersonalConfig, manifestPath: string): { manifest: DeploymentManifest; digest: string } {
  const environments = config.environments.map(environment => ({
    environmentId: environment.environmentId,
    ...(environment.displayName === undefined ? {} : { displayName: environment.displayName }),
    platform: environment.platform,
    account: environment.endpoint.user,
    personalIdentity: {
      hostname: environment.endpoint.hostname,
      port: environment.endpoint.port,
      credentialDigest: createHash('sha256').update(JSON.stringify([environment.identityId, environment.credential])).digest('hex'),
    },
    hostKey: environment.hostKey,
    namespace: environment.environmentId,
    transport: environment.helper !== null ? 'helper' : 'sftp',
    helper: environment.helper === null ? null : {
      sha256: environment.helper.sha256, protocol: environment.helper.protocol,
      ...(environment.helper.integrity === undefined ? {} : { integrity: environment.helper.integrity }),
    },
    connection: environment.helper !== null
      ? { host: managedAlias(environment), nodePath: environment.helper.nodePath, helperPath: environment.helper.helperPath }
      : { host: managedAlias(environment) },
    ...(environment.exec === undefined ? {} : { exec: environment.exec }),
    ...(environment.transfer === undefined ? {} : { transfer: environment.transfer }),
    credentialIsolation: 'unattested',
  }))
  return parseDeploymentManifest(JSON.stringify({
    schemaVersion: 1,
    configVersion: `personal-${config.revision}`,
    environments,
    bindings: config.bindings,
  }), manifestPath, { personal: true })
}

/** The alias the manifest connection carries for this environment. */
export function managedAlias(environment: PersonalEnvironment): string {
  return environment.credential.kind === 'ssh-config' ? environment.credential.alias : `dsh-${environment.environmentId}`
}

/**
 * Protection checks for the user-owned file (no read): absolute path,
 * regular non-symlink file owned by the current uid with mode bits 0600
 * semantics (no group/other access), a parent directory owned by the current
 * uid and not group/other-writable, and never inside a bound local primary.
 */
export function checkPersonalFileProtection(path: string, bindings: readonly { primary: string }[] = []): void {
  if (!isAbsolute(path)) throw new ManifestError('manifest-untrusted', `the personal config path must be absolute: ${JSON.stringify(path)}`)
  if (typeof process.getuid !== 'function') throw new ManifestError('manifest-untrusted', 'personal config protection checks require a POSIX host')
  const uid = process.getuid()
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    throw new ManifestError('manifest-unreadable', `cannot read the personal config: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new ManifestError('manifest-untrusted', 'the personal config must be a regular file, not a symlink')
  if (info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new ManifestError('manifest-untrusted', 'the personal config must be owned by the current user and not group/other-accessible')
  }
  checkPersonalDirectoryProtection(dirname(path))
  const canonical = canonicalPath(path)
  for (const binding of bindings) {
    if (isCanonicallyUnder(canonical, canonicalPath(binding.primary))) {
      throw new ManifestError('manifest-untrusted', 'the personal config must not lie inside a bound local primary root')
    }
  }
}

function checkPersonalDirectoryProtection(dir: string): void {
  const parent = lstatSync(dir)
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new ManifestError('manifest-untrusted', 'the personal config directory must be a real directory, not a symlink')
  }
  if (parent.uid !== process.getuid!() || (parent.mode & 0o022) !== 0) {
    throw new ManifestError('manifest-untrusted', 'the personal config directory must be owned by the current user and not group/other-writable')
  }
}

export interface PersonalManifest {
  readonly manifest: DeploymentManifest
  readonly digest: string
  readonly revision: number
  readonly identity: string
}

const bindingStorePath = (path: string): string => `${path}.bindings.json`

function filePresent(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function readProtected(path: string): string {
  checkPersonalFileProtection(path)
  return readFileSync(path, 'utf8')
}

function parseFile<T>(path: string, text: string, schema: z.ZodType<T>): T {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new ManifestError('invalid-manifest', `${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new ManifestError('invalid-manifest', `${path}: ${parsed.error.message}`)
  }
  return parsed.data
}

interface PersonalSnapshot {
  readonly config: PersonalConfig
  readonly identity: string
  readonly split: boolean
}

/** The v2 environment file is the migration commit point. A v1 reader ignores the prepared sidecar. */
/**
 * What makes one store file "the same" as last read: dev+ino+size+mtimeMs
 * covers content churn, and mode+uid cover the protection bits
 * `checkPersonalFileProtection` enforces — a chmod/chown or a symlink swap
 * must reload too. `null` when the path is absent.
 */
type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'mode' | 'uid'>

const statIdentity = (path: string): FileIdentity | null => {
  try {
    const info = lstatSync(path)
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, uid: info.uid }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

const sameIdentity = (left: FileIdentity | null, right: FileIdentity | null): boolean =>
  left === right || (left !== null && right !== null
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.uid === right.uid)

/**
 * `refreshRemotePersonal` re-reads this store on every remote operation. Skip
 * the read + parse while the stat identity of the env file and its bindings
 * sidecar is unchanged since the last successful read; a changed or missing
 * file still reloads immediately.
 */
const snapshotCache = new Map<string, { stats: readonly [FileIdentity | null, FileIdentity | null, FileIdentity | null]; snapshot: PersonalSnapshot }>()

function readSnapshot(path: string): PersonalSnapshot {
  // The parent dir is part of the identity: `checkPersonalDirectoryProtection`
  // reads its uid+mode on every full read, so a chmod/chown/symlink swap on
  // the directory must invalidate the cache just like a file change does.
  const stats: readonly [FileIdentity | null, FileIdentity | null, FileIdentity | null] =
    [statIdentity(path), statIdentity(bindingStorePath(path)), statIdentity(dirname(path))]
  const cached = snapshotCache.get(path)
  if (cached !== undefined && sameIdentity(cached.stats[0], stats[0]) && sameIdentity(cached.stats[1], stats[1])
    && sameIdentity(cached.stats[2], stats[2])) {
    return cached.snapshot
  }
  const snapshot = readSnapshotFull(path)
  snapshotCache.set(path, { stats, snapshot })
  return snapshot
}

function readSnapshotFull(path: string): PersonalSnapshot {
  if (!filePresent(path)) {
    return { config: { schemaVersion: 2, revision: 0, environments: [], bindings: [] }, identity: '', split: false }
  }
  const text = readProtected(path)
  const stored = parseFile(path, text, z.union([environmentsSchema, legacyConfigSchema]))
  if (stored.schemaVersion === 1) {
    const { revision, environments, bindings } = stored
    checkPersonalFileProtection(path, bindings)
    return {
      config: { schemaVersion: 2, revision, environments: environments.map(({ workspace: _workspace, ...environment }) => environment), bindings },
      identity: createHash('sha256').update(text).digest('hex'),
      split: false,
    }
  }

  const bindingsPath = bindingStorePath(path)
  const bindingsText = readProtected(bindingsPath)
  const { revision, bindings } = parseFile(bindingsPath, bindingsText, workspaceBindingsSchema)
  // A writer can change only one store at a time. If the environment file
  // changed around the binding read, no coherent revision was observed.
  if (readProtected(path) !== text) {
    throw new ManifestError('personal-config-conflict', 'the SSH environment store changed during the read; retry')
  }
  checkPersonalFileProtection(path, bindings)
  checkPersonalFileProtection(bindingsPath, bindings)
  return {
    config: { ...stored, revision: Math.max(stored.revision, revision), bindings },
    identity: createHash('sha256').update(JSON.stringify([text, bindingsText])).digest('hex'),
    split: true,
  }
}

export function loadPersonalConfig(path: string): PersonalConfig {
  return readSnapshot(path).config
}

/** Reuse the verified manifest when the bytes in both protected stores match. */
export function loadPersonalManifest(path: string, previous?: PersonalManifest): PersonalManifest {
  const { config, identity } = readSnapshot(path)
  if (previous?.identity === identity) return previous
  return { ...toDeploymentManifest(config, path), revision: config.revision, identity }
}

function writeProtected(path: string, data: unknown): void {
  const temp = `${path}.tmp-${randomUUID()}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Both stores share the revision check and kernel lease, including during migration. */
export async function savePersonalConfig(path: string, next: PersonalConfig, expectedRevision: number, beforeCommit?: () => void): Promise<PersonalManifest> {
  if (!isAbsolute(path)) throw new ManifestError('manifest-untrusted', `the personal config path must be absolute: ${JSON.stringify(path)}`)
  if (typeof process.getuid !== 'function') throw new ManifestError('manifest-untrusted', 'personal config protection checks require a POSIX host')
  const checked = personalConfigSchema.safeParse(next)
  if (!checked.success) throw new ManifestError('personal-config-invalid', `${path}: ${checked.error.message}`)
  try {
    toDeploymentManifest(checked.data, path)
  } catch (error) {
    throw new ManifestError('personal-config-invalid', `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  checkPersonalDirectoryProtection(dir)
  const canonicalDir = realpathSync(dir)
  const leasePath = join(canonicalDir, `${basename(path)}.lock`)
  let lease: RegistryAuthorityLease
  try {
    lease = await RegistryAuthorityLease.acquire(leasePath)
  } catch (error) {
    if (error instanceof RegistryLeaseContendedError) {
      throw new ManifestError('personal-config-conflict', 'the personal config is being written by another process; reload and retry')
    }
    throw error
  }
  try {
    const current = readSnapshot(path)
    if (current.config.revision !== expectedRevision) {
      throw new ManifestError('personal-config-conflict', `the personal config revision changed (expected ${expectedRevision}, found ${current.config.revision}); reload and retry`)
    }
    const { environments, bindings, revision } = checked.data
    const bindingsPath = bindingStorePath(path)
    for (const target of [path, bindingsPath]) {
      if (filePresent(target)) checkPersonalFileProtection(target, bindings)
      const canonical = join(canonicalDir, basename(target))
      if (bindings.some(binding => isCanonicallyUnder(canonical, canonicalPath(binding.primary)))) {
        throw new ManifestError('manifest-untrusted', 'the personal config must not lie inside a bound local primary root')
      }
    }

    const environmentsChanged = JSON.stringify(environments) !== JSON.stringify(current.config.environments)
    const bindingsChanged = JSON.stringify(bindings) !== JSON.stringify(current.config.bindings)
    if (current.split && environmentsChanged && bindingsChanged) {
      throw new ManifestError('personal-config-invalid', 'save SSH environments and Workspace bindings in separate operations')
    }
    if (current.split && (environmentsChanged || bindingsChanged) && revision <= expectedRevision) {
      throw new ManifestError('personal-config-conflict', 'a changed personal store requires a new revision')
    }
    beforeCommit?.()
    if (!current.split || bindingsChanged) writeProtected(bindingsPath, { schemaVersion: 1, revision, bindings })
    if (!current.split || !bindingsChanged) writeProtected(path, { schemaVersion: 2, revision, environments })
    return loadPersonalManifest(path)
  } finally {
    await lease.release()
  }
}
