/**
 * Personal custody (ADR-0041 §2): the user-owned remote-environment config.
 * The file carries the same environments/bindings facts as the deployment
 * manifest but lives under the user's storage root; `toDeploymentManifest`
 * converts it into the identical DeploymentManifest shape so admission,
 * records and remote-1 never fork. POSIX only.
 */
import { existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, type Stats, closeSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { isCanonicallyUnder } from '../../roots.ts'
import { bindingSchema, ManifestError, parseDeploymentManifest, type DeploymentManifest } from '../manifest.ts'

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
}).strict()

export const personalEnvironmentSchema = z.object({
  environmentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  displayName: z.string().max(120).optional(),
  platform: z.enum(['linux', 'darwin']),
  endpoint: z.object({
    hostname: hostName,
    port: z.number().int().min(1).max(65535).default(22),
    user: hostUser,
  }).strict(),
  credential: credentialSchema,
  hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  helper: helperSchema.nullable(),
  workspace: z.string().min(1).max(4096),
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

export const personalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  environments: z.array(personalEnvironmentSchema),
  bindings: z.array(bindingSchema),
}).strict()

export type PersonalEnvironment = z.infer<typeof personalEnvironmentSchema>
export type PersonalConfig = z.infer<typeof personalConfigSchema>

/** File stat identity for cheap change detection (ADR-0041 §2). */
export interface PersonalFileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

export function statIdentity(info: Stats): PersonalFileIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
}

export function sameIdentity(a: PersonalFileIdentity, b: PersonalFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

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
    hostKey: environment.hostKey,
    namespace: environment.environmentId,
    transport: environment.helper !== null ? 'helper' : 'sftp',
    helper: environment.helper === null ? null : { sha256: environment.helper.sha256, protocol: environment.helper.protocol },
    connection: environment.helper !== null
      ? { host: managedAlias(environment), nodePath: environment.helper.nodePath, helperPath: environment.helper.helperPath, workspace: environment.workspace }
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
  }), manifestPath)
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
  const parent = lstatSync(dirname(path))
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new ManifestError('manifest-untrusted', 'the personal config directory must be a real directory, not a symlink')
  }
  if (parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    throw new ManifestError('manifest-untrusted', 'the personal config directory must be owned by the current user and not group/other-writable')
  }
  const canonical = canonicalPath(path)
  for (const binding of bindings) {
    if (isCanonicallyUnder(canonical, canonicalPath(binding.primary))) {
      throw new ManifestError('manifest-untrusted', 'the personal config must not lie inside a bound local primary root')
    }
  }
}

export interface PersonalManifest {
  readonly manifest: DeploymentManifest
  readonly digest: string
  readonly revision: number
  readonly identity: PersonalFileIdentity
}

/**
 * Read the personal config itself (not the converted manifest). A MISSING
 * file is the empty config — the panel starts from a blank slate.
 */
export function loadPersonalConfig(path: string): PersonalConfig {
  if (!existsSync(path)) return { schemaVersion: 1, revision: 0, environments: [], bindings: [] }
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ManifestError('invalid-manifest', `${path}: not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = personalConfigSchema.safeParse(data)
  if (!parsed.success) {
    throw new ManifestError('invalid-manifest', `${path}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  checkPersonalFileProtection(path, parsed.data.bindings)
  return parsed.data
}

/**
 * Read the personal config and convert it to the shared manifest. A MISSING
 * file is not an error: it is the empty manifest — the plane proceeds.
 */
export function loadPersonalManifest(path: string): PersonalManifest {
  if (!existsSync(path)) {
    const empty = toDeploymentManifest({ schemaVersion: 1, revision: 0, environments: [], bindings: [] }, path)
    return { ...empty, revision: 0, identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0 } }
  }
  const text = readFileSync(path, 'utf8')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new ManifestError('invalid-manifest', `${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = personalConfigSchema.safeParse(data)
  if (!parsed.success) {
    throw new ManifestError('invalid-manifest', `${path}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  checkPersonalFileProtection(path, parsed.data.bindings)
  const { manifest, digest } = toDeploymentManifest(parsed.data, path)
  return { manifest, digest, revision: parsed.data.revision, identity: statIdentity(statSync(path)) }
}

/**
 * Compare-and-swap write: refuse `personal-config-conflict` when the on-disk
 * revision is not `expectedRevision`, then write temp-0600 → fsync → rename.
 */
export function savePersonalConfig(path: string, next: PersonalConfig, expectedRevision: number): PersonalManifest {
  if (existsSync(path)) {
    let current: unknown
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new ManifestError('personal-config-conflict', `the personal config is unreadable during the write: ${error instanceof Error ? error.message : String(error)}`)
    }
    const revision = (current as { revision?: unknown }).revision
    if (revision !== expectedRevision) {
      throw new ManifestError('personal-config-conflict', `the personal config revision changed (expected ${expectedRevision}, found ${String(revision)}); reload and retry`)
    }
  } else if (expectedRevision !== 0) {
    throw new ManifestError('personal-config-conflict', `the personal config was created concurrently (expected revision ${expectedRevision}); reload and retry`)
  }
  // Validate BEFORE writing: a config that fails the schema or the manifest
  // semantics must never land on disk (it would fail the whole plane).
  const checked = personalConfigSchema.safeParse(next)
  if (!checked.success) {
    throw new ManifestError('personal-config-invalid', `${path}: ${checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  try {
    toDeploymentManifest(checked.data, path)
  } catch (error) {
    throw new ManifestError('personal-config-invalid', `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${process.pid}`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  return loadPersonalManifest(path)
}
