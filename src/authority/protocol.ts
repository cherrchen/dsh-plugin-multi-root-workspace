/** Bounded, versioned requests on an already kernel-attested connection. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Channel } from './native.ts'
import { connectNative, listenNative, type Listener } from './native.ts'

const MAX_FRAME = 1024 * 1024, MAX_PENDING = 32
const helloSchema = z.object({ protocol: z.literal(1), store: z.string(), epoch: z.string(), limit: z.number().int() }).strict()
const methods = ['hello', 'snapshot', 'admit', 'add', 'removeAt', 'setAccess', 'setAlias', 'setSkillsEnabled', 'setAliasId', 'move', 'recheck'] as const
export type Method = typeof methods[number]
const requestSchema = z.object({ protocol: z.literal(1), store: z.string(), id: z.string().uuid(), epoch: z.string().nullable(), method: z.enum(methods), args: z.array(z.unknown()).max(4) }).strict()
const rootSchema = z.object({
  id: z.string(), path: z.string(), access: z.enum(['inherit', 'read-only', 'read-write']), addedAt: z.string(),
  recordedPath: z.string().optional(), readOnlyRecordedPath: z.string().optional(), readWriteRecordedPath: z.string().optional(),
  alias: z.string().optional(), aliasId: z.unknown().optional(), skillsEnabled: z.unknown().optional(),
  state: z.enum(['available', 'missing', 'redirected', 'invalid']), detail: z.string().optional(), invalidReason: z.literal('membership-conflict').optional(),
}).strict()
export const snapshotSchema = z.object({
  protocol: z.literal(1), store: z.string(), epoch: z.string(), revision: z.number().int().nonnegative().safe(),
  primary: z.string(), roots: z.array(rootSchema).max(4096), available: z.boolean(),
}).strict()
export type Snapshot = z.infer<typeof snapshotSchema>
const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reply'), id: z.string().uuid(), value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: z.string().uuid(), code: z.string(), message: z.string() }).strict(),
  z.object({ type: z.literal('change'), value: snapshotSchema }).strict(),
])
export class AuthorityRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
function receive(channel: Channel, body: (value: unknown) => void) {
  let data = Buffer.alloc(0)
  channel.on('data', (chunk: Buffer) => {
    try {
      if (data.length + chunk.length > MAX_FRAME) throw new Error('registry IPC frame exceeds budget')
      data = Buffer.concat([data, chunk])
      for (;;) {
        const end = data.indexOf(10)
        if (end < 0) break
        const line = data.subarray(0, end); data = data.subarray(end + 1)
        body(JSON.parse(line.toString('utf8')))
      }
    } catch { channel.destroy() }
  })
}
function send(channel: Channel, value: unknown) {
  const text = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(text) + (channel.writableLength ?? 0) > MAX_FRAME) { channel.destroy(); return false }
  channel.write(text)
  return true
}
export class AuthorityClient {
  private readonly pending = new Map<string, { method: Method; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  epoch: string | undefined
  private constructor(private readonly channel: Channel, private readonly store: string, private readonly limit: number, onChange: (snapshot: Snapshot) => void, disconnected: () => void) {
    channel.on('close', () => {
      if (this.closed) return
      this.closed = true
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new AuthorityRpcError('authority-disconnected', 'registry request result is unknown; resynchronize before another mutation')) }
      this.pending.clear(); disconnected()
    })
    channel.on('error', () => channel.destroy())
    receive(channel, value => {
      const reply = replySchema.parse(value)
      if (reply.type === 'change') { if (reply.value.store !== store || reply.value.epoch !== this.epoch) throw new Error('wrong registry epoch'); onChange(reply.value); return }
      const request = this.pending.get(reply.id)
      if (!request) return
      if (reply.type === 'reply' && request.method === 'hello') {
        // A change may share the same read buffer as hello. Set identity here,
        // before resolving the Promise, rather than one microtask later.
        const hello = helloSchema.parse(reply.value)
        if (hello.store !== store || hello.limit !== this.limit) throw new Error('registry configuration mismatch')
        this.epoch = hello.epoch
      }
      this.pending.delete(reply.id); clearTimeout(request.timer)
      if (reply.type === 'reply') request.resolve(reply.value)
      else request.reject(new AuthorityRpcError(reply.code, reply.message))
    })
  }
  static async connect(endpoint: string, store: string, limit: number, onChange: (snapshot: Snapshot) => void, disconnected: () => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new AuthorityRpcError('authority-cancelled', 'registry handshake was cancelled')
    const channel = await connectNative(endpoint)
    if (signal?.aborted) { channel.destroy(); throw new AuthorityRpcError('authority-cancelled', 'registry handshake was cancelled') }
    const client = new AuthorityClient(channel, store, limit, onChange, disconnected)
    const onAbort = () => client.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const hello = helloSchema.parse(await client.request('hello', [limit]))
      if (hello.store !== store || hello.limit !== limit) throw new Error('registry configuration mismatch')
      client.epoch = hello.epoch
      return client
    } catch (error) {
      client.close()
      if (signal?.aborted) throw new AuthorityRpcError('authority-cancelled', 'registry handshake was cancelled')
      throw error
    } finally { signal?.removeEventListener('abort', onAbort) }
  }
  request(method: Method, args: readonly unknown[]): Promise<unknown> {
    if (this.closed || this.pending.size >= MAX_PENDING) return Promise.reject(new AuthorityRpcError('authority-unavailable', 'registry connection is unavailable or busy'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.channel.destroy() }, 5000)
      // Deliberately referenced: the Windows pipe polls on an unref'd interval,
      // so this timer is what keeps a pending request alive there. Cancel and
      // close clear it synchronously; a missed cancel is bounded by 5s.
      this.pending.set(id, { method, resolve, reject, timer })
      send(this.channel, { protocol: 1, store: this.store, epoch: this.epoch ?? null, id, method, args })
    })
  }
  close() { this.channel.destroy() }
}
export class AuthorityServer {
  private listener: Listener | undefined
  private readonly peers = new Set<Channel>()
  private readonly readyPeers = new Set<Channel>()
  private closed = false
  private inFlight = 0
  private constructor(private readonly store: string, private readonly epoch: string, private readonly limit: number, private readonly dispatch: (method: Method, args: unknown[]) => Promise<unknown>) {}
  static async listen(endpoint: string, store: string, epoch: string, limit: number, dispatch: (method: Method, args: unknown[]) => Promise<unknown>) {
    const server = new AuthorityServer(store, epoch, limit, dispatch)
    server.listener = await listenNative(endpoint, channel => server.accept(channel))
    return server
  }
  private accept(channel: Channel) {
    if (this.closed || this.peers.size >= 32) { channel.destroy(); return }
    this.peers.add(channel)
    let ready = false, pending = 0
    const seen = new Map<string, { fingerprint: string; outcome: Promise<{ ok: true } | { ok: false; code: string; message: string }> }>()
    const timer = setTimeout(() => { if (!ready) channel.destroy() }, 5000)
    timer.unref()
    channel.on('close', () => { clearTimeout(timer); this.peers.delete(channel); this.readyPeers.delete(channel) })
    channel.on('error', () => channel.destroy())
    receive(channel, value => {
      const request = requestSchema.parse(value)
      if (request.store !== this.store || pending >= MAX_PENDING) throw new Error('registry peer violated protocol')
      if (request.method === 'hello') {
        if (ready || request.epoch !== null || request.args[0] !== this.limit) throw new Error('registry handshake mismatch')
        ready = true; this.readyPeers.add(channel); clearTimeout(timer)
        send(channel, { type: 'reply', id: request.id, value: { protocol: 1, store: this.store, epoch: this.epoch, limit: this.limit } }); return
      }
      if (!ready || request.epoch !== this.epoch) throw new Error('registry epoch mismatch')
      if (this.inFlight >= MAX_PENDING) {
        send(channel, { type: 'error', id: request.id, code: 'authority-busy', message: 'registry is busy; request was not submitted' }); return
      }
      const mutation = request.method !== 'snapshot' && request.method !== 'admit'
      if (mutation && !seen.has(request.id) && seen.size >= 2048) { channel.destroy(); return }
      const fingerprint = createHash('sha256').update(JSON.stringify([request.method, request.args])).digest('hex')
      const entry = seen.get(request.id)
      if (entry && entry.fingerprint !== fingerprint) throw new Error('registry request ID reused with different arguments')
      pending++; this.inFlight++
      // Retain only the compact mutation outcome, never thousands of full root
      // snapshots. A duplicate observes a fresh view without repeating the write.
      const run = entry
        ? entry.outcome.then(outcome => {
            if (!outcome.ok) throw new AuthorityRpcError(outcome.code, outcome.message)
            return this.dispatch('snapshot', [request.args[0]])
          })
        : this.dispatch(request.method, request.args)
      if (mutation && !entry) seen.set(request.id, { fingerprint, outcome: run.then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, code: String(error?.code ?? 'registry-error').slice(0, 120), message: String(error?.message ?? error).slice(0, 4096) }),
      ) })
      void run.then(result => send(channel, { type: 'reply', id: request.id, value: result }), error => send(channel, {
        type: 'error', id: request.id, code: String(error?.code ?? 'registry-error'), message: String(error?.message ?? error),
      })).finally(() => { pending--; this.inFlight-- })
    })
  }
  changed(snapshot: Snapshot) {
    if (this.closed) return
    for (const peer of this.readyPeers) send(peer, { type: 'change', value: snapshot })
  }
  close() {
    if (this.closed) return
    this.closed = true; this.listener?.close()
    for (const peer of this.peers) peer.destroy()
    this.peers.clear()
  }
}

const ref = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), id: z.string() }).strict(),
  z.object({ kind: z.literal('path'), path: z.string() }).strict(),
  z.object({ kind: z.literal('ordinal'), ordinal: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('entry'), ordinal: z.number().int().positive(), id: z.string(), path: z.string(), addedAt: z.string() }).strict(),
])
const primary = z.string().min(1)
const argumentSchemas = {
  hello: z.tuple([z.number().int()]), snapshot: z.tuple([primary]), admit: z.tuple([primary]), recheck: z.tuple([primary]),
  add: z.tuple([primary, z.object({ path: z.string(), alias: z.string().optional(), access: z.enum(['inherit', 'read-only', 'read-write']).optional() }).strict()]),
  removeAt: z.tuple([primary, ref]), setAccess: z.tuple([primary, ref, z.enum(['inherit', 'read-only', 'read-write'])]),
  setAlias: z.tuple([primary, ref, z.string().nullable()]), setSkillsEnabled: z.tuple([primary, ref, z.boolean()]),
  setAliasId: z.tuple([primary, ref, z.string()]), move: z.tuple([primary, ref, ref.nullable()]),
}
export function parseArguments(method: Method, args: unknown[]): unknown[] { return argumentSchemas[method].parse(args) }
