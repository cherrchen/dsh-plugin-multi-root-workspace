/**
 * Compatibility adapter for `isMobileDevice` from
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * ```text
 * 0.1.5-rc.2 through 0.2.1-rc.5   no `isMobileDevice` export
 * 0.2.2-alpha.2 +                 `isMobileDevice` exported
 * ```
 *
 * The open-in-app fork's verbatim `open-toast.tsx` spells the detector as a
 * primitives import — a name absent before `0.2.2-alpha.2` — so the lookup
 * is by export name, not by release string (the `client-icons.ts` pattern).
 * An older runtime falls back to upstream's identical detection: mobile
 * userAgent, or a touch-capable MacIntel platform, memoized like upstream's.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/open-in-app-device
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The DOM `navigator`, declared at module scope so this file still
 * typechecks under `tsconfig.host.json`, which compiles every `src/compat/`
 * file with no DOM lib. Module-scoped and type-only: it emits nothing, and
 * at run time the name resolves to the real global.
 */
declare const navigator: {
  readonly userAgent: string
  readonly platform: string
  readonly maxTouchPoints: number
}

/** The primitives module, addressed by export name. */
const installed = primitives as unknown as { readonly isMobileDevice?: unknown }

/** Upstream's own detector when the installed release carries it (verbatim logic below otherwise). */
const upstream = typeof installed.isMobileDevice === 'function'
  ? installed.isMobileDevice as () => boolean
  : undefined

let fallbackResult: boolean | undefined

/**
 * Whether this browser is a mobile device — upstream's detection verbatim.
 * @returns true for a mobile userAgent or a touch-capable macOS surface.
 */
function isMobileDeviceFallback(): boolean {
  fallbackResult ??= /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return fallbackResult
}

/**
 * Resolve the installed release's `isMobileDevice`, or the identical local
 * fallback on releases that predate the export.
 * @returns the mobile-device verdict.
 */
export function isMobileDevice(): boolean {
  return upstream === undefined ? isMobileDeviceFallback() : upstream()
}
