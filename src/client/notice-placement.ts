/** Placement math and React lifecycle for the worktree suggestion notice. */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  observeConversationLayout,
  readConversationLayout,
  type ConversationLayout,
  type PlacementRect,
} from '../compat/client-conversation-layout.ts'

/** The notice's fixed seat, in viewport pixels. */
export type NoticePlacement = {
  readonly placement: 'hero' | 'conversation'
  readonly top: number
  readonly left: number
  readonly maxWidth: number
  readonly compact: boolean
}

/** What the pure resolver needs; every optional rect may have failed its probe. */
export interface PlacementInput extends ConversationLayout {
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly coarsePointer: boolean
}

/** The official Toast's top edge, which the Hero notice mirrors. */
export const HERO_TOP = 40
/** The official Toast's height (12+12 padding, 22 line) plus one gap. */
export const UPSTREAM_TOAST_SHIFT = 56
/** The gap below the conversation Header. */
export const CONVERSATION_TOP_GAP = 12
/** The widest the notice may grow. */
export const MAX_NOTICE_WIDTH = 560
/** The side inset when only the viewport is measurable. */
export const VIEWPORT_SIDE_INSET = 32
/** The side inset inside the conversation column. */
export const CONTENT_SIDE_INSET = 48
/** Below this measured width the two-row compact form takes over. */
export const COMPACT_MAX_WIDTH = 460

const MIN_VISIBLE_SIZE = 1

function usable(rect: PlacementRect | undefined): rect is PlacementRect {
  return rect !== undefined && rect.width >= MIN_VISIBLE_SIZE && rect.height >= MIN_VISIBLE_SIZE
}

/**
 * Resolve the notice's seat from the current page facts.
 * @param input - the page phase, viewport, optional rects, and pointer facts.
 * @returns the fixed seat; a missing conversation rect degrades to the Hero form.
 */
export function resolveNoticePlacement(input: PlacementInput): NoticePlacement {
  if (input.phase === 'conversation' && usable(input.content)) {
    const content = input.content
    const maxWidth = Math.max(0, Math.min(MAX_NOTICE_WIDTH, content.width - CONTENT_SIDE_INSET))
    return {
      placement: 'conversation',
      top: content.top + CONVERSATION_TOP_GAP,
      left: content.left + content.width / 2,
      maxWidth,
      compact: input.coarsePointer || maxWidth < COMPACT_MAX_WIDTH,
    }
  }
  const root = usable(input.root) ? input.root : undefined
  const composer = usable(input.composer) ? input.composer : undefined
  const columnWidth = root?.width ?? input.viewportWidth
  const maxWidth = Math.max(0, Math.min(MAX_NOTICE_WIDTH, columnWidth - VIEWPORT_SIDE_INSET))
  const center = composer !== undefined
    ? composer.left + composer.width / 2
    : root !== undefined
      ? root.left + root.width / 2
      : input.viewportWidth / 2
  return {
    placement: 'hero',
    top: HERO_TOP + (input.upstreamToast ? UPSTREAM_TOAST_SHIFT : 0),
    left: center,
    maxWidth,
    compact: input.coarsePointer || maxWidth < COMPACT_MAX_WIDTH,
  }
}

/**
 * The inline fixed-position style for one resolved seat.
 * @param placement - the seat resolved for the current page.
 * @returns the style object; compact seats take the measured width.
 */
export function noticeStyle(placement: NoticePlacement): CSSProperties {
  return {
    top: placement.top,
    left: placement.left,
    maxWidth: placement.maxWidth,
    ...(placement.compact ? { width: placement.maxWidth } : {}),
  }
}

function coarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: coarse)').matches
}

/**
 * Read the current page facts and resolve the notice's seat.
 * @param doc - the document whose markers and rects are read.
 * @param viewport - the viewport size.
 * @returns the resolved seat; missing probes fall back to the Hero form.
 */
export function readNoticePlacement(doc: Document, viewport: { readonly width: number; readonly height: number }): NoticePlacement {
  return resolveNoticePlacement({
    ...readConversationLayout(doc),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    coarsePointer: coarsePointer(),
  })
}

function samePlacement(left: NoticePlacement, right: NoticePlacement): boolean {
  return left.placement === right.placement
    && Math.abs(left.top - right.top) < 0.5
    && Math.abs(left.maxWidth - right.maxWidth) < 0.5
    && left.compact === right.compact
    && Math.abs(left.left - right.left) < 0.5
}

/**
 * Keep the notice on the current page seat while it is visible.
 *
 * Only runs while [[active]] is true. Layout and phase changes are coalesced
 * into one microtask so a streaming transcript cannot turn every mutation into
 * a synchronous layout read.
 * @param active - whether the notice is currently shown.
 * @returns the latest seat, or undefined before the first measurement.
 */
export function useNoticePlacement(active: boolean): NoticePlacement | undefined {
  const [placement, setPlacement] = useState<NoticePlacement | undefined>(undefined)
  const latest = useRef<NoticePlacement | undefined>(undefined)
  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined' || typeof document === 'undefined') return
    let disposed = false
    let scheduled = false
    const measure = (): void => {
      if (disposed) return
      const next = readNoticePlacement(document, { width: window.innerWidth, height: window.innerHeight })
      const previous = latest.current
      if (previous !== undefined && samePlacement(previous, next)) return
      latest.current = next
      setPlacement(next)
    }
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; measure() })
    }
    measure()
    window.addEventListener('resize', schedule)
    const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : undefined
    coarse?.addEventListener('change', schedule)
    const stopObserving = observeConversationLayout(document, schedule)
    return () => {
      disposed = true
      window.removeEventListener('resize', schedule)
      coarse?.removeEventListener('change', schedule)
      stopObserving()
    }
  }, [active])
  return placement
}
