// @vitest-environment jsdom
/**
 * The standalone SSH management dialog, driven against a fake \`SshClient\`.
 *
 * The Workspace Folders panel keeps the remote-workspace list and two entry
 * points; every connection-shaped surface lives in the dialog's four tabs.
 * These tests pin that split, the mode-aware Add guidance, the actual platform
 * names, and the unchanged secret/CAS behavior of the personal management
 * flows.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RootView, RootsView } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import { PanelError } from '../src/client/panel-client.ts'
import { WorkspaceFoldersDialog, type Translate } from '../src/client/WorkspaceFoldersAction.tsx'
import type { SshClient, SshEnvironmentView, SshStateView } from '../src/client/ssh-client.ts'
import type { RemoteModeControl } from '../src/compat/skills-client.ts'
import { zh } from '../src/client/locales.ts'

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

/** A recording \`SshClient\`; failures can be injected per method. */
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
  status?: RemotesView['status']
  endpoints?: RemotesView['endpoints']
  remoteMode?: RemoteModeControl
  t?: Translate
  onList?: () => void
  onClose?: () => void
} = {}): void {
  const remotesView: RemotesView = {
    primaryRoot: '/repos/primary',
    mode: 'workspace-write',
    status: options.status ?? { state: options.state ?? 'ready' },
    custodyMode: options.custodyMode ?? 'personal',
    endpoints: options.endpoints ?? [],
  } as RemotesView
  const panel = { call: async () => ROOTS }
  const remotes = { list: async () => { options.onList?.(); return remotesView } }
  render(createElement(WorkspaceFoldersDialog, {
    panel: panel as never,
    remotes: remotes as never,
    ssh: options.ssh,
    remoteMode: options.remoteMode,
    pickDirectory: undefined,
    sessionId: () => 'session-1',
    t: options.t ?? t,
    onClose: options.onClose ?? (() => {}),
  }))
}

/** The tab strip inside the management dialog. */
function tab(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole('tab', { name })
}

/** The credential form's confirm button (the dialog has its own add-root one). */
function sshFormConfirm(dialog: HTMLElement): HTMLElement {
  return within(dialog.querySelector('.mrfw-sshForm') as HTMLElement).getByRole('button', { name: 'panel.addConfirm' })
}

async function callsOf(ssh: { calls: { method: string; args: unknown[] }[] }, method: string): Promise<unknown[][]> {
  await waitFor(() => expect(ssh.calls.some(call => call.method === method)).toBe(true))
  return ssh.calls.filter(call => call.method === method).map(call => call.args)
}

/** Open the render helper's dialog with a specific test renderer. */
function withDialog(options: Parameters<typeof renderDialog>[0], via: 'add' | 'manage'): Promise<HTMLElement> {
  renderDialog(options)
  return (async () => {
    const label = via === 'add' ? 'panel.remoteAdd' : 'panel.remoteManage'
    const entry = await screen.findByRole('button', { name: label })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    return await screen.findByRole('dialog', { name: 'ssh.dialog.title' })
  })()
}

describe('the SSH management dialog', () => {
  it('replaces the inline management area with a remote list and add/manage entries', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('panel.remote')
    // The old inline management surface is gone; the section is a list plus
    // the two entries.
    expect(screen.queryByText('ssh.credentials')).toBeNull()
    expect(screen.queryByText('ssh.custodyMode')).toBeNull()
    expect(screen.getByRole('button', { name: 'panel.remoteAdd' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'panel.remoteManage' })).toBeTruthy()
    expect(ssh.calls).toHaveLength(0)
  })

  it('opens the existing connections tab from Manage and lists the saved environment', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    expect(await within(dialog).findByText('ssh.environments')).toBeTruthy()
    expect(within(dialog).getByText('Production')).toBeTruthy()
    expect(within(dialog).getByText(/deploy@prod\.internal:22/)).toBeTruthy()
    expect(within(dialog).getByText('ssh.platform.linux')).toBeTruthy()
    expect(await callsOf(ssh, 'state')).toEqual([['session-1']])
  })

  it('opens the Add tab directly and shows the guided personal form', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    expect(await within(dialog).findByText('ssh.add.stepTarget')).toBeTruthy()
    expect(within(dialog).getByText('ssh.add.personalGuide')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'ssh.add.save' })).toBeTruthy()
    // All four tabs are present and switchable.
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.connections' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.keys' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.mode' })).toBeTruthy()
    // The form uses the primitive Input wrappers and a real field grid; the
    // old row-only .mrfw-input class must not reach a column form again.
    expect(dialog.querySelector('.mrfw-sshGrid')).toBeTruthy()
    expect(dialog.querySelector('.mrfw-sshInput input')).toBeTruthy()
    expect(dialog.querySelectorAll('input.mrfw-input, select.mrfw-input, textarea.mrfw-input')).toHaveLength(0)
    expect(within(dialog).getByText('ssh.field.hostname')).toBeTruthy()
  })

  it('renders Linux and macOS for the platform options instead of raw codes', async () => {
    const ssh = fakeSsh(sshState())
    const tZh: Translate = (key, params) => {
      let text = (zh as unknown as Record<string, string>)[key as string] ?? key
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll('{' + name + '}', String(value))
      return text
    }
    renderDialog({ ssh, t: tZh })
    const entry = await screen.findByRole('button', { name: '添加 SSH 远端…' })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: 'SSH 远端管理' })
    await within(dialog).findByText('1. 连接目标')
    const platform = within(dialog).getByLabelText('平台') as HTMLSelectElement
    expect([...platform.options].map(option => option.textContent)).toEqual(['Linux', 'macOS'])
    // The saved environment's badge uses the same mapping.
    fireEvent.click(within(dialog).getByRole('tab', { name: '已有连接' }))
    expect(await within(dialog).findByText('Linux')).toBeTruthy()
  })

  it('lists SSH keys in the Keys tab and keeps the consequence note', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(tab(dialog, 'ssh.tab.keys'))
    expect(await within(dialog).findByText('ssh.credentials')).toBeTruthy()
    expect(within(dialog).getByText('deploy key')).toBeTruthy()
    expect(within(dialog).getByText('SHA256:cred-fingerprint')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'ssh.copyPublicKey' })).toBeTruthy()
    expect(within(dialog).getByText('ssh.keys.personalGuide')).toBeTruthy()
  })

  it('renders the shared custody-mode control in the Mode tab and writes the form', async () => {
    const writes: unknown[] = []
    const snapshot = { value: { enabled: true, mode: 'personal' }, status: 'ready', writable: true, revision: 2 }
    const form = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate: async (...args: unknown[]) => { writes.push(args); return true },
    }
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({
      ssh,
      remoteMode: { form: () => form, subscribe: () => () => {} },
    }, 'manage')
    fireEvent.click(tab(dialog, 'ssh.tab.mode'))
    expect(await within(dialog).findByText('ssh.custodyMode')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: /remote\.mode\.team/ }))
    await waitFor(() => expect(writes).toEqual([[[{ op: 'set', path: ['mode'], value: 'team' }], 2]]))
  })

  it('shows deployment guidance and never calls sshState in team/hardened custody', async () => {
    for (const custodyMode of ['team', 'hardened'] as const) {
      const ssh = fakeSsh(sshState())
      const dialog = await withDialog({ ssh, custodyMode }, 'manage')
      expect(await within(dialog).findByText(/ssh\.connections\.deploymentGuide/)).toBeTruthy()
      expect(within(dialog).queryByText('ssh.environments')).toBeNull()
      fireEvent.click(tab(dialog, 'ssh.tab.add'))
      expect(await within(dialog).findByText(custodyMode === 'team' ? 'ssh.add.teamGuide' : 'ssh.add.hardenedGuide')).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: 'ssh.add.save' })).toBeNull()
      expect(ssh.calls).toHaveLength(0)
      cleanup()
    }
  })

  it('does not open a personal surface without an ssh client', async () => {
    const dialog = await withDialog({ custodyMode: 'personal' }, 'add')
    expect(await within(dialog).findByText('ssh.add.noClient')).toBeTruthy()
  })

  it('keeps the custody control available when the plane is config-invalid', async () => {
    const snapshot = { value: { enabled: true, mode: 'team' }, status: 'ready', writable: true, revision: 1 }
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    const dialog = await withDialog({
      ssh: fakeSsh(sshState()),
      status: { state: 'config-invalid', reason: 'missing manifest' },
      remoteMode: { form: () => form, subscribe: () => () => {} },
    }, 'manage')
    expect(await within(dialog).findByText(/ssh\.add\.loading|panel\.remoteUnavailable/)).toBeTruthy()
    fireEvent.click(tab(dialog, 'ssh.tab.mode'))
    expect(await within(dialog).findByText('ssh.custodyMode')).toBeTruthy()
    expect(within(dialog).getByRole('radio', { name: /remote\.mode\.personal/ })).toBeTruthy()
  })

  it('refreshes the remote section when the shared settings form changes', async () => {
    const listeners: (() => void)[] = []
    const snapshot = { value: { enabled: true, mode: 'personal' }, status: 'ready', writable: true, revision: 1 }
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    let lists = 0
    renderDialog({
      ssh: fakeSsh(sshState()),
      remoteMode: {
        form: () => form,
        subscribe: listener => { listeners.push(listener); return () => {} },
      },
      onList: () => { lists += 1 },
    })
    await screen.findByText('panel.remote')
    await waitFor(() => expect(lists).toBe(1))
    act(() => { for (const listener of listeners) listener() })
    await waitFor(() => expect(lists).toBeGreaterThan(1))
  })

  it('offers the config link in the Connections tab and keeps it hidden when linked', async () => {
    const ssh = fakeSsh(sshState({ linked: false }))
    const dialog = await withDialog({ ssh }, 'manage')
    expect(await within(dialog).findByText('ssh.linkBanner')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.linkNow' }))
    expect(await callsOf(ssh, 'configLink')).toEqual([['session-1']])
  })

  it('hides the link banner once linked or when only ssh-config environments exist', async () => {
    const configOnly = fakeSsh(sshState({
      linked: false,
      environments: [{ ...ENV_A, credential: { kind: 'ssh-config', alias: 'prod' } }],
    }))
    const dialog = await withDialog({ ssh: configOnly }, 'manage')
    expect(await within(dialog).findByText('ssh.environments')).toBeTruthy()
    expect(within(dialog).queryByText('ssh.linkBanner')).toBeNull()
  })

  it('clears the password input after submit and never renders the secret', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(tab(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialPassword' }))
    fireEvent.change(within(dialog).getByLabelText('ssh.label'), { target: { value: 'bot password' } })
    const secret = within(dialog).getByLabelText('ssh.password') as HTMLInputElement
    fireEvent.change(secret, { target: { value: 's3cr3t-value' } })
    fireEvent.click(sshFormConfirm(dialog))
    expect(await callsOf(ssh, 'credentialPassword')).toEqual([['session-1', 'bot password', 's3cr3t-value']])
    expect(dialog.innerHTML).not.toContain('s3cr3t-value')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialPassword' }))
    expect((within(dialog).getByLabelText('ssh.password') as HTMLInputElement).value).toBe('')
  })

  it('clears the imported private key after submit even when the host refuses', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('credentialImport', new PanelError('credential-import-failed', 'bad key'))
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(tab(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialImport' }))
    const material = within(dialog).getByLabelText('ssh.privateKey') as HTMLTextAreaElement
    fireEvent.change(within(dialog).getByLabelText('ssh.label'), { target: { value: 'imported' } })
    fireEvent.change(material, { target: { value: 'PRIVATE-KEY-BYTES' } })
    fireEvent.click(sshFormConfirm(dialog))
    await waitFor(() => expect(within(dialog).getByText('error.credential-import-failed')).toBeTruthy())
    expect(dialog.innerHTML).not.toContain('PRIVATE-KEY-BYTES')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialImport' }))
    expect((within(dialog).getByLabelText('ssh.privateKey') as HTMLTextAreaElement).value).toBe('')
  })

  it('scans the host key, picks the first fingerprint, and saves fingerprint+token with the draft', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    await within(dialog).findByText('ssh.add.stepTarget')
    fireEvent.change(within(dialog).getByLabelText('ssh.field.environmentId'), { target: { value: 'env-build' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: 'build.internal' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ssh.field.alias' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'ssh.field.alias' }), { target: { value: 'build' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.workspace'), { target: { value: '/srv/ci' } })
    fireEvent.click(within(dialog).getByLabelText('ssh.field.allowTransfer'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', 'build.internal', 22]])
    await within(dialog).findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.save' }))
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
    const dialog = await withDialog({ ssh }, 'add')
    await within(dialog).findByText('ssh.add.stepTarget')
    fireEvent.change(within(dialog).getByLabelText('ssh.field.environmentId'), { target: { value: 'env-exec' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: 'h.internal' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ssh.field.alias' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'ssh.field.alias' }), { target: { value: 'alias' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.workspace'), { target: { value: '/srv/x' } })
    fireEvent.click(within(dialog).getByLabelText('ssh.field.allowExec'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    await within(dialog).findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.save' }))
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

  it('edits a saved environment in the Connections tab', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = dialog.querySelector('.mrfw-sshForm') as HTMLElement
    expect((within(editor).getByLabelText('ssh.field.environmentId') as HTMLInputElement).value).toBe('env-prod')
    fireEvent.change(within(editor).getByLabelText('ssh.field.hostname'), { target: { value: 'prod2.internal' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'ssh.scan' }))
    await within(editor).findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(within(editor).getByRole('button', { name: 'ssh.envSave' }))
    const saves = await callsOf(ssh, 'environmentSave')
    expect((saves[0][2] as { endpoint: { hostname: string } }).endpoint.hostname).toBe('prod2.internal')
  })

  it('deletes an environment only through the inline confirm', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envDelete' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.confirmDelete' }))
    expect(await callsOf(ssh, 'environmentRemove')).toEqual([['session-1', 7, 'env-prod']])
  })

  it('offers the primary plus available aliased roots as local transfer peers and saves the binding', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.bindingAdd' }))
    const environmentSelect = within(dialog).getByLabelText('ssh.binding.environment') as HTMLSelectElement
    expect([...environmentSelect.options].map(option => option.value)).toEqual(['env-prod'])
    // The local sinks are the primary plus every available root's alias id —
    // the exact ids localTransferDestination resolves.
    const imports = within(dialog).getAllByRole('checkbox', { name: /ssh.binding.import/ })
    const exports = within(dialog).getAllByRole('checkbox', { name: /ssh.binding.export/ })
    expect(imports.map(input => (input as HTMLInputElement).parentElement?.textContent)).toEqual([
      'ssh.binding.import panel.primary',
      'ssh.binding.import payments',
    ])
    expect(exports).toHaveLength(2)
    fireEvent.change(within(dialog).getByLabelText('ssh.binding.rootId'), { target: { value: 'a' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.binding.path'), { target: { value: '/srv/data' } })
    fireEvent.click(imports[1]!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.binding.save' }))
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
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(tab(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialGenerate' }))
    fireEvent.change(within(dialog).getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm(dialog))
    await waitFor(() => expect(within(dialog).getByText('error.personal-config-conflict')).toBeTruthy())
    expect(ssh.calls.filter(call => call.method === 'state').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the connection test result under its environment with the actual platform name', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envTest' }))
    expect(await callsOf(ssh, 'environmentTest')).toEqual([['session-1', 'env-prod']])
    await within(dialog).findByText('ssh.platform.linux · node v22.0.0')
  })

  it('asks the Workspace Folders panel to re-read the remote section after a mutation', async () => {
    const ssh = fakeSsh(sshState())
    let lists = 0
    renderDialog({ ssh, onList: () => { lists += 1 } })
    const entry = await screen.findByRole('button', { name: 'panel.remoteManage' })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: 'ssh.dialog.title' })
    fireEvent.click(tab(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialGenerate' }))
    fireEvent.change(within(dialog).getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm(dialog))
    await callsOf(ssh, 'credentialGenerate')
    await waitFor(() => expect(lists).toBeGreaterThan(1))
  })

  it('closes without closing the Workspace Folders dialog underneath', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.dialog.title' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'panel.title' })).toBeTruthy()
  })
})
