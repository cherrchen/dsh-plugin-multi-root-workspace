/** Extract one exact Cordis base version, including prereleases; refuse compound ranges. */
export function cordisPin(range) {
  const match = typeof range === 'string' ? /^[\^~]?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/u.exec(range) : null
  if (match === null) throw new Error(`Cordis ${JSON.stringify(range)} is not a single exact, caret or tilde version`)
  return match[1]
}
