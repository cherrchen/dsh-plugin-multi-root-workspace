// @vitest-environment jsdom
/**
 * The Files-page takeover notice.
 *
 * A third-party `files` tab takeover replaces the page that hosts the root
 * switcher, so the switcher's slot registration never renders. The notice is
 * driven by the tab registry's effective definition: it must fire once per
 * takeover, stay silent on the built-in page and on hosts without the Files
 * page, rearm after a restore, and render as the LOW-level official Toast
 * (plain text, no icon, no `tone`) rather than a warning.
 */

import { StrictMode, useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FILES_PAGE_NOTICE_HOLD_MS,
  FilesPageNoticeToast,
  createFilesPageNoticeSource,
  installFilesPageNotice,
  type FilesPageNoticeSource,
} from '../src/client/files-page-notice.tsx'

const COPY: Record<string, string> = {
  'filesPage.notice': 'Another extension has taken over the Files page',
}

/** The plugin-dictionary seat the overlay entry binds. */
const t = ((key: string): string => COPY[key] ?? key) as never

/** A tab registry stand-in whose effective definition the test can replace. */
interface FakeTabs {
  get(kind: string): unknown
  subscribe(listener: () => void): () => void
  replace(definition: unknown): void
  notify(): void
}

/** Build one fake registry with a starting effective definition. */
function fakeTabs(initial: unknown): FakeTabs {
  const listeners = new Set<() => void>()
  let definition = initial
  return {
    get: kind => kind === 'files' ? definition : undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace(next) { definition = next },
    notify() { for (const listener of listeners) listener() },
  }
}

/** The built-in Files definition as the registry reports it. */
const BUILTIN = { kind: 'files', id: '@deepseek-ai/dsh-client-ui-sidebar-files', priority: 'builtin' }

/** A third-party takeover definition, the shape better-sidebar registers. */
const TAKEOVER = { kind: 'files', id: 'dsh-better-sidebar.files', priority: 'extension' }

interface RecordedRegistration {
  readonly options: { readonly name?: string; readonly id?: string; readonly inject?: () => unknown }
  readonly component: unknown
}

/**
 * Install the notice against a fake client root.
 * @param tabs - the service value the injected scope resolves `sidebarRightTabs` to.
 * @param overlay - whether `shell.overlay` is declared (`false` skips the registration callback).
 * @returns the source and the captured overlay registrations.
 */
function install(tabs: unknown, overlay = true): { source: FilesPageNoticeSource; registrations: RecordedRegistration[] } {
  const source = createFilesPageNoticeSource()
  const registrations: RecordedRegistration[] = []
  const ctx = {
    slots: {
      inject: (key: string, callback: () => unknown) => {
        if (key === 'shell.overlay' && overlay) callback()
        return () => {}
      },
      register: (options: RecordedRegistration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    inject: (_services: readonly string[], callback: (scope: unknown) => void) => {
      callback({
        get: (name: string) => name === 'sidebarRightTabs' ? tabs : undefined,
        effect: (callback: () => (() => void) | void) => { callback() },
      })
      return () => {}
    },
  }
  installFilesPageNotice(ctx as never, source, t)
  return { source, registrations }
}

/** Bind the source's observable as the slot renderer's `useNotice` hook. */
function useBound<S>(source: { getSnapshot(): S; subscribe(listener: () => void): () => void }) {
  return <T,>(selector: (snapshot: S) => T): T =>
    useSyncExternalStore(
      listener => source.subscribe(listener),
      () => selector(source.getSnapshot()),
    )
}

/** Render the overlay entry against a fresh notice source. */
function mount(): FilesPageNoticeSource {
  const source = createFilesPageNoticeSource()
  render(
    <StrictMode>
      <FilesPageNoticeToast
        useNotice={selector => useBound(source.hooks.notice)(selector)}
        dismiss={source.dismiss}
        t={t}
      />
    </StrictMode> as ReactElement,
  )
  return source
}

afterEach(() => {
  cleanup()
})

describe('the Files-page takeover detector', () => {
  it('announces a takeover once and never repeats it while the takeover lasts', () => {
    const tabs = fakeTabs(BUILTIN)
    const { source } = install(tabs)
    expect(source.hooks.notice.getSnapshot()).toBeNull()

    tabs.replace(TAKEOVER)
    tabs.notify()
    expect(source.hooks.notice.getSnapshot()).toEqual({ seq: 1 })

    tabs.notify()
    tabs.notify()
    expect(source.hooks.notice.getSnapshot()).toEqual({ seq: 1 })
  })

  it('stays silent while the built-in Files page is in force', () => {
    const tabs = fakeTabs(BUILTIN)
    const { source } = install(tabs)
    tabs.notify()
    tabs.notify()
    expect(source.hooks.notice.getSnapshot()).toBeNull()
  })

  it('rearms after a restore, so a later takeover announces again', () => {
    const tabs = fakeTabs(BUILTIN)
    const { source } = install(tabs)

    tabs.replace(TAKEOVER)
    tabs.notify()
    expect(source.hooks.notice.getSnapshot()).toEqual({ seq: 1 })

    tabs.replace(BUILTIN)
    tabs.notify()
    tabs.replace(TAKEOVER)
    tabs.notify()
    expect(source.hooks.notice.getSnapshot()).toEqual({ seq: 2 })
  })

  it('announces a takeover that is already in force when the client mounts', () => {
    const { source } = install(fakeTabs(TAKEOVER))
    expect(source.hooks.notice.getSnapshot()).toEqual({ seq: 1 })
  })
})

describe('the detector defaults to silence', () => {
  it('does nothing when the composition has no sidebarRightTabs service', () => {
    const { source } = install(undefined)
    expect(source.hooks.notice.getSnapshot()).toBeNull()
  })

  it('does nothing when the host has no Files kind (old releases)', () => {
    const { source } = install({ get: () => undefined, subscribe: () => () => {} })
    expect(source.hooks.notice.getSnapshot()).toBeNull()
  })

  it('does not fail when the registry exposes no subscription', () => {
    const tabs = { get: () => TAKEOVER }
    expect(() => install(tabs)).not.toThrow()
    // With no subscription only the initial evaluation runs, and it still announces.
    expect(install(tabs).source.hooks.notice.getSnapshot()).toEqual({ seq: 1 })
  })

  it('does not fail when shell.overlay is not declared', () => {
    expect(() => install(fakeTabs(TAKEOVER), false)).not.toThrow()
  })
})

describe('the overlay entry', () => {
  it('registers the notice component with its injected face', () => {
    const { registrations } = install(fakeTabs(BUILTIN))
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options).toMatchObject({
      name: 'shell.overlay',
      id: 'multi-root-files-page.notice',
    })
    expect(registrations[0]?.component).toBe(FilesPageNoticeToast)
    const face = registrations[0]?.options.inject?.() as {
      hooks: { notice: unknown }
      dismiss: () => void
      t: unknown
    } | undefined
    expect(face?.hooks.notice).toBeDefined()
    expect(face?.t).toBe(t)
  })
})

describe('the notice Toast', () => {
  it('renders nothing until a takeover is reported', () => {
    mount()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the localized copy as an info-level Toast without a warning glyph', () => {
    const source = mount()
    act(() => { source.report() })
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain(COPY['filesPage.notice'])
    // The official Toast's icon seat carries the warning tint; omitting the
    // icon is what keeps this notice informational. The stub renders `icon`
    // as an svg when one is passed.
    expect(banner.querySelector('svg')).toBeNull()
    expect(banner.getAttribute('data-hold-ms')).toBe(String(FILES_PAGE_NOTICE_HOLD_MS))
  })

  it('restarts the banner for a new takeover and clears on dismissal', () => {
    const source = mount()
    act(() => { source.report() })
    act(() => { source.report() })
    expect(screen.getByRole('status').textContent).toContain(COPY['filesPage.notice'])
    act(() => { screen.getByRole('status').click() })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
