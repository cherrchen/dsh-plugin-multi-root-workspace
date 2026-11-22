import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { commands, page } from 'vitest/browser'
import { WorkspaceFoldersDialog } from '../src/client/WorkspaceFoldersAction.tsx'
import { en } from '../src/client/locales.ts'
import type { PanelClient } from '../src/client/panel-client.ts'
import type { RemotesClient } from '../src/client/remotes-client.ts'
import { createSshClient } from '../src/client/ssh-client.ts'
import { STYLES } from '../src/client/styles.ts'
import type { PanelResponseMap } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'

declare module 'vitest/browser' {
  interface BrowserCommands {
    wheelOverRootList(pixels: number): Promise<void>
  }
}

beforeEach(() => {
  const stylesheet = document.createElement('style')
  stylesheet.textContent = `* { box-sizing: border-box } :root { --ds-font-family-code: monospace }\n${STYLES}`
  document.head.append(stylesheet)
  return () => {
    cleanup()
    stylesheet.remove()
  }
})

async function renderRoot(path: string, remotes?: RemotesClient) {
  const responses: Partial<PanelResponseMap> = {
    list: {
      primaryRoot: '/workspaces/main',
      roots: [{
        id: 'deep-root',
        ordinal: 1,
        path,
        alias: 'Deep checkout',
        addedAt: '2026-11-21T00:00:00.000Z',
        state: 'available',
        access: 'read-write',
        skillsEnabled: true,
      }],
      limit: 16,
      count: 1,
    },
  }
  const panel: PanelClient = {
    async call(endpoint) {
      const response = responses[endpoint]
      if (response === undefined) throw new Error(`Unexpected panel endpoint: ${endpoint}`)
      return response
    },
  }
  render(<WorkspaceFoldersDialog
    panel={panel}
    remotes={remotes}
    ssh={remotes === undefined ? undefined : createSshClient({ rpc: { async call() {
      throw new Error('Unexpected SSH request')
    } } })}
    remoteEnabled={() => remotes !== undefined}
    pickDirectory={async () => null}
    sessionId={() => 'layout-test'}
    t={key => en[key]}
    onClose={() => {}}
  />)

  const alias = await screen.findByText('Deep checkout')
  const row = alias.closest<HTMLElement>('.mrfw-row')!
  const list = row.closest<HTMLElement>('.mrfw-rootList')!
  const body = list.closest<HTMLElement>('.mrfw-body')!
  const addButton = screen.getByRole('button', { name: en['panel.add'] })
  return { row, list, body, addButton }
}

function controlsFit(body: HTMLElement, controls: readonly HTMLElement[]): boolean {
  const viewport = body.getBoundingClientRect()
  return controls.every(control => {
    const bounds = control.getBoundingClientRect()
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
  })
}

it('caps an oversized root row and chains wheel scrolling to the add controls', async () => {
  await page.viewport(320, 300)
  const { row, list, body, addButton } = await renderRoot(
    '/workspaces/' + 'nested-workspace-segment/'.repeat(16) + 'checkout',
  )
  const cap = window.innerHeight * 0.6

  expect(row.getBoundingClientRect().height).toBeGreaterThan(cap)
  expect(list.getBoundingClientRect().height).toBeCloseTo(cap, 0)

  // Start where the user can point at the list on a short dialog.
  body.scrollTop += list.getBoundingClientRect().top - body.getBoundingClientRect().top
  const bodyStart = body.scrollTop
  expect(addButton.getBoundingClientRect().top).toBeGreaterThan(body.getBoundingClientRect().bottom)

  // A real wheel over the list must fill its scroll range first.
  await commands.wheelOverRootList(list.scrollHeight)
  const remainingListScroll = () => list.scrollHeight - list.clientHeight - list.scrollTop
  await expect.poll(remainingListScroll).toBeLessThanOrEqual(1)
  expect(list.scrollTop).toBeGreaterThan(0)
  expect(body.scrollTop).toBe(bodyStart)

  // Keep the pointer over the list at its end so this wheel exercises chaining.
  await commands.wheelOverRootList(body.scrollHeight)
  await expect.poll(() => body.scrollTop).toBeGreaterThan(bodyStart)
  await expect.poll(() => controlsFit(body, [addButton])).toBe(true)
})

it('fits a wrapped row below the cap and keeps the add controls visible without scrolling', async () => {
  await page.viewport(400, 640)
  const { row, list, body, addButton } = await renderRoot(
    '/workspaces/' + 'nested-workspace-segment/'.repeat(3) + 'checkout',
  )
  const cap = window.innerHeight * 0.6
  const rowHeight = row.getBoundingClientRect().height
  const listHeight = list.getBoundingClientRect().height

  expect(rowHeight).toBeLessThan(cap)
  expect(listHeight).toBeGreaterThanOrEqual(rowHeight)
  expect(listHeight - rowHeight).toBeLessThan(1)
  expect(body.scrollHeight).toBe(body.clientHeight)
  expect(controlsFit(body, [addButton])).toBe(true)
})

it('keeps the SSH section and split add menu reachable after scrolling the local list', async () => {
  await page.viewport(400, 480)
  const view: RemotesView = {
    primaryRoot: '/workspaces/main',
    mode: 'workspace-write',
    custodyMode: 'personal',
    status: { state: 'ready' },
    endpoints: [{
      environmentId: 'build',
      rootId: 'app',
      path: '/srv/build-checkout',
      platform: 'linux',
      state: 'registered',
      actions: ['read'],
      transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    }],
  }
  const readRemotes = async (): Promise<RemotesView> => view
  const { list, body, addButton } = await renderRoot(
    '/workspaces/' + 'nested-workspace-segment/'.repeat(30) + 'checkout',
    { list: readRemotes, add: readRemotes, remove: readRemotes },
  )
  const remoteRow = (await screen.findByText('build-checkout')).closest<HTMLElement>('.mrfw-row')!
  const manage = screen.getByRole('button', { name: en['panel.remoteManage'] })
  expect(list.contains(remoteRow)).toBe(false)
  expect(list.contains(manage)).toBe(false)

  body.scrollTop += list.getBoundingClientRect().top - body.getBoundingClientRect().top
  const bodyStart = body.scrollTop
  await commands.wheelOverRootList(list.scrollHeight)
  await expect.poll(() => list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1)
  expect(list.scrollTop).toBeGreaterThan(0)
  expect(body.scrollTop).toBe(bodyStart)

  await commands.wheelOverRootList(body.scrollHeight)
  await expect.poll(() => controlsFit(body, [remoteRow, manage, addButton])).toBe(true)
  await page.getByRole('button', { name: en['panel.add'], exact: true }).hover()
  await expect.element(page.getByRole('button', { name: en['panel.addLocal'] })).toBeEnabled()
  await expect.element(page.getByRole('button', { name: en['panel.addRemote'] })).toBeEnabled()
})
