// @vitest-environment jsdom
/**
 * The width budget and text measurement behind the root-name fit.
 *
 * jsdom has no layout, so every element's box is stubbed and the flex gaps and
 * paddings come from inline styles (which jsdom does resolve). The tests pin
 * the arithmetic: which children are fixed, which one yields, and how the
 * trigger's own chrome is kept out of the label budget.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLabelMeasurer, rootNameLabelBudget } from '../src/client/root-name-room.ts'

/** One named box a fixture element reports. */
const boxes = new Map<Element, number>()

/** Give an element a fixed viewport width and a zero-height row box. */
function stubBox(element: Element, width: number): void {
  boxes.set(element, width)
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0, right: width, width, top: 0, bottom: 38, height: 38, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect),
  })
}

/** The elements one mounted header fixture exposes. */
interface Fixture {
  readonly switcher: HTMLElement
  readonly button: HTMLElement
  readonly label: HTMLElement
  readonly probe: HTMLElement
  readonly path: HTMLElement
  readonly controls: readonly HTMLElement[]
}

/**
 * Mount one switcher row: the trigger anchor, the path label, and whatever
 * fixed in-row controls the caller asks for.
 * @param options - which controls to render and how wide each box is.
 * @returns the elements the tests measure against.
 */
function mountRow(options: {
  readonly switcherWidth?: number
  readonly controls?: boolean
} = {}): Fixture {
  document.body.innerHTML = `
    <span class="mrfw-rootSwitcher" style="display: flex; column-gap: 4px">
      <span class="mrfw-rootSwitchAnchor" style="display: inline-flex">
        <button class="mrfw-rootSwitchBtn" style="display: inline-flex; column-gap: 4px; padding: 0 4px">
          <span class="mrfw-triggerIcon">folder</span>
          <span class="mrfw-rootSwitchLabel">dsh-plugin-multi-root-workspace</span>
          <span class="mrfw-triggerIcon mrfw-rootSwitchChevron">chevron</span>
          <span class="mrfw-rootSwitchProbe" aria-hidden="true"></span>
        </button>
      </span>
      <span class="mrfw-switcherPath" style="margin-right: 12px"></span>
      ${options.controls === true
    ? '<button class="mrfw-switcherReload"></button><button class="mrfw-switcherSearch"></button><span class="mrfw-openAnchor"></span>'
    : ''}
    </span>`
  const switcher = document.querySelector('.mrfw-rootSwitcher') as HTMLElement
  const button = document.querySelector('.mrfw-rootSwitchBtn') as HTMLElement
  const label = document.querySelector('.mrfw-rootSwitchLabel') as HTMLElement
  const probe = document.querySelector('.mrfw-rootSwitchProbe') as HTMLElement
  const path = document.querySelector('.mrfw-switcherPath') as HTMLElement
  const controls = Array.from(switcher.querySelectorAll('.mrfw-switcherReload, .mrfw-switcherSearch, .mrfw-openAnchor')) as HTMLElement[]
  stubBox(switcher, options.switcherWidth ?? 400)
  for (const icon of Array.from(button.querySelectorAll('.mrfw-triggerIcon'))) stubBox(icon, icon.classList.contains('mrfw-rootSwitchChevron') ? 14 : 16)
  stubBox(probe, 0)
  stubBox(label, options.switcherWidth ?? 400)
  const [reload, search, open] = controls
  if (reload !== undefined) stubBox(reload, 28)
  if (search !== undefined) stubBox(search, 28)
  if (open !== undefined) stubBox(open, 43)
  return { switcher, button, label, probe, path, controls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  boxes.clear()
  document.body.innerHTML = ''
})

describe('the root-name label budget', () => {
  it('subtracts the trigger chrome, the row gaps and the path gutter', () => {
    const { switcher, button, label } = mountRow()
    // 400 switcher - 4 gap - 12 path gutter - 0 fixed, then the button's own
    // 8px padding + 2 gaps (8px) + folder (16) + chevron (14).
    expect(rootNameLabelBudget(switcher, button, label)).toBe(400 - 4 - 12 - 46)
  })

  it('subtracts the fixed controls the takeover renders inside the row', () => {
    const { switcher, button, label } = mountRow({ controls: true })
    // 5 children, 4 gaps; the reload, search and open-in-app boxes are fixed.
    expect(rootNameLabelBudget(switcher, button, label)).toBe(400 - 16 - 12 - 28 - 28 - 43 - 46)
  })

  it('ignores the probe candidate text it measures with', () => {
    const { switcher, button, label, probe } = mountRow()
    const before = rootNameLabelBudget(switcher, button, label)
    probe.textContent = 'a very long candidate string that is not part of the row'
    stubBox(probe, 300)
    expect(rootNameLabelBudget(switcher, button, label)).toBe(before)
  })

  it('never reports a negative budget', () => {
    const { switcher, button, label } = mountRow({ switcherWidth: 20, controls: true })
    expect(rootNameLabelBudget(switcher, button, label)).toBe(0)
  })
})

describe('the label text measurer', () => {
  it('measures in the label font through an offscreen canvas when one exists', () => {
    const { label, probe } = mountRow()
    const measureText = vi.fn((text: string) => ({ width: text.length * 5 }))
    const context = { font: '', measureText }
    vi.stubGlobal('OffscreenCanvas', class {
      getContext(): typeof context { return context }
    })
    const measure = createLabelMeasurer(label, probe)
    expect(measure('abcd')).toBe(20)
    expect(measureText).toHaveBeenCalledWith('abcd')
    expect(context.font).not.toBe('')
  })

  it('falls back to the hidden probe when no offscreen canvas exists', () => {
    const { label, probe } = mountRow()
    Object.defineProperty(probe, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const width = (probe.textContent ?? '').length * 7
        return { left: 0, right: width, width, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      },
    })
    const measure = createLabelMeasurer(label, probe)
    expect(measure('abc')).toBe(21)
    expect(probe.textContent).toBe('abc')
  })
})
