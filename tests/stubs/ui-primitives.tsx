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
import type { OpsConfirmationProps } from '../../src/compat/ops-confirmation.ts'

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

// The names the files-tree fork spells verbatim: the folder pair the tree
// rows toggle between (Regular in 0.1.7+, pixel-sized before it) and the
// file-type pair every supported release carries.
export const IconFolderCloseRegular = icon('folder-close')
export const IconFolderOpenRegular = icon('folder-open')
export const IconFolderOpen16 = icon('folder-open')

// Current upstream permission glyph export names.
export const PermissionIconWorkspaceWriteRegular = icon('workspace-write')
export const PermissionIconReadOnlyRegular = icon('read-only')

// The Regular glyph family the workspace-search surface spells verbatim
// (0.2.2-rc.2, where the feature itself arrived).
export const IconSearchOutlineRegular = icon('search')
export const IconEyeOutlineRegular = icon('eye')
export const IconEyeOffOutlineRegular = icon('eye-off')
export const IconCloseOutlineRegular = icon('close')
export const IconInfoOutlineRegular = icon('info')
export const IconPlusOutlineRegular = icon('plus')
export const IconTrashOutlineRegular = icon('trash')
export const IconRefreshOutlineRegular = icon('refresh')

/** Controlled host Switch mirror, preserving its accessible button contract. */
export function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): ReactNode {
  return <button type="button" role="switch" aria-label={props.label}
    aria-checked={props.checked} disabled={props.disabled}
    onClick={() => props.onChange(!props.checked)} />
}

/** Minimal `Button` mirror: a real button, with every extra prop forwarded (data-*, aria-*). */
export function Button(props: {
  readonly variant?: string
  readonly size?: string
  readonly className?: string
  readonly onClick?: () => void
  readonly children?: ReactNode
} & Record<string, unknown>): ReactNode {
  const { variant, size, className, onClick, children, ...rest } = props
  return createElement('button', {
    type: 'button',
    'data-variant': variant,
    'data-size': size,
    className,
    onClick,
    ...rest,
  }, children)
}

/** Minimal `StateDot` mirror: the state rides a data attribute. */
export function StateDot(props: {
  readonly state: string
  readonly size?: number
  readonly className?: string
}): ReactNode {
  return createElement('span', { 'data-state-dot': props.state, className: props.className })
}

/** Minimal `Tag` mirror: the same `span[data-tone]` shape the host renders. */
export function Tag(props: {
  readonly tone?: string
  readonly className?: string
  readonly children?: ReactNode
}): ReactNode {
  return createElement('span', { 'data-tone': props.tone ?? 'outline', className: props.className }, props.children)
}

/** Minimal `classifyFileType` mirror: a kind string by extension. */
export function classifyFileType(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'file'
  const extension = name.slice(dot + 1).toLowerCase()
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension) ? 'code'
    : ['md', 'markdown', 'txt'].includes(extension) ? 'text'
    : 'file'
}

/** Minimal `FileTypeIcon` mirror: the kind lands on `data-icon`. */
export function FileTypeIcon(props: IconProps & {
  readonly kind?: string
  readonly path?: string
}): ReactNode {
  const kind = props.kind ?? (props.path === undefined ? 'file' : classifyFileType(props.path))
  return createElement('svg', {
    'data-icon': `file-${kind}`,
    className: props.className,
    width: props.size ?? 16,
    height: props.size ?? 16,
  })
}

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
  readonly tone?: 'success'
  readonly holdMs?: number
  readonly anchor?: HTMLElement | null
  readonly actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
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

/** The host risk dialog's acknowledgement, action, and dismissal contract. */
export function RiskConfirmation(props: OpsConfirmationProps): ReactNode {
  if (!props.open) return null
  return createPortal(<div data-testid="risk-confirmation-mask" onClick={event => {
    if (event.target === event.currentTarget) props.onCancel()
  }}>
    <section role="dialog" aria-label={props.title} onKeyDown={event => {
      if (event.key === 'Escape') props.onCancel()
    }}>
      <h2>{props.title}</h2>
      <button type="button" aria-label={props.closeLabel} onClick={props.onCancel}>×</button>
      <p>{props.description}</p>
      <label><input type="checkbox" checked={props.acknowledged} disabled={props.disabled}
        onChange={event => props.onAcknowledgedChange(event.currentTarget.checked)} />{props.acknowledgeLabel}</label>
      <button type="button" onClick={props.onCancel}>{props.cancelLabel}</button>
      <button type="button" disabled={props.disabled || !props.acknowledged} onClick={props.onConfirm}>{props.confirmLabel}</button>
    </section>
  </div>, document.body)
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
