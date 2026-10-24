/**
 * Build the domain record schemas with the zod module the installed
 * `@deepseek-ai/dsh-storage-domain` resolves.
 *
 * ```text
 * through 0.2.1-alpha.2   storage-domain declares zod ^4.4.3
 * from   0.2.1-alpha.3    storage-domain declares zod 4.4.3 exactly
 * ```
 *
 * `domainTable` types its `schema` parameter as `ZodType`, resolved from
 * whichever zod copy storage-domain itself depends on — never from the copy
 * this package installs for its own validation work (`src/contract.ts`
 * parses the panel wire shapes with it). While upstream declared `^4.4.3`,
 * both sides resolved to one install; the exact `4.4.3` pin since
 * `0.2.1-alpha.3` splits the tree into two resolutions of the same v4 line,
 * and zod v4 brands every type with the minor it was compiled by, so a
 * schema produced by `4.6.x` is not assignable to a `ZodType` declared by
 * `4.4.3`. Pinning this package to `4.4.3` would only move the split to the
 * other side: on the supported releases before the pin changed, upstream's
 * `^4.4.3` resolves to `4.6.x` and the pinned copy is the foreign one.
 *
 * The fix resolves the BUILDER the same way the boundary resolves the TYPE:
 * `require('zod')` from inside the storage-domain package. A schema built by
 * that namespace is by construction an instance of the `ZodType` the
 * installed `domainTable` accepts, on every supported release — whichever
 * zod version a release pins, both sides keep coming from one module.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/storage-zod
 */

import { createRequire } from 'node:module'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'

/**
 * The `ZodType` the installed `domainTable` accepts for records of `V`.
 * Indexed off `DomainTableSpec` rather than named `zod`: the specifier would
 * resolve THIS package's zod copy, which is exactly the split this module
 * exists to avoid.
 */
export type DomainValueSchema<V> = DomainTableSpec<string, V>['valueSchema']

/**
 * The slice of the zod namespace the domain schemas are built from.
 * Structurally typed — `typeof import('zod')` would brand every product with
 * this package's copy — and products stay `unknown`-shaped; the
 * {@link DomainValueSchema} annotation on the schema declaration is what
 * binds them to the boundary type.
 */
interface DomainZodModule {
  object(shape: Record<string, unknown>): any
  string(): { min(length: number): any; optional(): any }
  array(item: unknown): any
  unknown(): any
}

/**
 * The `z` namespace as the installed `@deepseek-ai/dsh-storage-domain`
 * resolves it.
 *
 * A resolution failure propagates rather than falling back to this package's
 * zod: a storage-domain that no longer depends on zod changes what
 * `domainTable` accepts, and that is an adapter decision, not a silent
 * degradation. The failure surfaces where a missing peer already would — at
 * module load, before any row runs.
 * @returns the zod module, typed as the used surface only.
 */
export function domainZod(): DomainZodModule {
  const require = createRequire(import.meta.url)
  const domainRequire = createRequire(require.resolve('@deepseek-ai/dsh-storage-domain/package.json'))
  return domainRequire('zod') as DomainZodModule
}
