// @vitest-environment jsdom
/**
 * The New Session hero entry's width adaptation, driven the way the browser
 * drives it: a synthetic hero row supplies the flex structure, stubbed boxes
 * supply the geometry jsdom has no layout for, and a stub ResizeObserver plays
 * the row's width changes back to the component.
 *
 * The stylesheet side (what `data-size` and the room custom property do) is
 * pinned by `client-styles.spec.ts`; the geometry math lives in
 * `client-hero-room.spec.ts`.
 */

import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroWorkspaceEntry } from '../src/client/HeroWorkspaceEntry.tsx'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

/** A translator that echoes its key, matching the harness convention. */
const t: Translate = key => key

/** One observed target set per constructed observer. */
interface ObserverRecord {
  readonly callback: () => void
  readonly observed: Set<Element>
  disconnected: boolean
}

const observers: ObserverRecord[] = []

/** Stand-in for the browser's ResizeObserver, which jsdom does not provide. */
class StubResizeObserver {
  private readonly record: ObserverRecord

  constructor(callback: () => void) {
    this.record = { callback, observed: new Set<Element>(), disconnected: false }
    observers.push(this.record)
  }

  observe(target: Element): void {
    this.record.observed.add(target)
  }

  unobserve(target: Element): void {
    this.record.observed.delete(target)
  }

  disconnect(): void {
    this.record.disconnected = true
  }
}

/** Viewport facts the stubbed layout answers with. */
const layout = { rowWidth: 500 }

/** The left/width the stub reports for one element. */
function boxOf(element: Element): { left: number; width: number } | null {
  if (element.classList.contains('mrfw-heroEntrySeat')) {
    return { left: layout.rowWidth - 20, width: 28 }
  }
  if (element.getAttribute('data-testid') === 'row') return { left: 0, width: layout.rowWidth }
  if (element.getAttribute('data-testid') === 'chip') return { left: 20, width: 207 }
  return null
}

/** The props every case uses; the entry only needs a session reader here. */
const props = {
  panel: undefined,
  pickDirectory: undefined,
  sessionId: () => 'session-1',
  t,
}

/**
 * Render the entry inside a hero row shaped like the upstream one: padded flex
 * row, the workspace chip, then the options container and the slot outlet's
 * contents anchor. The stylesheet is not loaded here, so the seat's own 4px
 * inset is absent and the room is the group budget itself.
 * @param view - what the component renders; defaults to the hero entry.
 * @returns the render result.
 */
function renderInRow(view?: ReactNode): ReturnType<typeof render> {
  return render(
    <div data-testid="row" style={{ display: 'flex', columnGap: '2px', padding: '0 16px 0 20px' }}>
      <span data-testid="chip">marketing-website-preview</span>
      <div style={{ display: 'flex', marginLeft: 'auto' }}>
        <div style={{ display: 'contents' }}>
          {view ?? <HeroWorkspaceEntry {...props} />}
        </div>
      </div>
    </div>,
  )
}

/** The seat the entry rendered. */
function seatOf(container: HTMLElement): HTMLElement {
  return container.querySelector('.mrfw-heroEntrySeat') as HTMLElement
}

beforeEach(() => {
  observers.length = 0
  layout.rowWidth = 500
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  const original = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxOf(this)
    if (box === null) return original.call(this)
    return {
      left: box.left, right: box.left + box.width, width: box.width,
      top: 0, bottom: 28, height: 28, x: box.left, y: 0, toJSON: () => ({}),
    } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the hero entry inside a hero row', () => {
  it('clamps itself to the room the row leaves and keeps the label', () => {
    const view = renderInRow()
    const seat = seatOf(view.container)
    // Content 20..484; the group starts at 20 + 207 + 2 = 229 → 255 available.
    expect(seat.getAttribute('data-size')).toBe('full')
    expect(seat.style.getPropertyValue('--mrfw-hero-entry-room')).toBe('255px')
    expect(view.container.querySelector('.mrfw-heroEntryLabel')?.textContent).toBe('action.label')
  })

  it('keeps the icon alone when the room cannot hold a label', () => {
    layout.rowWidth = 300
    const view = renderInRow()
    const seat = seatOf(view.container)
    // Content 20..284 → 55 available, below the label minimum.
    expect(seat.getAttribute('data-size')).toBe('compact')
    expect(seat.style.getPropertyValue('--mrfw-hero-entry-room')).toBe('55px')
    // The label stays in the DOM so the stylesheet, not React, owns the
    // visual form; the accessible name rides aria-label in either form.
    const trigger = view.container.querySelector('.mrfw-heroEntry') as HTMLButtonElement
    expect(trigger.getAttribute('aria-label')).toBe('action.label')
    expect(trigger.getAttribute('title')).toBe('action.title')
  })

  it('observes the row, its controls and the options group, never the seat', () => {
    const view = renderInRow()
    const row = view.container.querySelector('[data-testid="row"]') as HTMLElement
    const chip = view.container.querySelector('[data-testid="chip"]') as HTMLElement
    const options = seatOf(view.container).closest('div[style*="flex"]') as HTMLElement | null
    const observer = observers.at(-1)
    expect(observer?.observed.has(row)).toBe(true)
    expect(observer?.observed.has(chip)).toBe(true)
    expect(options === null || observer?.observed.has(options)).toBe(true)
    expect(observer?.observed.has(seatOf(view.container))).toBe(false)
  })

  it('measures again when an observed box changes size', () => {
    const view = renderInRow()
    const seat = seatOf(view.container)
    layout.rowWidth = 300
    act(() => {
      observers.at(-1)?.callback()
    })
    expect(seat.getAttribute('data-size')).toBe('compact')
    expect(seat.style.getPropertyValue('--mrfw-hero-entry-room')).toBe('55px')
  })

  it('measures again after a re-render that leaves the row unchanged', () => {
    const view = renderInRow()
    const seat = seatOf(view.container)
    layout.rowWidth = 300
    // Locale switches hand down a new translator; the room probe runs again on
    // every commit, so the entry follows without waiting for a resize.
    view.rerender(
      <div data-testid="row" style={{ display: 'flex', columnGap: '2px', padding: '0 16px 0 20px' }}>
        <span data-testid="chip">marketing-website-preview</span>
        <div style={{ display: 'flex', marginLeft: 'auto' }}>
          <div style={{ display: 'contents' }}>
            <HeroWorkspaceEntry {...props} t={key => `next.${key}`} />
          </div>
        </div>
      </div>,
    )
    expect(seat.getAttribute('data-size')).toBe('compact')
  })

  it('stops observing once the entry unmounts', () => {
    const view = renderInRow()
    const observer = observers.at(-1)
    view.unmount()
    expect(observer?.disconnected).toBe(true)
  })

  it('survives StrictMode double-invoked effects with one live observer', () => {
    const view = renderInRow(<StrictMode><HeroWorkspaceEntry {...props} /></StrictMode>)
    expect(seatOf(view.container).getAttribute('data-size')).toBe('full')
    expect(observers.filter(observer => !observer.disconnected)).toHaveLength(1)
  })
})

describe('the hero entry outside a recognized row', () => {
  it('keeps the stylesheet fallback and does not observe anything', () => {
    const view = render(<HeroWorkspaceEntry {...props} />)
    const seat = seatOf(view.container)
    expect(seat.hasAttribute('data-size')).toBe(false)
    expect(seat.style.getPropertyValue('--mrfw-hero-entry-room')).toBe('')
    expect(view.container.querySelector('.mrfw-heroEntryLabel')?.textContent).toBe('action.label')
    expect(observers).toHaveLength(0)
  })
})
