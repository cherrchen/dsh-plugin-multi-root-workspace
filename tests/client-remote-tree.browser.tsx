/**
 * Real-browser GUI evidence for the remote file tree: the same switcher
 * harness `tests/client-switcher.spec.tsx` drives (real `client.apply`,
 * real `RootSwitcher` + `FilesPane` fork), rendered in headless Chromium via
 * vitest browser mode. The Host side (Connection RPC, remotes view, the
 * `remoteFiles` wire) is the recording stub — every remote row the tree
 * draws comes from a `remoteFiles.list` RPC, never the local
 * `workspaceFiles` port. Screenshots land under `.dsh-smoke/gui/`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import type { ReactElement } from 'react'
import { NS } from '../src/client/locales.ts'
import { STYLES } from '../src/client/styles.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import { appended, mount, renderInPane, type RemoteStub } from './support/switcher-harness.tsx'

const SHOTS = '../.dsh-smoke/gui'

const TOKEN = 'a'.repeat(64)

const listings: Record<string, { name: string; type: 'file' | 'directory' }[]> = {
  '': [
    { name: 'inner.ts', type: 'file' },
    { name: 'deep', type: 'directory' },
    { name: 'uni-名字.md', type: 'file' },
    { name: 'literal\\', type: 'directory' },
  ],
  deep: [{ name: 'leaf.txt', type: 'file' }],
}

const remoteStub = (): RemoteStub => ({
  view: {
    primaryRoot: '/repos/primary', mode: 'workspace-write',
    status: { state: 'ready' },
    endpoints: [{
      environmentId: 'device', rootId: 'out', path: '/srv/root', platform: 'linux',
      displayName: 'Build Box',
      state: 'registered', actions: ['read'], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
      browseAuthorization: TOKEN,
    }],
  } satisfies RemotesView,
  list: ({ relativePath }) => ({ entries: listings[relativePath] ?? [], truncated: false }),
  wait: 'park',
})

beforeEach(() => {
  const stylesheet = document.createElement('style')
  stylesheet.textContent = `* { box-sizing: border-box } :root { --ds-font-family-code: monospace }\n${STYLES}`
  document.head.append(stylesheet)
  return () => {
    cleanup()
    stylesheet.remove()
  }
})

const openMenu = async () => {
  fireEvent.click(document.querySelector<HTMLElement>('.mrfw-rootSwitchBtn')!)
  await screen.findByText(`${NS}.switcher.manage`)
}

it('paints the remote root through remoteFiles.list in a real browser', async () => {
  const harness = mount(true, {}, { remotes: remoteStub() })
  const { pane } = renderInPane(harness)
  await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })

  // The menu offers the remote row; discovery alone never lists.
  await openMenu()
  const remoteRow = await screen.findByRole('button', { name: 'out · Build Box (device) · /srv/root · SSH' })
  await page.screenshot({ path: `${SHOTS}/remote-menu.png` })
  expect(harness.remoteListCalls).toEqual([])

  fireEvent.click(remoteRow)
  // The remote root's entries paint in the pane — including the Unicode and
  // the literal-backslash names — from the recorded remoteFiles.list RPC.
  await waitFor(() => {
    expect(pane.querySelector('[data-files-path="/mrfw/uni-名字.md"]')).not.toBeNull()
    expect(pane.querySelector('[data-files-path="/mrfw/deep"]')).not.toBeNull()
  })
  expect(harness.remoteListCalls).toEqual([{ relativePath: '', authorization: TOKEN }])
  await page.screenshot({ path: `${SHOTS}/remote-tree.png` })

  // Expand 'deep' — a second RPC for the nested relativePath.
  fireEvent.click(screen.getByRole('button', { name: 'deep' }))
  await waitFor(() => {
    expect(harness.remoteListCalls).toEqual([
      { relativePath: '', authorization: TOKEN },
      { relativePath: 'deep', authorization: TOKEN },
    ])
    expect(pane.querySelector('[data-files-path="/mrfw/deep/leaf.txt"]')).not.toBeNull()
  })
  await page.screenshot({ path: `${SHOTS}/remote-tree-expanded.png` })
  for (const element of appended) expect(element.isConnected).toBe(true)
})

it('keeps the remote disabled row unselectable when browse is withheld', async () => {
  const stub = remoteStub()
  const view = stub.view!
  stub.view = {
    ...view,
    endpoints: [{
      ...view.endpoints[0]!,
      rootId: 'stale', browseAuthorization: undefined, state: 'withheld',
    }],
  }
  const harness = mount(true, {}, { remotes: stub })
  render(harness.occupant({ absolutePath: '/repos/primary' }) as ReactElement)
  await waitFor(() => { expect(document.querySelector('.mrfw-rootSwitchLabel')?.textContent).toBe('Platform') })
  await openMenu()
  const disabled = await screen.findByRole('button', {
    name: `stale · Build Box (device) · /srv/root · SSH · ${NS}.switcher.remoteDisabled`,
  })
  expect(disabled).toHaveProperty('disabled', true)
  await page.screenshot({ path: `${SHOTS}/remote-disabled-row.png` })
  expect(harness.remoteListCalls).toEqual([])
})
