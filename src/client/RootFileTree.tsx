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
}

export function RootFileTree(props: RootFileTreeProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [generation, setGeneration] = useState(0)
  return <div className="mrfw-fileTree">
    <button className="mrfw-btn mrfw-btnGhost" type="button" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{props.t('files.browse')}</button>
    {open && <>
      <button className="mrfw-btn mrfw-btnGhost" type="button" onClick={() => { setGeneration(value => value + 1) }}>{props.t('files.reload')}</button>
      <Directory key={generation} {...props} path="." />
    </>}
  </div>
}

function Directory(props: RootFileTreeProps & { path: string }): ReactNode {
  const [listing, setListing] = useState<FilesView>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    setListing(undefined)
    setError(undefined)
    const session = props.sessionId()
    if (session === undefined) { setError(props.t('panel.noSession')); return }
    void props.panel.call('files', { sessionId: session, entry: props.entry, path: props.path }).then(value => {
      if (active && props.sessionId() === session) setListing(value)
    }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { active = false }
  }, [props.panel, props.entry, props.path, props.sessionId, props.t])
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
  useEffect(() => () => { epoch.current += 1 }, [])
  const toggle = async (): Promise<void> => {
    setOpen(!open)
    const current = ++epoch.current
    if (open || props.kind !== 'file') return
    setPreview(undefined)
    setError(undefined)
    const session = props.sessionId()
    if (session === undefined) { setError(props.t('panel.noSession')); return }
    try {
      const value = await props.panel.call('readFile', { sessionId: session, entry: props.entry, path: props.path })
      if (current === epoch.current && props.sessionId() === session) setPreview(value)
    } catch (failure: unknown) {
      if (current === epoch.current) setError(failure instanceof Error ? failure.message : String(failure))
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
