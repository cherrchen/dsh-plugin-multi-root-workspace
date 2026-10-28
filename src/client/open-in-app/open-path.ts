/**
 * Fork-facing shim for upstream `ui-open-in-app/src/client/open-path.ts`.
 *
 * The fork only needs the failure union the path gestures' `execute`
 * returns; upstream's file also carries `OpenInAppPathController`, the
 * document-preview path controller that speaks to a Session Remote this
 * plugin does not hold. Keeping the verbatim file would pull
 * `@deepseek-ai/dsh-api-remotes` and `dsh-api-session-controller` into the
 * bundle for a class nothing here calls. From `0.2.2-alpha.2` the failure
 * union lives in upstream's `outcome.ts` (an alias of the deliverables
 * `PresentedOpenFailure`), so this shim re-exports the fork's own outcome
 * shim under the same name. See FORK.md.
 */

export type { OpenInAppPathFailure } from './outcome.ts'
