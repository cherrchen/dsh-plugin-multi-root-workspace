// @vitest-environment jsdom
/**
 * The standalone SSH management dialog, driven against a fake \`SshClient\`.
 *
 * The Workspace Folders panel keeps the remote-workspace list and two entry
 * points; connection management lives in the three-tab dialog and Add wizard.
 * These tests pin that split, the two-step Add flow, the actual platform
 * names, and the unchanged secret/CAS behavior of the personal management
 * flows.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RootView, RootsView } from '../src/contract.ts'
import type { RemotesView } from '../src/remote/panel-contract.ts'
import { PanelError } from '../src/client/panel-client.ts'
import { SshManagementDialog, type SshManagementDialogProps } from '../src/client/ssh-panel.tsx'
import { WorkspaceFoldersDialog, type Translate } from '../src/client/WorkspaceFoldersAction.tsx'
import type { SshBindingDraft, SshClient, SshEnvironmentView, SshStateView } from '../src/client/ssh-client.ts'
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
}

const ENV_HELPER: SshEnvironmentView = {
  ...ENV_A,
  environmentId: 'env-helper',
  helper: { nodePath: '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 },
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
    aliases: async (sessionId: string) => await record('aliases', [sessionId], { aliases: ['prod.host', 'build.internal'] }),
    listDirectories: async (sessionId: string, environmentId: string, path?: string) => {
      const base = path === undefined || path === '' ? '/home/deploy' : path
      return await record('listDirectories', [sessionId, environmentId, path], {
        path: base,
        parent: base === '/' ? '/' : base.slice(0, base.lastIndexOf('/')) || '/',
        entries: [{ name: 'app', path: base === '/' ? '/app' : base + '/app' }],
      })
    },
    credentialGenerate: async (sessionId: string, label: string) =>
      await record('credentialGenerate', [sessionId, label], state),
    credentialImport: async (sessionId: string, label: string, privateKey: string, passphrase?: string) =>
      await record('credentialImport', [sessionId, label, privateKey, passphrase], state),
    credentialPassword: async (sessionId: string, label: string, password: string) =>
      await record('credentialPassword', [sessionId, label, password], state),
    credentialRemove: async (sessionId: string, id: string) =>
      await record('credentialRemove', [sessionId, id], state),
    hostKeyScan: async (sessionId: string, target: { hostname?: string; port?: number; alias?: string }) =>
      await record('hostKeyScan', [sessionId, target], {
        token: 'scan-token-1',
        keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:scanned' }],
        ...(target.alias !== undefined
          ? { endpoint: { hostname: 'resolved.internal', port: 22, user: 'root' } }
          : {}),
      }),
    environmentSave: async (sessionId: string, revision: number, environment: unknown, fingerprint: string, hostKeyToken: string | undefined, intent: 'create' | 'update') => {
      const draft = environment as Omit<SshEnvironmentView, 'hostKey' | 'helper'>
      const previous = state.environments.find(existing => existing.environmentId === draft.environmentId)
      const sameTarget = previous !== undefined
        && previous.endpoint.hostname === draft.endpoint.hostname
        && previous.endpoint.port === draft.endpoint.port
        && previous.endpoint.user === draft.endpoint.user
        && previous.credential.kind === draft.credential.kind
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        environments: [...state.environments.filter(existing => existing.environmentId !== draft.environmentId),
          { ...draft, hostKey: fingerprint, helper: sameTarget ? previous.helper : null }],
      }
      const answer = await record('environmentSave', [sessionId, revision, environment, fingerprint, hostKeyToken, intent], next)
      state = next
      return answer
    },
    environmentRemove: async (sessionId: string, revision: number, environmentId: string) => {
      const next: SshStateView = { ...state, revision: revision + 1, environments: state.environments.filter(env => env.environmentId !== environmentId) }
      const answer = await record('environmentRemove', [sessionId, revision, environmentId], next)
      state = next
      return answer
    },
    environmentTest: async (sessionId: string, environmentId: string) =>
      await record('environmentTest', [sessionId, environmentId], { platform: 'linux', nodePath: '/usr/bin/node', nodeVersion: 'v22.0.0' }),
    helperInstall: async (sessionId: string, revision: number, environmentId: string, nodePath?: string) => {
      const helper = { nodePath: nodePath ?? '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 }
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        environments: state.environments.map(env => env.environmentId === environmentId ? { ...env, helper } : env),
      }
      const answer = await record('helperInstall', [sessionId, revision, environmentId, nodePath], next)
      state = next
      return answer
    },
    accessKeyInstall: async (sessionId: string, revision: number, environmentId: string) =>
      await record('accessKeyInstall', [sessionId, revision, environmentId], state),
    bindingSave: async (sessionId: string, revision: number, binding: SshBindingDraft) => {
      const rootId = binding.rootId ?? binding.path.slice(binding.path.lastIndexOf('/') + 1)
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        bindings: [...state.bindings.filter(entry => entry.environmentId !== binding.environmentId || entry.rootId !== rootId), { ...binding, rootId }],
      }
      const answer = await record('bindingSave', [sessionId, revision, binding], next)
      state = next
      return answer
    },
    bindingRemove: async (sessionId: string, revision: number, environmentId: string, rootId: string) => {
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        bindings: state.bindings.filter(binding => !(binding.environmentId === environmentId && binding.rootId === rootId)),
      }
      const answer = await record('bindingRemove', [sessionId, revision, environmentId, rootId], next)
      state = next
      return answer
    },
    configLink: async (sessionId: string) => {
      const next: SshStateView = { ...state, linked: true }
      const answer = await record('configLink', [sessionId], next)
      state = next
      return answer
    },
  }
  return fake as SshClient & typeof fake
}

function renderDialog(options: {
  ssh?: SshClient
  custodyMode?: 'personal' | 'team' | 'hardened'
  state?: RemotesView['status']['state']
  status?: RemotesView['status']
  endpoints?: RemotesView['endpoints']
  subscribeRemoteSettings?: (listener: () => void) => () => void
  t?: Translate
  onList?: () => void
  onClose?: () => void
  remoteCalls?: { method: string; args: unknown[] }[]
  remoteAddGate?: Promise<void>
} = {}): void {
  const remotesView: RemotesView = {
    primaryRoot: '/repos/primary',
    mode: 'workspace-write',
    status: options.status ?? { state: options.state ?? 'ready' },
    custodyMode: options.custodyMode ?? 'personal',
    endpoints: options.endpoints ?? [],
  } as RemotesView
  const panel = { call: async () => ROOTS }
  const remotes = {
    list: async () => { options.onList?.(); return remotesView },
    add: async (...args: unknown[]) => {
      options.remoteCalls?.push({ method: 'add', args })
      if (options.remoteAddGate !== undefined) await options.remoteAddGate
      return remotesView
    },
    remove: async (...args: unknown[]) => { options.remoteCalls?.push({ method: 'remove', args }); return remotesView },
  }
  render(createElement(WorkspaceFoldersDialog, {
    panel: panel as never,
    remotes: remotes as never,
    ssh: options.ssh,
    subscribeRemoteSettings: options.subscribeRemoteSettings,
    pickDirectory: undefined,
    sessionId: () => 'session-1',
    t: options.t ?? t,
    onClose: options.onClose ?? (() => {}),
  }))
}

/** The tab strip inside the management dialog. */
function settingsNavItem(dialog: HTMLElement, name: string): HTMLElement {
  const navigation = within(dialog).getByRole('navigation', { name: 'ssh.tab.listLabel' })
  return within(navigation).getByRole('button', { name })
}

/** Open the add-credential modal and pick a kind; returns the modal element. */
async function chooseCredentialForm(dialog: HTMLElement, kind: 'Generate' | 'Import' | 'Password'): Promise<HTMLElement> {
  if (screen.queryByRole('dialog', { name: 'ssh.credentialAdd' }) !== null) {
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.credentialAdd' })).toBeNull())
  }
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialAdd' }))
  const modal = await screen.findByRole('dialog', { name: 'ssh.credentialAdd' })
  fireEvent.click(within(modal).getByRole('radio', { name: new RegExp(`ssh.credential${kind}`) }))
  return modal
}

function sshFormConfirm(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: 'panel.addConfirm' })
}

async function callsOf(ssh: { calls: { method: string; args: unknown[] }[] }, method: string): Promise<unknown[][]> {
  try {
    await waitFor(() => expect(ssh.calls.some(call => call.method === method)).toBe(true))
  } catch {
    throw new Error(`callsOf(${method}) timed out; recorded: ${JSON.stringify(ssh.calls.map(call => call.method))}`)
  }
  return ssh.calls.filter(call => call.method === method).map(call => call.args)
}

/** Open the render helper's dialog with a specific test renderer. */
function withDialog(options: Parameters<typeof renderDialog>[0], via: 'add' | 'manage'): Promise<HTMLElement> {
  renderDialog(options)
  return (async () => {
    const entry = await screen.findByRole('button', { name: 'panel.remoteManage' })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: 'ssh.dialog.title' })
    if (via === 'manage') return dialog
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.tab.add' }))
    return await screen.findByRole('dialog', { name: 'ssh.tab.add' })
  })()
}

/** Fill step one's target fields without submitting. */
function fillConnectStep(dialog: HTMLElement, fields: {
  displayName?: string
  hostname?: string
  user?: string
  port?: string
}): void {
  if (fields.displayName !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.displayName'), { target: { value: fields.displayName } })
  }
  if (fields.hostname !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: fields.hostname } })
  }
  if (fields.user !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: fields.user } })
  }
  if (fields.port !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.port'), { target: { value: fields.port } })
  }
}

function openPicker(dialog: HTMLElement, label: string): HTMLElement {
  fireEvent.click(within(dialog).getByRole('button', { name: label }))
  return screen.getByRole('menu')
}

function selectOption(dialog: HTMLElement, label: string, option: string): void {
  fireEvent.click(within(openPicker(dialog, label)).getByRole('button', { name: option }))
}

/** Pick a managed credential in step one. */
function selectManagedCredential(dialog: HTMLElement): void {
  selectOption(dialog, 'ssh.field.managed', 'deploy key')
}

/** Switch step one's credential source. */
function selectCredentialSource(dialog: HTMLElement, source: 'alias' | 'managed'): void {
  selectOption(dialog, 'ssh.field.credentialSource', `ssh.field.${source}`)
}

/** Click scan, then pick one fingerprint on the wizard's host-key pane. */
async function scanAndConfirm(
  dialog: HTMLElement,
  ssh: { calls: { method: string; args: unknown[] }[] },
  fingerprint = 'SHA256:scanned',
): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
  const keys = await within(dialog).findByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })
  fireEvent.click(within(keys).getByRole('radio', { name: new RegExp(fingerprint) }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scanConfirm' }))
  await callsOf(ssh, 'environmentSave')
}

/** Finish the wizard's setup step and close it from the done pane. */
async function finishAndClose(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.finish' }))
  await within(dialog).findByText('ssh.add.done')
  const footer = dialog.querySelector('.mrfw-wizFoot') as HTMLElement
  fireEvent.click(within(footer).getByRole('button', { name: 'panel.close' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.tab.add' })).toBeNull())
}

async function openBindings(ssh: SshClient, options: { add?: boolean } = {}): Promise<HTMLElement> {
  renderDialog({ ssh })
  fireEvent.click(await screen.findByRole('button', { name: 'panel.remoteBindings' }))
  const dialog = await screen.findByRole('dialog', { name: 'ssh.bindings' })
  const add = await within(dialog).findByRole('button', { name: 'ssh.bindingAdd' })
  if (options.add !== false) fireEvent.click(add)
  return dialog
}

describe('the SSH management dialog', () => {
  it('replaces the inline management area with a remote list and the manage entry', async () => {
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh })
    await screen.findByText('panel.remoteList')
    // The old inline management surface is gone; the section is a list plus
    // the single management entry. Adding a connection lives in its dialog.
    expect(screen.queryByText('ssh.credentials')).toBeNull()
    expect(screen.queryByText('ssh.custodyMode')).toBeNull()
    expect(screen.getByRole('button', { name: 'panel.remoteManage' })).toBeTruthy()
    const bindings = await screen.findByRole('button', { name: 'panel.remoteBindings' })
    expect(bindings.parentElement).toBe(screen.getByRole('button', { name: 'panel.remoteManage' }).parentElement)
    expect(bindings.closest('section')).toBe(screen.getByText('panel.remoteList').closest('section'))
    expect(screen.queryByText('panel.remote')).toBeNull()
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

  it('opens the Add connection dialog from the Connections tab', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    const main = screen.getByRole('dialog', { name: 'ssh.dialog.title' })
    // The settings navigation contains two sections. Adding opens its own dialog.
    const navigation = within(main).getByRole('navigation', { name: 'ssh.tab.listLabel' })
    expect(within(navigation).getAllByRole('button').map(node => node.textContent))
      .toEqual(['ssh.tab.connections', 'ssh.tab.keys'])
    expect(settingsNavItem(main, 'ssh.tab.connections').getAttribute('aria-current')).toBe('true')
    expect(within(main).getByRole('button', { name: 'ssh.tab.add' })).toBeTruthy()
    // Step one collects credentials, name, target and platform on the wizard kit.
    expect(await within(dialog).findByLabelText('ssh.field.displayName')).toBeTruthy()
    expect(within(dialog).queryByLabelText('ssh.field.environmentId')).toBeNull()
    expect(within(dialog).getByLabelText('ssh.field.credentialSource')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'ssh.field.managed' }).getAttribute('aria-haspopup')).toBe('menu')
    expect(dialog.querySelector('select, datalist')).toBeNull()
    expect(within(dialog).queryByLabelText('ssh.field.workspace')).toBeNull()
    expect(within(dialog).getByText('ssh.add.personalGuide')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'ssh.credentialManage' })).toBeTruthy()
    const steps = within(dialog).getByRole('list', { name: 'ssh.step.listLabel' })
    expect([...steps.querySelectorAll('.mrfw-wizStepTitle')].map(item => item.textContent)).toEqual(['ssh.add.stepInfo', 'ssh.add.stepSetup'])
    expect(steps.querySelector('[aria-current="step"] .mrfw-wizStepTitle')?.textContent).toBe('ssh.add.stepInfo')
    expect(within(dialog).getByRole('button', { name: 'ssh.scan' })).toBeTruthy()
    // The add dialog carries no tabs of its own.
    expect(within(dialog).queryByRole('tab')).toBeNull()
    // The form uses the primitive Input wrappers and a real field grid; the
    // old row-only .mrfw-input class must not reach a column form again.
    expect(dialog.querySelectorAll('input.mrfw-input, select.mrfw-input, textarea.mrfw-input')).toHaveLength(0)
  })

  it('closes the Add connection dialog and discards its draft', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fireEvent.change(within(dialog).getByLabelText('ssh.field.displayName'), { target: { value: 'Discarded' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.tab.add' })).toBeNull())
    const main = screen.getByRole('dialog', { name: 'ssh.dialog.title' })
    expect(within(main).getByText('ssh.environments')).toBeTruthy()
    // Reopening starts from a blank draft instead of the closed one.
    fireEvent.click(within(main).getByRole('button', { name: 'ssh.tab.add' }))
    const reopened = await screen.findByRole('dialog', { name: 'ssh.tab.add' })
    expect((within(reopened).getByLabelText('ssh.field.displayName') as HTMLInputElement).value).toBe('')
  })

  it('keeps the credential controls and the host metadata on the wizard rows', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    await within(dialog).findByLabelText('ssh.field.displayName')
    // The managed credential picker and the manage action sit on one path bar.
    const pathBars = dialog.querySelectorAll('.mrfw-sshPathBar')
    const credentialBar = [...pathBars].find(bar => within(bar as HTMLElement).queryByRole('button', { name: 'ssh.field.managed' })) as HTMLElement
    expect(credentialBar).toBeTruthy()
    expect(within(credentialBar).getByRole('button', { name: 'ssh.field.managed' })).toBeTruthy()
    expect(within(credentialBar).getByRole('button', { name: 'ssh.credentialManage' })).toBeTruthy()

    // The endpoint is one ssh-target row: user @ host : port.
    const targetRow = dialog.querySelector('.mrfw-wizTargetRow') as HTMLElement
    expect(targetRow).toBeTruthy()
    expect([...targetRow.querySelectorAll('.mrfw-wizFieldLabel')].map(node => node.textContent))
      .toEqual(['ssh.field.user', 'ssh.field.hostname', 'ssh.field.port'])
    expect([...targetRow.querySelectorAll('.mrfw-wizTargetSep')].map(node => node.textContent)).toEqual(['@', ':'])
  })

  it('renders Linux and macOS for the platform options instead of raw codes', async () => {
    const ssh = fakeSsh(sshState())
    const tZh: Translate = (key, params) => {
      let text = (zh as unknown as Record<string, string>)[key as string] ?? key
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll('{' + name + '}', String(value))
      return text
    }
    renderDialog({ ssh, t: tZh })
    const entry = await screen.findByRole('button', { name: '管理 SSH 远端…' })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    const main = await screen.findByRole('dialog', { name: 'SSH 设置' })
    // The saved environment's badge uses the same mapping.
    expect(await within(main).findByText('Linux')).toBeTruthy()
    fireEvent.click(within(main).getByRole('button', { name: '添加连接' }))
    const dialog = await screen.findByRole('dialog', { name: '添加连接' })
    const menu = openPicker(dialog, '平台')
    expect(within(menu).getAllByRole('button').map(option => option.textContent)).toEqual(['Linux', 'macOS'])
    expect(within(menu).getByRole('button', { name: 'Linux' }).getAttribute('data-selected')).toBe('true')
  })

  it('lists SSH keys in the Keys tab and keeps the consequence note', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    const keys = settingsNavItem(dialog, 'ssh.tab.keys')
    fireEvent.click(keys)
    expect(keys.getAttribute('aria-current')).toBe('true')
    expect(settingsNavItem(dialog, 'ssh.tab.connections').hasAttribute('aria-current')).toBe(false)
    const pane = within(dialog).getByRole('region', { name: 'ssh.credentials' })
    expect(await within(pane).findByRole('heading', { name: 'ssh.credentials' })).toBeTruthy()
    expect(within(pane).getByRole('listitem').textContent).toContain('deploy key')
    expect(within(pane).queryByRole('button', { name: 'ssh.credentialGenerate' })).toBeNull()
    expect(within(pane).getByRole('button', { name: 'ssh.credentialAdd' })).toBeTruthy()
    expect(within(dialog).getByText('SHA256:cred-fingerprint')).toBeTruthy()
    const actions = within(pane).getByRole('group', { name: 'deploy key' })
    for (const [label, glyph] of [['ssh.copyPublicKey', 'copy'], ['ssh.delete', 'trash']]) {
      const action = within(actions).getByRole('button', { name: label })
      expect(action.textContent).toBe('')
      expect(action.classList.contains('mrfw-btnGhost')).toBe(true)
      expect(action.getAttribute('title')).toBe(label)
      expect(action.querySelector(`[data-icon="${glyph}"]`)).toBeTruthy()
    }
    fireEvent.click(within(actions).getByRole('button', { name: 'ssh.delete' }))
    const confirm = within(actions).getByRole('button', { name: 'ssh.confirmDelete' })
    expect(confirm.textContent).toBe('ssh.confirmDelete')
    const cancel = within(actions).getByRole('button', { name: 'ssh.cancel' })
    expect(cancel.textContent).toBe('ssh.cancel')
    fireEvent.click(cancel)
    expect(ssh.calls.some(call => call.method === 'credentialRemove')).toBe(false)
    expect(within(dialog).getByText('ssh.keys.personalGuide')).toBeTruthy()
  })

  it.each(['team', 'hardened'] as const)('hides remote endpoints and actions reported by a legacy %s host', async custodyMode => {
    const ssh = fakeSsh(sshState())
    const listed = vi.fn()
    renderDialog({ ssh, custodyMode, onList: listed })
    await waitFor(() => expect(listed).toHaveBeenCalled())
    expect(screen.queryByText('panel.remoteList')).toBeNull()
    expect(screen.queryByRole('button', { name: 'panel.remoteManage' })).toBeNull()
    expect(ssh.calls).toHaveLength(0)
  })

  it('shows the no-client note instead of an add entry without an ssh client', async () => {
    const dialog = await withDialog({ custodyMode: 'personal' }, 'manage')
    expect(await within(dialog).findByText('ssh.add.noClient')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'ssh.tab.add' })).toBeNull()
  })

  it('refreshes the remote section when the shared settings form changes', async () => {
    const listeners: (() => void)[] = []
    let lists = 0
    renderDialog({
      ssh: fakeSsh(sshState()),
      subscribeRemoteSettings: listener => { listeners.push(listener); return () => {} },
      onList: () => { lists += 1 },
    })
    await screen.findByText('panel.remoteList')
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
    fireEvent.click(settingsNavItem(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    const add = await chooseCredentialForm(dialog, 'Password')
    fireEvent.change(within(add).getByLabelText('ssh.label'), { target: { value: 'bot password' } })
    const secret = within(add).getByLabelText('ssh.password') as HTMLInputElement
    fireEvent.change(secret, { target: { value: 's3cr3t-value' } })
    fireEvent.click(sshFormConfirm(add))
    expect(await callsOf(ssh, 'credentialPassword')).toEqual([['session-1', 'bot password', 's3cr3t-value']])
    expect(dialog.innerHTML).not.toContain('s3cr3t-value')
    const reopen = await chooseCredentialForm(dialog, 'Password')
    expect((within(reopen).getByLabelText('ssh.password') as HTMLInputElement).value).toBe('')
  })

  it('clears the imported private key after submit even when the host refuses', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('credentialImport', new PanelError('credential-import-failed', 'bad key'))
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(settingsNavItem(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    const add = await chooseCredentialForm(dialog, 'Import')
    const material = within(add).getByLabelText('ssh.privateKey') as HTMLTextAreaElement
    fireEvent.change(within(add).getByLabelText('ssh.label'), { target: { value: 'imported' } })
    fireEvent.change(material, { target: { value: 'PRIVATE-KEY-BYTES' } })
    fireEvent.click(sshFormConfirm(add))
    await waitFor(() => expect(screen.getByText('error.credential-import-failed')).toBeTruthy())
    expect(dialog.innerHTML).not.toContain('PRIVATE-KEY-BYTES')
    const reopen = await chooseCredentialForm(dialog, 'Import')
    expect((within(reopen).getByLabelText('ssh.privateKey') as HTMLTextAreaElement).value).toBe('')
  })

  it('opens setup after the connection is saved and allows finishing without a binding', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { displayName: 'Env Build', hostname: 'build.internal', user: 'ci' })
    selectManagedCredential(dialog)
    await scanAndConfirm(dialog, ssh)
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', { port: 22, hostname: 'build.internal' }]])
    const saves = await callsOf(ssh, 'environmentSave')
    expect(saves).toEqual([['session-1', 7, {
      environmentId: 'env-build',
      displayName: 'Env Build',
      platform: 'linux',
      endpoint: { hostname: 'build.internal', port: 22, user: 'ci' },
      credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
    }, 'SHA256:scanned', 'scan-token-1', 'create']])
    await within(dialog).findByRole('button', { name: 'ssh.step.finish' })
    expect(dialog.querySelector('[aria-current="step"] .mrfw-wizStepTitle')?.textContent).toBe('ssh.add.stepSetup')
    expect((within(dialog).getByLabelText('ssh.field.allowExec') as HTMLInputElement).disabled).toBe(true)
    await finishAndClose(dialog)
    const management = screen.getByRole('dialog', { name: 'ssh.dialog.title' })
    expect(within(management).getByText('Env Build')).toBeTruthy()
    expect(within(management).queryByRole('button', { name: 'ssh.bindingAdd' })).toBeNull()
    expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(false)
    expect(ssh.calls.filter(call => call.method === 'environmentSave')).toHaveLength(1)
  })

  it('detects Node, installs the Helper and saves execution from settings without a session or a new scan', async () => {
    const ssh = fakeSsh(sshState())
    render(<SshManagementDialog initialTab="connections" ssh={ssh} fromSettings sessionId={undefined}
      custodyMode="personal" status={{ state: 'ready' }}
      onClose={() => {}} onChanged={() => {}} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ssh.tab.add' }))
    const dialog = await screen.findByRole('dialog', { name: 'ssh.tab.add' })
    fillConnectStep(dialog, { displayName: 'Env Build', hostname: 'build.internal', user: 'ci' })
    selectManagedCredential(dialog)
    await scanAndConfirm(dialog, ssh)

    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.add.detectNode' }))
    expect(await callsOf(ssh, 'environmentTest')).toEqual([[undefined, 'env-build']])
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.helperInstall' }))
    // The wizard delegates node discovery to the host probe rather than an
    // input field: install is sent without a path.
    expect(await callsOf(ssh, 'helperInstall')).toEqual([[undefined, 8, 'env-build', undefined]])
    await within(dialog).findByText('ssh.helperInstalled')
    const exec = within(dialog).getByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(exec.disabled).toBe(false)
    expect(exec.checked).toBe(false)
    fireEvent.click(exec)
    fireEvent.click(within(dialog).getByLabelText('ssh.field.allowTransfer'))
    await finishAndClose(dialog)
    expect(await callsOf(ssh, 'environmentSave')).toEqual([
      [undefined, 7, expect.objectContaining({ environmentId: 'env-build' }), 'SHA256:scanned', 'scan-token-1', 'create'],
      [undefined, 9, expect.objectContaining({
        environmentId: 'env-build',
        exec: expect.objectContaining({ shell: ['/bin/sh', '-c'] }),
        transfer: { maxBytes: 268_435_456, timeoutMs: 600_000 },
      }), 'SHA256:scanned', undefined, 'update'],
    ])
    expect(ssh.calls.filter(call => call.method === 'hostKeyScan')).toHaveLength(1)
    expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(false)

    const binding = await openBindings(ssh)
    selectOption(binding, 'ssh.binding.environment', 'Env Build')
    fireEvent.change(within(binding).getByLabelText('ssh.binding.path'), { target: { value: '/srv/app' } })
    const bindingExec = within(binding).getByLabelText('remote.capability.exec') as HTMLInputElement
    expect(bindingExec.disabled).toBe(false)
    fireEvent.click(bindingExec)
    fireEvent.click(within(binding).getByRole('button', { name: 'ssh.binding.save' }))
    expect(await callsOf(ssh, 'bindingSave')).toEqual([['session-1', 10, {
      environmentId: 'env-build', path: '/srv/app', actions: ['read', 'exec'],
    }]])
  })

  it.each(['', 'ab', '远端环境'])('creates a connection with a short UUID when the display name %j has no valid slug', async displayName => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { displayName, hostname: 'build.internal', user: 'ci' })
    selectManagedCredential(dialog)
    await scanAndConfirm(dialog, ssh)
    const [[, , draft]] = await callsOf(ssh, 'environmentSave')
    expect(draft).toEqual(expect.objectContaining({ environmentId: expect.stringMatching(/^[0-9a-f]{8}$/) }))
    await within(dialog).findByRole('button', { name: 'ssh.step.finish' })
  })

  it('rejects bad ports before a connection scan', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { hostname: 'build.internal', user: 'ci' })
    const port = within(dialog).getByLabelText('ssh.field.port')
    for (const bad of ['abc', '0', '65536', '22.5']) {
      fireEvent.change(port, { target: { value: bad } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
      const field = port.closest('.mrfw-wizField')!
      expect(field.getAttribute('data-invalid')).toBe('true')
      expect(within(field as HTMLElement).getByText('ssh.field.portHint')).toBeTruthy()
      expect(ssh.calls.some(call => call.method === 'hostKeyScan')).toBe(false)
    }
    fireEvent.change(port, { target: { value: '2222' } })
    selectManagedCredential(dialog)
    await scanAndConfirm(dialog, ssh)
    expect((await callsOf(ssh, 'hostKeyScan'))[0]![1]).toEqual({ port: 2222, hostname: 'build.internal' })
  })

  it('hides endpoint fields for an alias source and saves the ssh -G resolution', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    // Choosing the alias source locks the target fields; ssh -G resolves them
    // during the scan.
    selectCredentialSource(dialog, 'alias')
    expect((within(dialog).getByLabelText('ssh.field.hostname') as HTMLInputElement).disabled).toBe(true)
    fillConnectStep(dialog, { displayName: 'Env Alias' })
    selectOption(dialog, 'ssh.field.pickAlias', 'prod.host')
    const alias = within(dialog).getByRole('textbox', { name: 'ssh.field.alias' }) as HTMLInputElement
    expect(alias.value).toBe('prod.host')
    fireEvent.change(alias, { target: { value: 'prod' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', { port: 22, alias: 'prod' }]])
    // The scan resolved the alias: the target fields echo it on the keys pane.
    const keys = await within(dialog).findByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })
    expect((within(dialog).getByLabelText('ssh.field.hostname') as HTMLInputElement).value).toBe('resolved.internal')
    expect((within(dialog).getByLabelText('ssh.field.user') as HTMLInputElement).value).toBe('root')
    fireEvent.click(within(keys).getByRole('radio', { name: /SHA256:scanned/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scanConfirm' }))
    const saves = await callsOf(ssh, 'environmentSave')
    expect(saves).toEqual([['session-1', 7, {
      environmentId: 'env-alias',
      displayName: 'Env Alias',
      platform: 'linux',
      endpoint: { hostname: 'resolved.internal', port: 22, user: 'root' },
      credential: { kind: 'ssh-config', alias: 'prod' },
    }, 'SHA256:scanned', 'scan-token-1', 'create']])
    await within(dialog).findByRole('button', { name: 'ssh.step.finish' })
  })

  it('gates the scan on a picked credential and the save on the host-key pick', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { hostname: 'build.internal', user: 'ci' })
    // No credential picked yet: the scan reveals the field error and never
    // reaches the host.
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    expect(within(dialog).getByText('ssh.field.credentialIdHint')).toBeTruthy()
    expect(ssh.calls.some(call => call.method === 'hostKeyScan')).toBe(false)
    selectManagedCredential(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    await within(dialog).findByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })
    expect((within(dialog).getByRole('button', { name: 'ssh.scanConfirm' }) as HTMLButtonElement).disabled).toBe(false)
    // Backing out of the pick saves nothing and leaves the draft on step one.
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.back' }))
    expect(ssh.calls.some(call => call.method === 'environmentSave')).toBe(false)
    expect(within(dialog).queryByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })).toBeNull()
    expect(within(dialog).getByLabelText('ssh.field.displayName')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    await within(dialog).findByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scanConfirm' }))
    await callsOf(ssh, 'environmentSave')
    await within(dialog).findByRole('button', { name: 'ssh.step.finish' })
  })


  it('falls back to a short UUID when the display-name slug is already taken', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { displayName: 'Env Prod', hostname: 'other.internal', user: 'deploy' })
    selectManagedCredential(dialog)
    await scanAndConfirm(dialog, ssh)
    const [[, , draft]] = await callsOf(ssh, 'environmentSave')
    expect(draft).toEqual(expect.objectContaining({ displayName: 'Env Prod', environmentId: expect.stringMatching(/^[0-9a-f]{8}$/) }))
    await within(dialog).findByRole('button', { name: 'ssh.step.finish' })
    const [existing, created] = (await ssh.state('session-1')).environments
    expect(existing).toEqual(ENV_A)
    expect(created?.environmentId).not.toBe(existing?.environmentId)
  })

  it('saves a display-name edit with the recorded fingerprint and no scan', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = within(dialog.querySelector('.mrfw-sshEdit') as HTMLElement)
    fireEvent.change(editor.getByLabelText('ssh.field.displayName'), { target: { value: 'Renamed production' } })
    fireEvent.click(editor.getByRole('button', { name: 'ssh.envSave' }))
    const [call] = await callsOf(ssh, 'environmentSave')
    expect(call?.slice(2)).toEqual([
      expect.objectContaining({ environmentId: ENV_A.environmentId, displayName: 'Renamed production' }), ENV_A.hostKey, undefined, 'update',
    ])
    expect(ssh.calls.some(entry => entry.method === 'hostKeyScan')).toBe(false)
  })

  it('requires a new scan after an identity field changes, including after a previous scan', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = within(dialog.querySelector('.mrfw-sshEdit') as HTMLElement)
    const save = () => editor.getByRole('button', { name: 'ssh.envSave' }) as HTMLButtonElement
    selectOption(dialog.querySelector('.mrfw-sshEdit') as HTMLElement, 'ssh.field.platform', 'ssh.platform.darwin')
    expect(save().disabled).toBe(true)
    fireEvent.click(editor.getByRole('button', { name: 'ssh.scan' }))
    await editor.findByRole('radio', { name: /SHA256:scanned/ })
    expect(save().disabled).toBe(false)
    fireEvent.change(editor.getByLabelText('ssh.field.user'), { target: { value: 'other' } })
    expect(save().disabled).toBe(true)
    expect(ssh.calls.some(entry => entry.method === 'environmentSave')).toBe(false)
  })

  it('keeps the saved-environment editor flat — one card, all sections', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const card = within(dialog).getByText('Production').closest('li')!
    const editor = card.querySelector('.mrfw-sshEdit') as HTMLElement
    // No stepper, no Next button; every section stays visible.
    expect(within(editor).queryByRole('list', { name: 'ssh.step.listLabel' })).toBeNull()
    expect(within(editor).queryByRole('button', { name: 'ssh.step.next' })).toBeNull()
    expect(within(editor).queryByLabelText('ssh.field.environmentId')).toBeNull()
    expect(within(editor).getByLabelText('ssh.field.hostname')).toBeTruthy()
    expect(within(editor).queryByLabelText('ssh.field.workspace')).toBeNull()
    expect(within(editor).getByRole('button', { name: 'ssh.scan' })).toBeTruthy()
    expect(within(editor).getByRole('button', { name: 'ssh.envSave' })).toBeTruthy()
  })

  it('disables the exec toggle without an installed helper and shows the guidance', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = dialog.querySelector('.mrfw-sshForm') as HTMLElement
    const toggle = within(editor).getByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.checked).toBe(false)
    expect(within(editor).getByText('ssh.field.allowExecHelper')).toBeTruthy()
  })

  it('resets the exec toggle when the helper target identity is edited away', async () => {
    const ssh = fakeSsh(sshState({ environments: [ENV_HELPER] }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = dialog.querySelector('.mrfw-sshForm') as HTMLElement
    const toggle = within(editor).getByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    fireEvent.change(within(editor).getByLabelText('ssh.field.hostname'), { target: { value: 'other.internal' } })
    const after = within(editor).getByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(after.checked).toBe(false)
    expect(after.disabled).toBe(true)
  })

  it('materializes the documented exec and transfer defaults when the toggles are on', async () => {
    const ssh = fakeSsh(sshState({ environments: [ENV_HELPER] }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = dialog.querySelector('.mrfw-sshForm') as HTMLElement
    fireEvent.click(within(editor).getByLabelText('ssh.field.allowExec'))
    fireEvent.click(within(editor).getByLabelText('ssh.field.allowTransfer'))
    fireEvent.click(within(editor).getByRole('button', { name: 'ssh.scan' }))
    await within(editor).findByRole('radio', { name: /SHA256:scanned/ })
    fireEvent.click(within(editor).getByRole('button', { name: 'ssh.envSave' }))
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
    const confirm = within(dialog).getByRole('button', { name: 'ssh.confirmDelete' })
    expect(confirm.textContent).toBe('ssh.confirmDelete')
    expect(within(dialog).getByRole('button', { name: 'ssh.cancel' }).textContent).toBe('ssh.cancel')
    fireEvent.click(confirm)
    expect(await callsOf(ssh, 'environmentRemove')).toEqual([['session-1', 7, 'env-prod']])
  })

  it('offers the primary plus available aliased roots as local transfer peers and saves the binding', async () => {
    const ssh = fakeSsh(sshState({ environments: [{ ...ENV_A, transfer: { maxBytes: 1024, timeoutMs: 1000 } }] }))
    const dialog = await openBindings(ssh)
    const environments = openPicker(dialog, 'ssh.binding.environment')
    const environment = within(environments).getByRole('button', { name: 'Production' })
    expect(environment.getAttribute('data-selected')).toBe('true')
    fireEvent.click(environment)
    // The local sinks are the primary plus every available root's alias id —
    // the exact ids localTransferDestination resolves.
    const imports = within(dialog).getAllByRole('checkbox', { name: /ssh.binding.import/ })
    const exports = within(dialog).getAllByRole('checkbox', { name: /ssh.binding.export/ })
    expect(imports.map(input => (input as HTMLInputElement).parentElement?.textContent)).toEqual([
      'ssh.binding.import (panel.primary)',
      'ssh.binding.import (payments)',
    ])
    expect(exports).toHaveLength(2)
    expect(within(dialog).getAllByRole('textbox')).toEqual([within(dialog).getByLabelText('ssh.binding.path')])
    fireEvent.change(within(dialog).getByLabelText('ssh.binding.path'), { target: { value: '/srv/data' } })
    fireEvent.click(imports[1]!)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.binding.save' }))
    expect(await callsOf(ssh, 'bindingSave')).toEqual([['session-1', 7, {
      environmentId: 'env-prod',
      path: '/srv/data',
      actions: ['read'],
      transfers: [{ direction: 'import', peer: { environmentId: 'local', rootId: 'payments' } }],
    }]])
  })

  it('shows a directory row without its internal ID and edits the binding by that ID', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const ssh = fakeSsh(sshState({
      environments: [{ ...ENV_A, endpoint: { ...ENV_A.endpoint, port: 2222 } }],
      bindings: [{
        environmentId: ENV_A.environmentId,
        rootId: 'project-root',
        path: '/srv/app',
        actions: ['read', 'write', 'exec'],
        transfers: [
          { direction: 'import', peer: { environmentId: 'local', rootId: 'primary' } },
          { direction: 'export', peer: { environmentId: 'local', rootId: 'archived' } },
        ],
      }],
    }))
    const dialog = await openBindings(ssh, { add: false })
    const row = within(within(dialog).getByText('app').closest<HTMLElement>('.mrfw-row')!)
    expect(row.getByText('Production')).toBeTruthy()
    expect(row.queryByText('project-root')).toBeNull()
    expect(row.getByText('remote.capability.read, remote.capability.write, remote.capability.exec')).toBeTruthy()
    expect(row.getByText('ssh.binding.import (panel.primary)')).toBeTruthy()
    expect(row.getByText('ssh.binding.export (archived)')).toBeTruthy()

    const copy = row.getByRole('button', { name: 'panel.copyPath' })
    expect(copy.textContent).toBe('ssh://deploy@prod.internal:2222/srv/app')
    fireEvent.click(copy)
    await row.findByRole('button', { name: 'panel.copied' })
    expect(writeText).toHaveBeenCalledWith('ssh://deploy@prod.internal:2222/srv/app')

    const edit = row.getByRole('button', { name: 'ssh.binding.edit' })
    const remove = row.getByRole('button', { name: 'ssh.binding.remove' })
    expect(edit.textContent).toBe('')
    expect(edit.querySelector('[data-icon="edit"]')).toBeTruthy()
    expect(remove.textContent).toBe('')
    expect(remove.querySelector('[data-icon="trash"]')).toBeTruthy()
    fireEvent.click(edit)
    const path = within(dialog).getByLabelText<HTMLInputElement>('ssh.binding.path')
    expect(within(dialog).getAllByRole('textbox')).toEqual([path])
    expect(path.value).toBe('/srv/app')
    fireEvent.change(path, { target: { value: '/srv/renamed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.binding.save' }))
    expect(await callsOf(ssh, 'bindingSave')).toMatchObject([['session-1', 7, { rootId: 'project-root', path: '/srv/renamed' }]])
  })

  it('reloads the state and shows the localized conflict on personal-config-conflict', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('credentialGenerate', new PanelError('personal-config-conflict', 'revision moved'))
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(settingsNavItem(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    const add = await chooseCredentialForm(dialog, 'Generate')
    fireEvent.change(within(add).getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm(add))
    await waitFor(() => expect(screen.getByText('error.personal-config-conflict')).toBeTruthy())
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
    fireEvent.click(settingsNavItem(dialog, 'ssh.tab.keys'))
    await within(dialog).findByText('ssh.credentials')
    const add = await chooseCredentialForm(dialog, 'Generate')
    fireEvent.change(within(add).getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm(add))
    await callsOf(ssh, 'credentialGenerate')
    await waitFor(() => expect(lists).toBeGreaterThan(1))
  })

  it('shows the first setup task and exposes one Helper install action', async () => {
    const ssh = fakeSsh(sshState({ linked: false }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    const row = within(dialog).getByRole('listitem')
    expect(within(row).getByRole('img', { name: 'ssh.helperMissing' })).toBeTruthy()
    expect(within(row).getByText('ssh.helperMissing')).toBeTruthy()
    // One install affordance — the primary next step, not two same-named buttons.
    expect(within(row).getAllByRole('button', { name: 'ssh.helperInstall' })).toHaveLength(1)
    const actions = within(row).getByRole('group', { name: 'Production' })
    for (const [label, glyph] of [['ssh.envTest', 'play'], ['ssh.envEdit', 'edit'], ['ssh.envDelete', 'trash']]) {
      const action = within(actions).getByRole('button', { name: label })
      expect(action.textContent).toBe('')
      expect(action.classList.contains('mrfw-btnGhost')).toBe(true)
      expect(action.getAttribute('title')).toBe(label)
      expect(action.querySelector(`[data-icon="${glyph}"]`)).toBeTruthy()
    }
    const install = within(actions).getByRole('button', { name: 'ssh.helperInstall' })
    expect(install.classList.contains('mrfw-btnGhost')).toBe(true)
    expect(install.getAttribute('title')).toBe('ssh.helperInstall')
    // The link step is not this row's primary yet: only the banner offers it.
    expect(within(row).queryByRole('button', { name: 'ssh.linkNow' })).toBeNull()
    expect(within(dialog).getByText('ssh.linkBanner')).toBeTruthy()
  })

  it('makes linking ssh_config the primary step once the helper is installed', async () => {
    const ssh = fakeSsh(sshState({ linked: false, environments: [ENV_HELPER] }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    const row = within(dialog).getByRole('listitem')
    expect(within(row).queryByRole('button', { name: 'ssh.helperInstall' })).toBeNull()
    const link = within(row).getAllByRole('button', { name: 'ssh.linkNow' })
    expect(link).toHaveLength(1)
    fireEvent.click(link[0]!)
    expect(await callsOf(ssh, 'configLink')).toEqual([['session-1']])
  })



  it('unlocks execution in an open editor after installing the Helper on a saved connection', async () => {
    const ssh = fakeSsh(sshState({ environments: [ENV_A] }))
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.envEdit' }))
    const exec = within(dialog).getByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(exec.disabled).toBe(true)
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.helperInstall' }))
    fireEvent.change(within(dialog).getByLabelText('ssh.nodePath'), { target: { value: '/opt/bin/node' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.helperInstall' }))
    expect(await callsOf(ssh, 'helperInstall')).toEqual([['session-1', 7, 'env-prod', '/opt/bin/node']])
    await within(dialog).findByText('ssh.helperInstalled')
    expect(exec.disabled).toBe(false)
    fireEvent.click(exec)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envSave' }))
    expect(await callsOf(ssh, 'environmentSave')).toEqual([['session-1', 8, expect.objectContaining({
      environmentId: 'env-prod',
      exec: expect.objectContaining({ shell: ['/bin/sh', '-c'] }),
    }), ENV_A.hostKey, undefined, 'update']])
    expect(within(dialog).queryByRole('button', { name: 'ssh.helperInstall' })).toBeNull()
    expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(false)
  })

  it('binds two Roots to one connection and unbinds only the selected Root', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await openBindings(ssh)
    for (const path of ['/srv/app', '/srv/logs']) {
      const bindingPath = within(dialog).getByLabelText('ssh.binding.path')
      const save = within(dialog).getByRole('button', { name: 'ssh.binding.save' }) as HTMLButtonElement
      fireEvent.change(bindingPath, { target: { value: '/srv//bad' } })
      expect(save.disabled).toBe(true)
      expect(within(dialog).getByText('error.workspace-invalid')).toBeTruthy()
      fireEvent.change(bindingPath, { target: { value: path } })
      fireEvent.click(save)
      await within(dialog).findByText(`ssh://deploy@prod.internal:22${path}`)
      if (path === '/srv/app') fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.bindingAdd' }))
    }
    const calls = await callsOf(ssh, 'bindingSave')
    expect(calls.map(args => args[2])).toEqual([
      { environmentId: 'env-prod', path: '/srv/app', actions: ['read'] },
      { environmentId: 'env-prod', path: '/srv/logs', actions: ['read'] },
    ])
    const row = within(dialog).getByText('ssh://deploy@prod.internal:22/srv/app').closest('.mrfw-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'ssh.binding.remove' }))
    const confirmation = await screen.findByRole('dialog', { name: 'ssh.binding.remove' })
    expect(ssh.calls.some(call => call.method === 'bindingRemove')).toBe(false)
    fireEvent.click(within(confirmation).getByRole('button', { name: 'ssh.cancel' }))
    expect(ssh.calls.some(call => call.method === 'bindingRemove')).toBe(false)
    fireEvent.click(within(row).getByRole('button', { name: 'ssh.binding.remove' }))
    const confirmed = await screen.findByRole('dialog', { name: 'ssh.binding.remove' })
    fireEvent.click(within(confirmed).getByRole('button', { name: 'ssh.confirmDelete' }))
    expect((await callsOf(ssh, 'bindingRemove'))[0]?.slice(0, 4)).toEqual(['session-1', 9, 'env-prod', 'app'])
    await waitFor(() => expect(within(dialog).queryByText('ssh://deploy@prod.internal:22/srv/app')).toBeNull())
    expect(within(dialog).getByText('ssh://deploy@prod.internal:22/srv/logs')).toBeTruthy()
    expect(ssh.calls.some(call => call.method === 'environmentSave' || call.method === 'environmentRemove')).toBe(false)
  })

  it('opens the credential manager dialog from the managed source', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.credentialManage' }))
    const manager = await screen.findByRole('dialog', { name: 'ssh.credentials' })
    const add = await chooseCredentialForm(manager, 'Generate')
    fireEvent.change(within(add).getByLabelText('ssh.label'), { target: { value: 'new key' } })
    fireEvent.click(sshFormConfirm(add))
    expect(await callsOf(ssh, 'credentialGenerate')).toEqual([['session-1', 'new key']])
    fireEvent.click(within(manager).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.credentials' })).toBeNull())
    expect(within(dialog).getByLabelText('ssh.field.displayName')).toBeTruthy()
  })

  it('browses remote directories and fills the remote path', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await openBindings(ssh)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.pickPath' }))
    const picker = await screen.findByRole('dialog', { name: 'ssh.pathPickerTitle' })
    fireEvent.click(await within(picker).findByRole('button', { name: 'app' }))
    await waitFor(() => {
      expect((within(picker).getByLabelText('ssh.binding.path') as HTMLInputElement).value).toBe('/home/deploy/app')
    })
    fireEvent.click(within(picker).getByRole('button', { name: 'ssh.pathPickerUse' }))
    expect((within(dialog).getByLabelText('ssh.binding.path') as HTMLInputElement).value).toBe('/home/deploy/app')
    expect(await callsOf(ssh, 'listDirectories')).toHaveLength(2)
  })

  it('keeps the manual path field usable when the directory listing fails', async () => {
    const ssh = fakeSsh(sshState())
    ssh.fail('listDirectories', new PanelError('remote-path-listing-failed', 'boom'))
    const dialog = await openBindings(ssh)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.pickPath' }))
    const picker = await screen.findByRole('dialog', { name: 'ssh.pathPickerTitle' })
    expect(await within(picker).findByText('ssh.pathPickerFailed')).toBeTruthy()
    fireEvent.change(within(picker).getByLabelText('ssh.binding.path'), { target: { value: '/srv/app' } })
    fireEvent.click(within(picker).getByRole('button', { name: 'ssh.pathPickerUse' }))
    expect((within(dialog).getByLabelText('ssh.binding.path') as HTMLInputElement).value).toBe('/srv/app')
  })

  it('guides registration of bound personal endpoints and hides the hint once all are registered', async () => {
    const endpoint = {
      environmentId: 'env-helper', rootId: 'web', path: '/srv/app', platform: 'linux',
      state: 'unregistered' as const, actions: [], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    }
    renderDialog({ ssh: fakeSsh(sshState()), endpoints: [endpoint] })
    expect(await screen.findByText('panel.remoteRegisterGuide')).toBeTruthy()
    cleanup()
    renderDialog({ ssh: fakeSsh(sshState()), endpoints: [{ ...endpoint, state: 'registered' as const }] })
    await screen.findByTitle('remote.state.registered')
    expect(screen.queryByText('panel.remoteRegisterGuide')).toBeNull()
  })

  it('edits one remote Root’s actions and local transfer peers inside its menu', async () => {
    const binding = {
      environmentId: 'env-prod', rootId: 'web', path: '/srv/app',
      actions: ['read'] as const,
      transfers: [{ direction: 'export' as const, peer: { environmentId: 'local', rootId: 'payments' } }],
    }
    const endpoint = {
      environmentId: binding.environmentId, rootId: binding.rootId, path: binding.path,
      displayName: 'Production', platform: 'linux', target: 'ssh://deploy@prod.internal:22',
      state: 'registered' as const, actions: [...binding.actions], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: true },
    }
    const ssh = fakeSsh(sshState({
      environments: [{ ...ENV_A, transfer: { maxBytes: 1024, timeoutMs: 1000 } }],
      bindings: [binding],
    }))
    const remoteCalls: { method: string; args: unknown[] }[] = []
    let listCalls = 0
    renderDialog({ ssh, endpoints: [endpoint], remoteCalls, onList: () => { listCalls++ } })
    const row = (await screen.findByText('ssh://deploy@prod.internal:22/srv/app')).closest('.mrfw-row') as HTMLElement
    expect(within(row).getByText('app')).toBeTruthy()
    expect(within(row).getByText('Production').className).toBe('mrfw-cwdTag')
    fireEvent.click(within(row).getByRole('button', { name: 'panel.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'ssh.binding.editCapabilities' }))
    const write = await screen.findByRole('button', { name: 'remote.capability.write' })
    const menu = write.closest('[role="menu"], [data-menu]') as HTMLElement
    expect((within(menu).getByRole('button', { name: 'remote.capability.exec' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(menu).getByRole('button', { name: 'ssh.binding.save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(write)
    fireEvent.click(within(menu).getAllByRole('button', { name: 'panel.primary' })[0]!)
    expect(within(menu).getByText('ssh.binding.editCapabilitiesReregister')).toBeTruthy()
    fireEvent.click(within(menu).getByRole('button', { name: 'ssh.binding.save' }))
    expect(await callsOf(ssh, 'bindingSave')).toEqual([['session-1', 7, {
      ...binding, actions: ['read', 'write'], transfers: [...binding.transfers, {
        direction: 'import', peer: { environmentId: 'local', rootId: 'primary' },
      }],
    }]])
    expect(remoteCalls).toEqual([])
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
    expect(screen.queryByRole('button', { name: 'ssh.binding.save' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'ssh.bindings' })).toBeNull()
  })

  it('leaves Workspace Folders open when closing the separate binding dialog', async () => {
    const onClose = vi.fn()
    const ssh = fakeSsh(sshState())
    renderDialog({ ssh, onClose })
    fireEvent.click(await screen.findByRole('button', { name: 'panel.remoteBindings' }))
    const dialog = await screen.findByRole('dialog', { name: 'ssh.bindings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.bindings' })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'panel.title' })).toBeTruthy()
  })

  it('closes without closing the Workspace Folders dialog underneath', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.dialog.title' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'panel.title' })).toBeTruthy()
  })
})


describe('pending feedback on network-bound requests', () => {
  it('marks a running connection test without blocking the row or the dialog', async () => {
    const gate = Promise.withResolvers<{ platform: string; nodePath?: string; nodeVersion?: string }>()
    const ssh = fakeSsh(sshState())
    ssh.environmentTest = async (...args: unknown[]) => {
      ssh.calls.push({ method: 'environmentTest', args })
      return await gate.promise
    }
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envTest' }))
    await waitFor(() => expect(ssh.calls.some(call => call.method === 'environmentTest')).toBe(true))
    const test = within(dialog).getByRole('button', { name: 'ssh.envTest' })
    await within(dialog).findByText('ssh.pending.test')
    expect(test.getAttribute('aria-busy')).toBe('true')
    expect((test as HTMLButtonElement).disabled).toBe(false)
    // Testing never takes the management lock: edit stays available.
    expect((within(dialog).getByRole('button', { name: 'ssh.envEdit' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      gate.resolve({ platform: 'linux', nodeVersion: 'v22.0.0' })
      await gate.promise
    })
    await waitFor(() => expect(within(dialog).queryByText('ssh.pending.test')).toBeNull())
    expect(await within(dialog).findByText('ssh.platform.linux · node v22.0.0')).toBeTruthy()
  })

  it('marks a running Helper install on the row, its button, and the dialog bar', async () => {
    const gate = Promise.withResolvers<SshStateView>()
    const ssh = fakeSsh(sshState())
    ssh.helperInstall = async () => await gate.promise
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.helperInstall' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.helperInstall' }))
    await within(dialog).findByText('ssh.pending.helper')
    expect(dialog.querySelector('.mrfw-pendingBar[data-active="true"]')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'ssh.envEdit' }) as HTMLButtonElement).disabled).toBe(true)
    // The inline form closed on submit; the row's install button carries the spinner.
    const install = within(dialog).getByRole('button', { name: 'ssh.helperInstall' })
    expect(install.getAttribute('aria-busy')).toBe('true')
    expect((install as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      gate.resolve(sshState({
        environments: [{ ...ENV_A, helper: { nodePath: '/usr/bin/node', helperPath: '/opt/dsh/helper.js', sha256: 'a'.repeat(64), protocol: 1 } }],
      }))
      await gate.promise
    })
    await waitFor(() => expect(within(dialog).queryByText('ssh.pending.helper')).toBeNull())
    expect(await within(dialog).findByText('ssh.helperInstalled')).toBeTruthy()
  })

  it('marks the host-key scan inside the Add connection dialog', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<SshClient['hostKeyScan']>>>()
    const ssh = fakeSsh(sshState())
    ssh.hostKeyScan = async (...args: unknown[]) => {
      ssh.calls.push({ method: 'hostKeyScan', args })
      return await gate.promise
    }
    const dialog = await withDialog({ ssh }, 'add')
    fillConnectStep(dialog, { hostname: 'build.internal', user: 'ci' })
    selectManagedCredential(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    await waitFor(() => expect(ssh.calls.some(call => call.method === 'hostKeyScan')).toBe(true))
    const scan = within(dialog).getByRole('button', { name: 'ssh.scan' })
    await waitFor(() => expect(scan.getAttribute('aria-busy')).toBe('true'))
    expect(dialog.querySelector('.mrfw-pendingBar[data-active="true"]')).toBeTruthy()
    await act(async () => {
      gate.resolve({ token: 'scan-token-1', keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:scanned' }] })
      await gate.promise
    })
    const keys = await within(dialog).findByRole('radiogroup', { name: 'ssh.scanConfirmTitle' })
    expect(within(keys).getByRole('radio', { name: /SHA256:scanned/ })).toBeTruthy()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'ssh.scanConfirm' }).getAttribute('aria-busy')).not.toBe('true'))
  })

  it('marks binding save and remove requests inside the bindings dialog', async () => {
    const saved = Promise.withResolvers<SshStateView>()
    const removed = Promise.withResolvers<SshStateView>()
    const ssh = fakeSsh(sshState())
    ssh.bindingSave = async (...args: unknown[]) => {
      ssh.calls.push({ method: 'bindingSave', args })
      return await saved.promise
    }
    ssh.bindingRemove = async (...args: unknown[]) => {
      ssh.calls.push({ method: 'bindingRemove', args })
      return await removed.promise
    }
    const dialog = await openBindings(ssh)
    fireEvent.change(within(dialog).getByLabelText('ssh.binding.path'), { target: { value: '/srv/app' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.binding.save' }))
    await waitFor(() => expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(true))
    const save = within(dialog).getByRole('button', { name: 'ssh.binding.save' })
    await within(dialog).findByText('ssh.pending.bindingSave')
    expect(save.getAttribute('aria-busy')).toBe('true')
    expect(dialog.querySelector('.mrfw-pendingBar[data-active="true"]')).toBeTruthy()
    await act(async () => {
      saved.resolve(sshState({
        bindings: [{ environmentId: 'env-prod', rootId: 'app', path: '/srv/app', actions: ['read'] }],
      }))
      await saved.promise
    })
    const row = (await within(dialog).findByText('ssh://deploy@prod.internal:22/srv/app')).closest('.mrfw-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'ssh.binding.remove' }))
    const confirmation = await screen.findByRole('dialog', { name: 'ssh.binding.remove' })
    expect(ssh.calls.some(call => call.method === 'bindingRemove')).toBe(false)
    fireEvent.click(within(confirmation).getByRole('button', { name: 'ssh.confirmDelete' }))
    await waitFor(() => expect(ssh.calls.some(call => call.method === 'bindingRemove')).toBe(true))
    const remove = within(row).getByRole('button', { name: 'ssh.binding.remove' })
    await within(row).findByText('ssh.pending.bindingRemove')
    expect(remove.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      removed.resolve(sshState())
      await removed.promise
    })
    await waitFor(() => expect(within(dialog).queryByText('ssh.pending.bindingRemove')).toBeNull())
  })

  it('keeps the previous remote listing rendered while the next one loads', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<SshClient['listDirectories']>>>()
    const ssh = fakeSsh(sshState())
    let listings = 0
    ssh.listDirectories = async (sessionId, environmentId, path) => {
      listings += 1
      ssh.calls.push({ method: 'listDirectories', args: [sessionId, environmentId, path] })
      if (listings === 2) return await gate.promise
      const base = path === undefined || path === '' ? '/home/deploy' : path
      return {
        path: base,
        parent: base === '/' ? '/' : base.slice(0, base.lastIndexOf('/')) || '/',
        entries: [{ name: 'app', path: base === '/' ? '/app' : base + '/app' }],
      }
    }
    const dialog = await openBindings(ssh)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.pickPath' }))
    const picker = await screen.findByRole('dialog', { name: 'ssh.pathPickerTitle' })
    fireEvent.click(await within(picker).findByRole('button', { name: 'app' }))
    await waitFor(() => expect(ssh.calls.filter(call => call.method === 'listDirectories')).toHaveLength(2))
    await within(picker).findByText('ssh.pending.list')
    const list = picker.querySelector('.mrfw-sshDirList') as HTMLElement
    expect(list.getAttribute('aria-busy')).toBe('true')
    expect(within(list).getByRole('button', { name: 'app' })).toBeTruthy()
    await act(async () => {
      gate.resolve({
        path: '/home/deploy/app',
        parent: '/home/deploy',
        entries: [{ name: 'src', path: '/home/deploy/app/src' }],
      })
      await gate.promise
    })
    await waitFor(() => expect(within(picker).queryByText('ssh.pending.list')).toBeNull())
    expect(await within(picker).findByRole('button', { name: 'src' })).toBeTruthy()
  })

  it('marks the remote row while its registration verifies on the host', async () => {
    const gate = Promise.withResolvers<void>()
    const endpoint = {
      environmentId: 'env-prod',
      rootId: 'web',
      path: '/srv/app',
      platform: 'linux',
      target: 'ssh://deploy@prod.internal:22',
      state: 'unregistered' as const,
      actions: ['read'],
      transfers: [],
      capabilities: { read: false, write: false, exec: false, receive: false, send: false },
    }
    const remoteCalls: { method: string; args: unknown[] }[] = []
    renderDialog({ ssh: fakeSsh(sshState()), endpoints: [endpoint], remoteCalls, remoteAddGate: gate.promise })
    const row = (await screen.findByText('ssh://deploy@prod.internal:22/srv/app')).closest('.mrfw-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'panel.more' }))
    fireEvent.click(await screen.findByRole('button', { name: 'panel.remoteRegister' }))
    await waitFor(() => expect(remoteCalls.some(call => call.method === 'add')).toBe(true))
    await within(row).findByText('panel.remoteRegistering')
    expect(within(row).getByRole('button', { name: 'panel.more' }).getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await waitFor(() => expect(within(row).queryByText('panel.remoteRegistering')).toBeNull())
  })

  it('spins the capabilities save item while the binding write runs', async () => {
    const binding = {
      environmentId: 'env-prod', rootId: 'web', path: '/srv/app',
      actions: ['read'] as const,
      transfers: [{ direction: 'export' as const, peer: { environmentId: 'local', rootId: 'payments' } }],
    }
    const endpoint = {
      environmentId: binding.environmentId, rootId: binding.rootId, path: binding.path,
      displayName: 'Production', platform: 'linux', target: 'ssh://deploy@prod.internal:22',
      state: 'registered' as const, actions: [...binding.actions], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: true },
    }
    const saved = Promise.withResolvers<SshStateView>()
    const ssh = fakeSsh(sshState({
      environments: [{ ...ENV_A, transfer: { maxBytes: 1024, timeoutMs: 1000 } }],
      bindings: [binding],
    }))
    ssh.bindingSave = async (...args: unknown[]) => {
      ssh.calls.push({ method: 'bindingSave', args })
      return await saved.promise
    }
    renderDialog({ ssh, endpoints: [endpoint] })
    const row = (await screen.findByText('ssh://deploy@prod.internal:22/srv/app')).closest('.mrfw-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'panel.more' }))
    fireEvent.click(await screen.findByRole('button', { name: 'ssh.binding.editCapabilities' }))
    fireEvent.click(await screen.findByRole('button', { name: 'remote.capability.write' }))
    fireEvent.click(await screen.findByRole('button', { name: 'ssh.binding.save' }))
    await waitFor(() => expect(ssh.calls.some(call => call.method === 'bindingSave')).toBe(true))
    const save = await screen.findByRole('button', { name: 'ssh.binding.save' })
    await waitFor(() => expect(save.querySelector('[data-state-dot="ongoing"]')).toBeTruthy())
    await act(async () => {
      saved.resolve(sshState({
        environments: [{ ...ENV_A, transfer: { maxBytes: 1024, timeoutMs: 1000 } }],
        bindings: [{ ...binding, actions: ['read', 'write'] }],
      }))
      await saved.promise
    })
  })
})


describe('SSH dialog asynchronous scope isolation', () => {
  const propsFor = (ssh: SshClient): SshManagementDialogProps => ({
    initialTab: 'connections', ssh, sessionId: 'a', custodyMode: 'personal', status: { state: 'ready' },
    onClose() {}, onChanged() {}, t,
  })
  const named = (name: string) => sshState({ environments: [{ ...ENV_A, displayName: name }] })

  it.each(['resolve', 'reject'] as const)('ignores an old session state %s after the new state arrives', async outcome => {
    const old = Promise.withResolvers<SshStateView>()
    const ssh = fakeSsh(named('New session'))
    ssh.state = async id => id === 'a' ? await old.promise : named('New session')
    const props = propsFor(ssh)
    const view = render(createElement(SshManagementDialog, props))
    view.rerender(createElement(SshManagementDialog, { ...props, sessionId: 'b' }))
    await screen.findByText('New session')
    await act(async () => {
      if (outcome === 'resolve') old.resolve(named('Old session'))
      else old.reject(new PanelError('personal-config-conflict', 'old failure'))
      await old.promise.catch(() => {})
    })
    expect(screen.getByText('New session')).toBeTruthy()
    expect(screen.queryByText('Old session')).toBeNull()
    expect(screen.queryByText('error.personal-config-conflict')).toBeNull()
  })

  it.each(['session', 'mode', 'status', 'client'] as const)('ignores a stale mutation across a %s transition', async transition => {
    const saved = Promise.withResolvers<SshStateView>()
    const ssh = fakeSsh(named('Initial'))
    ssh.configLink = async () => await saved.promise
    ssh.setState({ ...named('Initial'), linked: false })
    let changed = 0
    const props = { ...propsFor(ssh), onChanged: () => { changed++ } }
    const view = render(createElement(SshManagementDialog, props))
    fireEvent.click(await screen.findByRole('button', { name: 'ssh.linkNow' }))
    ssh.setState(named('Current'))
    if (transition === 'session') view.rerender(createElement(SshManagementDialog, { ...props, sessionId: 'b' }))
    else if (transition === 'client') { view.rerender(createElement(SshManagementDialog, { ...props, ssh: fakeSsh(named('Current')) })) }
    else if (transition === 'status') {
      view.rerender(createElement(SshManagementDialog, { ...props, status: { state: 'disabled' } }))
      view.rerender(createElement(SshManagementDialog, props))
    } else {
      view.rerender(createElement(SshManagementDialog, { ...props, custodyMode: 'team' }))
      view.rerender(createElement(SshManagementDialog, props))
    }
    await screen.findByText('Current')
    await act(async () => { saved.resolve(named('Stale mutation')); await saved.promise })
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.queryByText('Stale mutation')).toBeNull()
    expect(changed).toBe(0)
    expect((screen.getAllByRole('button', { name: 'ssh.envTest' })[0] as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('error copy detail policy', () => {
  it('shows the host message for codes whose cause only the message names', async () => {
    const { errorHasDetail, errorKeyOf } = await import('../src/client/panel-client.ts')
    // Three unrelated failures share this code; only the message splits them.
    expect(errorKeyOf('endpoint-unverifiable')).toBe('error.endpoint-unverifiable')
    expect(errorHasDetail('endpoint-unverifiable')).toBe(true)
    for (const code of ['ssh-config-not-linked', 'host-identity-unverifiable', 'invalid-manifest', 'workspace-invalid']) {
      expect(errorHasDetail(code), code).toBe(true)
    }
    // Codes whose fixed copy already says everything keep the message hidden.
    expect(errorHasDetail('helper-node-missing')).toBe(false)
    expect(errorHasDetail('host-key-mismatch')).toBe(false)
    // Unknown and transport codes always show whatever the host sent.
    expect(errorHasDetail('panel/transport')).toBe(true)
    expect(errorHasDetail('never-heard-of-it')).toBe(true)
  })
})
