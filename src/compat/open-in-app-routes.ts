/**
 * Compatibility adapter for the route constants of
 * `@deepseek-ai/dsh-host-open-in-app/shared`.
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   OPEN_IN_APP_ICON_PREFIX = '/open-in-app/icon'       (absolute pathname)
 * 0.1.7-alpha.1 +      OPEN_IN_APP_ICON_PREFIX_ROUTE = 'open-in-app/icon'  (document-relative)
 * ```
 *
 * `0.1.7-alpha.1` split every shared route constant into a `*_PATH` spelling
 * the Host registers and a `*_ROUTE` spelling the browser addresses, retiring
 * the old names. The fork's `iconUrl` needs the browser-facing form — which a
 * pixel-era release spells without the `_ROUTE` suffix, so a named import of
 * the new name does not even BUILD against those manifests (MISSING_EXPORT at
 * bundle time, not a runtime undefined). The lookup is by export name, not by
 * release string.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/open-in-app-routes
 */

import * as shared from '@deepseek-ai/dsh-host-open-in-app/shared'

/** Exports addressed by name. A release spells each route exactly one way. */
type SharedModule = Readonly<Record<string, string | undefined>>

/**
 * The installed shared module, addressed by export name.
 *
 * Named imports cannot spell both eras: each name is absent from the other
 * era's declaration, so the compiler is told once, here.
 */
const installed = shared as unknown as SharedModule

/**
 * Pick the first export name this release actually provides.
 * @param module - the shared module to read.
 * @param names - candidate export names, preferred first.
 * @returns the route string.
 * @throws {Error} when none of the names is exported. That is a compatibility
 *   break to adapt here, not a missing optional peer.
 */
export function selectSharedRoute(module: SharedModule, names: readonly string[]): string {
  for (const name of names) {
    const found = module[name]
    if (found !== undefined) return found
  }
  throw new Error(
    'multi-root workspace: @deepseek-ai/dsh-host-open-in-app/shared exports none of '
    + `${names.join(', ')}; the open-in-app fork cannot address its icon route. `
    + 'Adapt src/compat/open-in-app-routes.ts to the installed release.',
  )
}

/**
 * The browser-facing icon-prefix route, whichever spelling this release
 * exports. Resolved once at module load: the fork's adapter only reaches
 * `iconUrl` on runtimes whose glyph gate already passed, and on the pixel era
 * the absolute form is exactly what upstream's own client fetched.
 */
export const OPEN_IN_APP_ICON_URL_PREFIX = selectSharedRoute(installed, [
  'OPEN_IN_APP_ICON_PREFIX_ROUTE',
  'OPEN_IN_APP_ICON_PREFIX',
])
