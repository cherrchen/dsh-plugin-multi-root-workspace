import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PendingSpinner } from './pending.tsx'

/** SSH actions share the height of the host's single-line Input. */
export function SshButton(props: ComponentPropsWithoutRef<typeof Button> & { readonly loading?: boolean }): ReactNode {
  const { loading, className, children, onClick, disabled, ...rest } = props
  const busy = loading === true
  const classes = ['mrfw-sshButton', className, busy ? 'mrfw-btnLoading' : undefined]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' ')
  return (
    <Button
      {...rest}
      {...(busy ? { 'aria-busy': true, 'aria-disabled': true } : {})}
      className={classes}
      disabled={busy ? false : disabled}
      onClick={busy ? undefined : onClick}
    >
      {/* The label stays in the DOM at opacity 0 while loading: the accessible
          name and the button width do not change under the spinner. */}
      <span className="mrfw-btnLabel">{children}</span>
      {busy ? <span className="mrfw-loadingSpinner"><PendingSpinner /></span> : null}
    </Button>
  )
}

/** The visual family of one capsule button, mirroring the host Button kit. */
type ActionVariant = 'ghost' | 'outline' | 'primary' | 'danger'

const VARIANT_CLASS: Record<ActionVariant, string> = {
  ghost: 'mrfw-btnGhost',
  outline: 'mrfw-btnOutline',
  primary: 'mrfw-btnPrimary',
  danger: 'mrfw-btnDanger',
}

/** One small capsule button matching the panel's own styling.
 * Pending requests block activation through aria-disabled without changing
 * opacity, hover or keyboard focus. Native disabled is for unavailable actions.
 */
export function Action(props: {
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  pending?: boolean
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  return (
    <button
      type="button"
      className={`mrfw-btn ${VARIANT_CLASS[variant]}`}
      onClick={props.pending === true ? undefined : props.onClick}
      disabled={props.disabled === true}
      aria-disabled={props.disabled === true || props.pending === true || undefined}
      aria-busy={props.pending === true || undefined}
    >
      {props.children}
    </button>
  )
}

/**
 * One icon-only button (a host "iconButton"): a fixed square of the capsule
 * family whose meaning travels in `title`/`aria-label` instead of text.
 * `loading` swaps the glyph for a spinner while the request it fired runs;
 * the button stays undimmed and unclickable through aria attributes.
 */
export function IconButton(props: {
  onClick: () => void
  icon: ReactNode
  label: string
  disabled?: boolean
  pending?: boolean
  loading?: boolean
  pressed?: boolean
  expanded?: boolean
  className?: string
  hint?: string
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  const loading = props.loading === true
  const classes = ['mrfw-btn mrfw-iconBtn', VARIANT_CLASS[variant], props.className].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={classes}
      title={props.hint ?? props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      onClick={props.pending === true || loading ? undefined : props.onClick}
      disabled={loading ? false : props.disabled === true}
      aria-disabled={props.disabled === true || props.pending === true || loading || undefined}
      aria-busy={props.pending === true || loading || undefined}
    >
      {loading ? <PendingSpinner size={16} /> : props.icon}
    </button>
  )
}
