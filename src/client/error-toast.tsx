import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { WarningOutlineIcon } from '../compat/client-icons.ts'
import { errorHasDetail, errorKeyOf, type PanelError } from './panel-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/** Long enough to read a failure that names what broke. */
const ERROR_TOAST_HOLD_MS = 8000

/** Texts currently on screen, so one failure reported by two sources shows once. */
const active = new Set<string>()

/** The localized text of a panel failure, with the host detail when the code cannot name it. */
export const panelErrorText = (t: Translate, error: PanelError): string =>
  `${t(errorKeyOf(error.code))}${errorHasDetail(error.code) ? ` (${error.message})` : ''}`

/**
 * Show a failure as a transient Toast. The banner fires every time `error`
 * changes to a defined value (a new object or string remounts it, restarting
 * the hold) and never renders inline text.
 * @param props.error - the failure; `undefined` shows nothing.
 * @param props.format - turns the failure into its localized text.
 * @returns the portaled banner, or nothing.
 */
export function ErrorToast<E>(props: { readonly error: E | undefined; readonly format: (error: E) => string }): ReactNode {
  const format = useRef(props.format)
  format.current = props.format
  const seq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  useEffect(() => {
    if (props.error === undefined) return
    const text = format.current(props.error)
    if (active.has(text)) return
    active.add(text)
    seq.current += 1
    setToast({ seq: seq.current, text })
  }, [props.error])
  useEffect(() => {
    if (toast === null) return
    return () => { active.delete(toast.text) }
  }, [toast])
  return toast === null ? null : (
    <Toast
      key={toast.seq}
      text={toast.text}
      icon={WarningOutlineIcon === undefined ? undefined : <WarningOutlineIcon />}
      holdMs={ERROR_TOAST_HOLD_MS}
      onDone={() => { setToast(null) }}
    />
  )
}

/** {@link ErrorToast} for a {@link PanelError}. */
export function PanelErrorToast(props: { readonly error: PanelError | undefined; readonly t: Translate }): ReactNode {
  return <ErrorToast error={props.error} format={error => panelErrorText(props.t, error)} />
}
