// @vitest-environment jsdom
/**
 * The open-in-app fork's `0.2.2-alpha.2` announcement seam: settled gestures
 * report into a plugin-owned toast source instead of a per-control banner,
 * and the `shell.overlay` entry renders whatever the source publishes —
 * failures on every device, acknowledged opens and reveals on mobile only.
 * `device.ts`'s `isMobileDevice` shim is exercised both ways: falling back to
 * the identical userAgent/platform logic when the primitives module lacks the
 * export (this suite's stub), and deferring to the export when it exists.
 */

import { StrictMode, useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenInAppController } from '../src/client/open-in-app/controller.ts'

const COPY: Record<string, string> = {
  'path.opened': 'Opened on another device',
  'path.revealed': 'File location shown on another device',
  'path.openError': 'Could not open. Try again.',
  'path.revealError': 'Could not show the file location. Try again.',
}

/** The `open-in-app` namespace seat the overlay entry binds. */
const t = ((key: string): string => COPY[key] ?? key) as never

/** The `useToast` hook the slot renderer would bind from `hooks.toast`. */
function useBound<S>(source: { getSnapshot(): S; subscribe(l: () => void): () => void }) {
  return <T,>(selector: (snapshot: S) => T): T =>
    useSyncExternalStore(
      (listener: () => void) => source.subscribe(listener),
      () => selector(source.getSnapshot()),
    )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** Render the overlay entry against a fresh toast source. */
async function mount() {
  const { createOpenInAppToastSource, OpenInAppToast } = await import('../src/client/open-in-app/open-toast.tsx')
  const source = createOpenInAppToastSource()
  const view = render(
    <StrictMode>
      <OpenInAppToast useToast={selector => useBound(source.hooks.toast)(selector)} dismiss={source.dismiss} t={t} />
    </StrictMode> as ReactElement,
  )
  return { source, view }
}

describe('the open-in-app overlay toast', () => {
  it('announces a failed gesture with the localized path.openError copy', async () => {
    const { source } = await mount()
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { source.report({ kind: 'failed', failure: 'openError' }) })
    expect(screen.getByRole('status').textContent).toContain('Could not open. Try again.')
  })

  it('announces nothing for a skipped gesture', async () => {
    const { source } = await mount()
    act(() => { source.report({ kind: 'skipped' }) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(source.hooks.toast.getSnapshot()).toBeNull()
  })

  it('shows no success toast for an opened outcome on a non-mobile device', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })
    const { source } = await mount()
    act(() => { source.report({ kind: 'opened' }) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the localized path.opened toast for an opened outcome on a mobile device', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 })
    const { source } = await mount()
    act(() => { source.report({ kind: 'opened' }) })
    expect(screen.getByRole('status').textContent).toContain('Opened on another device')
  })
})

describe('OpenInAppController.launch', () => {
  it('resolves a failed outcome instead of rejecting when the host answers non-OK', async () => {
    const controller = new OpenInAppController(async () => new Response(null, { status: 500 }))
    await expect(controller.launch('app.finder', '/root')).resolves.toEqual({ kind: 'failed', failure: 'openError' })
  })

  it('resolves skipped while another launch holds the operation', async () => {
    const controller = new OpenInAppController(async () => new Promise<Response>(() => {}))
    const first = controller.launch('app.finder', '/root')
    await expect(controller.launch('app.finder', '/root')).resolves.toEqual({ kind: 'skipped' })
    void first
  })
})

describe('the isMobileDevice shim', () => {
  it('falls back to the identical detection when the primitives module has no export', async () => {
    const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')
    expect('isMobileDevice' in primitives).toBe(false)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 })
    const { isMobileDevice } = await import('../src/client/open-in-app/device.ts')
    expect(isMobileDevice()).toBe(true)
  })

  it('detects a non-mobile device through the same fallback', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })
    const { isMobileDevice } = await import('../src/client/open-in-app/device.ts')
    expect(isMobileDevice()).toBe(false)
  })

  it('uses the primitives export when the installed release carries it', async () => {
    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
      ...(await vi.importActual<object>('./stubs/ui-primitives.tsx')),
      isMobileDevice: () => true,
    }))
    // A desktop UA: only the mocked export (not the fallback) can answer true.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })
    const { isMobileDevice } = await import('../src/client/open-in-app/device.ts')
    expect(isMobileDevice()).toBe(true)
    vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
  })
})
