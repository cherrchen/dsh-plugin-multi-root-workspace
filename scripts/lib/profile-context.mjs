/**
 * The launch-time overlay fields every in-process `profileContext` must carry.
 *
 * The pre-0.2.3 `dsh-app-boot` reads `context.overlays` inside its
 * `readProfilePatches()`, while the 0.2.3 line reads `context.overlayPaths`.
 * A fixture that supplies only one generation's key makes the other
 * generation throw when a consumer lists or enables a plugin, so every boot
 * fixture spreads both empty defaults from here.
 *
 * @module scripts/lib/profile-context
 */

/**
 * Both overlay spellings, always empty in the in-process fixtures.
 * @returns the overlay fields to spread into a `profileContext`.
 */
export function profileContextOverlays() {
  return { overlays: [], overlayPaths: [] }
}
