/**
 * Placement math and DOM probes for the worktree suggestion notice.
 *
 * The notice lives in the shell's overlay slot, outside the conversation tree,
 * so following the page requires read-only probes of upstream markers plus the
 * composer/content rectangles. The resolver stays pure so the arithmetic is
 * testable; the adapter reads the installed DOM and degrades to the Hero
 * top-center seat whenever a probe is missing.
 *
 * Markers read here, never class names:
 * - \[data-phase\] on the main conversation root (hero / active / settling).
 * - \[data-composer-card\] for the Hero horizontal center.
 * - \[data-conversation-content\] for the active content top (0.2.1-alpha.3+);
 *   older releases measure the root's first child (the Header) instead.
 * - Direct role="alert" children of body are the upstream transient Toast;
 *   while one is present the Hero notice moves below it.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/notice-placement
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** One element rectangle; the subset of DOMRect the placement math reads. */
export interface PlacementRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

/** The page phase the conversation root publishes. */
export type ConversationPhase = 'hero' | 'conversation' | 'unknown'

/** The notice's fixed seat, in viewport pixels. */
export type NoticePlacement =
  | { readonly placement: 'hero'; readonly top: number; readonly left: number; readonly maxWidth: number; readonly compact: boolean }
  | { readonly placement: 'conversation'; readonly top: number; readonly right: number; readonly maxWidth: number; readonly compact: boolean }

/** What the pure resolver needs; every optional rect may have failed its probe. */
export interface PlacementInput {
  readonly phase: ConversationPhase
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly composer?: PlacementRect | undefined
  readonly content?: PlacementRect | undefined
  readonly root?: PlacementRect | undefined
  readonly upstreamToast: boolean
  readonly coarsePointer: boolean
}

/** The official Toast's top edge, which the Hero notice mirrors. */
export const HERO_TOP = 40
/** The official Toast's height (12+12 padding, 22 line) plus one gap. */
export const UPSTREAM_TOAST_SHIFT = 56
/** The gap below the conversation Header. */
export const CONVERSATION_TOP_GAP = 12
/** The inset from the conversation column's right edge. */
export const CONVERSATION_RIGHT_INSET = 24
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
      right: input.viewportWidth - content.right + CONVERSATION_RIGHT_INSET,
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
  const base: CSSProperties = {
    top: placement.top,
    maxWidth: placement.maxWidth,
    ...(placement.compact ? { width: placement.maxWidth } : {}),
  }
  return placement.placement === 'conversation'
    ? { ...base, right: placement.right }
    : { ...base, left: placement.left }
}

function phaseOf(value: string | undefined): ConversationPhase {
  return value === 'active' ? 'conversation' : value === 'hero' || value === 'settling' ? 'hero' : 'unknown'
}

function rectOf(element: Element | null | undefined): PlacementRect | undefined {
  if (element === null || element === undefined) return undefined
  const rect = element.getBoundingClientRect()
  if (rect.width < MIN_VISIBLE_SIZE || rect.height < MIN_VISIBLE_SIZE) return undefined
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
}

function contentFromHeader(root: Element | null, rootRect: PlacementRect | undefined): PlacementRect | undefined {
  if (root === null || rootRect === undefined) return undefined
  const header = rectOf(root.firstElementChild)
  const top = header === undefined ? rootRect.top : header.bottom
  return { ...rootRect, top, height: Math.max(0, rootRect.bottom - top) }
}

function upstreamToastVisible(doc: Document): boolean {
  const body = doc.body
  if (body === null) return false
  for (const child of Array.from(body.children)) {
    if (child.getAttribute('role') === 'alert') return true
  }
  return false
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
  const root = doc.querySelector<HTMLElement>('[data-phase]')
  const rootRect = rectOf(root)
  const phase = phaseOf(root?.dataset.phase)
  const content = phase === 'conversation'
    ? rectOf(root?.querySelector('[data-conversation-content]')) ?? contentFromHeader(root, rootRect)
    : undefined
  return resolveNoticePlacement({
    phase,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    composer: rectOf(doc.querySelector('[data-composer-card]')),
    content,
    root: rootRect,
    upstreamToast: upstreamToastVisible(doc),
    coarsePointer: coarsePointer(),
  })
}

function samePlacement(left: NoticePlacement, right: NoticePlacement): boolean {
  return left.placement === right.placement
    && Math.abs(left.top - right.top) < 0.5
    && Math.abs(left.maxWidth - right.maxWidth) < 0.5
    && left.compact === right.compact
    && (left.placement === 'hero'
      ? right.placement === 'hero' && Math.abs(left.left - right.left) < 0.5
      : right.placement === 'conversation' && Math.abs(left.right - right.right) < 0.5)
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
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
    if (resizeObserver !== undefined) {
      for (const element of [document.querySelector('[data-phase]'), document.querySelector('[data-composer-card]')]) {
        if (element !== null) resizeObserver.observe(element)
      }
    }
    const attributes = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : undefined
    attributes?.observe(document.body, { attributes: true, attributeFilter: ['data-phase', 'data-content-phase'], subtree: true })
    const bodyChildren = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : undefined
    bodyChildren?.observe(document.body, { childList: true })
    return () => {
      disposed = true
      window.removeEventListener('resize', schedule)
      coarse?.removeEventListener('change', schedule)
      resizeObserver?.disconnect()
      attributes?.disconnect()
      bodyChildren?.disconnect()
    }
  }, [active])
  return placement
}
