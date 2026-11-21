import type { ReactNode } from 'react'
import { IconCopy } from '../compat/client-icons.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

/**
 * One path that copies itself: text that paints like the surrounding copy
 * and reveals a trailing icon on hover — clicking the text or the icon
 * copies the same canonical path. The accessible name swaps to "copied"
 * for the feedback window.
 */
function PathCopy(props: {
  readonly path: string
  readonly copied: boolean
  readonly onCopy: () => void
  readonly t: Translate
}): ReactNode {
  return (
    <button
      type="button"
      className="mrfw-rootPath mrfw-pathCopy"
      title={props.path}
      aria-label={props.copied ? props.t('panel.copied') : props.t('panel.copyPath')}
      onClick={props.onCopy}
    >
      {props.path}
      <span className="mrfw-pathCopyIcon" aria-hidden="true"><IconCopy size={14} /></span>
    </button>
  )
}

interface WorkspaceRowProps {
  readonly className?: string
  /** The display name; callers wrap it in `mrfw-rootNameText` for ellipsis. */
  readonly name: ReactNode
  /** Badges that ride beside the name (cwd tag, access, platform, state, root id). */
  readonly badges?: ReactNode
  /** The copyable location (an absolute path, or a remote target + path). */
  readonly path: string | undefined
  readonly copied?: boolean
  readonly onCopy?: (() => void) | undefined
  readonly t: Translate
  /** Additional information below the path. */
  readonly details?: ReactNode
  /** The row's trailing action cluster. */
  readonly trailing?: ReactNode
  /** Content that must wrap below the row (the alias editor). */
  readonly children?: ReactNode
  /** The primary row has no bottom rule. */
  readonly bare?: boolean
}

/**
 * Shared row for workspace directories, SSH bindings, and SSH connections.
 */
export function WorkspaceRow(props: WorkspaceRowProps): ReactNode {
  return <div className={['mrfw-row', props.bare === true ? 'mrfw-rowBare' : undefined, props.className].filter(Boolean).join(' ')}>
    <div className="mrfw-rootText">
      <span className="mrfw-rootName">
        {props.name}
        {props.badges}
      </span>
      {props.path === undefined
        ? <span className="mrfw-rootPath">…</span>
        : props.onCopy === undefined
          ? <span className="mrfw-rootPath">{props.path}</span>
          : <PathCopy path={props.path} copied={props.copied === true} onCopy={props.onCopy} t={props.t} />}
      {props.details}
    </div>
    {props.trailing}
    {props.children}
  </div>
}
