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
export const IconFolderOpenOutline16 = icon('folder-open')
export const IconPlusOutline16 = icon('plus')
export const IconTrashOutline16 = icon('trash')

/** Minimal `MenuItem` mirror (only the fields the panel uses). */
interface StubMenuItem {
  readonly id: string
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly danger?: boolean
}

/**
 * The anchored menu: the anchor renders in place, the open list portals to
 * `document.body` as one button per item — the same observable shape the real
 * `Menu` gives a jsdom test (placement, graceful close, and submenu behavior
 * are visual concerns this stub deliberately drops).
 */
export function Menu(props: {
  open: boolean
  anchor: ReactNode
  items: readonly StubMenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
}): ReactNode {
  return createElement(
    Fragment,
    null,
    props.anchor,
    props.open
      ? createPortal(
          createElement(
            'div',
            { 'data-menu': 'true' },
            props.items.map(item =>
              createElement(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  disabled: item.disabled === true,
                  'data-danger': item.danger === true ? 'true' : undefined,
                  onClick: () => props.onSelect(item.id),
                },
                item.label,
              ),
            ),
          ),
          document.body,
        )
      : null,
  )
}
