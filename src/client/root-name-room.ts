/**
 * Width budget and text measurement for the Files header's root name.
 *
 * The trigger lives in a flex row whose own width is stable: the switcher is
 * the row's growing/shrinking item, so its width equals the space the header
 * leaves for it no matter what the label says. That makes it the right input
 * for the three-tier fit — measuring the trigger itself would feed the chosen
 * text back into its own budget and oscillate. This module reads that budget
 * from the rendered row and measures candidate strings in the label's font.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/root-name-room
 */

import type { TextMeasure } from './root-name-fit.ts'

/** The switcher's own path label; its box yields all of its width before the trigger shrinks. */
const PATH_CLASS = 'mrfw-switcherPath'

/** The hidden probe span rendered inside the trigger for the no-canvas fallback. */
export const ROOT_NAME_PROBE_CLASS = 'mrfw-rootSwitchProbe'

/** A computed length, or 0 when the engine reports a non-length. */
function lengthOf(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** An element's outer width: its border box plus its horizontal margins. */
function outerWidth(element: Element): number {
  const style = getComputedStyle(element)
  return element.getBoundingClientRect().width + lengthOf(style.marginLeft) + lengthOf(style.marginRight)
}

/** The horizontal gap between a flex row's items, or 0 when it has none. */
function columnGapOf(element: Element): number {
  const style = getComputedStyle(element)
  return lengthOf(style.columnGap) || lengthOf(style.gap)
}

/**
 * The width the trigger spends on everything but the label: its paddings, the
 * gaps between its children, the folder glyph and the chevron.
 *
 * @param button - the trigger button.
 * @param label - the label inside it.
 * @returns the non-label width, in CSS px.
 */
function triggerChrome(button: HTMLElement, label: HTMLElement): number {
  const style = getComputedStyle(button)
  let others = 0
  let count = 0
  for (const child of Array.from(button.children)) {
    // The probe is off-flow and holds a candidate string: it is not part of the row.
    if (child.classList.contains(ROOT_NAME_PROBE_CLASS)) continue
    count += 1
    if (child !== label) others += outerWidth(child)
  }
  return lengthOf(style.paddingLeft) + lengthOf(style.paddingRight)
    + others + columnGapOf(button) * Math.max(0, count - 1)
}

/**
 * The width the trigger label may use before the trigger box itself shrinks.
 *
 * The path label yields its whole width to the name, so it is left out of the
 * fixed items and only its own gutter is subtracted; that keeps the result
 * independent of what the path currently shows.
 *
 * @param switcher - the flex row the plugin owns inside the header.
 * @param button - the trigger button inside it.
 * @param label - the label inside the button.
 * @returns the label budget in CSS px, never negative.
 */
export function rootNameLabelBudget(switcher: HTMLElement, button: HTMLElement, label: HTMLElement): number {
  const children = Array.from(switcher.children)
  const anchor = button.parentElement
  let fixed = 0
  let path: HTMLElement | null = null
  for (const child of children) {
    if (child === anchor) continue
    if (child instanceof HTMLElement && child.classList.contains(PATH_CLASS)) { path = child; continue }
    fixed += outerWidth(child)
  }
  const pathMargin = path === null ? 0 : lengthOf(getComputedStyle(path).marginRight)
  const gap = columnGapOf(switcher)
  const available = switcher.getBoundingClientRect().width
    - fixed - pathMargin - gap * Math.max(0, children.length - 1)
  return Math.max(0, available - triggerChrome(button, label))
}

/** The 2D context of an offscreen canvas, or null where the environment has none. */
function offscreenContext(): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== 'function') return null
  const canvas = new OffscreenCanvas(1, 1)
  return canvas.getContext('2d')
}

/** The CSS font shorthand of an element, with engine-neutral fallbacks. */
function fontOf(element: HTMLElement): string {
  const style = getComputedStyle(element)
  return [
    style.fontStyle,
    style.fontWeight,
    style.fontSize === '' ? '13px' : style.fontSize,
    style.fontFamily === '' ? 'sans-serif' : style.fontFamily,
  ].filter(part => part !== '').join(' ')
}

/**
 * Build a text measurer in the label's own font.
 *
 * An offscreen canvas measures without touching the document, so the fit never
 * forces a layout of the header it is deciding about. Where the environment has
 * no offscreen canvas (jsdom in tests, a host with canvas disabled) the hidden
 * probe span is measured instead: the same font, one synchronous layout read
 * per candidate.
 *
 * @param label - the element whose computed font the label text is drawn with.
 * @param probe - the hidden span rendered inside the trigger for the fallback.
 * @returns a measuring function in CSS px.
 */
export function createLabelMeasurer(label: HTMLElement, probe: HTMLElement): TextMeasure {
  const context = offscreenContext()
  if (context !== null) {
    context.font = fontOf(label)
    return text => context.measureText(text).width
  }
  return text => {
    probe.textContent = text
    return probe.getBoundingClientRect().width
  }
}
