// @vitest-environment jsdom
/**
 * The guided add-remote flow: pick or create an environment, bind a remote
 * directory, then register the endpoint. These tests pin the staged gate —
 * an environment may not advance until it is ready, and `remotes.add` names
 * the root the binding answer assigned.
 */

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RootView, RootsView } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import { RemoteWizard } from '../src/client/wizard/add-remote.tsx'
import type { SshBindingDraft, SshClient, SshEnvironmentView, SshStateView } from '../src/client/ssh-client.ts'
import type { RemotesClient } from '../src/client/remotes-client.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = key => key
afterEach(cleanup)

const ROOT_A: RootView = {
  ordinal: 1,
  id: 'a',
  path: '/repos/payments',
  aliasId: 'payments',
  addedAt: '2026-09-12T00:00:00.000Z',
  state: 'available',
  access: 'read-write',
  alias: 'payments',
}

const ROOTS: RootsView = {
  primaryRoot: '/repos/primary',
  roots: [ROOT_A],
  limit: 16,
  count: 1,
} as RootsView

const ENV_READY: SshEnvironmentView = {
  environmentId: 'env-prod',
  displayName: 'Production',
  platform: 'linux',
  endpoint: { hostname: 'prod.internal', port: 22, user: 'deploy' },
  credential: { kind: 'ssh-config', alias: 'prod.host' },
  hostKey: 'SHA256:host-fingerprint',
  helper: { nodePath: '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 },
}

const ENV_BARE: SshEnvironmentView = { ...ENV_READY, environmentId: 'env-bare', displayName: 'Staging', helper: null }

function sshState(overrides: Partial<SshStateView> = {}): SshStateView {
  return {
    mode: 'personal',
    enabled: true,
    linked: true,
    revision: 7,
    environments: [ENV_READY],
    credentials: [],
    bindings: [],
    ...overrides,
  }
}

/** A recording `SshClient` seeded with one state view. */
function fakeSsh(initial: SshStateView): SshClient & { readonly calls: { method: string; args: unknown[] }[] } {
  let state = initial
  const calls: { method: string; args: unknown[] }[] = []
  function record<T>(method: string, args: unknown[], answer: T): Promise<T> {
    calls.push({ method, args })
    return Promise.resolve(answer)
  }
  const fake = {
    calls,
    state: async (sessionId: string) => await record('state', [sessionId], state),
    aliases: async (sessionId: string) => await record('aliases', [sessionId], { aliases: [] }),
    listDirectories: async (sessionId: string, environmentId: string, path?: string) =>
      await record('listDirectories', [sessionId, environmentId, path], { path: path ?? '/', parent: '/', entries: [] }),
    credentialGenerate: async () => state,
    credentialImport: async () => state,
    credentialPassword: async () => state,
    credentialRemove: async () => state,
    hostKeyScan: async () => await record('hostKeyScan', [], { token: 'scan-token', keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:scanned' }] }),
    environmentSave: async (sessionId: string, revision: number, environment: unknown, fingerprint: string) => {
      const draft = environment as Omit<SshEnvironmentView, 'hostKey' | 'helper'>
      const previous = state.environments.find(entry => entry.environmentId === draft.environmentId)
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        environments: [...state.environments.filter(entry => entry.environmentId !== draft.environmentId),
          { ...draft, hostKey: fingerprint, helper: previous?.helper ?? null }],
      }
      const answer = await record('environmentSave', [sessionId, revision, environment, fingerprint], next)
      state = next
      return answer
    },
    environmentRemove: async () => state,
    environmentTest: async () => ({ platform: 'linux', nodePath: '/usr/bin/node', nodeVersion: 'v22.0.0' }),
    helperInstall: async (sessionId: string, revision: number, environmentId: string, nodePath?: string) => {
      const helper = { nodePath: nodePath ?? '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 }
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        environments: state.environments.map(entry => entry.environmentId === environmentId ? { ...entry, helper } : entry),
      }
      const answer = await record('helperInstall', [sessionId, revision, environmentId, nodePath], next)
      state = next
      return answer
    },
    accessKeyInstall: async () => state,
    bindingSave: async (sessionId: string, revision: number, binding: SshBindingDraft) => {
      const rootId = binding.path.slice(binding.path.lastIndexOf('/') + 1)
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        bindings: [...state.bindings, { ...binding, rootId }],
      }
      const answer = await record('bindingSave', [sessionId, revision, binding], next)
      state = next
      return answer
    },
    bindingRemove: async () => state,
    configLink: async () => state,
  }
  return fake as unknown as SshClient & typeof fake
}

function fakeRemotes(): RemotesClient & { readonly adds: unknown[][] } {
  const adds: unknown[][] = []
  const view = { primaryRoot: '/repos/primary', endpoints: [] } as RemotesView
  return {
    adds,
    list: async () => view,
    add: async (...args: unknown[]) => { adds.push(args); return view },
    remove: async () => view,
  } as unknown as RemotesClient & { readonly adds: unknown[][] }
}

function renderWizard(ssh: SshClient, remotes: RemotesClient, onChanged?: () => void): void {
  render(createElement(RemoteWizard, {
    ssh,
    remotes,
    sessionId: 'session-1',
    roots: ROOTS,
    onClose: () => {},
    onChanged: onChanged ?? (() => {}),
    t,
  }))
}

describe('the add-remote wizard', () => {
  it('walks environment → binding → register for a ready environment', async () => {
    const ssh = fakeSsh(sshState())
    const remotes = fakeRemotes()
    renderWizard(ssh, remotes)

    // Step one names the environments it was given; a ready one may advance.
    const card = await screen.findByRole('radio', { name: /Production/ })
    const next = screen.getByRole('button', { name: 'ssh.step.next' })
    expect(next).toHaveProperty('disabled', true)
    fireEvent.click(card)
    expect(next).toHaveProperty('disabled', false)
    fireEvent.click(next)

    // Step two gates on a valid absolute path plus at least one action; `read`
    // is pre-checked, and write joins it on request.
    const path = await screen.findByLabelText('ssh.binding.path')
    fireEvent.change(path, { target: { value: '/srv/app' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'remote.capability.write' }))
    const bindingNext = screen.getByRole('button', { name: 'ssh.step.next' })
    expect(bindingNext).toHaveProperty('disabled', false)
    fireEvent.click(bindingNext)

    await waitFor(() => {
      expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(true)
    })
    expect(ssh.calls.find(call => call.method === 'bindingSave')?.args[2]).toMatchObject({
      environmentId: 'env-prod',
      path: '/srv/app',
      actions: ['read', 'write'],
    })

    // Step three registers the root the binding answer assigned.
    const register = await screen.findByRole('button', { name: 'wizard.register' })
    fireEvent.click(register)
    await waitFor(() => { expect(remotes.adds).toHaveLength(1) })
    expect(remotes.adds[0]?.slice(0, 3)).toEqual(['session-1', 'env-prod', 'app'])
    await screen.findByText('wizard.done')
  })

  it('gates a helper-less environment until the readiness repair succeeds', async () => {
    const ssh = fakeSsh(sshState({ environments: [ENV_BARE] }))
    const remotes = fakeRemotes()
    renderWizard(ssh, remotes)

    const card = await screen.findByRole('radio', { name: /Staging/ })
    fireEvent.click(card)
    const next = screen.getByRole('button', { name: 'ssh.step.next' })
    expect(next).toHaveProperty('disabled', true)

    // The readiness list offers the repair inline; once the helper lands the
    // same environment may advance without a round trip through the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'ssh.helperInstall' }))
    await waitFor(() => { expect(next).toHaveProperty('disabled', false) })
    expect(ssh.calls.some(call => call.method === 'helperInstall'
      && call.args[2] === 'env-bare')).toBe(true)
  })
})
