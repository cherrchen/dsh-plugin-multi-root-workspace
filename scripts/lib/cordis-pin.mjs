/** Extract one exact Cordis base version, including prereleases; refuse compound ranges. */
export function cordisPin(range) {
  const match = typeof range === 'string' ? /^[\^~]?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/u.exec(range) : null
  if (match === null) throw new Error(`Cordis ${JSON.stringify(range)} is not a single exact, caret or tilde version`)
  return match[1]
}

/** Keep vendor probes on the declared minor line, or the exact declared prerelease. */
export function ecosystemPin(range, admitted) {
  if (!Array.isArray(admitted) || admitted.length === 0) throw new Error('no admitted ecosystem versions')
  const base = cordisPin(range)
  if (!admitted.includes(base)) throw new Error(`declared ecosystem baseline ${base} is not published`)
  if (base.includes('-')) return base
  // Stable patch fixes are needed by older hosts (e.g. schemastery's zod
  // codecs). New vendor minors can require a newer Cordis even when their
  // semver ranges still admit the old host; never cross that boundary.
  const [major, minor, patch] = base.split('.').map(Number)
  return admitted.filter(version => {
    if (!/^\d+\.\d+\.\d+$/u.test(version)) return false
    const parts = version.split('.').map(Number)
    return parts[0] === major && parts[1] === minor && parts[2] >= patch
  }).sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2])).at(-1)
}
