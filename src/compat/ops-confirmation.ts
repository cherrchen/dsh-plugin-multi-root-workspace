/** Keep the optional host confirmation component behind a structural probe. */
import type { ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

export interface OpsConfirmationProps {
  open: boolean
  title: string
  description: string
  acknowledgeLabel: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  acknowledged: boolean
  disabled?: boolean
  onAcknowledgedChange(value: boolean): void
  onCancel(): void
  onConfirm(): void
}

export function opsRiskConfirmation(): ComponentType<OpsConfirmationProps> | undefined {
  return (primitives as unknown as { RiskConfirmation?: ComponentType<OpsConfirmationProps> }).RiskConfirmation
}
