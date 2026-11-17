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
import { SshManagementDialog, type SshManagementDialogProps } from '../src/client/ssh-panel.tsx'
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
    environmentSave: async (sessionId: string, revision: number, environment: unknown, fingerprint: string, hostKeyToken?: string) => {
      const draft = environment as Omit<SshEnvironmentView, 'hostKey' | 'helper'>
      const next: SshStateView = {
        ...state,
        revision: revision + 1,
        environments: [...state.environments.filter(existing => existing.environmentId !== draft.environmentId),
          { ...draft, hostKey: fingerprint, helper: null }],
      }
      const answer = await record('environmentSave', [sessionId, revision, environment, fingerprint, hostKeyToken], next)
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
    bindingSave: async (sessionId: string, revision: number, binding: unknown) => {
      const next: SshStateView = { ...state, revision: revision + 1, bindings: [...state.bindings, binding as SshStateView['bindings'][number]] }
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
  remoteMode?: RemoteModeControl
  t?: Translate
  onList?: () => void
  onClose?: () => void
  remoteCalls?: { method: string; args: unknown[] }[]
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
    add: async (...args: unknown[]) => { options.remoteCalls?.push({ method: 'add', args }); return remotesView },
    remove: async (...args: unknown[]) => { options.remoteCalls?.push({ method: 'remove', args }); return remotesView },
  }
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
    const label = via === 'add' ? 'panel.remoteAdd' : 'panel.remoteManage'
    const entry = await screen.findByRole('button', { name: label })
    await waitFor(() => { expect((entry as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(entry)
    return await screen.findByRole('dialog', { name: 'ssh.dialog.title' })
  })()
}

/** Click the wizard's Next button. */
function nextStep(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.next' }))
}

/** Wizard step 1: fill the environment info fields (managed endpoint) and advance. */
function infoStep(dialog: HTMLElement, fields: { environmentId: string; hostname?: string; user?: string; workspace?: string }): void {
  fireEvent.change(within(dialog).getByLabelText('ssh.field.environmentId'), { target: { value: fields.environmentId } })
  if (fields.hostname !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: fields.hostname } })
  }
  if (fields.user !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: fields.user } })
  }
  fireEvent.change(within(dialog).getByLabelText('ssh.field.workspace'), { target: { value: fields.workspace ?? '/srv/app' } })
  nextStep(dialog)
}

/** Wizard step 2 for a managed credential: pick the credential, scan, confirm the fingerprint. */
async function managedKeyStep(dialog: HTMLElement): Promise<void> {
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'ssh.field.managed' }), { target: { value: 'aabbccddeeff' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
  fireEvent.click(await within(dialog).findByRole('radio', { name: 'ssh-ed25519 SHA256:scanned' }))
}

/** Click the wizard save button and wait for the save call to land. */
async function saveKeyStep(dialog: HTMLElement, ssh: { calls: { method: string; args: unknown[] }[] }): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.save' }))
  await callsOf(ssh, 'environmentSave')
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

  it('opens the Add tab directly on the wizard environment step', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    // Step one is the environment card: id, target row, platform, workspace.
    expect(await within(dialog).findByLabelText('ssh.field.environmentId')).toBeTruthy()
    expect(within(dialog).getByLabelText('ssh.field.workspace')).toBeTruthy()
    expect(within(dialog).getByText('ssh.add.personalGuide')).toBeTruthy()
    // The platform hint explains what the pick does.
    expect(within(dialog).getByText('ssh.field.platformHint')).toBeTruthy()
    // The credential-source radios live here; the managed select waits for step two.
    expect(within(dialog).getByRole('radio', { name: 'ssh.field.managed' })).toBeTruthy()
    expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
    // The stepper lists all four steps; only the first is reachable until filled.
    const stepper = within(dialog).getByRole('list', { name: 'ssh.step.listLabel' })
    expect(within(stepper).getAllByRole('listitem')).toHaveLength(4)
    expect(within(dialog).getByRole('button', { name: 'ssh.step.next' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'ssh.add.save' })).toBeNull()
    // All four tabs are present and switchable.
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.connections' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.keys' })).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'ssh.tab.mode' })).toBeTruthy()
    // The form uses the primitive Input wrappers and a real field grid; the
    // old row-only .mrfw-input class must not reach a column form again.
    expect(dialog.querySelectorAll('input.mrfw-input, select.mrfw-input, textarea.mrfw-input')).toHaveLength(0)
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
    const platform = await within(dialog).findByLabelText('平台') as HTMLSelectElement
    expect([...platform.options].map(option => option.textContent)).toEqual(['Linux', 'macOS'])
    // The platform hint spells out that registration and the helper verify it.
    expect(within(dialog).getByText(/登记与 helper 握手/)).toBeTruthy()
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

  it('walks the managed wizard and saves fingerprint+token with the draft', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    await within(dialog).findByLabelText('ssh.field.environmentId')
    infoStep(dialog, { environmentId: 'env-build', hostname: 'build.internal', user: 'ci', workspace: '/srv/ci' })
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    await managedKeyStep(dialog)
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', { port: 22, hostname: 'build.internal' }]])
    await saveKeyStep(dialog, ssh)
    const saves = await callsOf(ssh, 'environmentSave')
    expect(saves).toEqual([['session-1', 7, {
      environmentId: 'env-build',
      platform: 'linux',
      endpoint: { hostname: 'build.internal', port: 22, user: 'ci' },
      credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
      workspace: '/srv/ci',
      transfer: { maxBytes: 268435456, timeoutMs: 600000 },
    }, 'SHA256:scanned', 'scan-token-1']])
    // Saving stays inside the wizard: the helper step is next.
    await within(dialog).findByText('ssh.add.helperGuide')
    expect(within(dialog).queryByRole('tab', { name: 'ssh.tab.connections', selected: true })).toBeNull()
  })

  it('blocks Next on the environment step until environmentId satisfies the slug contract', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    const idInput = await within(dialog).findByLabelText('ssh.field.environmentId')
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: 'build.internal' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.workspace'), { target: { value: '/srv/ci' } })
    // Two characters or an illegal character keeps the wizard on this step.
    fireEvent.change(idInput, { target: { value: 'ab' } })
    expect(within(dialog).getByText('ssh.field.environmentIdHint')).toBeTruthy()
    nextStep(dialog)
    expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
    fireEvent.change(idInput, { target: { value: 'BAD ID' } })
    nextStep(dialog)
    expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
    fireEvent.change(idInput, { target: { value: 'env-build' } })
    nextStep(dialog)
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    expect(within(dialog).queryByText('ssh.field.environmentIdHint')).toBeNull()
  })

  it('rejects bad ports and non-normalized workspaces instead of defaulting them', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    fireEvent.change(await within(dialog).findByLabelText('ssh.field.environmentId'), { target: { value: 'env-build' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.hostname'), { target: { value: 'build.internal' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.user'), { target: { value: 'ci' } })
    const port = within(dialog).getByLabelText('ssh.field.port')
    for (const bad of ['abc', '0', '65536', '22.5']) {
      fireEvent.change(port, { target: { value: bad } })
      nextStep(dialog)
      const errors = dialog.querySelector('.mrfw-sshErrors') as HTMLElement
      expect(errors).toBeTruthy()
      expect(errors.textContent).toContain('ssh.field.portHint')
      expect(port.closest('.mrfw-sshField')!.classList.contains('mrfw-sshFieldInvalid')).toBe(true)
      expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
    }
    // The error summary is the single place validation text renders: the
    // target row itself stays a pure field row.
    expect(dialog.querySelector('.mrfw-sshTargetRow .mrfw-sshDanger')).toBeNull()
    fireEvent.change(port, { target: { value: '2222' } })
    const workspace = within(dialog).getByLabelText('ssh.field.workspace')
    for (const bad of ['srv/ci', '/srv//ci', '/srv/../ci', '/srv/ci/', '/srv/.']) {
      fireEvent.change(workspace, { target: { value: bad } })
      nextStep(dialog)
      expect(within(dialog).getByText('ssh.field.workspaceHint')).toBeTruthy()
      expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
    }
    fireEvent.change(workspace, { target: { value: '/srv/ci' } })
    nextStep(dialog)
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
  })

  it('hides endpoint fields for an alias draft and saves the ssh -G resolution', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    // Choosing the alias source on step one drops the host fields; id and
    // workspace are all the info step still needs.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ssh.field.alias' }))
    const idInput = await within(dialog).findByLabelText('ssh.field.environmentId')
    expect(within(dialog).queryByLabelText('ssh.field.hostname')).toBeNull()
    fireEvent.change(idInput, { target: { value: 'env-alias' } })
    fireEvent.change(within(dialog).getByLabelText('ssh.field.workspace'), { target: { value: '/srv/app' } })
    nextStep(dialog)
    // Step two types the alias and scans; ssh -G backfills the hidden target.
    const alias = await within(dialog).findByRole('textbox', { name: 'ssh.field.alias' })
    expect(within(dialog).getByText(/ssh\.add\.aliasResolvedNote/)).toBeTruthy()
    fireEvent.change(alias, { target: { value: 'prod' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    expect(await callsOf(ssh, 'hostKeyScan')).toEqual([['session-1', { port: 22, alias: 'prod' }]])
    await within(dialog).findByRole('radio', { name: /SHA256:scanned/ })
    await waitFor(() => {
      expect((within(dialog).getByRole('button', { name: 'ssh.add.save' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.save' }))
    const saves = await callsOf(ssh, 'environmentSave')
    expect(saves).toEqual([['session-1', 7, {
      environmentId: 'env-alias',
      platform: 'linux',
      endpoint: { hostname: 'resolved.internal', port: 22, user: 'root' },
      credential: { kind: 'ssh-config', alias: 'prod' },
      workspace: '/srv/app',
      transfer: { maxBytes: 268435456, timeoutMs: 600000 },
    }, 'SHA256:scanned', undefined]])
    await within(dialog).findByText('ssh.add.helperGuide')
  })

  it('lays the managed target fields out in user@host:port order', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    await within(dialog).findByLabelText('ssh.field.environmentId')
    const row = dialog.querySelector('.mrfw-sshTargetRow') as HTMLElement
    expect(row).toBeTruthy()
    const labels = [...row.querySelectorAll('.mrfw-sshFieldLabel')].map(node => node.textContent)
    expect(labels).toEqual(['ssh.field.user', 'ssh.field.hostname', 'ssh.field.port'])
    const separators = [...row.querySelectorAll('.mrfw-sshTargetSep')].map(node => node.textContent)
    expect(separators).toEqual(['@', ':'])
  })

  it('gates saving on a picked credential, a scan, and a confirmed fingerprint', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    infoStep(dialog, { environmentId: 'env-build', hostname: 'build.internal', user: 'ci' })
    const save = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'ssh.add.save' }) as HTMLButtonElement
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    // No credential picked yet → save stays disabled.
    expect(save().disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'ssh.field.managed' }), { target: { value: 'aabbccddeeff' } })
    // Credential without a scanned fingerprint → still disabled.
    expect(save().disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.scan' }))
    await within(dialog).findByRole('radio', { name: 'ssh-ed25519 SHA256:scanned' })
    await waitFor(() => { expect(save().disabled).toBe(false) })
    // Switching to the alias source (the radios live on step one) swaps the
    // credential field for the alias textbox; a malformed alias keeps both
    // the scan button and save disabled.
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.back' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ssh.field.alias' }))
    nextStep(dialog)
    const alias = await within(dialog).findByRole('textbox', { name: 'ssh.field.alias' })
    fireEvent.change(alias, { target: { value: 'bad alias!' } })
    expect((within(dialog).getByRole('button', { name: 'ssh.scan' }) as HTMLButtonElement).disabled).toBe(true)
    expect(save().disabled).toBe(true)
    fireEvent.change(alias, { target: { value: 'prod.host' } })
    expect((within(dialog).getByRole('button', { name: 'ssh.scan' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('lets the step chips move inside the validated range and Back retrace', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    const stepper = within(dialog).getByRole('list', { name: 'ssh.step.listLabel' })
    const chips = () => within(stepper).getAllByRole('listitem') as HTMLButtonElement[]
    await within(dialog).findByLabelText('ssh.field.environmentId')
    // Steps past the first incomplete one are disabled.
    expect(chips()[1]!.disabled).toBe(true)
    expect(chips()[2]!.disabled).toBe(true)
    expect(chips()[3]!.disabled).toBe(true)
    infoStep(dialog, { environmentId: 'env-build', hostname: 'build.internal', user: 'ci' })
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    // Helper and register stay out of reach until the key step saves.
    expect(chips()[2]!.disabled).toBe(true)
    expect(chips()[3]!.disabled).toBe(true)
    // A completed step is clickable; Back walks one step at a time.
    fireEvent.click(chips()[0]!)
    await within(dialog).findByLabelText('ssh.field.environmentId')
    fireEvent.click(chips()[1]!)
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.back' }))
    await within(dialog).findByLabelText('ssh.field.environmentId')
  })

  it('resets the wizard to step one on cancel', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    const idInput = await within(dialog).findByLabelText('ssh.field.environmentId')
    fireEvent.change(idInput, { target: { value: 'env-build' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.add.reset' }))
    expect((await within(dialog).findByLabelText('ssh.field.environmentId') as HTMLInputElement).value).toBe('')
    expect(within(dialog).queryByRole('combobox', { name: 'ssh.field.managed' })).toBeNull()
  })

  it('keeps the saved-environment editor flat — one card, all sections', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.envEdit' }))
    const editor = dialog.querySelector('.mrfw-sshEdit') as HTMLElement
    // No stepper, no Next button; every section stays visible.
    expect(within(editor).queryByRole('list', { name: 'ssh.step.listLabel' })).toBeNull()
    expect(within(editor).queryByRole('button', { name: 'ssh.step.next' })).toBeNull()
    expect(within(editor).getByLabelText('ssh.field.environmentId')).toBeTruthy()
    expect(within(editor).getByLabelText('ssh.field.hostname')).toBeTruthy()
    expect(within(editor).getByLabelText('ssh.field.workspace')).toBeTruthy()
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

  it('disables the exec toggle on a new environment too — there is no helper yet', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'add')
    const toggle = await within(dialog).findByLabelText('ssh.field.allowExec') as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(within(dialog).getByText('ssh.field.allowExecHelper')).toBeTruthy()
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

  it('walks the readiness chain: helper is the first pending step with a single install affordance', async () => {
    const ssh = fakeSsh(sshState({ linked: false }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    const row = dialog.querySelector('.mrfw-sshEnvRow') as HTMLElement
    expect(within(row).getByText('ssh.ready.label')).toBeTruthy()
    expect(within(row).getByText('ssh.step.helper')).toBeTruthy()
    expect(within(row).getByText('ssh.step.link')).toBeTruthy()
    expect(within(row).getByText('ssh.step.binding')).toBeTruthy()
    // One install affordance — the primary next step, not two same-named buttons.
    expect(within(row).getAllByRole('button', { name: 'ssh.helperInstall' })).toHaveLength(1)
    // The link step is not this row's primary yet: only the banner offers it.
    expect(within(row).queryByRole('button', { name: 'ssh.linkNow' })).toBeNull()
    expect(within(dialog).getByText('ssh.linkBanner')).toBeTruthy()
  })

  it('makes linking ssh_config the primary step once the helper is installed', async () => {
    const ssh = fakeSsh(sshState({ linked: false, environments: [ENV_HELPER] }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    const row = dialog.querySelector('.mrfw-sshEnvRow') as HTMLElement
    const link = within(row).getAllByRole('button', { name: 'ssh.linkNow' })
    expect(link).toHaveLength(1)
    fireEvent.click(link[0]!)
    expect(await callsOf(ssh, 'configLink')).toEqual([['session-1']])
  })

  it('makes add-binding the primary step for a linked environment and preselects it', async () => {
    const ssh = fakeSsh(sshState({ environments: [ENV_HELPER] }))
    const dialog = await withDialog({ ssh }, 'manage')
    await within(dialog).findByText('ssh.environments')
    const row = dialog.querySelector('.mrfw-sshEnvRow') as HTMLElement
    fireEvent.click(within(row).getAllByRole('button', { name: 'ssh.bindingAdd' })[0]!)
    const select = within(dialog).getByLabelText('ssh.binding.environment') as HTMLSelectElement
    expect(select.value).toBe('env-helper')
  })

  it('registers a ready binding endpoint from the dialog', async () => {
    const remoteCalls: { method: string; args: unknown[] }[] = []
    const binding = { environmentId: 'env-helper', rootId: 'web', path: '/srv/app', actions: ['read' as const] }
    const endpoint = {
      environmentId: 'env-helper', rootId: 'web', path: '/srv/app', platform: 'linux',
      state: 'unregistered' as const, actions: [], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    }
    const ssh = fakeSsh(sshState({ environments: [ENV_HELPER], bindings: [binding] }))
    const dialog = await withDialog({ ssh, endpoints: [endpoint], remoteCalls }, 'manage')
    await within(dialog).findByText('ssh.environments')
    expect(within(dialog).getByText('ssh.ready.done')).toBeTruthy()
    const bindingRow = within(dialog).getByText('web').closest('.mrfw-row') as HTMLElement
    expect(within(bindingRow).getByText('remote.state.unregistered')).toBeTruthy()
    fireEvent.click(within(bindingRow).getByRole('button', { name: 'panel.remoteRegister' }))
    await waitFor(() => expect(remoteCalls).toEqual([{ method: 'add', args: ['session-1', 'env-helper', 'web'] }]))
  })

  it('marks a registered binding and withdraws it from the dialog', async () => {
    const remoteCalls: { method: string; args: unknown[] }[] = []
    const binding = { environmentId: 'env-helper', rootId: 'web', path: '/srv/app', actions: ['read' as const] }
    const endpoint = {
      environmentId: 'env-helper', rootId: 'web', path: '/srv/app', platform: 'linux',
      state: 'registered' as const, actions: [], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    }
    const ssh = fakeSsh(sshState({ environments: [ENV_HELPER], bindings: [binding] }))
    const dialog = await withDialog({ ssh, endpoints: [endpoint], remoteCalls }, 'manage')
    const bindingRow = (await within(dialog).findByText('web')).closest('.mrfw-row') as HTMLElement
    expect(within(bindingRow).getByText('remote.state.registered')).toBeTruthy()
    fireEvent.click(within(bindingRow).getByRole('button', { name: 'panel.remoteRemove' }))
    await waitFor(() => expect(remoteCalls).toEqual([{ method: 'remove', args: ['session-1', 'env-helper', 'web'] }]))
  })

  it('walks helper install, link, binding and registration inside the wizard, then lands on Connections', async () => {
    const remoteCalls: { method: string; args: unknown[] }[] = []
    const ssh = fakeSsh(sshState({ environments: [], linked: false, bindings: [] }))
    const dialog = await withDialog({ ssh, remoteCalls }, 'add')
    infoStep(dialog, { environmentId: 'env-build', hostname: 'build.internal', user: 'ci' })
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    await managedKeyStep(dialog)
    await saveKeyStep(dialog, ssh)
    // Step three installs the helper; it moves on by itself once installed.
    await within(dialog).findByText('ssh.add.helperGuide')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.helperInstall' }))
    expect(await callsOf(ssh, 'helperInstall')).toEqual([['session-1', 8, 'env-build', undefined]])
    // Step four opens on the managed-config link because it is not linked yet.
    await within(dialog).findByText('ssh.add.registerGuide')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.linkNow' }))
    await callsOf(ssh, 'configLink')
    // With no binding yet the step offers an inline binding form.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.bindingAdd' }))
    const bindings = await callsOf(ssh, 'bindingSave')
    expect(bindings[0]![2]).toMatchObject({ environmentId: 'env-build', rootId: 'primary' })
    // Then the endpoint registers through the same remotes path the panel uses.
    const register = await within(dialog).findByRole('button', { name: 'panel.remoteRegister' })
    await waitFor(() => { expect((register as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(register)
    await waitFor(() => expect(remoteCalls).toEqual([{ method: 'add', args: ['session-1', 'env-build', 'primary'] }]))
    // Finish closes the wizard on the new environment's row.
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.finish' }))
    expect(await within(dialog).findByText('ssh.environments')).toBeTruthy()
    expect(within(dialog).getAllByText('env-build').length).toBeGreaterThan(0)
  })

  it('lets the helper and register steps be skipped — the connection stays visible with its readiness chain', async () => {
    const ssh = fakeSsh(sshState({ environments: [], bindings: [] }))
    const dialog = await withDialog({ ssh }, 'add')
    infoStep(dialog, { environmentId: 'env-skip', hostname: 'skip.internal', user: 'ci' })
    await within(dialog).findByRole('combobox', { name: 'ssh.field.managed' })
    await managedKeyStep(dialog)
    await saveKeyStep(dialog, ssh)
    await within(dialog).findByText('ssh.add.helperGuide')
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.skip' }))
    // Skipping the helper still walks the register step: the inline binding
    // form needs no helper, but the register button itself explains why it
    // stays disabled.
    await within(dialog).findByText('ssh.add.registerGuide')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'ssh.bindingAdd' }))
    await callsOf(ssh, 'bindingSave')
    expect(await within(dialog).findByText('ssh.add.registerNeedsHelper')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'panel.remoteRegister' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'ssh.step.finish' }))
    expect(await within(dialog).findByText('ssh.environments')).toBeTruthy()
    const rows = await within(dialog).findAllByText('env-skip')
    expect(rows[0]!.closest('.mrfw-row')).toBeTruthy()
    // The helper was skipped, so no install ran and no endpoint registered.
    expect(ssh.calls.map(call => call.method)).not.toContain('helperInstall')
  })

  it('points unregistered personal endpoints at the readiness chain and hides the hint once all are registered', async () => {
    const endpoint = {
      environmentId: 'env-helper', rootId: 'web', path: '/srv/app', platform: 'linux',
      state: 'unregistered' as const, actions: [], transfers: [],
      capabilities: { read: true, write: false, exec: false, receive: false, send: false },
    }
    renderDialog({ ssh: fakeSsh(sshState()), endpoints: [endpoint] })
    expect(await screen.findByText('panel.remoteRegisterGuide')).toBeTruthy()
    cleanup()
    renderDialog({ ssh: fakeSsh(sshState()), endpoints: [{ ...endpoint, state: 'registered' as const }] })
    await screen.findByText('remote.state.registered')
    expect(screen.queryByText('panel.remoteRegisterGuide')).toBeNull()
  })

  it('closes without closing the Workspace Folders dialog underneath', async () => {
    const ssh = fakeSsh(sshState())
    const dialog = await withDialog({ ssh }, 'manage')
    fireEvent.click(within(dialog).getByRole('button', { name: 'panel.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ssh.dialog.title' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'panel.title' })).toBeTruthy()
  })
})


describe('SSH dialog asynchronous scope isolation', () => {
  const propsFor = (ssh: SshClient): SshManagementDialogProps => ({
    initialTab: 'connections', ssh, sessionId: 'a', custodyMode: 'personal', status: { state: 'ready' },
    endpoints: [], roots: ROOTS, remoteMode: undefined, onClose() {}, onChanged() {}, t,
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
