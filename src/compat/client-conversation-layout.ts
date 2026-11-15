/** Read and observe the upstream conversation and Toast DOM across releases. */

const ROOT = '[data-phase]'
const COMPOSER = '[data-composer-card]'
const CONTENT = '[data-conversation-content]'
const LAYOUT_MARKERS = [ROOT, COMPOSER, CONTENT].join(',')

export type PlacementRect = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>

export interface ConversationLayout {
  readonly phase: 'hero' | 'conversation' | 'unknown'
  readonly composer?: PlacementRect | undefined
  readonly content?: PlacementRect | undefined
  readonly root?: PlacementRect | undefined
  readonly upstreamToast: boolean
}

function conversationElements(doc: Document) {
  const root = doc.querySelector<HTMLElement>(ROOT)
  const active = root?.dataset.phase === 'active'
  return {
    root,
    composer: doc.querySelector(COMPOSER),
    content: active ? root.querySelector(CONTENT) : null,
    header: active ? root.firstElementChild : null,
  }
}

function visibleRect(element: Element | null): PlacementRect | undefined {
  const rect = element?.getBoundingClientRect()
  return rect !== undefined && rect.width >= 1 && rect.height >= 1 ? rect : undefined
}

function contentBelowHeader(root: PlacementRect | undefined, header: PlacementRect | undefined): PlacementRect | undefined {
  if (root === undefined) return undefined
  const top = header?.bottom ?? root.top
  return { left: root.left, right: root.right, top, bottom: root.bottom, width: root.width, height: Math.max(0, root.bottom - top) }
}

/** Prefer the content marker. Older hosts expose only the root's first-child Header. */
export function readConversationLayout(doc: Document): ConversationLayout {
  const elements = conversationElements(doc)
  const value = elements.root?.dataset.phase
  const phase = value === 'active' ? 'conversation' : value === 'hero' || value === 'settling' ? 'hero' : 'unknown'
  const root = visibleRect(elements.root)
  return {
    phase,
    root,
    composer: visibleRect(elements.composer),
    content: phase === 'conversation'
      ? visibleRect(elements.content) ?? contentBelowHeader(root, visibleRect(elements.header))
      : undefined,
    // The upstream transient Toast is a direct role="alert" child of body.
    upstreamToast: Array.from(doc.body?.children ?? []).some(child => child.getAttribute('role') === 'alert'),
  }
}

function containsLayoutMarker(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const element = node as Element
  return element.matches(LAYOUT_MARKERS) || element.querySelector(LAYOUT_MARKERS) !== null
}

/** Rebind geometry observers when the shell mounts, replaces, or changes phase. */
export function observeConversationLayout(doc: Document, onChange: () => void): () => void {
  const body = doc.body
  if (body === null) return () => {}
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(onChange) : undefined
  let root: Element | null = null
  let observed = new Set<Element>()
  const observeElements = (): void => {
    const elements = conversationElements(doc)
    root = elements.root
    const next = new Set(Object.values(elements).filter((element): element is Element => element !== null))
    for (const element of observed) if (!next.has(element)) resize?.unobserve(element)
    for (const element of next) if (!observed.has(element)) resize?.observe(element)
    observed = next
  }
  observeElements()

  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.type === 'attributes') return record.attributeName !== 'role' || record.target.parentNode === body
      if (record.target === body || record.target === root) return true
      return Array.from(record.addedNodes).some(containsLayoutMarker) || Array.from(record.removedNodes).some(containsLayoutMarker)
    })
    if (!relevant) return
    observeElements()
    onChange()
  }) : undefined
  mutations?.observe(body, {
    childList: true,
    subtree: true,
    attributeFilter: ['data-phase', 'data-content-phase', 'data-composer-card', 'data-conversation-content', 'role'],
  })
  return () => {
    resize?.disconnect()
    mutations?.disconnect()
  }
}
