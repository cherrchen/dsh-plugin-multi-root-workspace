/**
 * Fork-facing shim for upstream `ui-open-in-app/src/client/open-path.ts`.
 *
 * The fork only needs the failure union `OpenInAppPathButton`'s `execute`
 * returns; upstream's file also carries `OpenInAppPathController`, the
 * document-preview path controller that speaks to a Session Remote this
 * plugin does not hold. Keeping the verbatim file would pull
 * `@deepseek-ai/dsh-api-remotes` and `dsh-api-session-controller` into the
 * bundle for a class nothing here calls — so this shim owns just the type,
 * spelled verbatim. See FORK.md.
 */

/** Failure kind of one settled path gesture, for the initiating control to announce. */
export type OpenInAppPathFailure = 'openError' | 'revealError'
