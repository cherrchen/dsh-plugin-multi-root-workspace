/**
 * A test stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package is the host's own bundle: its published lib carries bare
 * `.module.css` imports and undeclared host-side dependencies (anser, shiki)
 * that only the web shell's bundler resolves, so the jsdom suite cannot load
 * the barrel. The stub keeps the panel spec focused on THIS plugin's wiring —
 * which icon sits in which button, which entries the row menu offers — with
 * the same DOM shape (an icon span, real buttons for the open menu). The real
 * components render in the browser and are covered by the journey smoke's web
 * leg, exactly like every other host-owned surface.
 *
 * @module stubs/ui-primitives
 */

import { Fragment, createElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Minimal `IconProps` mirror. */
interface IconProps {
  readonly size?: number
  readonly className?: string
}

/** One icon as a named svg placeholder: same element shape, no path data. */
function icon(name: string): (props: IconProps) => ReactNode {
  return props => createElement('svg', {
    'data-icon': name,
    width: props.size ?? 16,
    height: props.size ?? 16,
  })
}

export const IconChevronDownOutline14 = icon('chevron-down')
export const IconChevronUpOutline14 = icon('chevron-up')
export const IconCopyOutline16 = icon('copy')
export const IconEditOutline16 = icon('edit')
export const IconEllipsisOutline16 = icon('ellipsis')
export const IconFolderClose16 = icon('folder-close')
export const IconFolderOpenOutline16 = icon('folder-open')
export const IconPlusOutline16 = icon('plus')
export const IconRefreshOutline16 = icon('refresh')
export const IconSettingsOutline16 = icon('settings')
export const IconTrashOutline16 = icon('trash')

// The *Regular family the open-in-app fork spells verbatim (0.1.7+ names).
export const IconChevronDownOutlineRegular = icon('chevron-down')
export const IconRightUpOutlineRegular = icon('right-up')
export const IconFolderOpenOutlineRegular = icon('folder-open')
export const IconWarningOutlineRegular = icon('warning')

/** Minimal `Tooltip` mirror: the wrapper renders its content in place. */
export function Tooltip(props: {
  readonly label?: ReactNode
  readonly children?: ReactNode
}): ReactNode {
  return createElement(Fragment, null, props.children)
}

/** Minimal `Toast` mirror: a labeled banner that dismisses itself on click. */
export function Toast(props: {
  readonly text: string
  readonly icon?: ReactNode
  readonly onDone: () => void
}): ReactNode {
  return createElement(
    'div',
    { role: 'status', onClick: props.onDone },
    props.icon,
    props.text,
  )
}

/** Minimal `PathLabel` mirror: a titled span carrying the whole path. */
export function PathLabel(props: {
  readonly path: string
  readonly className?: string
}): ReactNode {
  return createElement(
    'span',
    { className: props.className, title: props.path, 'data-path-label': true },
    props.path,
  )
}

/** Minimal `Modal` mirror: closed renders nothing; open portals a labeled dialog. */
export function Modal(props: {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: string
  readonly closeLabel: string
  readonly footer?: ReactNode
  readonly children?: ReactNode
}): ReactNode {
  if (!props.open) return null
  return createPortal(
    createElement(
      'div',
      { role: 'dialog', 'aria-label': props.title },
      createElement('h2', null, props.title),
      props.description === undefined ? null : createElement('p', null, props.description),
      props.children,
      props.footer,
    ),
    document.body,
  )
}

/** Minimal `MenuItem` mirror (only the fields the panel uses). */
interface StubMenuItem {
  readonly id: string
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly icon?: ReactNode
}

/** Minimal `MenuEntry` mirror: a row, a hairline, or a heading. */
type StubMenuEntry =
  | StubMenuItem
  | { readonly type: 'separator'; readonly id: string }
  | { readonly type: 'label'; readonly id: string; readonly text: string }

/**
 * The anchored menu: the anchor renders in place, the open list portals to
 * `document.body` with one button per item — the same observable shape the
 * real `Menu` gives a jsdom test (placement, graceful close, and submenu
 * behavior are visual concerns this stub deliberately drops).
 */
export function Menu(props: {
  open: boolean
  anchor: ReactNode
  items: readonly StubMenuEntry[]
  footer?: readonly StubMenuEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
}): ReactNode {
  const entry = (item: StubMenuEntry): ReactNode => {
    if ('type' in item && item.type === 'separator') {
      return createElement('hr', { key: item.id, 'data-separator': item.id })
    }
    if ('type' in item && item.type === 'label') {
      return createElement('div', { key: item.id, 'data-menu-label': item.id }, item.text)
    }
    const row = item as StubMenuItem
    return createElement(
      'button',
      {
        key: row.id,
        type: 'button',
        disabled: row.disabled === true,
        'data-danger': row.danger === true ? 'true' : undefined,
        'data-selected': props.selectedId === row.id ? 'true' : undefined,
        onClick: () => props.onSelect(row.id),
      },
      row.icon,
      row.label,
    )
  }
  return createElement(
    Fragment,
    null,
    props.anchor,
    props.open
      ? createPortal(
          createElement(
            'div',
            { 'data-menu': 'true' },
            props.items.map(entry),
            (props.footer ?? []).map(entry),
          ),
          document.body,
        )
      : null,
  )
}
