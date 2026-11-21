// @vitest-environment jsdom
/**
 * The root list's one-row measurement: a narrow dialog wraps a row's actions
 * below its text, so the list floor follows the tallest rendered row instead
 * of assuming one normal row height.
 */

import { describe, expect, it } from 'vitest'
import { measureRootRowHeight } from '../src/client/root-row-room.ts'

/** A DOMRect carrying the height the measurement reads. */
function rect(height: number): DOMRect {
  return { x: 0, y: 0, width: 0, height, top: 0, right: 0, bottom: height, left: 0, toJSON: () => ({}) }
}

/** A list element holding one row per height. */
function listWithHeights(heights: readonly number[]): HTMLElement {
  const list = document.createElement('div')
  for (const height of heights) {
    const row = document.createElement('div')
    row.className = 'mrfw-row'
    row.getBoundingClientRect = () => rect(height)
    list.append(row)
  }
  return list
}

describe('measureRootRowHeight', () => {
  it('returns the tallest row rounded up', () => {
    expect(measureRootRowHeight(listWithHeights([64.2, 131.7, 100]))).toBe(132)
  })

  it('returns zero when no row is measurable', () => {
    expect(measureRootRowHeight(document.createElement('div'))).toBe(0)
    expect(measureRootRowHeight(listWithHeights([0]))).toBe(0)
  })

  it('ignores children that are not root rows', () => {
    const list = document.createElement('div')
    const note = document.createElement('p')
    note.getBoundingClientRect = () => rect(400)
    const row = document.createElement('div')
    row.className = 'mrfw-row'
    row.getBoundingClientRect = () => rect(66)
    list.append(note, row)
    expect(measureRootRowHeight(list)).toBe(66)
  })
})
