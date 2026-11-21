/**
 * The wizard design kit: the shared visual language for the workspace panel's
 * guided flows. `WizardShell` owns the rail + stepper + content + footer
 * layout, `ChoiceCard` the big selectable rows, `WizardField`/`WizardCheckbox`/
 * `WizardSegment` the form controls, and `ChecklistRow` the readiness items.
 * These are the pieces the legacy SSH management dialogs migrate onto later —
 * they wrap the host primitives wherever a primitive exists and fall back to
 * the same markup the support matrix's older releases can render.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/wizard/kit
 */
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheck, IconChevronDown, IconClose, maybeComponent } from '../../compat/client-icons.ts'
import { IconButton } from '../panel-buttons.tsx'
import { PendingBar, PendingSpinner } from '../pending.tsx'

type SettingsModalLayer = (dialog: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) => void
const hostModalLayer = maybeComponent<SettingsModalLayer>(['useModalLayer'])

interface CheckboxProps {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
  readonly className?: string | undefined
}
const HostCheckbox = maybeComponent<(props: CheckboxProps) => ReactNode>(['Checkbox'])

interface SegmentOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
}
interface SegmentedProps {
  readonly id: string
  readonly value: string
  readonly options: readonly SegmentOption[]
  readonly onChange: (next: string) => void
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly className?: string | undefined
}
const HostSegmented = maybeComponent<(props: SegmentedProps) => ReactNode>(['SegmentedControl'])

interface StateDotProps {
  readonly state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
  readonly size?: number | undefined
  readonly appearance?: 'dot' | 'step' | undefined
  readonly className?: string | undefined
}
const HostStateDot = maybeComponent<(props: StateDotProps) => ReactNode>(['StateDot'])

/** One step in the {@link WizardShell} rail. */
export interface WizardStepItem {
  readonly id: string
  readonly title: string
}

/** The numbered rail dot: filled check once done, accent at the current step. */
function WizardStepDot(props: { readonly index: number; readonly state: 'done' | 'current' | 'todo' }): ReactNode {
  if (props.state === 'done') {
    return (
      <span className="mrfw-wizDot" data-state="done" aria-hidden>
        {HostStateDot !== undefined
          ? <HostStateDot state="done" appearance="step" size={20} />
          : IconCheck === undefined ? <span aria-hidden="true">✓</span> : <IconCheck size={10} />}
      </span>
    )
  }
  return (
    <span className="mrfw-wizDot" data-state={props.state} aria-hidden>
      {props.index + 1}
    </span>
  )
}

/**
 * The guided-flow frame: a wide card with a left rail naming every step and a
 * main column carrying the current step's content and the footer action row.
 * The host's modal layer owns Escape/Tab/focus where it exists; older
 * runtimes get the same content inside the plain `Modal` chrome.
 */
export function WizardShell(props: {
  readonly title: string
  readonly railLabel: string
  readonly closeLabel: string
  readonly onClose: () => void
  readonly busy?: boolean | undefined
  readonly steps: readonly WizardStepItem[]
  readonly current: number
  readonly complete?: boolean | undefined
  readonly footer?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  const dialog = useRef<HTMLElement | null>(null)
  const titleId = useId()
  hostModalLayer?.(dialog, true, props.onClose)
  const current = Math.min(props.current, props.steps.length - 1)
  const steps = (
    <ol className="mrfw-wizSteps" aria-label={props.railLabel}>
      {props.steps.map((step, index) => {
        const state = props.complete === true || index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li key={step.id} className="mrfw-wizStep" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <WizardStepDot index={index} state={state} />
            <span className="mrfw-wizStepTitle">{step.title}</span>
          </li>
        )
      })}
    </ol>
  )
  const main = (
    <div className="mrfw-wizMain">
      <div className="mrfw-wizBody">{props.children}</div>
      {props.footer === undefined ? null : <div className="mrfw-wizFoot">{props.footer}</div>}
    </div>
  )
  if (hostModalLayer === undefined) {
    return (
      <Modal
        open
        title={props.title}
        closeLabel={props.closeLabel}
        onClose={props.onClose}
        className="mrfw-wizCard"
        contentClassName="mrfw-wizContent"
      >
        <PendingBar active={props.busy === true} />
        <div className="mrfw-wizGrid">
          <aside className="mrfw-wizRail">{steps}</aside>
          {main}
        </div>
      </Modal>
    )
  }
  return createPortal(
    <div className="mrfw-overlay">
      <div className="mrfw-mask" aria-hidden onClick={props.onClose} />
      <section
        ref={dialog as RefObject<HTMLElement>}
        className="mrfw-wizCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <PendingBar active={props.busy === true} />
        <div className="mrfw-wizGrid">
          <aside className="mrfw-wizRail">
            <h2 id={titleId} className="mrfw-wizTitle">{props.title}</h2>
            {steps}
          </aside>
          <div className="mrfw-wizMain">
            <IconButton className="mrfw-wizClose" label={props.closeLabel} onClick={props.onClose}
              icon={IconClose === undefined ? <span aria-hidden="true">✕</span> : <IconClose size={12} />} />
            <div className="mrfw-wizBody">{props.children}</div>
            {props.footer === undefined ? null : <div className="mrfw-wizFoot">{props.footer}</div>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}

/**
 * One big selectable row: leading glyph, title + subtitle stack, trailing
 * badges or status. Rendered as a `radio` for the enclosing radiogroup, or as
 * a static card when `onSelect` is omitted (e.g. the locked environment echo).
 */
export function ChoiceCard(props: {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly icon?: ReactNode
  readonly trailing?: ReactNode
  readonly selected?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly onSelect?: (() => void) | undefined
  readonly hint?: ReactNode
}): ReactNode {
  const content = <>
    {props.icon === undefined ? null : <span className="mrfw-choiceIcon" aria-hidden>{props.icon}</span>}
    <span className="mrfw-choiceText">
      <span className="mrfw-choiceTitle">{props.title}</span>
      {props.subtitle === undefined ? null : <span className="mrfw-choiceSub">{props.subtitle}</span>}
      {props.hint === undefined ? null : <span className="mrfw-choiceHint">{props.hint}</span>}
    </span>
    {props.trailing === undefined ? null : <span className="mrfw-choiceTrail">{props.trailing}</span>}
  </>
  const className = 'mrfw-choice' + (props.selected === true ? ' mrfw-choiceOn' : '')
  if (props.onSelect === undefined) return <div className={className}>{content}</div>
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected === true}
      disabled={props.disabled === true}
      onClick={props.onSelect}
      className={className}
    >
      {content}
    </button>
  )
}

/** A form row: label, control, optional hint (red when `invalid`). */
export function WizardField(props: {
  readonly label: string
  readonly hint?: ReactNode
  readonly invalid?: boolean | undefined
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="mrfw-wizField" data-invalid={props.invalid === true ? 'true' : undefined}>
      <span className="mrfw-wizFieldLabel">{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : <span className="mrfw-wizFieldHint">{props.hint}</span>}
    </div>
  )
}

/** A labeled checkbox row with an optional hint line, on the host Checkbox. */
export function WizardCheckbox(props: {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly hint?: string | undefined
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
}): ReactNode {
  return (
    <div className="mrfw-wizCheck">
      {HostCheckbox !== undefined
        ? <HostCheckbox checked={props.checked} onChange={props.onChange} label={props.label} disabled={props.disabled} title={props.title} />
        : (
          <label className="mrfw-checkRow" title={props.title}>
            <input
              type="checkbox"
              checked={props.checked}
              disabled={props.disabled === true}
              onChange={event => { props.onChange(event.target.checked) }}
            />
            <span>{props.label}</span>
          </label>
        )}
      {props.hint === undefined ? null : <span className="mrfw-wizCheckHint">{props.hint}</span>}
    </div>
  )
}

/** A segmented mode switch on the host `SegmentedControl`. */
export function WizardSegment<Value extends string>(props: {
  readonly id: string
  readonly label: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string; readonly disabled?: boolean | undefined; readonly title?: string | undefined }[]
  readonly onChange: (next: Value) => void
  readonly disabled?: boolean | undefined
}): ReactNode {
  if (HostSegmented === undefined) {
    return (
      <div className="mrfw-wizSeg" role="radiogroup" aria-label={props.label}>
        {props.options.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            disabled={props.disabled === true || option.disabled === true}
            title={option.title}
            onClick={() => { props.onChange(option.value) }}
            className="mrfw-wizSegBtn"
            data-selected={option.value === props.value ? 'true' : undefined}
          >
            {option.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <HostSegmented
      id={props.id}
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      options={props.options.map(option => ({ value: option.value, label: option.label, disabled: option.disabled, title: option.title }))}
      onChange={next => { props.onChange(next as Value) }}
    />
  )
}

/**
 * One readiness line: a state dot, the item name, an optional detail, and an
 * optional inline action on the right. The checklist the wizard's environment
 * step is built from.
 */
export function ChecklistRow(props: {
  readonly state: 'done' | 'ongoing' | 'idle' | 'warning' | 'error'
  readonly label: ReactNode
  readonly detail?: ReactNode
  readonly action?: ReactNode
}): ReactNode {
  return (
    <div className="mrfw-checkItem" data-state={props.state}>
      <span className="mrfw-checkDot" aria-hidden>
        {props.state === 'ongoing'
          ? <PendingSpinner size={14} />
          : HostStateDot !== undefined
            ? <HostStateDot state={props.state} appearance={props.state === 'done' || props.state === 'idle' ? 'step' : 'dot'} size={16} />
            : <span className="mrfw-checkDotFallback" data-state={props.state}>{props.state === 'done' ? '✓' : ''}</span>}
      </span>
      <span className="mrfw-checkText">
        <span className="mrfw-checkLabel">{props.label}</span>
        {props.detail === undefined ? null : <span className="mrfw-checkDetail">{props.detail}</span>}
      </span>
      {props.action === undefined ? null : <span className="mrfw-checkAction">{props.action}</span>}
    </div>
  )
}

/** The footer's right-aligned action pair, primary last. */
export function WizardActions(props: { readonly children: ReactNode }): ReactNode {
  return <div className="mrfw-wizActions">{props.children}</div>
}

/** A controlled dropdown picker on the host `Menu`, in the kit's field style. */
export function WizardPicker<Value extends string>(props: {
  readonly label: string
  readonly value: Value
  readonly items: readonly { readonly id: Value; readonly label: string }[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean | undefined
  readonly invalid?: boolean | undefined
  readonly iconOnly?: boolean | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const disabled = props.disabled === true || props.items.length === 0
  const expanded = open && !disabled
  const selectedLabel = props.items.find(item => item.id === props.value)?.label ?? props.label
  return (
    <Menu
      open={expanded}
      items={props.items}
      selectedId={props.value}
      portal
      autoFocus
      align={props.iconOnly === true ? 'end' : 'start'}
      className={props.iconOnly === true ? 'mrfw-wizPickerCompact' : 'mrfw-wizPicker'}
      onClose={() => setOpen(false)}
      onSelect={id => {
        setOpen(false)
        const choice = props.items.find(item => item.id === id)
        if (choice !== undefined && choice.id !== props.value) props.onChange(choice.id)
      }}
      anchor={
        <button
          type="button"
          className={props.iconOnly === true ? 'mrfw-wizPickerBtn' : 'mrfw-wizPickerBtn mrfw-wizPickerFull'}
          disabled={disabled}
          aria-label={props.label}
          aria-invalid={props.invalid === true || undefined}
          aria-haspopup="menu"
          aria-expanded={expanded}
          title={selectedLabel}
          onClick={() => setOpen(!expanded)}
          onKeyDown={event => {
            if (expanded || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
            event.preventDefault()
            setOpen(true)
          }}
        >
          {props.iconOnly === true ? null : <span className="mrfw-wizPickerLabel">{selectedLabel}</span>}
          <IconChevronDown size={12} aria-hidden="true" />
        </button>
      }
    />
  )
}
