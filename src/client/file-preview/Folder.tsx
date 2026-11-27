/**
 * The remote preview's Folder navigator (ADR-0053 P6): the same forked
 * FilesTree the Files page draws, mounted inside the preview tab's aside.
 * It browses the RECORD's remote root through the same `remoteFiles` client
 * and shared authorization lease — never through a synthetic endpoint or a
 * second SSH path — so a grant the Viewer's read surfaces as expired is the
 * same grant this tree's listings die against.
 *
 * Lifetime mirrors the document preview's navigator: the takeover signal is
 * keyed on a synthetic owner (`mrfw-remote-preview:<panel id>` — pane id,
 * not tab id, because `replaceTab` mints fresh tab ids while the pane
 * survives), and a normal Folder close ends only the body's hold — the
 * store bucket's `expanded`/`scrollTop`/`revealed` memory persists through
 * the takeover record until the pane dies, exactly like upstream's
 * `hold(paneId, cwd)` against `pane.lifetime`. `retainHiddenLevels: false`
 * on the SSH provider is what actually releases the listings on close.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/Folder
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { RemoteFilesClient } from '../remote-files-client.ts'
import type { RemoteFilesFailureCode } from '../../remote/files-contract.ts'
import type { FilesTreeSurface } from '../files-tree/adapter.tsx'
import { providerKey, treeBucketId, type WorkspaceFilesProvider } from '../files-tree/provider.ts'
import { createSshWorkspaceProvider } from '../files-tree/providers/ssh.ts'
import { FilesPane } from '../files-tree/pane.tsx'
import { searchStateKey } from '../files-tree/search-state.ts'
import { createRemotePreviewPort } from './open-port.ts'
import type { RemotePreviewRecord } from './resource-book.ts'
import type { RemotePreviewIntegration, PreviewTabInfo } from './install.tsx'

/**
 * A dockkit pane has no stable element: a non-empty pane's id rides on its
 * SELECTED tab's host (`data-dockkit-pane`), an empty pane's on its
 * `TabPanel`, and a floating pane's host carries `data-dockkit-float` —
 * `replaceTab` swaps the host while the pane lives on. The pane is
 * therefore alive while some connected element still carries its id.
 */
function paneAlive(id: string): boolean {
  for (const element of document.querySelectorAll<HTMLElement>('[data-dockkit-pane],[data-dockkit-float]')) {
    if (element.dataset.dockkitPane === id || element.dataset.dockkitFloat === id) return true
  }
  return false
}

export interface RemotePreviewFolderProps {
  /** The record this tab previews — identity of the browsed root. */
  readonly record: RemotePreviewRecord
  /** This tab's live panel/tab slice. */
  readonly info: PreviewTabInfo
  /** The forked-tree surface the body composed. */
  readonly surface: FilesTreeSurface
  /** The `remoteFiles` channel client the provider lists through. */
  readonly client: RemoteFilesClient
  /** The integration its file rows open through (replace-in-place). */
  readonly preview: RemotePreviewIntegration
  /** Code → localized message for the fixed `remoteFiles` failure groups. */
  readonly localize: (code: RemoteFilesFailureCode) => string
}

/** One Folder hold: the takeover identity the body mounted under. */
interface FolderHold {
  readonly owner: TabId
  readonly key: string
  readonly signal: AbortSignal
}

export function RemotePreviewFolder(props: RemotePreviewFolderProps): ReactNode {
  const { record, info, surface, client, preview, localize } = props
  const takeoverCtl = surface.takeover
  const owner = `mrfw-remote-preview:${info.panel.id}` as TabId
  const pKey = providerKey(record.identity)
  const [invalid, setInvalid] = useState(false)
  const [hold, setHold] = useState<FolderHold | null>(null)

  // The provider is bound to the record's exact grant: a replaced record —
  // same root, new incarnation — remounts this component and re-proves
  // everything, while same-record renders reuse the one instance the
  // takeover identity was minted against.
  const provider = useMemo((): WorkspaceFilesProvider => createSshWorkspaceProvider(
    record.identity,
    client,
    localize,
    () => {
      takeoverCtl.invalidate(owner, pKey)
      setInvalid(true)
    },
    createRemotePreviewPort(record.identity, record.label, preview),
  ), [record, client, localize, preview, takeoverCtl, owner, pKey])

  const bucketId = treeBucketId(owner, provider.identity)
  const bucket = surface.useStore(store => store.byTab[bucketId])

  // The hold: `takeover.signal` reuses the live (owner, key) record across
  // close/reopen, and this body's combined signal — never the record
  // itself — is what the tree's levels die with. No `end(owner)` on a
  // normal close: the pane-record memory outlives the aside.
  useEffect(() => {
    if (invalid) {
      setHold(null)
      return
    }
    const controller = new AbortController()
    const held = takeoverCtl.signal(owner, pKey, () => paneAlive(info.panel.id))
    setHold({
      owner,
      key: pKey,
      signal: AbortSignal.any([held, controller.signal, record.signal, info.tab.signal]),
    })
    return () => { controller.abort() }
  }, [invalid, takeoverCtl, owner, pKey, info.panel.id, record.signal, info.tab.signal])

  // The pane-record memory is written continuously, not at cleanup: the
  // bucket's expansion set mirrors into the inject-side map on every
  // update — gated on the live hold's owner+key so a superseded hold can
  // never stamp under a newer one — and the body reports its live scroll
  // offset the same way.
  useEffect(() => {
    if (bucket !== undefined && hold !== null && hold.owner === owner && hold.key === pKey) {
      takeoverCtl.save(hold.owner, { providerKey: hold.key, expanded: bucket.expanded })
    }
  }, [bucket, hold, owner, pKey, takeoverCtl])
  const onScrollOffset = useCallback((offset: number): void => {
    if (hold !== null) takeoverCtl.save(hold.owner, { providerKey: hold.key, scrollTop: offset })
  }, [hold, takeoverCtl])
  const onRevealSettled = useCallback((path: string): void => {
    if (hold !== null) takeoverCtl.save(hold.owner, { providerKey: hold.key, revealed: path })
  }, [hold, takeoverCtl])
  // The snapshot belongs to the LIVE hold, not the freshly computed key.
  const savedTree = hold === null ? undefined : takeoverCtl.saved(hold.owner, hold.key)

  // Record or tab death hides the tree synchronously; the hold's combined
  // signal ends the listings with it.
  if (invalid || hold === null || record.signal.aborted || info.tab.signal.aborted || hold.signal.aborted) return null
  return (
    <FilesPane
      filesTree={surface}
      mode="preview"
      stateKey={searchStateKey(hold.owner, hold.key)}
      provider={provider}
      tabId={bucketId}
      signal={hold.signal}
      replaceTab={info.tab.id}
      useStore={surface.useStore}
      actions={surface.actions}
      reveal={{
        path: `${provider.treeRoot}/${record.relativePath}`,
        relativePath: record.relativePath,
        revealed: savedTree?.revealed,
        onSettled: onRevealSettled,
      }}
      saved={savedTree}
      onScrollOffset={onScrollOffset}
    />
  )
}
