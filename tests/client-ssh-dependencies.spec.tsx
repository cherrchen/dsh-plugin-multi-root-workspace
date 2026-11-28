// @vitest-environment jsdom
/** The split SSH dependency install/upgrade/restart flow and its degradation paths. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshDependencyNotice } from '../src/client/ssh-dependencies.tsx'
import type { SshDependencyView } from '../src/remote/ssh-diagnostics.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = (key, params) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
type LauncherWindow = Window & { dshDesktop?: unknown; deepseekDesktop?: unknown }
let serial = 0

function view(code: SshDependencyView['code'], options: {
  command?: string
  install?: boolean
  profile?: string
  version?: string
} = {}): SshDependencyView {
  const version = options.version ?? '0.2.2-rc.4'
  return {
    code,
    profile: options.profile ?? `web-${++serial}`,
    release: '0.2.2-rc.5',
    capabilities: { install: options.install !== false },
    ...(options.command === undefined ? {} : { command: options.command }),
    packages: [
      { name: '@deepseek-ai/dsh-ssh', state: code === 'ssh-deps-version' ? 'version-mismatch' : 'missing', ...(code === 'ssh-deps-version' ? { version } : {}) },
      { name: '@deepseek-ai/dsh-fs-ssh', state: code === 'ssh-deps-partial' ? 'installed' : code === 'ssh-deps-version' ? 'version-mismatch' : 'missing', ...(code === 'ssh-deps-version' ? { version } : code === 'ssh-deps-partial' ? { version: '0.2.2-rc.5' } : {}) },
      { name: '@deepseek-ai/dsh-subprocess-ssh', state: 'missing' },
      { name: '@deepseek-ai/dsh-sandbox-ssh', state: 'missing' },
    ],
  }
}

function launcher(options: {
  install?: (request: { profile: string; release: string }) => Promise<unknown>
  restart?: (request: { profile: string; release: string }) => Promise<unknown>
  installAvailable?: boolean
  restartAvailable?: boolean
  protocolVersion?: number
}): void {
  const installAvailable = options.installAvailable ?? options.install !== undefined
  const restartAvailable = options.restartAvailable ?? options.restart !== undefined
  ;(window as LauncherWindow).dshDesktop = {
    sshDependencies: {
      protocolVersion: options.protocolVersion ?? 2,
      capabilities: { install: installAvailable, restart: restartAvailable },
      ...(installAvailable ? { install: options.install ?? vi.fn() } : {}),
      ...(restartAvailable ? { restart: options.restart ?? vi.fn() } : {}),
      subscribe: () => () => {},
    },
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete (window as LauncherWindow).dshDesktop
  delete (window as LauncherWindow).deepseekDesktop
})

describe('SshDependencyNotice split flow', () => {
  it('shows install for missing and repair for partial, and prevents concurrent execution', async () => {
    for (const [code, label] of [['ssh-deps-missing', 'ssh.installRuntime'], ['ssh-deps-partial', 'ssh.repairRuntime']] as const) {
      const gate = Promise.withResolvers<{ status: 'restart-required' }>()
      const onInstall = vi.fn(() => gate.promise)
      const rendered = render(<SshDependencyNotice view={view(code)} onCheck={() => {}} onInstall={onInstall} t={t} />)
      const button = screen.getByRole('button', { name: label })
      fireEvent.click(button)
      fireEvent.click(button)
      await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1))
      gate.resolve({ status: 'restart-required' })
      await waitFor(() => expect(screen.getByText('ssh.manualRestartSummary')).toBeTruthy())
      rendered.unmount()
    }
  })

  it('opens the dedicated upgrade dialog with profile, Host release, target, and package states', () => {
    const current = view('ssh-deps-version')
    render(<SshDependencyNotice view={current} onCheck={() => {}} onInstall={async () => ({ status: 'restart-required' })} t={t} />)
    expect(screen.getByText('ssh.upgradeTitle')).toBeTruthy()
    expect(screen.getAllByText(`ssh.dependenciesProfile:${JSON.stringify({ profile: current.profile, version: current.release })}`).length).toBeGreaterThan(0)
    expect(screen.getByText('ssh.upgradeTarget')).toBeTruthy()
    expect(screen.getByText('ssh.upgradeScope')).toBeTruthy()
    expect(screen.getByText('ssh.upgradeCaution')).toBeTruthy()
    expect(screen.getByText('ssh.upgradeRestartNeeded')).toBeTruthy()
    expect(screen.getAllByText(/@deepseek-ai\/dsh-ssh/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/ssh\.dependency\.version-mismatch/).length).toBeGreaterThan(0)
  })

  it('remembers Later for the same state and re-prompts when the package state changes', async () => {
    const profile = `web-${++serial}`
    const initial = view('ssh-deps-version', { profile })
    const rendered = render(<SshDependencyNotice view={initial} onCheck={() => {}} t={t} />)
    expect(screen.getByText('ssh.upgradeTitle')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'ssh.later' })[0]!)
    await waitFor(() => expect(screen.queryByText('ssh.upgradeTitle')).toBeNull())
    rendered.rerender(<SshDependencyNotice view={initial} onCheck={() => {}} t={t} />)
    await act(async () => {})
    expect(screen.queryByText('ssh.upgradeTitle')).toBeNull()

    const changed = view('ssh-deps-version', { profile, version: '0.2.2-rc.3' })
    rendered.rerender(<SshDependencyNotice view={changed} onCheck={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByText('ssh.upgradeTitle')).toBeTruthy())
  })

  it('shows manual restart guidance after a successful upgrade when restart capability is absent', async () => {
    const onInstall = vi.fn(async () => ({ status: 'restart-required' as const }))
    render(<SshDependencyNotice view={view('ssh-deps-version')} onCheck={() => {}} onInstall={onInstall} t={t} />)
    const buttons = screen.getAllByRole('button', { name: 'ssh.upgradeRuntime' })
    fireEvent.click(buttons[buttons.length - 1]!)
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('ssh.manualRestartSummary')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ssh.restartHost' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ssh.recheckAfterRestart' })).toBeTruthy()
  })

  it('shows and invokes an explicit Restart Host button when restart capability exists', async () => {
    const restart = vi.fn(async (request: { profile: string; release: string }) => ({ status: 'done', ...request }))
    const install = vi.fn(async (request: { profile: string; release: string }) => ({ status: 'installed', ...request }))
    launcher({ restart, install })
    const onCheck = vi.fn()
    render(<SshDependencyNotice view={view('ssh-deps-missing')} onCheck={onCheck} onInstall={async () => ({ status: 'restart-required' })} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'ssh.installRuntime' }))
    expect(await screen.findByText('ssh.restartSummary')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ssh.restartHost' }))
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
    expect(install).not.toHaveBeenCalled()
    await waitFor(() => expect(onCheck).toHaveBeenCalled())
  })

  it('enters restart guidance directly for ssh-deps-restart and never offers install or upgrade there', () => {
    launcher({ restart: async request => ({ status: 'done', ...request }) })
    render(<SshDependencyNotice view={view('ssh-deps-restart')} onCheck={() => {}} t={t} />)
    expect(screen.getByText('ssh.restartSummary')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ssh.installRuntime' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ssh.upgradeRuntime' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ssh.restartHost' })).toBeTruthy()
  })

  it('does not offer install or upgrade for private, resolution, host-level, or ready states', () => {
    for (const code of ['ssh-deps-private', 'ssh-deps-resolution', 'ssh-host-unsupported', 'ssh-host-platform', 'ready'] as const) {
      const rendered = render(<SshDependencyNotice view={view(code)} onCheck={() => {}} onInstall={async () => ({ status: 'restart-required' })} t={t} />)
      expect(screen.queryByRole('button', { name: 'ssh.installRuntime' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'ssh.repairRuntime' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'ssh.upgradeRuntime' })).toBeNull()
      rendered.unmount()
    }
  })

  it('keeps a failed install retryable', async () => {
    const onInstall = vi.fn()
      .mockRejectedValueOnce(new Error('package manager failed'))
      .mockResolvedValueOnce({ status: 'restart-required' as const })
    render(<SshDependencyNotice view={view('ssh-deps-missing')} onCheck={() => {}} onInstall={onInstall} t={t} />)
    const button = screen.getByRole('button', { name: 'ssh.installRuntime' })
    fireEvent.click(button)
    expect(await screen.findByText('ssh.installPhase.failed:{"message":"package manager failed"}')).toBeTruthy()
    fireEvent.click(button)
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('ssh.manualRestartSummary')).toBeTruthy()
  })

  it('uses the copy command as the primary degradation path without install capability', () => {
    render(<SshDependencyNotice view={view('ssh-deps-missing', { command: 'install command', install: false })} onCheck={() => {}} t={t} />)
    expect(screen.queryByRole('button', { name: 'ssh.installRuntime' })).toBeNull()
    expect(screen.getByText('install command')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ssh.copyInstallCommand' })).toBeTruthy()
  })

  it('degrades the upgrade action to copying the upgrade command without install capability', () => {
    render(<SshDependencyNotice view={view('ssh-deps-version', { command: 'upgrade command', install: false })} onCheck={() => {}} t={t} />)
    expect(screen.getByText('ssh.upgradeTitle')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'ssh.copyUpgradeCommand' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('upgrade command').length).toBeGreaterThan(0)
  })

  it('uses a protocol-v2 launcher install when Host RPC install is unavailable and ignores v1', async () => {
    const install = vi.fn(async request => ({ status: 'restart-required' as const, ...request }))
    launcher({ install })
    render(<SshDependencyNotice view={view('ssh-deps-missing', { install: false })} onCheck={() => {}} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'ssh.installRuntime' }))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    cleanup()

    launcher({ install, protocolVersion: 1 })
    render(<SshDependencyNotice view={view('ssh-deps-missing', { command: 'install command', install: false })} onCheck={() => {}} t={t} />)
    expect(screen.queryByRole('button', { name: 'ssh.installRuntime' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ssh.copyInstallCommand' })).toBeTruthy()
  })
})
