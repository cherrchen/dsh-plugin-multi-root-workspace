/**
 * The registry stack a spec mounts: the real JSON storage backend, the domain
 * form, the scope service, and the registry — assembled exactly the way a
 * profile assembles them, so a spec exercises the durable path rather than a
 * double.
 *
 * Dispose unloads the root fiber: the registry lease is a kernel lock, so a
 * trailing sibling fiber would leave the first stack holding the lock and the
 * next restart would start contended.
 *
 * @module tests/support/registry-stack
 */

import { mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MultiRootRegistry, { DOMAIN_NAME } from '../../src/registry.ts'
import MultiRootScopeService from '../../src/scope.ts'

/** One mounted stack, with everything a spec needs to act on it. */
export interface RegistryStack {
  /** The root context every service is mounted on. */
  readonly ctx: Context
  /** The registry under test. */
  readonly registry: MultiRootRegistry
  /** The scope the registry publishes into. */
  readonly scope: MultiRootScopeService
  /** The store root the JSON backend writes under. */
  readonly storeRoot: string
  /** The path of the domain's own document. */
  readonly storeFile: string
  /** Dispose the whole stack. */
  dispose: () => Promise<void>
}

/**
 * Mount one registry stack over a private store root.
 * @param storeRoot - directory the JSON backend owns (created when absent).
 * @returns the mounted stack.
 */
export async function mountRegistryStack(storeRoot: string): Promise<RegistryStack> {
  mkdirSync(storeRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storeRoot })
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(MultiRootScopeService)
  await ctx.plugin(MultiRootRegistry, { leasePath: `${storeRoot}/${DOMAIN_NAME}.lock` })
  return {
    ctx,
    registry: ctx.multiRootRegistry,
    scope: ctx.multiRootScope,
    storeRoot,
    storeFile: `${storeRoot}/${DOMAIN_NAME}.json`,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}
