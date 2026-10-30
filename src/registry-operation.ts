/**
 * Host-local operation context after ordered Registry authority admission.
 * This is Host-only state, never a wire permit or a reusable cached grant.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { FilesystemScope } from './scope.ts'

export type RegistryOperationKind = 'fs-write' | 'fs-edit' | 'process' | 'pty' | 'lsp' | 'files' | 'instructions' | 'skills'

const operations = new AsyncLocalStorage<{ proof: object | undefined; operation: RegistryOperation; active: boolean; profiles: Array<{ argv: string[]; capped: boolean }> }>()

export function currentRegistryOperation(proof: object): RegistryOperation | undefined {
  const frame = operations.getStore()
  return frame?.active === true && frame.proof === proof ? frame.operation : undefined
}

export interface RegistryOperationIdentity {
  readonly operationId: string
  readonly kind: RegistryOperationKind
  readonly mode: SandboxMode | undefined
  readonly primaryRoot: string
  /** Absent when the registry cannot grant additional authority. */
  readonly authorityEpoch: string | undefined
  /** Effective publication revision, meaningful only within this epoch. */
  readonly revision: number
}

export interface RegistryOperation {
  readonly identity: RegistryOperationIdentity
  /** Only readable during this operation's callback. */
  readonly scope: FilesystemScope
}

/** Capture by value: neither later publication nor a caller can mutate admission. */
export function freezeOperationScope(scope: FilesystemScope): FilesystemScope {
  return Object.freeze({
    ...scope,
    additionalRoots: Object.freeze([...scope.additionalRoots]),
    roots: Object.freeze(scope.roots.map(root => Object.freeze({ ...root }))),
    writableRoots: Object.freeze([...scope.writableRoots]),
    deniedRoots: Object.freeze([...scope.deniedRoots]),
  })
}

/** Execute outside the authority queue; completion also expires async descendants. */
export async function runRegistryOperation<T>(
  scope: FilesystemScope,
  kind: RegistryOperationKind,
  authorityEpoch: string | undefined,
  revision: number,
  body: (operation: RegistryOperation) => T | Promise<T>,
  proof?: object,
  mode?: SandboxMode,
): Promise<T> {
  let active = true
  const operation: RegistryOperation = Object.freeze({
    identity: Object.freeze({ operationId: randomUUID(), kind, authorityEpoch, revision, mode, primaryRoot: scope.primaryRoot }),
    get scope(): FilesystemScope {
      if (!active) throw new Error('multi-root registry: operation admission has expired')
      return scope
    },
  })
  const frame = { proof, operation, active: true, profiles: [] as Array<{ argv: string[]; capped: boolean }> }
  try {
    return await operations.run(frame, () => body(operation))
  } finally {
    active = false; frame.active = false
  }
}

/** Optional Registry seam for public consumers; the legacy composition stays exact. */
export async function withRegistryRead<T>(
  ctx: import('@deepseek-ai/cordis').Context,
  primary: string,
  kind: RegistryOperationKind,
  body: () => T | Promise<T>,
): Promise<T> {
  const registry = ctx.get('multiRootRegistry')
  return registry?.shared
    ? registry.withOperation({ workspaceRoot: primary, mode: 'read-only' }, kind, () => body())
    : body()
}

export async function withRegistryAdmission<T>(ctx: import('@deepseek-ai/cordis').Context,
  policy: import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy, kind: RegistryOperationKind,
  body: () => T | Promise<T>): Promise<T> {
  const registry = ctx.get('multiRootRegistry')
  return registry?.shared ? registry.withOperation(policy, kind, () => body()) : body()
}

/** Preserve a legacy synchronous entry while granting only the safe primary-root fallback. */
export function runPrimaryOperation<T>(scope: FilesystemScope, mode: SandboxMode, proof: object, body: () => T): T {
  let active = true
  const operation: RegistryOperation = Object.freeze({
    identity: Object.freeze({ operationId: randomUUID(), kind: 'process' as const, authorityEpoch: undefined, revision: 0, mode, primaryRoot: scope.primaryRoot }),
    get scope() { if (!active) throw new Error('operation admission has expired'); return scope },
  })
  const frame = { proof, operation, active: true, profiles: [] as Array<{ argv: string[]; capped: boolean }> }
  const finish = () => { active = false; frame.active = false }
  try {
    const result = operations.run(frame, body)
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      return Promise.resolve(result).finally(finish) as T
    }
    finish(); return result
  } catch (error) { finish(); throw error }
}

/** Only profiles produced within this exact admission can reach a sync spawn. */
export function rememberOperationProfile(proof: object, argv: readonly string[], capped: boolean): void {
  const frame = operations.getStore()
  if (frame?.active !== true || frame.proof !== proof) return
  if (frame.profiles.length >= 128) throw new Error('too many confined profiles in one operation')
  frame.profiles.push({ argv: [...argv], capped })
}
export function operationPermitsProfile(proof: object, argv: readonly string[], capped: boolean): boolean {
  const frame = operations.getStore()
  return frame?.active === true && frame.proof === proof && frame.profiles.some(profile =>
    profile.capped === capped && profile.argv.length <= argv.length && profile.argv.every((arg, i) => argv[i] === arg))
}
