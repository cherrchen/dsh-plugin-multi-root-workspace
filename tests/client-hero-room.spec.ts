// @vitest-environment jsdom
/**
 * The hero entry's room measurement, exercised against a synthetic hero row.
 *
 * The geometry is pure DOM math, so the fixtures carry real inline styles
 * (jsdom resolves those) and fixed viewport boxes (stubbed, because jsdom has
 * no layout). What the stylesheet does with the result is pinned separately by
 * `client-hero-entry.spec.tsx` and `client-styles.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  HERO_ENTRY_ICON_PX,
  HERO_ENTRY_LABEL_MIN_PX,
  heroEntryForm,
  heroRowOf,
  heroRowWidthTargets,
  measureHeroEntryRoom,
} from '../src/client/hero-entry-room.ts'

/** Give an element a fixed viewport box. */
function stubRect(element: Element, left: number, width: number): void {
  const rect = {
    left, right: left + width, width, height: 28, top: 0, bottom: 28, x: left, y: 0, toJSON: () => ({}),
  } as DOMRect
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect })
}

/** The viewport boxes a 500px hero row reports with the upstream paddings. */
const ROW_WIDTH = 500
const ROW_PADDING_LEFT = 20
const ROW_PADDING_RIGHT = 16
const ROW_GAP = 2
const CHIP_WIDTH = 207

/**
 * One synthetic row: chip, preset anchor, then the options group holding an
 * optional same-slot occupant and the entry seat inside `display: contents`
 * outlets — the DOM the slot renderer produces.
 */
function mountRow(options: { readonly rowWidth?: number; readonly occupant?: number; readonly trailing?: boolean } = {}): {
  readonly row: HTMLElement
  readonly seat: HTMLElement
  readonly chip: HTMLElement
  readonly occupant: HTMLElement | null
} {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-row style="display: flex; column-gap: ${ROW_GAP}px; padding: 0 ${ROW_PADDING_RIGHT}px 0 ${ROW_PADDING_LEFT}px">
      <button data-chip>marketing-website-preview</button>
      <span data-preset style="display: inline-flex"><button>Research</button></span>
      <div data-options style="display: flex; column-gap: ${ROW_GAP}px; margin-left: auto">
        <div data-occupant-anchor style="display: contents">
          <button data-occupant>Use worktree</button>
        </div>
        <div data-anchor style="display: contents">
          <span data-seat style="display: inline-flex; margin: 0 4px 0 0"><button>workspace folders</button></span>
        </div>
      </div>
      <span data-trailing style="display: inline-flex"><button>after</button></span>
    </div>`
  document.body.append(root)
  const row = root.querySelector('[data-row]') as HTMLElement
  const chip = root.querySelector('[data-chip]') as HTMLElement
  const preset = root.querySelector('[data-preset]') as HTMLElement
  const seat = root.querySelector('[data-seat]') as HTMLElement
  const occupant = root.querySelector('[data-occupant]') as HTMLElement
  const width = options.rowWidth ?? ROW_WIDTH
  stubRect(row, 0, width)
  stubRect(chip, ROW_PADDING_LEFT, CHIP_WIDTH)
  // Chip (20..227) + 2px gap, preset 108 wide → the group's start is 339.
  stubRect(preset, ROW_PADDING_LEFT + CHIP_WIDTH + ROW_GAP, 108)
  // The seat sits at the row's right edge while the probe pins it to the floor.
  stubRect(seat, width - ROW_PADDING_RIGHT - 4 - HERO_ENTRY_ICON_PX, HERO_ENTRY_ICON_PX)
  stubRect(occupant, 340, options.occupant ?? 93)
  if (options.occupant === undefined) occupant.closest('[data-occupant-anchor]')?.remove()
  if (options.trailing !== true) root.querySelector('[data-trailing]')?.remove()
  return { row, seat, chip, occupant: options.occupant === undefined ? null : occupant }
}

describe('the hero row lookup', () => {
  it('finds the flex row above the slot outlet\'s contents anchors', () => {
    const { row, seat } = mountRow()
    expect(heroRowOf(seat)).toBe(row)
  })

  it('returns null outside a flex row, so the component keeps its fallback', () => {
    const stray = document.createElement('span')
    document.body.append(stray)
    expect(heroRowOf(stray)).toBeNull()
  })

  it('watches the row, the controls sharing it and the options group, never the seat', () => {
    const { row, seat, chip } = mountRow()
    const targets = heroRowWidthTargets(row, seat)
    expect(targets).toContain(row)
    expect(targets).toContain(chip)
    // The group container is watched on purpose: another occupant appearing
    // changes its width, and the probe is idempotent.
    expect(targets).toContain(row.querySelector('[data-options]'))
    expect(targets).not.toContain(seat)
  })

  it('watches a same-slot occupant so its width changes trigger a re-measure', () => {
    const { row, seat, occupant } = mountRow({ occupant: 93 })
    expect(occupant).not.toBeNull()
    expect(heroRowWidthTargets(row, seat)).toContain(occupant)
  })
})

describe('the measured room', () => {
  it('spends the group budget after the preceding control, less its own inset', () => {
    // Row content 20..484; the group starts at 337 + 2 = 339; 145 available;
    // the seat's 4px inset comes off it.
    const { seat } = mountRow()
    expect(measureHeroEntryRoom(seat)).toBe(141)
  })

  it('subtracts the other occupants of the options group and their gaps', () => {
    // 145 - 93 (occupant) - 2 (group gap) - 4 (inset).
    const { seat } = mountRow({ occupant: 93 })
    expect(measureHeroEntryRoom(seat)).toBe(46)
  })

  it('falls back to the row content edge when nothing precedes the group', () => {
    const { row, seat } = mountRow()
    row.querySelector('[data-chip]')?.remove()
    row.querySelector('[data-preset]')?.remove()
    // 484 - 20 (content left) - 4 (inset).
    expect(measureHeroEntryRoom(seat)).toBe(460)
  })

  it('never reports less than the icon floor, even when the row already overflows', () => {
    const { seat } = mountRow({ rowWidth: 300 })
    // The group starts at 339, past the 284px content edge, so no room is left.
    expect(measureHeroEntryRoom(seat)).toBe(HERO_ENTRY_ICON_PX)
  })

  it('refuses a control after the group, whose share this budget cannot see', () => {
    const { seat } = mountRow({ trailing: true })
    expect(measureHeroEntryRoom(seat)).toBeNull()
  })

  it('leaves the probe attribute behind only for the duration of the read', () => {
    const { seat } = mountRow()
    let seen = false
    const original = seat.getBoundingClientRect.bind(seat)
    Object.defineProperty(seat, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        seen = seat.hasAttribute('data-measuring')
        return original()
      },
    })
    expect(measureHeroEntryRoom(seat)).toBe(141)
    expect(seen).toBe(true)
    expect(seat.hasAttribute('data-measuring')).toBe(false)
  })

  it('refuses to measure a seat that is not pinned to the icon floor', () => {
    // A missing sheet (or a hidden row) would otherwise report a squeezed row
    // from the label's own width, which is the one wrong answer that looks right.
    const { seat } = mountRow()
    stubRect(seat, 300, 143)
    expect(measureHeroEntryRoom(seat)).toBeNull()
  })

  it('returns null without the flex row it expects', () => {
    const stray = document.createElement('span')
    document.body.append(stray)
    stubRect(stray, 0, HERO_ENTRY_ICON_PX)
    expect(measureHeroEntryRoom(stray)).toBeNull()
  })
})

describe('the form threshold', () => {
  it('shows the label at and above the minimum room', () => {
    expect(heroEntryForm(HERO_ENTRY_LABEL_MIN_PX)).toBe('full')
    expect(heroEntryForm(HERO_ENTRY_LABEL_MIN_PX + 1)).toBe('full')
    expect(heroEntryForm(240)).toBe('full')
  })

  it('keeps the icon alone below the minimum room', () => {
    expect(heroEntryForm(HERO_ENTRY_LABEL_MIN_PX - 1)).toBe('compact')
    expect(heroEntryForm(HERO_ENTRY_ICON_PX)).toBe('compact')
    expect(heroEntryForm(0)).toBe('compact')
  })

  it('has no form before the room is known', () => {
    expect(heroEntryForm(null)).toBeUndefined()
  })
})
