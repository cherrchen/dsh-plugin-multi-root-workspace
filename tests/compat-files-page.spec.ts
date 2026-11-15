/**
 * The Files-tab takeover probe.
 *
 * The registry's `get(kind)` answers with the effective definition, so the
 * probe must judge the declared band and the implementation id structurally —
 * never a slot declaration (that stays declared under a takeover) and never a
 * release string. Everything unreadable collapses to `absent`, because a host
 * without the Files page must stay silent.
 */

import { describe, expect, it } from 'vitest'
import {
  BUILTIN_FILES_TAB_ID,
  FILES_TAB_KIND,
  filesPageState,
  subscribeFilesPage,
} from '../src/compat/files-page.ts'

/** A registry stand-in carrying one kind's effective definition. */
function registry(definition: unknown): { get(kind: string): unknown } {
  return { get: kind => kind === FILES_TAB_KIND ? definition : undefined }
}

describe('filesPageState', () => {
  it('reports absent when the service is missing or unreadable', () => {
    for (const service of [undefined, null, {}, { get: 1 }, { get: () => undefined }, { get: () => null }]) {
      expect(filesPageState(service)).toEqual({ kind: 'absent' })
    }
  })

  it('stays silent when the service has no Files kind at all', () => {
    expect(filesPageState({ get: () => undefined })).toEqual({ kind: 'absent' })
  })

  it('treats a throwing get as absent instead of failing the client graph', () => {
    expect(filesPageState({ get: () => { throw new Error('foreign service') } })).toEqual({ kind: 'absent' })
  })

  it('recognizes the built-in page by its declared band', () => {
    expect(filesPageState(registry({ id: 'some-id', priority: 'builtin', kind: 'files' })))
      .toEqual({ kind: 'builtin', id: 'some-id' })
  })

  it('recognizes the built-in page by its implementation id when the band is not declared', () => {
    expect(filesPageState(registry({ id: BUILTIN_FILES_TAB_ID, kind: 'files' })))
      .toEqual({ kind: 'builtin', id: BUILTIN_FILES_TAB_ID })
  })

  it('reports a takeover for an extension band', () => {
    expect(filesPageState(registry({ id: 'better-sidebar.files', priority: 'extension' })))
      .toEqual({ kind: 'shadowed', id: 'better-sidebar.files' })
  })

  it('reports a takeover when the band is omitted (the registry defaults to extension)', () => {
    expect(filesPageState(registry({ id: 'better-sidebar.files' })))
      .toEqual({ kind: 'shadowed', id: 'better-sidebar.files' })
  })

  it('does not mistake a foreign or missing id for the built-in implementation', () => {
    expect(filesPageState(registry({ priority: 'extension', id: 42 })))
      .toEqual({ kind: 'shadowed', id: undefined })
    expect(filesPageState(registry({ priority: 'extension' })))
      .toEqual({ kind: 'shadowed', id: undefined })
  })
})

describe('subscribeFilesPage', () => {
  it('subscribes where the release exposes the subscription and returns its disposer', () => {
    const listeners = new Set<() => void>()
    let disposed = false
    const tabs = {
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { disposed = true; listeners.delete(listener) }
      },
    }
    const listener = (): void => {}
    const dispose = subscribeFilesPage(tabs, listener)
    expect(listeners.has(listener)).toBe(true)
    dispose()
    expect(disposed).toBe(true)
    expect(listeners.size).toBe(0)
  })

  it('returns a no-op where the release has no subscription', () => {
    const dispose = subscribeFilesPage({ get: () => undefined }, () => {})
    expect(() => { dispose() }).not.toThrow()
    expect(typeof subscribeFilesPage(undefined, () => {})).toBe('function')
  })

  it('accepts a subscription that reports no disposer', () => {
    const tabs = { subscribe: (): void => {} }
    expect(() => { subscribeFilesPage(tabs, () => {})() }).not.toThrow()
  })
})
