import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** SSH actions share the height of the host's single-line Input. */
export function SshButton({ className, ...props }: ComponentPropsWithoutRef<typeof Button>): ReactNode {
  return <Button {...props} className={className === undefined ? 'mrfw-sshButton' : `mrfw-sshButton ${className}`} />
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
 */
export function IconButton(props: {
  onClick: () => void
  icon: ReactNode
  label: string
  disabled?: boolean
  pending?: boolean
  pressed?: boolean
  hint?: string
  variant?: ActionVariant
}): ReactNode {
  const variant = props.variant ?? 'ghost'
  return (
    <button
      type="button"
      className={`mrfw-btn mrfw-iconBtn ${VARIANT_CLASS[variant]}`}
      title={props.hint ?? props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.pending === true ? undefined : props.onClick}
      disabled={props.disabled === true}
      aria-disabled={props.disabled === true || props.pending === true || undefined}
      aria-busy={props.pending === true || undefined}
    >
      {props.icon}
    </button>
  )
}
