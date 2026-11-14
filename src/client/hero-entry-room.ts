/**
 * Room measurement for the New Session hero entry.
 *
 * The upstream hero row keeps plugin options in `.heroOptions`, which is
 * `flex: none`: the container never shrinks, so an occupant sized from its own
 * content pushes the row past the composer card instead of yielding to it.
 * This module measures the space the row leaves for the options group, minus
 * the other occupants that share it, so the entry can clamp itself into the
 * remainder and fall back to an icon-only form when no label fits.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/hero-entry-room
 */

/** The icon-only entry width; the probe pins the seat to exactly this width. */
export const HERO_ENTRY_ICON_PX = 28

/**
 * The narrowest room that still shows the label: the icon, its gap and the
 * button's paddings (16 + 4 + 16) plus four 13px label characters.
 */
export const HERO_ENTRY_LABEL_MIN_PX = 88

/** How much of the entry the row can show. */
export type HeroEntryForm = 'full' | 'compact'

/** Whether a computed display value takes the element out of layout as a box. */
function isContents(display: string): boolean {
  return display === 'contents'
}

/** Whether a computed display value is a flex container. */
function isFlex(display: string): boolean {
  return display === 'flex' || display === 'inline-flex'
}

/** The computed display of an element. */
function displayOf(element: Element): string {
  return getComputedStyle(element).display
}

/** A computed length, or 0 when the engine reports a non-length. */
function lengthOf(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The first ancestor that is a box: the slot outlet anchors occupants with
 * `display: contents`, so the seat's first boxed ancestor is the options
 * container that holds them all.
 *
 * @param seat - the entry's seat element.
 * @returns the nearest boxed ancestor, or null at the document root.
 */
function boxAncestor(seat: HTMLElement): HTMLElement | null {
  let node = seat.parentElement
  while (node !== null && isContents(displayOf(node))) node = node.parentElement
  return node
}

/** An element's padding-box content edge on one side. */
function contentEdge(element: HTMLElement, side: 'left' | 'right'): number {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return side === 'left'
    ? rect.left + lengthOf(style.paddingLeft)
    : rect.right - lengthOf(style.paddingRight)
}

/**
 * The hero row the seat sits in.
 *
 * The seat's first boxed ancestor is the options container and the next one is
 * the row. Nothing here names an upstream class: an unrecognized structure
 * returns null and the component keeps its content-sized fallback form.
 *
 * @param seat - the entry's seat element.
 * @returns the flex row containing the entry, or null when it is not that row.
 */
export function heroRowOf(seat: HTMLElement): HTMLElement | null {
  const options = boxAncestor(seat)
  if (options === null) return null
  const row = options.parentElement
  if (row === null) return null
  return isFlex(displayOf(row)) ? row : null
}

/** The right edge of the last box an element occupies. */
function trailingBoxRight(element: Element): number | null {
  if (!isContents(displayOf(element))) return element.getBoundingClientRect().right
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index]
    if (child === undefined) continue
    const right = trailingBoxRight(child)
    if (right !== null) return right
  }
  return null
}

/**
 * The boxes of the options group's other occupants.
 *
 * A `display: contents` outlet has no box of its own, so the occupants are
 * flattened to the boxes that take part in the flex layout. The entry's own
 * subtree is left out: its width is what this measurement is solving for.
 *
 * @param options - the options container holding the seat.
 * @param seat - the entry's seat element.
 * @returns the sibling occupant boxes, in document order.
 */
function groupBoxes(options: HTMLElement, seat: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = []
  const visit = (element: Element): void => {
    if (element === seat || element.contains(seat)) return
    if (isContents(displayOf(element))) {
      for (const child of element.children) visit(child)
      return
    }
    boxes.push(element as HTMLElement)
  }
  for (const child of options.children) visit(child)
  return boxes
}

/**
 * The boxes whose width changes the room the entry may take: the row itself
 * (the panel or window resizing), the controls that share it, and anything in
 * the options group that is not the entry — a workspace title, the active
 * locale or another occupant all change the room without resizing the row.
 *
 * @param row - the hero row returned by {@link heroRowOf}.
 * @param seat - the entry's seat element, whose own subtree is never observed.
 * @returns the elements to watch.
 */
export function heroRowWidthTargets(row: HTMLElement, seat: HTMLElement): Element[] {
  const targets = new Set<Element>([row])
  for (const child of row.children) {
    if (!child.contains(seat)) targets.add(child)
  }
  const options = boxAncestor(seat)
  if (options !== null) {
    targets.add(options)
    for (const box of groupBoxes(options, seat)) targets.add(box)
  }
  return [...targets]
}

/**
 * The boundary after the control before the options group, including the row's
 * gap; empty wrappers before the group are skipped.
 * @param options - the options container holding the seat.
 * @param row - the flex row holding the container.
 * @returns the group's start edge, or null when no boxed control precedes it.
 */
function gridStartOf(options: HTMLElement, row: HTMLElement): number | null {
  const gap = lengthOf(getComputedStyle(row).columnGap)
  for (let sibling = options.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
    const right = trailingBoxRight(sibling)
    if (right !== null) return right + gap
  }
  return null
}

/**
 * Measure the room the hero row leaves for the entry.
 *
 * The seat is pinned to its icon floor for the read (`data-measuring`, styled
 * by the plugin sheet) so the row's controls show their natural widths instead
 * of the widths this entry's label already squeezed. The pin is removed before
 * returning; the function leaves the element as it found it.
 *
 * The budget runs from the control before the options group to the row's
 * content edge; the other occupants, the gaps between the group's items and
 * the seat's own inset come off it, and the entry may use the rest up to the
 * icon floor.
 *
 * @param seat - the entry's seat element.
 * @returns the widest the button may be, or null when the row cannot be read
 * (no recognizable flex row, or a seat that is not laid out at its floor).
 */
export function measureHeroEntryRoom(seat: HTMLElement): number | null {
  seat.dataset.measuring = ''
  try {
    const box = seat.getBoundingClientRect()
    // The pin comes from the plugin sheet. Without it the read would treat the
    // full label as the entry's own start and report a squeezed row every
    // time, so an unpinned (not yet laid out, or unstyled) seat proves nothing.
    if (Math.abs(box.width - HERO_ENTRY_ICON_PX) > 0.5) return null
    const row = heroRowOf(seat)
    const options = boxAncestor(seat)
    if (row === null || options === null) return null
    // Upstream keeps the group the row's last item (margin-left: auto). A
    // control after it would share the same budget, which this subtraction
    // cannot see, so that structure falls back to the content-sized form.
    if (options.nextElementSibling !== null) return null
    const start = gridStartOf(options, row) ?? contentEdge(row, 'left')
    const available = contentEdge(row, 'right') - start
    const gap = lengthOf(getComputedStyle(options).columnGap)
    const others = groupBoxes(options, seat)
    const used = others.reduce((total, item) => total + item.getBoundingClientRect().width, 0)
    const inset = lengthOf(getComputedStyle(seat).marginRight)
    return Math.round(Math.max(HERO_ENTRY_ICON_PX, available - used - gap * others.length - inset))
  } finally {
    delete seat.dataset.measuring
  }
}

/**
 * Choose the entry's form from the measured room.
 *
 * @param room - the value {@link measureHeroEntryRoom} returned.
 * @returns the form to render, or undefined while the room is unknown (the
 * component then keeps the stylesheet's content-sized fallback).
 */
export function heroEntryForm(room: number | null): HeroEntryForm | undefined {
  if (room === null) return undefined
  return room < HERO_ENTRY_LABEL_MIN_PX ? 'compact' : 'full'
}
