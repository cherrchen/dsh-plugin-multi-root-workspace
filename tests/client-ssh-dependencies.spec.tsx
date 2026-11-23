// @vitest-environment jsdom
/** The dependency dialog's optional Desktop install action and its Web fallback. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshDependencyNotice } from '../src/client/ssh-dependencies.tsx'
import type { SshDependencyView } from '../src/remote/ssh-diagnostics.ts'
import type { Translate } from '../src/client/WorkspaceFoldersAction.tsx'

const t: Translate = (key, params) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
const view = (code: SshDependencyView['code'], command?: string): SshDependencyView => ({
  code, profile: 'web', release: '0.2.2-rc.5', ...(command === undefined ? {} : { command }),
  packages: [{ name: '@deepseek-ai/dsh-ssh', state: code === 'ssh-deps-partial' ? 'installed' : 'missing' }],
})
type LauncherWindow = Window & { dshDesktop?: unknown; deepseekDesktop?: unknown }

afterEach(() => {
  cleanup()
  delete (window as LauncherWindow).dshDesktop
  delete (window as LauncherWindow).deepseekDesktop
})

describe('SshDependencyNotice Desktop install', () => {
  it('offers install-and-restart only when the launcher explicitly supports it', async () => {
    let listener: ((phase: string) => void) | undefined
    const unsubscribe = vi.fn()
    const settled = Promise.withResolvers<{ status: 'installed'; profile: string; release: string }>()
    const install = vi.fn((request: { profile: string; release: string }) => {
      expect(request).toEqual({ profile: 'web', release: '0.2.2-rc.5' })
      return settled.promise
    })
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: {
        protocolVersion: 1,
        install,
        subscribe: (callback: (phase: string) => void) => { listener = callback; return unsubscribe },
      },
    }
    const onCheck = vi.fn()
    const rendered = render(<SshDependencyNotice view={view('ssh-deps-missing', 'install command')} onCheck={onCheck} t={t} />)
    const button = screen.getByRole('button', { name: 'ssh.installAndRestart' })
    expect(screen.getByRole('button', { name: 'ssh.copyInstallCommand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ssh.recheckDependencies' })).toBeTruthy()

    fireEvent.click(button)
    fireEvent.click(button)
    act(() => { listener?.('installing') })
    expect(screen.getByText('ssh.installPhase.installing')).toBeTruthy()
    settled.resolve({ status: 'installed', profile: 'web', release: '0.2.2-rc.5' })
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCheck).toHaveBeenCalled())
    rendered.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('does not stay busy after a ready result whose recheck is still missing', async () => {
    const checked = Promise.withResolvers<void>()
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: {
        protocolVersion: 1,
        install: async () => ({ status: 'ready', profile: 'web', release: '0.2.2-rc.5' }),
        subscribe: () => () => {},
      },
    }
    render(<SshDependencyNotice view={view('ssh-deps-missing', 'install command')} onCheck={() => checked.promise} t={t} />)
    const button = screen.getByRole('button', { name: 'ssh.installAndRestart' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(await screen.findByText('ssh.installPhase.ready')).toBeTruthy()
    expect(button.getAttribute('aria-busy')).toBe('true')
    checked.resolve()
    await waitFor(() => expect(button.getAttribute('aria-busy')).not.toBe('true'))
  })

  it('shows restart-required instead of claiming the restarted Host is checking', async () => {
    const checked = Promise.withResolvers<void>()
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: {
        protocolVersion: 1,
        install: async () => ({ status: 'restart-required', profile: 'web', release: '0.2.2-rc.5' }),
        subscribe: () => () => {},
      },
    }
    render(<SshDependencyNotice view={view('ssh-deps-missing', 'install command')} onCheck={() => checked.promise} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'ssh.installAndRestart' }))
    expect(await screen.findByText('ssh.installPhase.restart')).toBeTruthy()
    expect(screen.queryByText('ssh.installPhase.done')).toBeNull()
    checked.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: 'ssh.installAndRestart' })).toBeTruthy())
  })

  it('keeps the command and recheck when no launcher exists', () => {
    render(<SshDependencyNotice view={view('ssh-deps-missing', 'install command')} onCheck={() => {}} t={t} />)
    expect(screen.queryByRole('button', { name: 'ssh.installAndRestart' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ssh.copyInstallCommand' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ssh.recheckDependencies' })).toBeTruthy()
  })

  it('does not offer the launcher action for a version mismatch or a host-level refusal', () => {
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: { protocolVersion: 1, install: async () => ({ status: 'installed' }), subscribe: () => () => {} },
    }
    render(<SshDependencyNotice view={view('ssh-deps-version', 'install command')} onCheck={() => {}} t={t} />)
    expect(screen.queryByRole('button', { name: 'ssh.installAndRestart' })).toBeNull()
  })

  it('surfaces a launcher failure and keeps the recheck available', async () => {
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: {
        protocolVersion: 1,
        install: async () => { throw new Error('Host stop failed') },
        subscribe: () => () => {},
      },
    }
    render(<SshDependencyNotice view={view('ssh-deps-partial', 'install command')} onCheck={() => {}} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'ssh.installAndRestart' }))
    expect(await screen.findByText('ssh.installPhase.failed:{"message":"Host stop failed"}')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ssh.recheckDependencies' })).toBeTruthy()
  })

  it('shows the restart-required state when the restarted Host still cannot load the packages', async () => {
    ;(window as LauncherWindow).dshDesktop = {
      sshDependencies: {
        protocolVersion: 1,
        install: async () => ({ status: 'installed', profile: 'web', release: '0.2.2-rc.5' }),
        subscribe: () => () => {},
      },
    }
    function Harness() {
      const [current, setCurrent] = useState(view('ssh-deps-missing', 'install command'))
      return <SshDependencyNotice view={current} onCheck={() => { setCurrent(view('ssh-deps-restart')) }} t={t} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'ssh.installAndRestart' }))
    expect(await screen.findByText('error.ssh-deps-restart')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ssh.installAndRestart' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ssh.recheckDependencies' })).toBeTruthy()
  })
})
