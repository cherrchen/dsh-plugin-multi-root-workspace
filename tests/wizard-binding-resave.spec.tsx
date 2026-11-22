// @vitest-environment jsdom
/**
 * AddBindingWizard Back→Next regression: after a successful save the wizard
 * carries the created `rootId` in the draft, so a Back→Next pass sends an
 * UPDATE-shaped draft for the same binding instead of a create-shaped one
 * (the server side is covered by tests/binding-resave-idempotent.spec.ts).
 */
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AddBindingWizard } from '../src/client/wizard/add-binding.tsx'
import type { BindingDraft } from '../src/client/ssh-draft.ts'
import type { SshClient, SshEnvironmentView, SshStateView } from '../src/client/ssh-client.ts'
import type { RemotesClient } from '../src/client/remotes-client.ts'
import type { RootsView } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = key => key
afterEach(cleanup)

const ENV: SshEnvironmentView = {
  environmentId: 'env-prod',
  displayName: 'Production',
  platform: 'linux',
  endpoint: { hostname: 'prod.internal', port: 22, user: 'deploy' },
  credential: { kind: 'ssh-config', alias: 'prod.host' },
  hostKey: 'SHA256:host-fingerprint',
  helper: { nodePath: '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 },
}

const ROOTS = { primaryRoot: '/repos/primary', roots: [], limit: 16, count: 0 } as RootsView

describe('AddBindingWizard Back → Next resaves the same binding', () => {
  it('carries the saved rootId in the second save', async () => {
    const saves: BindingDraft[] = []
    const state: SshStateView = {
      mode: 'personal',
      enabled: true,
      linked: true,
      revision: 2,
      environments: [ENV],
      credentials: [],
      bindings: [{ environmentId: 'env-prod', rootId: 'app', path: '/srv/app', actions: ['read'] }],
    } as SshStateView
    const remotes = {
      list: async () => ({ primaryRoot: '/repos/primary', endpoints: [] }) as RemotesView,
      add: async () => ({ primaryRoot: '/repos/primary', endpoints: [] }) as RemotesView,
      remove: async () => ({ primaryRoot: '/repos/primary', endpoints: [] }) as RemotesView,
    } as unknown as RemotesClient
    render(createElement(AddBindingWizard, {
      ssh: {} as unknown as SshClient,
      sessionId: 'session-1',
      remotes,
      roots: ROOTS,
      environments: [ENV],
      busy: false,
      t,
      onClose: () => {},
      onChanged: () => {},
      onSave: async draft => { saves.push(draft); return { state } },
    }))

    fireEvent.change(await screen.findByLabelText('ssh.binding.path'), { target: { value: '/srv/app' } })
    fireEvent.click(screen.getByRole('button', { name: 'ssh.step.next' }))
    await screen.findByRole('button', { name: 'wizard.register' })
    expect(saves).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'ssh.step.back' }))
    fireEvent.click(await screen.findByRole('button', { name: 'ssh.step.next' }))
    await waitFor(() => expect(saves).toHaveLength(2))

    // The first save creates; the second carries the created rootId so the
    // server edits the same binding instead of allocating a fresh Root ID.
    expect(saves[0]!.rootId).toBeUndefined()
    expect(saves[1]!.rootId).toBe('app')
    expect(saves[1]).toMatchObject({ environmentId: 'env-prod', path: '/srv/app' })
  })
})
