// @vitest-environment jsdom
/**
 * The personal-custody management area inside the Workspace Folders dialog,
 * driven against a fake `SshClient`: the area mounts only when the remote
 * section reports a ready plane in personal custody, every mutation goes
 * through the client with the current revision, secret inputs are cleared on
 * submit and never rendered, and `personal-config-conflict` reloads the state.
 */

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RootView, RootsView } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import { PanelError } from '../src/client/panel-client.ts'
import { WorkspaceFoldersDialog, type Translate } from '../src/client/WorkspaceFoldersAction.tsx'
import type { SshClient, SshEnvironmentView, SshStateView } from '../src/client/ssh-client.ts'

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

const ENV_A: SshEnvironmentView = {
  environmentId: 'env-prod',
  displayName: 'Production',
  platform: 'linux',
  endpoint: { hostname: 'prod.internal', port: 22, user: 'deploy' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:host-fingerprint',
  helper: null,
  workspace: '/srv/app',
}

function sshState(overrides: Partial<SshStateView> = {}): SshStateView {
  return {
    mode: 'personal',
    enabled: true,
    linked: true,
    revision: 7,
    environments: [ENV_A],
    credentials: [{
      id: 'aabbccddeeff',
      label: 'deploy key',
      kind: 'key',
      publicKey: 'ssh-ed25519 AAAA test',
      fingerprint: 'SHA256:cred-fingerprint',
      createdAt: '2026-11-13T00:00:00.000Z',
    }],
    bindings: [],
    ...overrides,
  }
}

/** A recording `SshClient`; failures can be injected per method. */
function fakeSsh(initial: SshStateView): SshClient & {
  readonly calls: { method: string; args: unknown[] }[]
  setState: (next: SshStateView) => void
  fail: (method: string, error: PanelError) => void
} {
  let state = initial
  const failures = new Map<string, PanelError>()
  const calls: { method: string; args: unknown[] }[] = []
  function record<T>(method: string, args: unknown[], answer: T): Promise<T> {
    calls.push({ method, args })
    const failure = failures.get(method)
    if (failure !== undefined) return Promise.reject(failure)
    return Promise.resolve(answer)
  }
  const fake = {
    calls,
    setState: (next: SshStateView) => { state = next },
    fail: (method: string, error: PanelError) => { failures.set(method, error) },
    state: async (sessionId: string) => await record('state', [sessionId], state),
    credentialGenerate: async (sessionId: string, label: string) =>
      await record('credentialGenerate', [sessionId, label], state),
    credentialImport: async (sessionId: string, label: string, privateKey: string, passphrase?: string) =>
      await record('credentialImport', [sessionId, label, privateKey, passphrase], state),
    credentialPassword: async (sessionId: string, label: string, password: string) =>
      await record('credentialPassword', [sessionId, label, password], state),
    credentialRemove: async (sessionId: string, id: string) =>
      await record('credentialRemove', [sessionId, id], state),
    hostKeyScan: async (sessionId: string, hostname: string, port: number) =>
      await record('hostKeyScan', [sessionId, hostname, port], {
        token: 'scan-token-1',
        keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:scanned' }],
      }),
    environmentSave: async (sessionId: string, revision: number, environment: unknown, fingerprint: string, hostKeyToken?: string) =>
      await record('environmentSave', [sessionId, revision, environment, fingerprint, hostKeyToken], state),
    environmentRemove: async (sessionId: string, revision: number, environmentId: string) =>
      await record('environmentRemove', [sessionId, revision, environmentId], state),
    environmentTest: async (sessionId: string, environmentId: string) =>
      await record('environmentTest', [sessionId, environmentId], { platform: 'linux', nodePath: '/usr/bin/node', nodeVersion: 'v22.0.0' }),
    helperInstall: async (sessionId: string, revision: number, environmentId: string, nodePath?: string) =>
      await record('helperInstall', [sessionId, revision, environmentId, nodePath], state),
    accessKeyInstall: async (sessionId: string, revision: number, environmentId: string) =>
      await record('accessKeyInstall', [sessionId, revision, environmentId], state),
    bindingSave: async (sessionId: string, revision: number, binding: unknown) =>
      await record('bindingSave', [sessionId, revision, binding], state),
    bindingRemove: async (sessionId: string, revision: number, environmentId: string, rootId: string) =>
      await record('bindingRemove', [sessionId, revision, environmentId, rootId], state),
    configLink: async (sessionId: string) => await record('configLink', [sessionId], state),
  }
  return fake as SshClient & typeof fake
}

function renderDialog(options: {
  ssh?: SshClient
  custodyMode?: 'personal' | 'team' | 'hardened'
  state?: RemotesView['status']['state']
} = {}): void {
  const remotesView: RemotesView = {
    primaryRoot: '/repos/primary',
    mode: 'workspace-write',
    status: { state: options.state ?? 'ready' },
    custodyMode: options.custodyMode ?? 'personal',
    endpoints: [],
  } as RemotesView
  const panel = { call: async () => ROOTS }
  const remotes = { list: async () => remotesView }
  render(createElement(WorkspaceFoldersDialog, {
    panel: panel as never,
    remotes: remotes as never,
    ssh: options.ssh,
    pickDirectory: undefined,
    sessionId: () => 'session-1',
    t,
    onClose: () => {},
  }))
}

/** The credential form's confirm button (the dialog has its own add-root one). */
function sshFormConfirm(): HTMLElement {
  return within(document.querySelector('.mrfw-sshForm') as HTMLElement).getByRole('button', { name: 'panel.addConfirm' })
}

async function callsOf(ssh: { calls: { method: string; args: unknown[] }[] }, method: string): Promise<unknown[][]> {
  await waitFor(() => expect(ssh.calls.some(call => call.method === method)).toBe(true))
  return ssh.calls.filter(call => call.method === method).map(call => call.args)
}

describe('the personal-custody management area', () => {
  it('mounts when the plane is ready in personal custody and lists credentials/environments/bindings', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    expect(screen.getByText('ssh.environments')).toBeTruthy()
    expect(screen.getByText('ssh.bindings')).toBeTruthy()
    // The view only carries public metadata — label, kind, fingerprint — and a
    // copy-public-key control for key credentials.
    expect(screen.getByText('deploy key')).toBeTruthy()
    expect(screen.getByText('SHA256:cred-fingerprint')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ssh.copyPublicKey' })).toBeTruthy()
    expect(screen.getByText('Production')).toBeTruthy()
    expect(screen.getByText(/deploy@prod\.internal:22/)).toBeTruthy()
    expect(await callsOf(ssh, 'state')).toEqual([['session-1']])
  })

  it('does not mount for team/hardened custody or without an ssh client', async () => {
    for (const custodyMode of ['team', 'hardened'] as const) {
      const ssh = fakeSsh(sshState())
      renderDialog({ ssh, custodyMode })
      await waitFor(() => expect(screen.getByText('panel.remote')).toBeTruthy())
      expect(screen.queryByText('ssh.credentials')).toBeNull()
      expect(ssh.calls.length).toBe(0)
      cleanup()
    }
    renderDialog({})
    await waitFor(() => expect(screen.getByText('panel.remote')).toBeTruthy())
    expect(screen.queryByText('ssh.credentials')).toBeNull()
  })

  it('does not mount while the plane is not ready', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh, state: 'config-invalid' })
    await waitFor(() => expect(screen.getByText('panel.remote')).toBeTruthy())
    expect(screen.queryByText('ssh.credentials')).toBeNull()
    expect(ssh.calls.length).toBe(0)
  })

  it('offers the config link when a managed environment exists but ssh_config is not linked', async () => {
    const ssh = fakeSsh(sshState({ linked: false }))
    renderDialog({ ssh })
    await screen.findByText('ssh.linkBanner')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.linkNow' }))
    expect(await callsOf(ssh, 'configLink')).toEqual([['session-1']])
  })

  it('hides the link banner once linked or when only ssh-config environments exist', async () => {
    const configOnly = fakeSsh(sshState({
      linked: false,
      environments: [{ ...ENV_A, credential: { kind: 'ssh-config', alias: 'prod' } }],
    }))
    renderDialog({ ssh: configOnly })
    await screen.findByText('ssh.credentials')
    expect(screen.queryByText('ssh.linkBanner')).toBeNull()
  })

  it('clears the password input after submit and never renders the secret', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.credentialPassword' }))
    fireEvent.change(screen.getByLabelText('ssh.label'), { target: { value: 'bot password' } })
    const secret = screen.getByLabelText('ssh.password') as HTMLInputElement
    fireEvent.change(secret, { target: { value: 's3cr3t-value' } })
    fireEvent.click(sshFormConfirm())
    expect(await callsOf(ssh, 'credentialPassword')).toEqual([['session-1', 'bot password', 's3cr3t-value']])
    expect(document.body.innerHTML).not.toContain('s3cr3t-value')
    // The form unmounts on submit; reopening proves the state was cleared —
    // a reopened secret field starts empty instead of echoing the last value.
    fireEvent.click(screen.getByRole('button', { name: 'ssh.credentialPassword' }))
    expect((screen.getByLabelText('ssh.password') as HTMLInputElement).value).toBe('')
  })

  it('clears the imported private key after submit even when the host refuses', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('credentialImport', new PanelError('credential-import-failed', 'bad key'))
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.credentialImport' }))
    const material = screen.getByLabelText('ssh.privateKey') as HTMLTextAreaElement
    fireEvent.change(screen.getByLabelText('ssh.label'), { target: { value: 'imported' } })
    fireEvent.change(material, { target: { value: 'PRIVATE-KEY-BYTES' } })
    fireEvent.click(sshFormConfirm())
    await waitFor(() => expect(screen.getByText('error.credential-import-failed')).toBeTruthy())
    expect(document.body.innerHTML).not.toContain('PRIVATE-KEY-BYTES')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.credentialImport' }))
    expect((screen.getByLabelText('ssh.privateKey') as HTMLTextAreaElement).value).toBe('')
  })

  it('scans the host key, picks the first fingerprint, and saves fingerprint+token with the draft', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envAdd' }))
    fireEvent.change(screen.getByLabelText('ssh.field.environmentId'), { target: { value: 'env-build' } })
    fireEvent.change(screen.getByLabelText('ssh.field.hostname'), { target: { value: 'build.internal' } })
    fireEvent.change(screen.getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByRole('radio', { name: 'ssh.field.alias' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'ssh.field.alias' }), { target: { value: 'build' } })
    fireEvent.change(screen.getByLabelText('ssh.field.workspace'), { target: { value: '/srv/ci' } })
    // The blank editor enables file transfer by default; turn it off so the
    // asserted draft carries no `transfer` stanza.
    fireEvent.click(screen.getByLabelText('ssh.field.allowTransfer'))
    fireEvent.click(screen.getByRole('button', { name: 'ssh.scan' }))
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', 'build.internal', 22]])
    await screen.findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envSave' }))
    const saves = await callsOf(ssh, 'environmentSave')
    expect(saves).toEqual([['session-1', 7, {
      environmentId: 'env-build',
      platform: 'linux',
      endpoint: { hostname: 'build.internal', port: 22, user: 'ci' },
      credential: { kind: 'ssh-config', alias: 'build' },
      workspace: '/srv/ci',
    }, 'SHA256:scanned', undefined]])
  })

  it('materializes the documented exec and transfer defaults when the toggles are on', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envAdd' }))
    fireEvent.change(screen.getByLabelText('ssh.field.environmentId'), { target: { value: 'env-exec' } })
    fireEvent.change(screen.getByLabelText('ssh.field.hostname'), { target: { value: 'h.internal' } })
    fireEvent.change(screen.getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByRole('radio', { name: 'ssh.field.alias' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'ssh.field.alias' }), { target: { value: 'alias' } })
    fireEvent.change(screen.getByLabelText('ssh.field.workspace'), { target: { value: '/srv/x' } })
    fireEvent.click(screen.getByLabelText('ssh.field.allowExec'))
    fireEvent.click(screen.getByRole('button', { name: 'ssh.scan' }))
    await screen.findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envSave' }))
    const saves = await callsOf(ssh, 'environmentSave')
    const draft = saves[0][2] as { exec: unknown; transfer: unknown }
    expect(draft.exec).toEqual({
      shell: ['/bin/sh', '-c'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      maxTimeoutMs: 600_000,
      stdoutLimit: 1_048_576,
      stderrLimit: 262_144,
      terminateGraceMs: 2_000,
    })
    expect(draft.transfer).toEqual({ maxBytes: 268_435_456, timeoutMs: 600_000 })
  })

  it('deletes an environment only through the inline confirm', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envDelete' }))
    fireEvent.click(screen.getByRole('button', { name: 'ssh.confirmDelete' }))
    expect(await callsOf(ssh, 'environmentRemove')).toEqual([['session-1', 7, 'env-prod']])
  })

  it('offers the primary plus available aliased roots as local transfer peers and saves the binding', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.bindingAdd' }))
    const environmentSelect = screen.getByLabelText('ssh.binding.environment') as HTMLSelectElement
    expect([...environmentSelect.options].map(option => option.value)).toEqual(['env-prod'])
    // The local sinks are the primary plus every available root's alias id —
    // the exact ids `localTransferDestination` resolves.
    const imports = screen.getAllByRole('checkbox', { name: /ssh.binding.import/ })
    const exports = screen.getAllByRole('checkbox', { name: /ssh.binding.export/ })
    expect(imports.map(input => (input as HTMLInputElement).parentElement?.textContent)).toEqual([
      'ssh.binding.import panel.primary',
      'ssh.binding.import payments',
    ])
    expect(exports).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('ssh.binding.rootId'), { target: { value: 'a' } })
    fireEvent.change(screen.getByLabelText('ssh.binding.path'), { target: { value: '/srv/data' } })
    fireEvent.click(imports[1])
    fireEvent.click(screen.getByRole('button', { name: 'ssh.binding.save' }))
    expect(await callsOf(ssh, 'bindingSave')).toEqual([['session-1', 7, {
      environmentId: 'env-prod',
      rootId: 'a',
      path: '/srv/data',
      actions: ['read'],
      transfers: [{ direction: 'import', peer: { environmentId: 'local', rootId: 'payments' } }],
    }]])
  })

  it('reloads the state and shows the localized conflict on personal-config-conflict', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('credentialGenerate', new PanelError('personal-config-conflict', 'revision moved'))
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.credentialGenerate' }))
    fireEvent.change(screen.getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm())
    await waitFor(() => expect(screen.getByText('error.personal-config-conflict')).toBeTruthy())
    expect(ssh.calls.filter(call => call.method === 'state').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the connection test result under its environment', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('ssh.credentials')
    fireEvent.click(screen.getByRole('button', { name: 'ssh.envTest' }))
    expect(await callsOf(ssh, 'environmentTest')).toEqual([['session-1', 'env-prod']])
    await screen.findByText('linux · node v22.0.0')
  })
})
