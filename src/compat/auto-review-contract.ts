/** The companion's joint support contract is deliberately narrower than the ordinary bundle. */
export function assertAutoReviewRelease(release: string | undefined): void {
  if (release !== '0.2.1-rc.2') throw new Error('multi-root Auto Review requires exactly DSH 0.2.1-rc.2')
}
