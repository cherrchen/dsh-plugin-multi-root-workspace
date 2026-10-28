/**
 * Fork-facing shim for upstream `ui-open-in-app/src/client/outcome.ts`.
 *
 * Upstream's file aliases `PresentedOpenFailure`/`PresentedOpenOutcome` out
 * of `@deepseek-ai/dsh-client-ui-deliverables` — a package this plugin does
 * not depend on. Both aliases are types only, so this shim spells the same
 * structural unions verbatim (upstream
 * `ui-deliverables/src/client/present-open.ts`) instead of importing them.
 * See FORK.md.
 */

/** Failure kind of one settled gesture, keyed to the `path.*` copy it announces. */
export type OpenInAppPathFailure = 'openError' | 'revealError'

/** Acknowledged open or reveal, named failure, or deliberately skipped gesture. */
export type OpenInAppOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'revealed' }
  | { readonly kind: 'failed'; readonly failure: OpenInAppPathFailure }
  | { readonly kind: 'skipped' }
