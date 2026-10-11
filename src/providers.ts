/**
 * `MultiRootProviders`: the fail-loud guard that proves the services mounted as
 * `ctx.fs` and `ctx.sandbox` are THIS bundle's providers — the only ones whose
 * widening the registry, the instruction row, LSP routing and workspace-files
 * are allowed to attach to.
 *
 * Why a brand and not `instanceof`: the plugin may be installed twice (a
 * duplicated install forks the class identity), and cordis private fields are
 * not a public contract. A well-known symbol survives both. The brand is
 * non-enumerable so it never leaks into spreads, JSON, or surface payloads.
 *
 * Deterministic outcome under a provider conflict: cordis refuses a second
 * `ctx.provide` of an already-registered key, so whoever mounts the colliding
 * provider second loses loudly — but a conflicting plugin can also DISABLE this
 * bundle's rows (the same mechanism this bundle uses on upstream), leaving a
 * foreign `ctx.fs`/`ctx.sandbox` in place. In that case this service's
 * `[Service.init]` logs which service is foreign and throws: the row never
 * activates, so every row injecting `multiRootProviders` — the registry above
 * all — never starts, the scope stays empty, and nothing is ever granted,
 * regardless of patch order. Cordis re-evaluates an injecting fiber when an
 * injected service is unprovided and re-provided, so a LATE replacement re-runs
 * the same check.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/providers
 */

import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from './compat.ts'

/**
 * The well-known brand key both providers carry. `Symbol.for` makes it
 * identical across duplicated installs of this package.
 */
export const MULTI_ROOT_PROVIDER_BRAND = Symbol.for('@dsh-electron/dsh-plugin-multi-root-workspace/provider')

/** The two service keys this bundle takes over. */
export type ProviderKind = 'fs' | 'sandbox'

/**
 * Stamp the multi-root provider brand on a service value. Non-enumerable:
 * the mark must not travel into structural copies.
 * @param value - the service instance being mounted.
 * @param kind - which provider key it claims.
 * @returns the same value, branded.
 */
export function brandMultiRootProvider<T>(value: T, kind: ProviderKind): T {
  Object.defineProperty(value, MULTI_ROOT_PROVIDER_BRAND, {
    value: kind,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return value
}

/**
 * Whether `value` is this bundle's provider of `kind`. Structural on purpose:
 * no `instanceof`, so a duplicated install still recognizes the brand.
 * @param value - the service mounted under the key.
 * @param kind - the provider key being checked.
 */
export function isMultiRootProvider(value: unknown, kind: ProviderKind): boolean {
  return (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && (value as Record<PropertyKey, unknown>)[MULTI_ROOT_PROVIDER_BRAND] === kind
  )
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    multiRootProviders: MultiRootProviders
  }
}

/**
 * The conflict gate: `ctx.multiRootProviders` exists only while `ctx.fs` and
 * `ctx.sandbox` are this bundle's branded providers. Every row that widens an
 * authority surface injects it, so a foreign provider composition loses the
 * whole gated set instead of silently widening an unverified one.
 */
export class MultiRootProviders extends Service {
  // `multiRootCompat` is the compatibility gate, not a collaborator (see
  // src/compat.ts); `fs` and `sandbox` are the services being verified.
  static provide = 'multiRootProviders'
  static inject = ['multiRootCompat', 'fs', 'sandbox']

  /**
   * Verify the provider identities once per activation. A foreign service is
   * named in the log and the throw leaves this row — and every dependent —
   * unstarted: fail loud, never a widened grant.
   */
  protected [Service.init](): void {
    const foreign: ProviderKind[] = []
    if (!isMultiRootProvider(this.ctx.fs, 'fs')) foreign.push('fs')
    if (!isMultiRootProvider(this.ctx.sandbox, 'sandbox')) foreign.push('sandbox')
    if (foreign.length === 0) return
    const names = foreign.map(name => `ctx.${name}`).join(' and ')
    this.ctx.logger.error(
      `multi-root-workspace: ${names} is provided by another plugin, not this bundle's multi-root `
      + 'provider; refusing to start the multi-root rows so no widened grant can attach to an '
      + 'unverified provider. Resolve the conflict by disabling the other plugin\'s provider rows.',
    )
    throw new Error(`multi-root-workspace: ${names} is a foreign provider; multi-root rows are disabled`)
  }
}

export default MultiRootProviders
