/**
 * Fork-facing shim for `isMobileDevice` from
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The export exists only from `0.2.2-alpha.2`; the fork supports every
 * release back to `0.1.5`, so the name is probed by export name — like
 * `compat/client-icons.ts` — and an older runtime falls back to an
 * implementation with the identical logic (mobile userAgent, or a
 * touch-capable MacIntel platform, memoized). See FORK.md.
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

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
