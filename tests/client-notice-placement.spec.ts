// @vitest-environment jsdom
/**
 * Placement math and probes for the worktree suggestion notice.
 *
 * The component suite covers the notice's contents; this suite pins the seats
 * themselves: Hero centers on the composer, the conversation seat sits below
 * the measured Header, the upstream Toast pushes the Hero seat down, and every
 * missing marker degrades to the Hero form instead of the old bottom-right
 * corner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PlacementRect } from '../src/compat/client-conversation-layout.ts'
import {
  CONVERSATION_TOP_GAP,
  HERO_TOP,
  MAX_NOTICE_WIDTH,
  UPSTREAM_TOAST_SHIFT,
  noticeStyle,
  readNoticePlacement,
  resolveNoticePlacement,
  useNoticePlacement,
} from '../src/client/notice-placement.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

/** A laid-out rect. */
function rect(left: number, top: number, width: number, height: number): PlacementRect {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

/** Pin one element's measured box. */
function mockRect(element: Element, box: PlacementRect): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect)
}

const viewport = { width: 1200, height: 900 }

describe('resolveNoticePlacement', () => {
  it('centers the Hero seat on the composer card and mirrors the official top', () => {
    const placement = resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      composer: rect(300, 400, 600, 160), upstreamToast: false, coarsePointer: false,
    })
    expect(placement).toEqual({ placement: 'hero', top: HERO_TOP, left: 600, maxWidth: MAX_NOTICE_WIDTH, compact: false })
  })

  it('falls back to the conversation column, then the viewport, when the composer is absent', () => {
    const root = rect(200, 0, 800, 900)
    expect(resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      root, upstreamToast: false, coarsePointer: false,
    })).toMatchObject({ placement: 'hero', left: 600 })
    expect(resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      upstreamToast: false, coarsePointer: false,
    })).toMatchObject({ placement: 'hero', left: 600, maxWidth: MAX_NOTICE_WIDTH })
  })

  it('moves the Hero seat below an upstream transient Toast', () => {
    expect(resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      upstreamToast: true, coarsePointer: false,
    })).toMatchObject({ top: HERO_TOP + UPSTREAM_TOAST_SHIFT })
  })

  it('places the conversation seat below the content top and centers it', () => {
    const placement = resolveNoticePlacement({
      phase: 'conversation', viewportWidth: viewport.width, viewportHeight: viewport.height,
      content: rect(0, 76, 1200, 800), upstreamToast: false, coarsePointer: false,
    })
    expect(placement).toEqual({
      placement: 'conversation',
      top: 76 + CONVERSATION_TOP_GAP,
      left: 600,
      maxWidth: MAX_NOTICE_WIDTH,
      compact: false,
    })
  })

  it('switches to the compact form on a narrow column or a coarse pointer', () => {
    const narrow = resolveNoticePlacement({
      phase: 'conversation', viewportWidth: 500, viewportHeight: 800,
      content: rect(0, 76, 420, 700), upstreamToast: false, coarsePointer: false,
    })
    expect(narrow).toMatchObject({ maxWidth: 420 - 48, compact: true })
    const coarse = resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      upstreamToast: false, coarsePointer: true,
    })
    expect(coarse).toMatchObject({ compact: true })
  })

  it('never uses a conversation seat without a measured content rect', () => {
    expect(resolveNoticePlacement({
      phase: 'conversation', viewportWidth: viewport.width, viewportHeight: viewport.height,
      root: rect(200, 0, 800, 900), upstreamToast: false, coarsePointer: false,
    })).toMatchObject({ placement: 'hero' })
  })
})

describe('noticeStyle', () => {
  it('anchors both seats by left', () => {
    const hero = resolveNoticePlacement({
      phase: 'hero', viewportWidth: viewport.width, viewportHeight: viewport.height,
      upstreamToast: false, coarsePointer: false,
    })
    expect(noticeStyle(hero)).toMatchObject({ top: HERO_TOP, left: 600, maxWidth: MAX_NOTICE_WIDTH })
    expect(noticeStyle(hero)).not.toHaveProperty('right')
    const conversation = resolveNoticePlacement({
      phase: 'conversation', viewportWidth: viewport.width, viewportHeight: viewport.height,
      content: rect(0, 76, 1200, 800), upstreamToast: false, coarsePointer: false,
    })
    expect(noticeStyle(conversation)).toMatchObject({ top: 88, left: 600 })
  })

  it('pins the compact seat to the measured width', () => {
    const placement = resolveNoticePlacement({
      phase: 'conversation', viewportWidth: 500, viewportHeight: 800,
      content: rect(0, 76, 420, 700), upstreamToast: false, coarsePointer: false,
    })
    expect(noticeStyle(placement)).toMatchObject({ width: 372 })
  })
})

describe('readNoticePlacement', () => {
  it('reads the Hero phase and centers on the measured composer', () => {
    document.body.innerHTML = '<main><div data-phase="hero"></div><div data-composer-card></div></main>'
    mockRect(document.querySelector('[data-phase]')!, rect(200, 0, 800, 900))
    mockRect(document.querySelector('[data-composer-card]')!, rect(300, 400, 600, 160))
    expect(readNoticePlacement(document, viewport)).toMatchObject({ placement: 'hero', top: HERO_TOP, left: 600 })
  })

  it('reads the conversation content marker when the release carries it', () => {
    document.body.innerHTML = '<div data-phase="active"><header></header><div data-conversation-content></div></div>'
    mockRect(document.querySelector('[data-phase]')!, rect(0, 0, 1200, 900))
    mockRect(document.querySelector('[data-conversation-content]')!, rect(0, 76, 1200, 824))
    expect(readNoticePlacement(document, viewport)).toMatchObject({
      placement: 'conversation', top: 76 + CONVERSATION_TOP_GAP, left: 600,
    })
  })

  it('measures the Header itself when the content marker is absent', () => {
    document.body.innerHTML = '<div data-phase="active"><header></header></div>'
    mockRect(document.querySelector('[data-phase]')!, rect(0, 0, 1200, 900))
    mockRect(document.querySelector('header')!, rect(0, 0, 1200, 76))
    expect(readNoticePlacement(document, viewport)).toMatchObject({ placement: 'conversation', top: 76 + CONVERSATION_TOP_GAP })
  })

  it('moves the Hero seat down while an upstream Toast is in body', () => {
    document.body.innerHTML = '<div data-phase="hero"></div><div role="alert"></div>'
    mockRect(document.querySelector('[data-phase]')!, rect(200, 0, 800, 900))
    expect(readNoticePlacement(document, viewport)).toMatchObject({ top: HERO_TOP + UPSTREAM_TOAST_SHIFT })
  })

  it('degrades to the viewport Hero seat without any marker', () => {
    expect(readNoticePlacement(document, viewport)).toMatchObject({
      placement: 'hero', top: HERO_TOP, left: 600, maxWidth: MAX_NOTICE_WIDTH,
    })
  })
})

describe('useNoticePlacement', () => {
  it('observes a late-mounted content area, its resize and the replacement conversation', async () => {
    const observed = new Set<Element>()
    let onResize: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { onResize = callback }
      observe(element: Element): void { observed.add(element) }
      unobserve(element: Element): void { observed.delete(element) }
      disconnect(): void { observed.clear() }
    })
    const container = document.createElement('main')
    document.body.append(container)
    const { result, unmount } = renderHook(() => useNoticePlacement(true))
    expect(result.current?.placement).toBe('hero')

    container.innerHTML = '<div data-phase="active"><header></header><section data-conversation-content></section></div>'
    const root = container.firstElementChild!
    const content = root.querySelector('[data-conversation-content]')!
    mockRect(root, rect(200, 0, 800, 900))
    mockRect(content, rect(200, 76, 800, 824))
    await waitFor(() => expect(result.current).toMatchObject({ placement: 'conversation', top: 88, left: 600 }))
    expect(observed.has(content)).toBe(true)

    mockRect(content, rect(200, 96, 600, 804))
    await act(async () => onResize?.())
    expect(result.current).toMatchObject({ top: 108, left: 500 })

    container.innerHTML = '<div data-phase="active"><header></header></div>'
    const replacement = container.firstElementChild!
    const header = replacement.firstElementChild!
    mockRect(replacement, rect(300, 0, 700, 900))
    mockRect(header, rect(300, 0, 700, 64))
    await waitFor(() => expect(result.current).toMatchObject({ top: 76, left: 650 }))
    expect(observed.has(header)).toBe(true)
    expect(observed.has(content)).toBe(false)
    unmount()
    expect(observed.size).toBe(0)
  })
})
