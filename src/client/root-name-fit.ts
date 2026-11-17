/**
 * Three-tier display of the Files header's root name.
 *
 * The trigger label is the only place the selected root is named, and the
 * header can be a few dozen pixels wide in a narrowed right sidebar, a
 * two-column right sidebar, or a resized floating pane. A plain CSS ellipsis
 * keeps only the beginning, so roots that differ at the end (`…-workspace` vs
 * `…-experiment`) look identical. This module fits the name into the measured
 * width instead, in three forms:
 *
 * - `full` — the whole name, when it fits;
 * - `middle` — head and tail, when both ends fit;
 * - `head` — the head alone, at the last.
 *
 * The head-and-tail form prefers a split on a separator so the kept ends read
 * as whole words; the tail of a character-level split is capped so a short name
 * does not spend its whole width on the end. Widths come from the caller: the
 * component measures candidate strings in the label's own font, which keeps
 * the fit correct for variable-width characters (CJK, emoji).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/root-name-fit
 */

/** The character both truncated forms put between the kept ends. */
export const ROOT_NAME_ELLIPSIS = '…'

/** Fewest leading characters a head-and-tail form keeps. */
export const ROOT_NAME_MIN_HEAD = 3

/** Fewest trailing characters a head-and-tail form keeps. */
export const ROOT_NAME_MIN_TAIL = 4

/** Longest tail a character-level head-and-tail form spends on the end. */
export const ROOT_NAME_MAX_TAIL = 10

/**
 * How many visible characters a separator-aligned split may give up compared
 * with the richest candidate. Word-aligned ends read better than a couple of
 * extra characters glued to a cut word.
 */
export const ROOT_NAME_ALIGN_SLACK_CHARS = 2

/**
 * Width kept out of the fit so that a rounding difference between the measured
 * candidate and the rendered label never trips the stylesheet's ellipsis
 * fallback and cuts the kept tail a second time.
 */
export const ROOT_NAME_FIT_SLACK_PX = 2

/** Which tier the measured width allowed. */
export type RootNameForm = 'full' | 'middle' | 'head'

/** One fitted root name: the text to draw and the tier it took. */
export interface RootNameDisplay {
  /** Which tier the width allowed. */
  readonly form: RootNameForm
  /** The exact label text. */
  readonly text: string
}

/** Measures one candidate string in CSS px. */
export type TextMeasure = (text: string) => number

/** Characters a display name may be split at. */
const SEPARATORS: ReadonlySet<string> = new Set(['-', '_', '.', ' ', '/', '\\', ':'])

/** Whether a code point is a separator a split may land on. */
function isSeparator(char: string | undefined): boolean {
  return char !== undefined && SEPARATORS.has(char)
}

/** The text of the first `end` code points. */
function prefix(chars: readonly string[], end: number): string {
  return chars.slice(0, end).join('')
}

/** The text from `start` to the end. */
function suffix(chars: readonly string[], start: number): string {
  return chars.slice(start).join('')
}

/**
 * The widest prefix of at most `limit` code points that fits `budget`.
 *
 * Text width grows with the prefix length, so the search is a binary search
 * over prefix lengths instead of a measurement per character.
 *
 * @param chars - the name split into code points.
 * @param limit - the longest prefix the caller allows.
 * @param budget - the width the prefix may use, in CSS px.
 * @param measure - measures one candidate string in CSS px.
 * @returns the largest allowed prefix length that fits the budget.
 */
function widestPrefix(chars: readonly string[], limit: number, budget: number, measure: TextMeasure): number {
  let low = 0
  let high = Math.max(0, limit)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(prefix(chars, middle)) <= budget) low = middle
    else high = middle - 1
  }
  return low
}

/** One head-and-tail candidate: how many code points each end keeps, and its rendered width. */
interface MiddleCandidate {
  /** Code points kept at the start. */
  readonly head: number
  /** Code points kept at the end. */
  readonly tail: number
  /** Rendered width of the candidate, in CSS px. */
  readonly width: number
  /** Whether both cuts land on a separator boundary. */
  readonly aligned: boolean
}

/** The head ends that fall before a separator, plus the minimum head constraint. */
function alignedHeadEnds(chars: readonly string[], length: number): readonly number[] {
  const ends: number[] = []
  for (let end = ROOT_NAME_MIN_HEAD; end <= length - 1 - ROOT_NAME_MIN_TAIL; end += 1) {
    if (isSeparator(chars[end])) ends.push(end)
  }
  return ends
}

/** The tail starts that fall right after a separator. */
function alignedTailStarts(chars: readonly string[], length: number): readonly number[] {
  const starts: number[] = []
  for (let start = ROOT_NAME_MIN_HEAD + 1; start <= length - ROOT_NAME_MIN_TAIL; start += 1) {
    if (isSeparator(chars[start - 1])) starts.push(start)
  }
  return starts
}

/** Head-and-tail candidates whose both cuts fall on word boundaries. */
function alignedCandidates(
  chars: readonly string[],
  length: number,
  available: number,
  measure: TextMeasure,
): MiddleCandidate[] {
  const candidates: MiddleCandidate[] = []
  for (const head of alignedHeadEnds(chars, length)) {
    for (const start of alignedTailStarts(chars, length)) {
      if (start <= head) continue
      const text = prefix(chars, head) + ROOT_NAME_ELLIPSIS + suffix(chars, start)
      const width = measure(text)
      if (width <= available) candidates.push({ head, tail: length - start, width, aligned: true })
    }
  }
  return candidates
}

/** Head-and-tail candidates cut at arbitrary code points, with a capped tail. */
function characterCandidates(
  chars: readonly string[],
  length: number,
  available: number,
  ellipsisWidth: number,
  measure: TextMeasure,
): MiddleCandidate[] {
  const candidates: MiddleCandidate[] = []
  const longestTail = Math.min(ROOT_NAME_MAX_TAIL, length - ROOT_NAME_MIN_HEAD - 1)
  for (let tail = longestTail; tail >= ROOT_NAME_MIN_TAIL; tail -= 1) {
    let start = length - tail
    // A tail cut right at a separator would read as an ellipsis glued to a
    // dash (\`…-workspace\`); start at the word instead and keep the freed width
    // for the head.
    while (start < length - ROOT_NAME_MIN_TAIL && isSeparator(chars[start])) start += 1
    const keptTail = length - start
    if (keptTail < ROOT_NAME_MIN_TAIL) continue
    const tailWidth = measure(suffix(chars, start))
    const budget = available - ellipsisWidth - tailWidth
    if (budget <= 0) continue
    const head = widestPrefix(chars, start - 1, budget, measure)
    if (head < ROOT_NAME_MIN_HEAD) continue
    candidates.push({ head, tail: keptTail, width: measure(prefix(chars, head)) + ellipsisWidth + tailWidth, aligned: false })
  }
  return candidates
}

/**
 * Pick the head-and-tail form: the widest candidate, unless a word-aligned one
 * spends at most the alignment slack more of the unused width (that is, uses a
 * little less of it) — then the word-aligned split wins.
 *
 * @param candidates - every candidate the width allowed.
 * @returns the chosen candidate, or undefined when none fits.
 */
/**
 * Rank two candidates: the most visible characters first, then the longer kept
 * tail (a tail that covers a whole trailing word reads better even at the same
 * total), then the wider rendering so the label fills the room it has.
 *
 * @param left - one candidate.
 * @param right - the other.
 * @returns a negative number when the left candidate ranks first.
 */
function compareCandidates(left: MiddleCandidate, right: MiddleCandidate): number {
  const visible = (right.head + right.tail) - (left.head + left.tail)
  if (visible !== 0) return visible
  const tail = right.tail - left.tail
  if (tail !== 0) return tail
  return right.width - left.width
}

/**
 * Pick the head-and-tail form: the best-ranked candidate, unless a
 * word-aligned one gives up no more than the alignment slack — then the aligned
 * split wins.
 *
 * @param candidates - every candidate the width allowed.
 * @returns the chosen candidate, or undefined when none fits.
 */
function bestMiddle(candidates: readonly MiddleCandidate[]): MiddleCandidate | undefined {
  let best: MiddleCandidate | undefined
  for (const candidate of candidates) {
    if (best === undefined || compareCandidates(candidate, best) < 0) best = candidate
  }
  if (best === undefined) return undefined
  const richest = best.head + best.tail
  let aligned: MiddleCandidate | undefined
  for (const candidate of candidates) {
    if (!candidate.aligned || candidate.head + candidate.tail < richest - ROOT_NAME_ALIGN_SLACK_CHARS) continue
    if (aligned === undefined || compareCandidates(candidate, aligned) < 0) aligned = candidate
  }
  return aligned ?? best
}

/**
 * The head-only text: the widest prefix that fits, backing up to a separator
 * within a few characters so the kept part ends on a word boundary when one is
 * close enough.
 *
 * @param chars - the name split into code points.
 * @param available - the width the label may use, in CSS px.
 * @param ellipsisWidth - the measured width of the ellipsis.
 * @param measure - measures one candidate string in CSS px.
 * @returns the label text for the head-only form.
 */
function headOnly(
  chars: readonly string[],
  available: number,
  ellipsisWidth: number,
  measure: TextMeasure,
): string {
  const ellipsisFits = ellipsisWidth <= available
  const budget = available - ellipsisWidth
  if (budget <= 0) return ellipsisFits ? ROOT_NAME_ELLIPSIS : ''
  const length = chars.length
  let head = widestPrefix(chars, length, budget, measure)
  for (let index = head; index >= Math.max(1, head - 3); index -= 1) {
    if (isSeparator(chars[index]) && index >= ROOT_NAME_MIN_HEAD) {
      head = index
      break
    }
  }
  if (head <= 0) return ellipsisFits ? ROOT_NAME_ELLIPSIS : ''
  return prefix(chars, head) + ROOT_NAME_ELLIPSIS
}

/**
 * Fit a root name into the measured label width.
 *
 * @param name - the full display name of the selected root.
 * @param available - the width the label may use, in CSS px.
 * @param measure - measures one candidate string in the label's font.
 * @returns the text to render and the tier it took.
 */
export function fitRootName(name: string, available: number, measure: TextMeasure): RootNameDisplay {
  const chars = Array.from(name)
  const length = chars.length
  const ellipsisWidth = measure(ROOT_NAME_ELLIPSIS)
  if (!Number.isFinite(available)) return { form: 'full', text: name }
  if (available <= 0) return { form: 'head', text: '' }
  if (measure(name) <= available) return { form: 'full', text: name }
  const middle = bestMiddle([
    ...alignedCandidates(chars, length, available, measure),
    ...characterCandidates(chars, length, available, ellipsisWidth, measure),
  ])
  if (middle !== undefined) {
    return {
      form: 'middle',
      text: prefix(chars, middle.head) + ROOT_NAME_ELLIPSIS + suffix(chars, length - middle.tail),
    }
  }
  return { form: 'head', text: headOnly(chars, available, ellipsisWidth, measure) }
}
