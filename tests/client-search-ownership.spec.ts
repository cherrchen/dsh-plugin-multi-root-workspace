// @vitest-environment jsdom
/**
 * Search-record ownership: one store per session injection, a closed tab's
 * records released when its owner dies, and a body-only unmount keeping them
 * (that is how opening a file and coming back restores the search).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createFilesTreeSeats } from '../src/client/files-tree/adapter.tsx'
import { createSearchPreferenceBook } from '../src/client/files-tree/search-preferences.ts'
import { searchStateKey } from '../src/client/files-tree/search-state.ts'

const ROOT = '/repos/payments'
const TAB_A = 'tab-a' as TabId
const TAB_B = 'tab-b' as TabId

/** The seats over a stub context: this spec exercises ownership, not host I/O. */
function seats() {
  const ctx = {
    get: () => undefined,
    inject: () => {},
  } as never
  return createFilesTreeSeats(ctx, { preferences: createSearchPreferenceBook(undefined) })
}

/** One session's inject product. */
function product(sessionId: string) {
  const handle = seats()
  const instance = handle.store.create(sessionId)
  const injected = handle.inject(sessionId as SessionId, instance.actions)
  return { handle, injected }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('the search records ownership', () => {
  it('gives every session its own store', () => {
    const a = product('session-a').injected
    const b = product('session-b').injected
    expect(a.search).not.toBe(b.search)
    a.search.barOpen(searchStateKey(TAB_A, ROOT), true)
    expect(b.search.state(searchStateKey(TAB_A, ROOT)).barOpen).toBe(false)
  })

  it("drops one closed tab's records and keeps the other tab's", () => {
    const { injected } = product('session-a')
    const keyA = searchStateKey(TAB_A, ROOT)
    const otherRoot = searchStateKey(TAB_A, '/repos/other')
    const keyB = searchStateKey(TAB_B, ROOT)
    for (const key of [keyA, otherRoot, keyB]) {
      injected.search.setQuery(key, 'config')
    }
    // A detached carrier is a dead owner: the pane's dockkit id no longer has
    // any connected element, which is the tab-closed shape.
    injected.takeover.signal(TAB_A, ROOT, document.createElement('div'))

    expect(injected.search.state(keyA)).toMatchObject({ barOpen: false, query: '' })
    expect(injected.search.state(otherRoot)).toMatchObject({ barOpen: false, query: '' })
    expect(injected.search.state(keyB)).toMatchObject({ query: 'config' })
  })

  it("keeps a tab's records when only the body unmounts", () => {
    const { injected } = product('session-a')
    const key = searchStateKey(TAB_B, ROOT)
    injected.search.setQuery(key, 'config')
    const carrier = document.createElement('div')
    document.body.append(carrier)
    injected.takeover.signal(TAB_B, ROOT, carrier)

    // Opening a file unmounts the Files body: `end` is the body cleanup, not
    // an owner death, so the retained record is what restores the search.
    injected.takeover.end(TAB_B)
    expect(injected.search.state(key)).toMatchObject({ query: 'config' })
  })
})
