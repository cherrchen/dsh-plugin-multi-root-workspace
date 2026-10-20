/** The companion's joint support contract is deliberately narrower than the ordinary bundle. */
export const AUTO_REVIEW_RELEASE = '0.2.1-rc.2'
export function assertAutoReviewRelease(release: string | undefined): void {
  if (release !== AUTO_REVIEW_RELEASE) throw new Error(`multi-root Auto Review requires exactly DSH ${AUTO_REVIEW_RELEASE}`)
}
