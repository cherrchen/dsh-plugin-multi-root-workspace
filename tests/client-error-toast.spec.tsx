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
