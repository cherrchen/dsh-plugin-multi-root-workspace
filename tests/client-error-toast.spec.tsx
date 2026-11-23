// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelErrorToast } from '../src/client/error-toast.tsx'
import { PanelError } from '../src/client/panel-client.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Match the legacy module namespace for the probed optional exports.
  IconWarningOutlineRegular: undefined,
  IconWorkspaceTreeOutlineRegular: undefined,
  IconWorkspaceTreeOutline16: undefined,
  IconPlayOutline16: undefined,
  IconPlayOutlineRegular: undefined,
  IconDownloadOutline16: undefined,
  IconDownloadOutlineRegular: undefined,
  IconLinkOutline16: undefined,
  IconLinkOutlineRegular: undefined,
  IconShieldOutline16: undefined,
  IconShieldOutlineRegular: undefined,
}))

afterEach(cleanup)

it('renders an error toast with the pixel-era warning icon', () => {
  render(<PanelErrorToast error={new PanelError('unavailable', 'failed')} t={key => key} />)
  const toast = screen.getByRole('status')
  expect(toast.textContent).toContain('error.unavailable')
  expect(toast.querySelector('[data-icon="warning-16"]')).not.toBeNull()
})

it('retains localized remediation and expandable process facts from SSH RPC errors', async () => {
  const { createSshSettingsClient } = await import('../src/client/ssh-client.ts')
  const { SshErrorDetail, panelErrorText } = await import('../src/client/error-toast.tsx')
  const { errorHasDetail } = await import('../src/client/panel-client.ts')
  const { en } = await import('../src/client/locales.ts')
  const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
    en[key].replace(/\{([^}]+)}/g, (_, name) => String(params?.[name] ?? ''))
  const client = createSshSettingsClient({ rpc: { call: async () => ({
    ok: false,
    error: {
      code: 'helper-npm-network', message: 'npm reported EAI_AGAIN.',
      details: { stage: 'remote-install', remediation: 'registry', retryable: false, exitCode: 1, remoteState: 'may-have-changed' },
    },
  }) } })
  const error = await client.management.helperInstall(undefined, 1, 'build').catch((error: PanelError) => error) as PanelError
  expect(errorHasDetail(error.code, error.ssh)).toBe(true)
  expect(panelErrorText(t, error)).toContain('Remote installation')
  const { container } = render(<SshErrorDetail error={error} t={t} />)
  expect(screen.getByText(en['ssh.remedy.registry'])).toBeTruthy()
  expect(screen.getByText(en['ssh.remoteState.may-have-changed'])).toBeTruthy()
  expect(container.querySelector('details')?.textContent).toContain('npm reported EAI_AGAIN.')
  expect(container.querySelector('details')?.textContent).toContain('Exit code 1')
})
