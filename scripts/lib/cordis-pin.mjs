/** Extract one exact Cordis base version, including prereleases; refuse compound ranges. */
export function cordisPin(range) {
  const match = typeof range === 'string' ? /^[\^~]?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/u.exec(range) : null
  if (match === null) throw new Error(`Cordis ${JSON.stringify(range)} is not a single exact, caret or tilde version`)
  return match[1]
}

/** Pin a declared prerelease to its base, rather than silently mixing a later vendor generation. */
export function ecosystemPin(range, admitted) {
  if (!Array.isArray(admitted) || admitted.length === 0) throw new Error('no admitted ecosystem versions')
  if (typeof range === 'string' && /^[\^~]?\d+\.\d+\.\d+-[\w.]+$/u.test(range)) {
    const base = cordisPin(range)
    if (!admitted.includes(base)) throw new Error(`declared ecosystem prerelease ${base} is not published`)
    return base
  }
  return admitted.at(-1)
}
