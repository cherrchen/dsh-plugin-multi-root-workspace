/** Lazy additional-root tree and bounded text previews; requests carry a session and exact root. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FilesView, FilePreview, RootEntryView } from '../contract.ts'
import type { PanelClient } from './panel-client.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'

export interface RootFileTreeProps {
  panel: PanelClient
  entry: RootEntryView
  sessionId: () => string | undefined
  t: Translate
  /**
   * Bumped by the owner to refresh every mounted listing in place. The
   * switcher's header reload owns this counter — nothing here carries a
   * refresh control of its own (the native pane works the same way: reload
   * lives in the header, not inside the tree).
   */
  readonly reload?: number
}

/**
 * The tree the Files-tab root switcher portals into the pane it takes over:
 * it lists the selected root outright — no Browse gate — and refreshes in
 * place: a `reload` bump re-lists every mounted directory under its current
 * rows, so a refresh never flashes the loading note.
 */
export function RootFileTree(props: RootFileTreeProps): ReactNode {
  return <div className="mrfw-fileTree">
    <Directory {...props} path="." />
  </div>
}

function Directory(props: RootFileTreeProps & { path: string }): ReactNode {
  const [listing, setListing] = useState<FilesView>()
  const [error, setError] = useState<string>()
  // Only a different root or directory may blank the current rows — a
  // `reload` bump refetches underneath them, which is what keeps the
  // loading note from flashing on every manual refresh.
  const identity = useRef<string>()
  useEffect(() => {
    let active = true
    const cancel = new AbortController()
    const self = `${props.entry.id}:${props.path}`
    if (identity.current !== self) {
      identity.current = self
      setListing(undefined)
      setError(undefined)
    }
    const session = props.sessionId()
    if (session === undefined) { setError(props.t('panel.noSession')); return }
    void props.panel.call('files', { sessionId: session, entry: props.entry, path: props.path }, cancel.signal).then(value => {
      if (active && props.sessionId() === session) { setListing(value); setError(undefined) }
    }, (failure: unknown) => { if (active && !cancel.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { active = false; cancel.abort() }
  }, [props.panel, props.entry, props.path, props.sessionId, props.t, props.reload])
  if (error !== undefined) return <p className="mrfw-alert" role="alert">{error}</p>
  if (listing === undefined) return <p className="mrfw-note">{props.t('panel.loading')}</p>
  return <ul className="mrfw-fileLevel">
    {listing.entries.length === 0 && <li className="mrfw-note">{props.t('files.empty')}</li>}
    {[...listing.entries].sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true })).map(entry => <FileEntry key={entry.name} {...props} path={props.path === '.' ? entry.name : `${props.path}/${entry.name}`} name={entry.name} kind={entry.type} />)}
    {listing.truncated && <li className="mrfw-note">{props.t('files.truncated')}</li>}
  </ul>
}

function FileEntry(props: RootFileTreeProps & { path: string; name: string; kind: 'file' | 'directory' | 'other' }): ReactNode {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<FilePreview>()
  const [error, setError] = useState<string>()
  const epoch = useRef(0)
  const cancel = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { epoch.current += 1; cancel.current?.abort() }, [])
  const toggle = async (): Promise<void> => {
    setOpen(!open)
    const current = ++epoch.current
    cancel.current?.abort()
    if (open || props.kind !== 'file') return
    setPreview(undefined)
    setError(undefined)
    const session = props.sessionId()
    if (session === undefined) { setError(props.t('panel.noSession')); return }
    const controller = new AbortController()
    cancel.current = controller
    try {
      const value = await props.panel.call('readFile', { sessionId: session, entry: props.entry, path: props.path }, controller.signal)
      if (current === epoch.current && props.sessionId() === session) setPreview(value)
    } catch (failure: unknown) {
      if (current === epoch.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  return <li>
    <button className="mrfw-fileEntry" type="button" disabled={props.kind === 'other'} aria-expanded={open} onClick={() => { void toggle() }}>{props.kind === 'directory' ? (open ? '▾ ' : '▸ ') : ''}{props.name}</button>
    {open && (props.kind === 'directory' ? <Directory {...props} /> : <>
      {error !== undefined ? <p role="alert" className="mrfw-alert">{error}</p> : preview === undefined ? <p className="mrfw-note">{props.t('panel.loading')}</p> : <>
        <pre className="mrfw-filePreview">{preview.text}</pre>
        {!preview.eof && <p className="mrfw-note">{props.t('files.previewTruncated')}</p>}
      </>}
    </>)}
  </li>
}
