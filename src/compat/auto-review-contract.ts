/**
 * The optional Auto Review integration's joint support contract: which exact
 * DSH releases the forked reviewer is verified against, which frozen upstream
 * source generation each release runs, and where that generation is compiled.
 *
 * This is deliberately narrower than {@link SUPPORTED_DSH_RELEASES}: the fork
 * copies upstream's experimental reviewer and value-imports host packages, so
 * it is judged release by release instead of inheriting the ordinary matrix.
 *
 * This module is the ONE machine-readable home of that contract. It is
 * deliberately pure — no cordis, no I/O — so the runtime entry, the build
 * script, the static gates and the tests all read the same declaration. The
 * pre-build scripts re-read these literals from the source text.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/auto-review-contract
 */

/**
 * Releases served by the legacy fork of the frozen `0.2.1` reviewer source
 * generation (`dsh-v0.2.1-rc.2`). The generation's reviewer source is
 * byte-identical across these tags; only package versions change.
 */
export const AUTO_REVIEW_LEGACY_RELEASES = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5'] as const

/**
 * Releases served by the current fork of the frozen `0.2.2-alpha.3` reviewer
 * source generation. The reviewer input model was rewritten at
 * `0.2.2-alpha.2`; `alpha.3` to `rc.3` share its source, and the one
 * behavioral difference (`alpha.2` predates the request-purpose map) is
 * selected by {@link autoReviewRequestIdentity}.
 */
export const AUTO_REVIEW_CURRENT_RELEASES = ['0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3'] as const

/**
 * One frozen upstream reviewer source generation. Each baseline keeps one
 * verbatim upstream copy, one reviewed fork and one compile pin; a release is
 * supported only while it is a member of exactly one baseline's release list.
 */
export type AutoReviewBaseline = '0.2.1' | '0.2.2'

/** The release whose declarations typecheck the `0.2.1` fork implementation. */
export const AUTO_REVIEW_LEGACY_COMPILE_PIN = '0.2.1-rc.5'

/** The release whose declarations typecheck the `0.2.2` fork implementation. */
export const AUTO_REVIEW_CURRENT_COMPILE_PIN = '0.2.2-rc.3'

/** Every release the optional integration is jointly verified against, in order. */
export const AUTO_REVIEW_RELEASES = [...AUTO_REVIEW_LEGACY_RELEASES, ...AUTO_REVIEW_CURRENT_RELEASES] as const

/** One supported release of this contract. */
export type AutoReviewRelease = typeof AUTO_REVIEW_RELEASES[number]

/**
 * Resolve one installed DSH release to the baseline whose fork implements it.
 * @param release - the installed host release, or `undefined` when unknown.
 * @returns the baseline id, or `undefined` when the release is not supported.
 */
export function autoReviewBaseline(release: string | undefined): AutoReviewBaseline | undefined {
  if (release === undefined) return undefined
  if ((AUTO_REVIEW_LEGACY_RELEASES as readonly string[]).includes(release)) return '0.2.1'
  if ((AUTO_REVIEW_CURRENT_RELEASES as readonly string[]).includes(release)) return '0.2.2'
  return undefined
}

/**
 * Require a supported release.
 * @param release - the installed host release, or `undefined` when unknown.
 * @returns the exact supported release.
 * @throws when the release is not in this contract; the message names every
 *   supported release so an operator can act on it.
 */
export function requireAutoReviewRelease(release: string | undefined): AutoReviewRelease {
  if (!(AUTO_REVIEW_RELEASES as readonly string[]).includes(release ?? '')) {
    throw new Error(`multi-root Auto Review requires one of DSH ${AUTO_REVIEW_RELEASES.join(', ')}; installed: ${release ?? '(unknown)'}`)
  }
  return release as AutoReviewRelease
}

/**
 * Require a supported release and return its baseline.
 * @param release - the installed host release, or `undefined` when unknown.
 * @returns the matching baseline id.
 * @throws when the release is not in this contract.
 */
export function requireAutoReviewBaseline(release: string | undefined): AutoReviewBaseline {
  requireAutoReviewRelease(release)
  const baseline = autoReviewBaseline(release)
  // Both helpers read the same lists; a release in the contract always maps.
  if (baseline === undefined) throw new Error(`multi-root Auto Review: no baseline implements DSH ${release}`)
  return baseline
}

/**
 * The release whose declarations typecheck one baseline's fork implementation.
 * @param baseline - the baseline whose compile pin is requested.
 * @returns the exact release the implementation is compiled against.
 */
export function autoReviewCompilePin(baseline: AutoReviewBaseline): string {
  switch (baseline) {
    case '0.2.1': return AUTO_REVIEW_LEGACY_COMPILE_PIN
    case '0.2.2': return AUTO_REVIEW_CURRENT_COMPILE_PIN
  }
}

/**
 * The bundled implementation file each baseline's Loader entry loads. These are
 * separate build entries: a host never loads the implementation its release is
 * not part of, which keeps the other generation's imports out of its module
 * graph (the 0.2.1 line cannot load the 0.2.2 fork's type-only additions).
 */
export const AUTO_REVIEW_IMPLEMENTATIONS: Readonly<Record<AutoReviewBaseline, string>> = {
  '0.2.1': './auto-review-legacy.js',
  '0.2.2': './auto-review-current.js',
}

/** How one review request identifies itself to the LLM runtime. */
export type AutoReviewRequestIdentity = 'session-and-purpose' | 'none'

/**
 * The request-identity fields the official reviewer of one release sends.
 *
 * `0.2.2-alpha.2` predates `LlmRequestPurposeMap`: its `GenerateOptions.purpose`
 * is the closed `'compaction' | 'session-title'` union, and the deepseek
 * adapter forwards that field into the provider's request extensions. Sending
 * an undeclared purpose there is an unverified provider input, so that release
 * keeps the official request shape; `alpha.3` introduced both the open purpose
 * map and the auto-review purpose, and every later release sends them.
 * @param release - the exact supported host release.
 * @returns which identity fields the review request may carry.
 */
export function autoReviewRequestIdentity(release: AutoReviewRelease): AutoReviewRequestIdentity {
  return release === '0.2.2-alpha.2' ? 'none' : 'session-and-purpose'
}
