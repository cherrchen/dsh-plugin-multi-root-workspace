/**
 * P4 client lifecycle: the shared authorization-lease book and the preview
 * resource book — dedupe, pin lifetime, fences, caps and grant-scoped
 * invalidation, all on deferred-RPC fakes so wire timing is exact.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteFilesAuthorizationBook, type SshFilesIdentity } from '../src/client/file-preview/authorization.ts'
import { RemotePreviewBook } from '../src/client/file-preview/resource-book.ts'
import { RemoteFilesError, REMOTE_FILES_LIMITS, REMOTE_FILE_PREVIEW_LIMITS, type RemoteFilesReadContent } from '../src/remote/files-contract.ts'

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const identity = (over: Partial<SshFilesIdentity> = {}): SshFilesIdentity => ({
  sessionId: 's1' as SessionId,
  root: { kind: 'remote', environmentId: 'dev', rootId: 'out' },
  incarnation: 'a'.repeat(64),
  ...over,
})

interface WaitCall { readonly request: unknown; readonly signal: AbortSignal; readonly settle: PromiseWithResolvers<void> }

function authorizationHarness() {
  const calls: WaitCall[] = []
  const client = {
    // The fake transport IGNORES the abort signal — exactly the drain case
    // the book must survive without ever overlapping two waits.
    wait: vi.fn((request: unknown, signal: AbortSignal) => {
      const settle = Promise.withResolvers<void>()
      calls.push({ request, signal, settle })
      return settle.promise
    }),
  }
  return { book: new RemoteFilesAuthorizationBook(client), calls }
}

describe('the shared authorization lease book', () => {
  it('serves two concurrent holds with exactly one wire call and renews only while held', async () => {
    const { book, calls } = authorizationHarness()
    const a = new AbortController()
    const b = new AbortController()
    const first = book.observe(identity(), a.signal)
    const second = book.observe(identity(), b.signal)
    expect(calls).toHaveLength(1)
    // A settled lease renews ONLY while an observer holds it.
    calls[0].settle.resolve()
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    a.abort()
    b.abort()
    await first
    await second
    await vi.waitFor(() => {
      calls[1].settle.resolve()
    })
    await flush()
    // The aborted control stops the loop: no third wait ever leaves.
    expect(calls).toHaveLength(2)
  })

  it('a lease failure rejects its observers while an unrelated key stays pending', async () => {
    const { book, calls } = authorizationHarness()
    const other = identity({ root: { kind: 'remote', environmentId: 'other-env', rootId: 'out' } })
    const first = book.observe(identity(), new AbortController().signal)
    const second = book.observe(other, new AbortController().signal)
    expect(calls).toHaveLength(2)
    calls[0].settle.reject(new RemoteFilesError('binding-changed'))
    await expect(first).rejects.toMatchObject({ code: 'binding-changed' })
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await flush()
    expect(secondSettled).toBe(false)
    book.dispose()
    await second
  })

  it('an old generation rejection is never delivered to a new observe of the same key', async () => {
    const { book, calls } = authorizationHarness()
    const first = book.observe(identity(), new AbortController().signal)
    calls[0].settle.reject(new RemoteFilesError('root-unregistered'))
    await expect(first).rejects.toMatchObject({ code: 'root-unregistered' })
    await flush()
    const second = book.observe(identity(), new AbortController().signal)
    let settled: string | undefined
    void second.then(() => { settled = 'resolved' }, (error: RemoteFilesError) => { settled = error.code })
    await flush()
    expect(calls).toHaveLength(2)
    expect(settled).toBeUndefined()
    book.dispose()
    await second
  })

  it('a same-turn release and reacquire shares the live wire — no abort, no second wait', async () => {
    const { book, calls } = authorizationHarness()
    const first = new AbortController()
    const heldA = book.observe(identity(), first.signal)
    expect(calls).toHaveLength(1)
    first.abort()
    // Same synchronous turn, before the queued release microtask: the
    // rejoin shares the wire — the abort is never delivered.
    const second = book.observe(identity(), new AbortController().signal)
    await heldA
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].signal.aborted).toBe(false)
    book.dispose()
    await second
  })

  it('dispose settles drain-waiters promptly even while the wire stays stuck', async () => {
    const { book, calls } = authorizationHarness()
    const holder = new AbortController()
    const held = book.observe(identity(), holder.signal)
    holder.abort()
    await held
    await flush()
    // Draining: control aborted, the cancel-ignoring wire keeps the entry.
    expect(calls[0].signal.aborted).toBe(true)
    const rejoinedA = book.observe(identity(), new AbortController().signal)
    const rejoinedB = book.observe(identity(), new AbortController().signal)
    await flush()
    expect(calls).toHaveLength(1)
    book.dispose()
    await rejoinedA
    await rejoinedB
    // The stuck wire unwinds afterwards without a renewal.
    calls[0].settle.resolve()
    await flush()
    expect(calls).toHaveLength(1)
  })

  it('re-observing during drain waits for the old wire call — never a second pending wait', async () => {
    const { book, calls } = authorizationHarness()
    const controller = new AbortController()
    const first = book.observe(identity(), controller.signal)
    expect(calls).toHaveLength(1)
    controller.abort()
    await first
    await flush()
    // The lease is draining: the transport ignored the abort, so the map
    // entry stays and a new observe cannot fire another wait yet.
    const second = book.observe(identity(), new AbortController().signal)
    await flush()
    expect(calls).toHaveLength(1)
    calls[0].settle.resolve()
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    book.dispose()
    await second
  })

  it('caps distinct identities at the wait limit, a draining entry included', async () => {
    const { book, calls } = authorizationHarness()
    const keys = Array.from({ length: REMOTE_FILES_LIMITS.waitConcurrent }, (_, index) =>
      identity({ root: { kind: 'remote', environmentId: `env-${index}`, rootId: 'out' } }))
    const observations = keys.map(id => book.observe(id, new AbortController().signal).catch((error: RemoteFilesError) => error))
    expect(calls).toHaveLength(REMOTE_FILES_LIMITS.waitConcurrent)
    await expect(book.observe(identity({ root: { kind: 'remote', environmentId: 'env-x', rootId: 'out' } }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'resource-budget' })
    book.dispose()
    await Promise.all(observations)
  })

  it('a pre-aborted observer resolves with no RPC, and dispose frees every hold promptly', async () => {
    const { book, calls } = authorizationHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(book.observe(identity(), controller.signal)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
    const held = book.observe(identity(), new AbortController().signal)
    expect(calls).toHaveLength(1)
    book.dispose()
    await held
    // A late transport settle after disposal changes nothing.
    calls[0].settle.resolve()
    await flush()
    expect(calls).toHaveLength(1)
    // After disposal, observe still resolves — never a new wire call.
    await expect(book.observe(identity(), new AbortController().signal)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})

const CONTENT: RemoteFilesReadContent = { kind: 'file', size: 3, complete: true, bytes: new Uint8Array([65, 66, 67]) }

interface ReadCall { readonly request: { relativePath: string }; readonly settle: PromiseWithResolvers<RemoteFilesReadContent>; readonly signal: AbortSignal }

function previewHarness() {
  const waits: WaitCall[] = []
  const authorization = new RemoteFilesAuthorizationBook({
    wait: vi.fn((request: unknown, signal: AbortSignal) => {
      const settle = Promise.withResolvers<void>()
      waits.push({ request, signal, settle })
      return settle.promise
    }),
  })
  const reads: ReadCall[] = []
  const client = {
    read: vi.fn((request: { relativePath: string }, signal: AbortSignal) => {
      const settle = Promise.withResolvers<RemoteFilesReadContent>()
      reads.push({ request, settle, signal })
      return settle.promise
    }),
  }
  let active: string | undefined = 's1'
  let sequence = 0
  const book = new RemotePreviewBook(
    client,
    authorization,
    () => active,
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  )
  return {
    book, waits, reads, authorization,
    setActive: (value: string | undefined) => { active = value },
  }
}

describe('the remote preview resource book', () => {
  it('dedupes the same logical tuple and isolates every axis, including a literal backslash path', () => {
    const { book } = previewHarness()
    const first = book.register(identity(), 'a.txt', 'dev')!
    expect(first).toMatch(/^dsh-resource:\/\/mrfw-remote\/[0-9a-f-]{36}$/)
    // Same tuple → the same address, never a second record.
    expect(book.register(identity(), 'a.txt', 'dev')).toBe(first)
    for (const changed of [
      identity({ sessionId: 's1' as SessionId, root: { kind: 'remote', environmentId: 'other', rootId: 'out' } }),
      identity({ root: { kind: 'remote', environmentId: 'dev', rootId: 'other' } }),
      identity({ incarnation: 'b'.repeat(64) }),
    ]) {
      expect(book.register(changed, 'a.txt', 'dev')).not.toBe(first)
    }
    expect(book.register(identity(), 'dir\\file.txt', 'dev')).not.toBe(first)
  })

  it('refuses a mismatched session, an invalid path and a foreign/malformed address with zero wire calls', () => {
    const { book, setActive, waits } = previewHarness()
    setActive('s2')
    expect(book.register(identity(), 'a.txt', 'dev')).toBeUndefined()
    setActive('s1')
    expect(book.register(identity(), '', 'dev')).toBeUndefined()
    // A restored address whose record is gone can never synthesize a lease.
    const ghost = 'dsh-resource://mrfw-remote/00000000-0000-4000-8000-ffffffffffff'
    expect(book.get(ghost, 's1')).toBeUndefined()
    expect(book.pin(ghost, new AbortController().signal)).toBeUndefined()
    expect(book.get('dsh-resource://mrfw-remote/NOT-A-UUID', 's1')).toBeUndefined()
    expect(book.get('dsh-resource://file/00000000-0000-4000-8000-ffffffffffff', 's1')).toBeUndefined()
    expect(waits).toHaveLength(0)
  })

  it('scopes records to their session and retires a record on its last pin release', () => {
    const { book } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    expect(book.get(address, 's2')).toBeUndefined()
    const record = book.get(address, 's1')!
    expect(record.label).toBe('dev')
    expect(record.relativePath).toBe('a.txt')
    const pinA = new AbortController()
    const pinB = new AbortController()
    expect(book.pin(address, pinA.signal)?.address).toBe(address)
    book.pin(address, pinB.signal)
    pinA.abort()
    expect(book.get(address, 's1')).toBeDefined()
    pinB.abort()
    expect(record.signal.aborted).toBe(true)
    expect(book.get(address, 's1')).toBeUndefined()
  })

  it('pinning one signal twice is idempotent — one lease, one release path', async () => {
    const { book, waits } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    const pin = new AbortController()
    expect(book.pin(address, pin.signal)?.address).toBe(address)
    expect(book.pin(address, pin.signal)?.address).toBe(address)
    await vi.waitFor(() => { expect(waits).toHaveLength(1) })
    pin.abort()
    expect(book.get(address, 's1')).toBeUndefined()
  })

  it('a retired record\'s late lease rejection never sweeps the re-registered record', async () => {
    const observeCalls: PromiseWithResolvers<void>[] = []
    // An extracted lease authorizer: observe promises settle only when the
    // test settles them, so the stale rejection lands deliberately late.
    const authorizer = {
      observe: vi.fn((_id: SshFilesIdentity, _signal: AbortSignal) => {
        const settle = Promise.withResolvers<void>()
        observeCalls.push(settle)
        return settle.promise
      }),
      dispose: vi.fn(),
    } as unknown as RemoteFilesAuthorizationBook
    let sequence = 0
    const book = new RemotePreviewBook(
      { read: vi.fn() },
      authorizer,
      () => 's1',
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    )
    const pin = new AbortController()
    const stale = book.register(identity(), 'a.txt', 'dev')!
    book.pin(stale, pin.signal)
    await vi.waitFor(() => { expect(observeCalls).toHaveLength(1) })
    pin.abort()
    expect(book.get(stale, 's1')).toBeUndefined()
    // Close + reopen under the same grant: the fresh record shares the key.
    const reopened = book.register(identity(), 'a.txt', 'dev')!
    expect(reopened).not.toBe(stale)
    book.pin(reopened, new AbortController().signal)
    // The OLD lease's delayed rejection must not touch the new record.
    observeCalls[0].reject(new RemoteFilesError('binding-changed'))
    await flush()
    expect(book.get(reopened, 's1')).toBeDefined()
    expect(book.get(reopened, 's1')!.signal.aborted).toBe(false)
    observeCalls[1].resolve()
    book.dispose()
  })

  it('installs the shared lease on the first pin and invalidates same-grant records on its failure', async () => {
    const { book, waits } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    await vi.waitFor(() => { expect(waits).toHaveLength(1) })
    // A re-grant's record shares no providerKey — it survives the failure.
    const renewed = book.register(identity({ incarnation: 'b'.repeat(64) }), 'a.txt', 'dev')!
    book.pin(renewed, new AbortController().signal)
    waits[0].settle.reject(new RemoteFilesError('binding-changed'))
    await vi.waitFor(() => { expect(book.get(address, 's1')).toBeUndefined() })
    expect(book.get(renewed, 's1')).toBeDefined()
    expect(waits).toHaveLength(2)
  })

  it('mount and get require the ACTIVE session — a parked session throws before the view quota', () => {
    const { book, setActive } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const owner = new AbortController()
    const views = Array.from({ length: REMOTE_FILE_PREVIEW_LIMITS.clientContentViews }, () =>
      book.mount(address, 's1', owner.signal))
    setActive('s2')
    // The session check runs before the quota: a parked-session mount says
    // the record is unreachable, never 'resource-budget'.
    expect(() => book.mount(address, 's1', owner.signal)).toThrowError(expect.objectContaining({ code: 'root-unregistered' }) as Error)
    expect(book.get(address, 's1')).toBeUndefined()
    setActive('s1')
    for (const view of views) view.release()
  })

  it('requires a pinned live record and a live owner for mount; caps views and in-flight reads', async () => {
    const { book, reads } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    const owner = new AbortController()
    // Never pinned → mount refuses, coded.
    expect(() => book.mount(address, 's1', owner.signal)).toThrowError(expect.objectContaining({ code: 'root-unregistered' }) as Error)
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', owner.signal)
    // Both read slots occupied by uncooperative reads: a third is refused.
    const occupants = [
      view.read(new AbortController().signal).then(() => 'done' as const, (error: RemoteFilesError) => error.code),
      view.read(new AbortController().signal).then(() => 'done' as const, (error: RemoteFilesError) => error.code),
    ]
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    const second = book.register(identity(), 'b.txt', 'dev')!
    book.pin(second, new AbortController().signal)
    const view2 = book.mount(second, 's1', owner.signal)
    await expect(view2.read(new AbortController().signal)).rejects.toMatchObject({ code: 'resource-budget' })
    // Four content views is the cap; the fifth reservation is refused.
    const views = [view, view2, book.mount(address, 's1', owner.signal), book.mount(second, 's1', owner.signal)]
    expect(() => book.mount(address, 's1', owner.signal)).toThrowError(expect.objectContaining({ code: 'resource-budget' }) as Error)
    for (const entry of reads.splice(0)) entry.settle.resolve(CONTENT)
    await Promise.all(occupants)
    for (const v of views) v.release()
  })

  it('fences stale reads: only the latest call on one view may resolve', async () => {
    const { book, reads } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', new AbortController().signal)
    const first = view.read(new AbortController().signal)
    const second = view.read(new AbortController().signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    // The superseded read's own wire answer can still arrive — its caller
    // is fenced to cancelled while the latest resolves with bytes.
    reads[0].settle.resolve(CONTENT)
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    reads[1].settle.resolve(CONTENT)
    await expect(second).resolves.toEqual(CONTENT)
  })

  it('an aborted caller holding an uncooperative wire read keeps its slot until the RPC settles', async () => {
    const { book, reads } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', new AbortController().signal)
    const callerA = new AbortController()
    const pendingA = view.read(callerA.signal)
    const callerB = new AbortController()
    const pendingB = view.read(callerB.signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    callerA.abort()
    await flush()
    // The fake transport ignores abort: the aborted read's caller stays
    // pending AND keeps its slot until the RPC itself settles.
    let settledA = false
    void pendingA.then(() => { settledA = true }, () => { settledA = true })
    await flush()
    expect(settledA).toBe(false)
    await expect(view.read(new AbortController().signal)).rejects.toMatchObject({ code: 'resource-budget' })
    reads[0].settle.resolve(CONTENT)
    reads[1].settle.resolve(CONTENT)
    await expect(pendingA).rejects.toMatchObject({ code: 'cancelled' })
    // B was superseded by the budget-refused read's fence — its caller
    // settles cancelled once the wire answers, then a slot is free again.
    await expect(pendingB).rejects.toMatchObject({ code: 'cancelled' })
    const fresh = view.read(new AbortController().signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(3) })
    reads[2].settle.resolve(CONTENT)
    await expect(fresh).resolves.toEqual(CONTENT)
  })

  it('a grant-level read failure retires only that grant; a re-granted record and file-local failures survive', async () => {
    const { book, reads } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', new AbortController().signal)
    const pending = view.read(new AbortController().signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(1) })
    // A file-local failure is a read outcome, never a registry eviction.
    reads[0].settle.reject(new RemoteFilesError('file-too-large'))
    await expect(pending).rejects.toMatchObject({ code: 'file-too-large' })
    expect(book.get(address, 's1')).toBeDefined()
    // A grant-level failure retires exactly this providerKey's records.
    const renewed = book.register(identity({ incarnation: 'b'.repeat(64) }), 'a.txt', 'dev')!
    book.pin(renewed, new AbortController().signal)
    const dying = view.read(new AbortController().signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    reads[1].settle.reject(new RemoteFilesError('binding-changed'))
    await expect(dying).rejects.toMatchObject({ code: 'binding-changed' })
    expect(book.get(address, 's1')).toBeUndefined()
    expect(book.get(renewed, 's1')).toBeDefined()
  })

  it('stopSession aborts that session\'s views only; a switch back needs a fresh read with no cached content', async () => {
    const { book, reads, setActive } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', new AbortController().signal)
    setActive('s2')
    const other = identity({ sessionId: 's2' as SessionId })
    const address2 = book.register(other, 'a.txt', 'other-env')!
    book.pin(address2, new AbortController().signal)
    const view2 = book.mount(address2, 's2', new AbortController().signal)
    setActive('s1')
    book.stopSession('s1')
    expect(view.signal.aborted).toBe(true)
    expect(view2.signal.aborted).toBe(false)
    expect(book.get(address, 's1')).toBeDefined()
    // Session moved away: an in-flight read settles as cancelled, and the
    // return trip issues a NEW wire call — nothing is cached.
    const switched = book.mount(address, 's1', new AbortController().signal)
    setActive('s2')
    const pending = switched.read(new AbortController().signal)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    setActive('s1')
    const fresh = switched.read(new AbortController().signal)
    await vi.waitFor(() => { expect(reads).toHaveLength(1) })
    reads[0].settle.resolve(CONTENT)
    await expect(fresh).resolves.toEqual(CONTENT)
  })

  it('dispose retires every record and view; no pin or read replays afterwards', async () => {
    const { book, reads } = previewHarness()
    const address = book.register(identity(), 'a.txt', 'dev')!
    book.pin(address, new AbortController().signal)
    const view = book.mount(address, 's1', new AbortController().signal)
    book.dispose()
    expect(view.signal.aborted).toBe(true)
    expect(book.get(address, 's1')).toBeUndefined()
    expect(book.pin(address, new AbortController().signal)).toBeUndefined()
    expect(book.register(identity(), 'a.txt', 'dev')).toBeUndefined()
    expect(reads).toHaveLength(0)
  })

  it('the record cap is enforced and a colliding mint fails loudly with no silent replacement', () => {
    const { book } = previewHarness()
    const addresses = Array.from({ length: REMOTE_FILE_PREVIEW_LIMITS.clientResources }, (_, index) =>
      book.register(identity(), `file-${index}.txt`, 'dev')!)
    for (const address of addresses) expect(address).toBeDefined()
    expect(() => book.register(identity(), 'one-too-many.txt', 'dev')).toThrowError(expect.objectContaining({ code: 'resource-budget' }))
    const colliding = new RemotePreviewBook(
      { read: vi.fn() }, new RemoteFilesAuthorizationBook({ wait: vi.fn() }),
      () => 's1', () => '00000000-0000-4000-8000-000000000001',
    )
    expect(colliding.register(identity(), 'a.txt', 'dev')).toBeDefined()
    expect(() => colliding.register(identity(), 'b.txt', 'dev')).toThrow()
    const badMint = new RemotePreviewBook(
      { read: vi.fn() }, new RemoteFilesAuthorizationBook({ wait: vi.fn() }),
      () => 's1', () => 'not-a-uuid',
    )
    expect(() => badMint.register(identity(), 'a.txt', 'dev')).toThrow()
  })

  it('stages a replacement at capacity and keeps the old view live if routing fails', () => {
    const { book } = previewHarness()
    const addresses = Array.from({ length: REMOTE_FILE_PREVIEW_LIMITS.clientResources }, (_, index) =>
      book.register(identity(), `file-${index}.txt`, 'dev')!)
    const outgoing = addresses[0]!
    const oldPin = new AbortController()
    book.pin(outgoing, oldPin.signal)
    const oldView = book.mount(outgoing, 's1', new AbortController().signal)
    const committed = vi.fn(() => false)
    const replacement = { address: outgoing, committed }
    const failed = book.register(identity(), 'failed.txt', 'dev', replacement)!
    expect(book.get(failed, 's1')?.relativePath).toBe('failed.txt')
    expect(book.pin(failed, new AbortController().signal)).toBeUndefined()
    expect(() => book.register(identity(), 'parallel.txt', 'dev', replacement)).toThrowError(expect.objectContaining({ code: 'resource-budget' }))
    book.forgetUnpinned(failed)
    expect(book.get(failed, 's1')).toBeUndefined()
    expect(oldView.signal.aborted).toBe(false)
    expect(book.get(outgoing, 's1')).toBeDefined()

    const incoming = book.register(identity(), 'replacement.txt', 'dev', replacement)!
    committed.mockReturnValue(true)
    const newPin = new AbortController()
    expect(book.pin(incoming, newPin.signal)?.relativePath).toBe('replacement.txt')
    expect(committed).toHaveBeenLastCalledWith(incoming)
    expect(oldView.signal.aborted).toBe(true)
    expect(book.get(outgoing, 's1')).toBeUndefined()
    oldPin.abort()
    expect(book.get(incoming, 's1')).toBeDefined()
    expect(() => book.register(identity(), 'one-too-many.txt', 'dev')).toThrowError(expect.objectContaining({ code: 'resource-budget' }))
    expect(book.register(identity(), 'file-1.txt', 'dev')).toBe(addresses[1])
    book.dispose()
  })
})
