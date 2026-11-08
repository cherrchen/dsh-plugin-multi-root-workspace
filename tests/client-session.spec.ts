/**
 * The structural probe that names the session the browser is showing.
 *
 * 0.1.5-rc.2 and 0.1.6-alpha.1 put that id on `list.current`. 0.1.6-alpha.2
 * removed the field and projects the main view as `retainedBy.mainView` on
 * the catalog row; 0.1.7-alpha.1 keeps that probe (other catalog fields
 * moved, the main-view predicate did not). Both shapes have to resolve,
 * and a populated catalog with nobody retained must stay "no session" —
 * the panel must not guess.
 */

import { describe, expect, it } from 'vitest'
import { currentSessionIdOf, mainViewRetentionOf, subscribeCurrentSession } from '../src/compat/client-session.ts'

/** One catalog row the way 0.1.6-alpha.2 projects it. */
function row(id: string, mainView?: number): { id: string; retainedBy: { mainView?: number } } {
  return { id, retainedBy: mainView === undefined ? {} : { mainView } }
}

/** A sessions service whose list snapshot is exactly `snapshot`. */
function sessions(snapshot: unknown): { list: { getSnapshot: () => unknown } } {
  return { list: { getSnapshot: () => snapshot } }
}

describe('mainViewRetentionOf', () => {
  /** A service whose per-session retention snapshot is exactly `snapshot`. */
  function retained(snapshot: unknown): { retainInfo: (id: string) => { getSnapshot: () => unknown } } {
    return { retainInfo: () => ({ getSnapshot: () => snapshot }) }
  }

  it('reads the synchronous per-session retention count', () => {
    expect(mainViewRetentionOf(retained({ retainedBy: { mainView: 1 } }), 's1')).toBe(true)
    expect(mainViewRetentionOf(retained({ retainedBy: { mainView: 2 } }), 's1')).toBe(true)
    expect(mainViewRetentionOf(retained({ retainedBy: { mainView: 0 } }), 's1')).toBe(false)
    // A readable snapshot without the source means "not retained"; only an
    // unreadable shape is unknown.
    expect(mainViewRetentionOf(retained({ retainedBy: {} }), 's1')).toBe(false)
  })

  it('returns undefined when the surface has no readable probe', () => {
    expect(mainViewRetentionOf({ list: {} }, 's1')).toBeUndefined()
    expect(mainViewRetentionOf(null, 's1')).toBeUndefined()
    expect(mainViewRetentionOf({ retainInfo: () => { throw new Error('unknown session') } }, 's1')).toBeUndefined()
    expect(mainViewRetentionOf(retained({}), 's1')).toBeUndefined()
    expect(mainViewRetentionOf({ retainInfo: () => ({}) }, 's1')).toBeUndefined()
  })

  it('invokes retainInfo as a method so a store can read this', () => {
    const service = {
      marker: 'bound',
      retainInfo(this: { marker: string }) {
        return { getSnapshot: () => ({ retainedBy: { mainView: this.marker === 'bound' ? 1 : 0 } }) }
      },
    }
    expect(mainViewRetentionOf(service, 's1')).toBe(true)
  })
})

describe('currentSessionIdOf', () => {
  it.each(['legacy', 'retained'] as const)('only reports selection changes on the %s store', shape => {
    let id: string | undefined = 'a', notify!: () => void, changes = 0, stopped = false
    const service = { list: {
      getSnapshot: () => shape === 'legacy' ? { current: id } : { byId: id === undefined ? {} : { [id]: row(id, 1) } },
      subscribe: (listener: () => void) => { notify = listener; return () => { stopped = true } },
    } }
    const stop = subscribeCurrentSession(service, () => { changes++ })
    notify(); notify(); expect(changes).toBe(0)
    id = 'b'; notify(); expect(changes).toBe(1)
    notify(); expect(changes).toBe(1)
    id = undefined; notify(); expect(changes).toBe(2)
    stop(); expect(stopped).toBe(true)
  })

  it('reads the explicit selection on the 0.1.5 and 0.1.6-alpha.1 snapshot', () => {
    expect(currentSessionIdOf(sessions({ current: 'session-1' }))).toBe('session-1')
  })

  it('prefers the explicit selection over a different main-view row', () => {
    expect(currentSessionIdOf(sessions({
      current: 'session-selected',
      byId: { 'session-main': row('session-main', 1) },
    }))).toBe('session-selected')
  })

  it('reads the main-view row when the 0.1.6-alpha.2 catalog has no current field', () => {
    expect(currentSessionIdOf(sessions({
      ids: ['session-other', 'session-main'],
      byId: {
        'session-other': row('session-other'),
        'session-main': row('session-main', 1),
      },
      phase: 'ready',
    }))).toBe('session-main')
  })

  it('uses the row id when it differs from the catalog key', () => {
    expect(currentSessionIdOf(sessions({
      byId: { 'catalog-key': { id: 'session-real', retainedBy: { mainView: 1 } } },
    }))).toBe('session-real')
  })

  it('falls back to the catalog key when the retained row has no id', () => {
    expect(currentSessionIdOf(sessions({
      byId: { 'session-key': { retainedBy: { mainView: 2 } } },
    }))).toBe('session-key')
  })

  it('returns undefined when catalog rows exist but none is the main view', () => {
    expect(currentSessionIdOf(sessions({
      ids: ['session-other', 'session-zero'],
      byId: {
        'session-other': row('session-other'),
        'session-zero': row('session-zero', 0),
      },
    }))).toBeUndefined()
  })

  it('ignores a non-numeric mainView count', () => {
    expect(currentSessionIdOf(sessions({
      byId: { 'session-1': { id: 'session-1', retainedBy: { mainView: '1' } } },
    }))).toBeUndefined()
  })

  it('returns undefined for an empty selection, a missing service, and a snapshot that is not a list', () => {
    expect(currentSessionIdOf(sessions({ current: '' }))).toBeUndefined()
    expect(currentSessionIdOf(sessions({ current: undefined }))).toBeUndefined()
    expect(currentSessionIdOf(undefined)).toBeUndefined()
    expect(currentSessionIdOf(null)).toBeUndefined()
    expect(currentSessionIdOf({})).toBeUndefined()
    expect(currentSessionIdOf({ list: {} })).toBeUndefined()
    expect(currentSessionIdOf(sessions(null))).toBeUndefined()
    expect(currentSessionIdOf(sessions('session-1'))).toBeUndefined()
  })

  it('skips a catalog value that is not a row and keeps scanning', () => {
    expect(currentSessionIdOf(sessions({
      byId: {
        broken: null,
        'session-main': row('session-main', 1),
      },
    }))).toBe('session-main')
  })

  it('calls getSnapshot as a method so the store keeps this', () => {
    const store = {
      current: 'session-this',
      getSnapshot() {
        return { current: this.current }
      },
    }
    expect(currentSessionIdOf({ list: store })).toBe('session-this')
  })

  it('returns undefined when getSnapshot throws', () => {
    expect(currentSessionIdOf({
      list: {
        getSnapshot() {
          throw new Error('store closed')
        },
      },
    })).toBeUndefined()
  })
})
