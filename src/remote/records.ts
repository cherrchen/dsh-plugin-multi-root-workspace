/**
 * The durable remote-grant domain: a SEPARATE versioned store beside the v1
 * local registry, opened only by the lease owner of the same medium. Records
 * are strict — an `access`/`mode` or any unknown key is invalid — and no
 * connection, key, or admission handle is ever stored. Nothing here is ever
 * passed to `setAdditionalRoots`, the scope, dialects, instructions, or Skills.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { domainZod, type DomainValueSchema } from '../compat/storage-zod.ts'
import { primaryKey } from '../roots.ts'
import type { RemoteEndpointRef, RemoteGrant, RemoteGrantState } from './contract.ts'
import { bindingDigest, type DeploymentManifest, type RemoteBinding, type RemoteEnvironment } from './manifest.ts'

/** The remote domain name; also the store file stem. */
export const REMOTE_DOMAIN_NAME = 'multi_root_workspace_remote'
export const REMOTE_TABLE_NAME = 'grants'

/** Stored shape of one primary's remote registrations. */
export type PersistedRemoteGrants = { grants: RemoteGrant[] }

const z = domainZod()

const remoteGrant: DomainValueSchema<RemoteGrant> = z.strictObject({
  environmentId: z.string().min(1),
  rootId: z.string().min(1),
  displayPath: z.string().min(1),
  verifiedTarget: z.strictObject({ kind: z.enum(['object', 'path']), value: z.string().min(1).max(512) }),
  configVersion: z.string().min(1).max(128),
  bindingDigest: z.string().min(64).max(64),
  addedAt: z.string().min(1),
})

const persistedRemoteGrants: DomainValueSchema<PersistedRemoteGrants> = z.strictObject({
  grants: z.array(remoteGrant),
})

export const remoteDomainSpec = defineDomain({
  name: REMOTE_DOMAIN_NAME,
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { grants: domainTable<string, PersistedRemoteGrants>(persistedRemoteGrants) },
})

/** The manifest binding a `(primary key, ref)` pair is authorized for, if any. */
export function findBinding(manifest: DeploymentManifest, key: string, ref: RemoteEndpointRef):
  { readonly environment: RemoteEnvironment; readonly binding: RemoteBinding } | undefined {
  const environment = manifest.environments.find(candidate => candidate.environmentId === ref.environmentId)
  const binding = manifest.bindings.find(candidate =>
    primaryKey(candidate.primary) === key && candidate.environmentId === ref.environmentId && candidate.rootId === ref.rootId)
  return environment !== undefined && binding !== undefined ? { environment, binding } : undefined
}

/**
 * The grant's live state against the CURRENT manifest: `revoked` when its
 * binding is gone, `withheld` when the binding identity moved (host key,
 * account, helper, path — the digest covers all of it), else `registered`.
 */
export function grantState(manifest: DeploymentManifest, key: string, grant: RemoteGrant): RemoteGrantState {
  const found = findBinding(manifest, key, grant)
  if (found === undefined) return 'revoked'
  return bindingDigest(found.environment, found.binding) === grant.bindingDigest ? 'registered' : 'withheld'
}
