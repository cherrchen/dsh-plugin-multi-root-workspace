/**
 * Pending feedback for the network-bound SSH management requests.
 *
 * The host side of every one of these calls is already async; what was missing
 * is the client saying WHICH request is in flight. `StateDot` and
 * `TextShimmer` arrived with the 0.1.7-alpha.1 primitives line, so older
 * supported runtimes degrade to a CSS ring and plain text — the same
 * by-name probe the icons use (`compat/client-icons.ts`).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/pending
 */

import type { ReactNode } from 'react'
import { maybeComponent } from '../compat/client-icons.ts'

interface StateDotProps {
  readonly state: 'ongoing' | 'done'
  readonly size?: number
  readonly className?: string
}

interface TextShimmerProps {
  readonly children: ReactNode
  readonly active?: boolean
  readonly className?: string
}

const HostStateDot = maybeComponent<(props: StateDotProps) => ReactNode>(['StateDot'])
const HostTextShimmer = maybeComponent<(props: TextShimmerProps) => ReactNode>(['TextShimmer'])

/**
 * A small ongoing spinner: the host's animated state dot where the release
 * carries one, a CSS ring everywhere else.
 */
export function PendingSpinner(props: { readonly size?: number; readonly className?: string }): ReactNode {
  const size = props.size ?? 14
  const className = 'mrfw-pendingSpinner' + (props.className === undefined ? '' : ' ' + props.className)
  return (
    <span className={className} aria-hidden>
      {HostStateDot !== undefined
        ? <HostStateDot state="ongoing" size={size} />
        : <span className="mrfw-spinnerRing" style={{ width: size, height: size }} />}
    </span>
  )
}

/**
 * One line of live status: spinner plus shimmering text while the request
 * runs, a settled dot plus the same text once it answered.
 */
export function StatusLine(props: {
  readonly state: 'ongoing' | 'done'
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  const ongoing = props.state === 'ongoing'
  return (
    <p
      className={'mrfw-statusLine' + (props.className === undefined ? '' : ' ' + props.className)}
      role="status"
      aria-live="polite"
      data-state={props.state}
    >
      {ongoing
        ? <PendingSpinner size={12} />
        : HostStateDot !== undefined
          ? <HostStateDot state="done" size={10} />
          : <span className="mrfw-doneDot" aria-hidden />}
      <span className="mrfw-statusText">
        {ongoing && HostTextShimmer !== undefined
          ? <HostTextShimmer active>{props.children}</HostTextShimmer>
          : props.children}
      </span>
    </p>
  )
}

/** The thin progress bar pinned to the top of a scrolling dialog while busy. */
export function PendingBar(props: { readonly active: boolean }): ReactNode {
  return <div className="mrfw-pendingBar" data-active={props.active ? 'true' : undefined} aria-hidden />
}
