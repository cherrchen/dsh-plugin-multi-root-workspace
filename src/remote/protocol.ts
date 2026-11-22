/**
 * `remote-2`: the remote control plane's bounded requests on a SECOND,
 * derived endpoint (`<store>.r1.sock`) over the same kernel-attested native
 * transport. The v1 protocol is byte-identical on the wire; a released old
 * owner destroys the channel on unknown methods, so the remote entry can
 * never ride the v1 socket — an old owner simply has no `.r1.sock` listener,
 * and a follower reports `owner-without-remote-protocol`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Channel } from '../authority/native.ts'
import { connectNative, listenNative, type Listener } from '../authority/native.ts'
import { AuthorityRpcError, receive, send } from '../authority/protocol.ts'

const MAX_PENDING = 32
const PROTOCOL = 'remote-2'
export const REMOTE_MUTATION_BUDGET_MS = 45_000
export const remoteMethods = ['hello', 'remote-snapshot', 'remote-add', 'remote-remove', 'remote-admit', 'remote-withhold'] as const
export type RemoteMethod = typeof remoteMethods[number]
/**
 * Per-method request budgets: mutations wait out the owner's endpoint
 * verification (~30 s probe budget) while reads and admissions stay tight.
 * `hello` is the handshake — a missed reply still destroys the channel.
 */
export type RemoteRequestTimeouts = Partial<Record<RemoteMethod, number>>
const DEFAULT_REQUEST_TIMEOUTS: Record<RemoteMethod, number> = {
  hello: 5_000,
  'remote-snapshot': 5_000,
  'remote-admit': 5_000,
  'remote-add': 60_000,
  'remote-remove': 60_000,
  'remote-withhold': 5_000,
}
const requestSchema = z.object({
  protocol: z.string(), domain: z.string(), store: z.string(),
  id: z.string().uuid(), epoch: z.string().nullable(), manifestDigest: z.string().optional(), method: z.enum(remoteMethods), expiresAt: z.number().int().positive().safe().optional(), args: z.array(z.unknown()).max(4),
}).strict()
const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('change') }).strict(),
  z.object({ type: z.literal('reply'), id: z.string().uuid(), value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: z.string().uuid(), code: z.string(), message: z.string() }).strict(),
])
const helloReplySchema = z.object({
  protocol: z.literal(PROTOCOL), domain: z.literal('remote'), store: z.string(), epoch: z.string(), manifestDigest: z.string(),
}).strict()

export class RemoteClient {
  private readonly pending = new Map<string, { method: RemoteMethod; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly timeouts: Record<RemoteMethod, number>
  private closed = false
  epoch: string | undefined
  private constructor(private readonly channel: Channel, private readonly store: string, disconnected: () => void, timeouts: RemoteRequestTimeouts = {}, changed: () => void = () => {}) {
    this.timeouts = { ...DEFAULT_REQUEST_TIMEOUTS, ...timeouts }
    channel.on('close', () => {
      if (this.closed) return
      this.closed = true
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new AuthorityRpcError('authority-disconnected', 'remote request result is unknown; resynchronize before another mutation')) }
      this.pending.clear(); disconnected()
    })
    channel.on('error', () => channel.destroy())
    receive(channel, value => {
      const reply = replySchema.parse(value)
      if (reply.type === 'change') { changed(); return }
      const request = this.pending.get(reply.id)
      if (!request) return
      if (reply.type === 'reply' && request.method === 'hello') {
        const hello = helloReplySchema.parse(reply.value)
        if (hello.store !== store) throw new Error('remote store mismatch')
        this.epoch = hello.epoch
      }
      this.pending.delete(reply.id); clearTimeout(request.timer)
      if (reply.type === 'reply') request.resolve(reply.value)
      else request.reject(new AuthorityRpcError(reply.code, reply.message))
    })
  }
  static async connect(endpoint: string, store: string, manifestDigest: string, disconnected: () => void, timeouts: RemoteRequestTimeouts = {}, changed: () => void = () => {}) {
    const channel = await connectNative(endpoint)
    const client = new RemoteClient(channel, store, disconnected, timeouts, changed)
    try {
      const hello = helloReplySchema.parse(await client.request('hello', [manifestDigest]))
      if (hello.store !== store || hello.manifestDigest !== manifestDigest) throw new AuthorityRpcError('config-digest-mismatch', 'remote manifest digest mismatch')
      client.epoch = hello.epoch
      return client
    } catch (error) { client.close(); throw error }
  }
  request(method: RemoteMethod, args: readonly unknown[], manifestDigest?: string): Promise<unknown> {
    if (this.closed || this.pending.size >= MAX_PENDING) return Promise.reject(new AuthorityRpcError('authority-unavailable', 'remote connection is unavailable or busy'))
    const id = randomUUID()
    const expiresAt = Date.now() + this.timeouts[method]
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only the handshake keeps the destroy-on-timeout rule — its pending
        // entry stays, so 'close' still rejects it. Every other timed-out
        // request fails alone: the pending entry is gone, a late reply is
        // ignored, and the channel stays usable for what follows.
        if (method === 'hello') { this.channel.destroy(); return }
        if (!this.pending.delete(id)) return
        reject(new AuthorityRpcError('authority-timeout', 'remote request result is unknown; resynchronize before another mutation'))
      }, this.timeouts[method])
      this.pending.set(id, { method, resolve, reject, timer })
      send(this.channel, { protocol: PROTOCOL, domain: 'remote', store: this.store, epoch: this.epoch ?? null, id, method, args, manifestDigest, expiresAt })
    })
  }
  close() { this.channel.destroy() }
}

export class RemoteServer {
  private listener: Listener | undefined
  private readonly peers = new Set<Channel>()
  private readonly readyPeers = new Set<Channel>()
  private closed = false
  private inFlight = 0
  private constructor(
    private readonly store: string, private readonly epoch: string, private readonly manifestDigest: string | (() => string | undefined),
    private readonly dispatch: (method: RemoteMethod, args: unknown[], manifestDigest?: string, signal?: AbortSignal) => Promise<unknown>,
  ) {}
  static async listen(endpoint: string, options: { store: string; epoch: string; manifestDigest: string | (() => string | undefined) }, dispatch: (method: RemoteMethod, args: unknown[], manifestDigest?: string, signal?: AbortSignal) => Promise<unknown>) {
    const server = new RemoteServer(options.store, options.epoch, options.manifestDigest, dispatch)
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
    const peer = new AbortController()
    channel.on('close', () => { peer.abort(); clearTimeout(timer); this.peers.delete(channel); this.readyPeers.delete(channel) })
    channel.on('error', () => channel.destroy())
    receive(channel, value => {
      const request = requestSchema.parse(value)
      if (request.protocol !== PROTOCOL) {
        send(channel, { type: 'error', id: request.id, code: 'remote-protocol-mismatch', message: 'restart the Registry owner and follower with the same plugin release' })
        return
      }
      if (request.domain !== 'remote') {
        send(channel, { type: 'error', id: request.id, code: 'unknown-domain', message: 'this endpoint only serves the remote domain' }); return
      }
      if (request.store !== this.store || pending >= MAX_PENDING) throw new Error('remote peer violated protocol')
      if (request.method === 'hello') {
        if (ready || request.epoch !== null) throw new Error('remote handshake mismatch')
        const digest = typeof this.manifestDigest === 'function' ? this.manifestDigest() : this.manifestDigest
        if (digest === undefined || request.args[0] !== digest) {
          send(channel, { type: 'error', id: request.id, code: 'config-digest-mismatch', message: 'remote manifest digest mismatch' }); return
        }
        ready = true; this.readyPeers.add(channel); clearTimeout(timer)
        send(channel, { type: 'reply', id: request.id, value: { protocol: PROTOCOL, domain: 'remote', store: this.store, epoch: this.epoch, manifestDigest: digest } }); return
      }
      if (!ready || request.epoch !== this.epoch) throw new Error('remote epoch mismatch')
      if (this.inFlight >= MAX_PENDING) {
        send(channel, { type: 'error', id: request.id, code: 'authority-busy', message: 'remote registry is busy; request was not submitted' }); return
      }
      const mutation = request.method === 'remote-add' || request.method === 'remote-remove' || request.method === 'remote-withhold'
      if (mutation && !seen.has(request.id) && seen.size >= 2048) { channel.destroy(); return }
      const fingerprint = createHash('sha256').update(JSON.stringify([request.method, request.manifestDigest, request.args])).digest('hex')
      const entry = seen.get(request.id)
      if (entry && entry.fingerprint !== fingerprint) throw new Error('remote request ID reused with different arguments')
      pending++; this.inFlight++
      const budget = Math.max(0, Math.min(REMOTE_MUTATION_BUDGET_MS, (request.expiresAt ?? Infinity) - Date.now()))
      const signal = mutation ? AbortSignal.any([peer.signal, budget === 0 ? AbortSignal.abort() : AbortSignal.timeout(budget)]) : undefined
      const run = entry
        ? entry.outcome.then(outcome => {
            if (!outcome.ok) throw new AuthorityRpcError(outcome.code, outcome.message)
            return this.dispatch('remote-snapshot', [request.args[0]], request.manifestDigest)
          })
        : this.dispatch(request.method, request.args, request.manifestDigest, signal)
      if (mutation && !entry) seen.set(request.id, { fingerprint, outcome: run.then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, code: String(error?.code ?? 'remote-error').slice(0, 120), message: String(error?.message ?? error).slice(0, 4096) }),
      ) })
      void run.then(result => send(channel, { type: 'reply', id: request.id, value: result }), error => send(channel, {
        type: 'error', id: request.id, code: String(error?.code ?? 'remote-error'), message: String(error?.message ?? error),
      })).finally(() => { pending--; this.inFlight-- })
    })
  }
  changed() {
    for (const peer of this.readyPeers) send(peer, { type: 'change' })
  }

  close() {
    if (this.closed) return
    this.closed = true; this.listener?.close()
    for (const peer of this.peers) peer.destroy()
    this.peers.clear()
  }
}

const grantSchema = z.object({
  environmentId: z.string(), rootId: z.string(), displayPath: z.string(),
  verifiedTarget: z.object({ kind: z.enum(['object', 'path']), value: z.string() }).strict(),
  configVersion: z.string(), bindingDigest: z.string(), addedAt: z.string(), grantId: z.uuid().optional(),
}).strict()
export const remoteSnapshotSchema = z.object({
  epoch: z.string(), revision: z.number().int().nonnegative().safe(), primary: z.string(), manifestDigest: z.string(),
  grants: z.array(grantSchema.extend({ state: z.enum(['registered', 'withheld', 'revoked']) }).strict()),
}).strict()
export const remoteAdmitSchema = z.object({
  decision: z.literal('admit'), epoch: z.string(), authorizationFingerprint: z.string().regex(/^[0-9a-f]{64}$/), primary: z.string(),
  endpoints: z.array(z.object({
    environmentId: z.string(), rootId: z.string(), displayPath: z.string(),
    verifiedTarget: z.object({ kind: z.enum(['object', 'path']), value: z.string() }).strict().nullable(),
    bindingDigest: z.string().nullable(), environmentDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(), configVersion: z.string().nullable(),
    incarnation: z.string().optional(),
    localRoot: z.object({
      incarnation: z.string(), rootId: z.string(), path: z.string(), access: z.enum(['primary', 'inherit', 'read-only', 'read-write']),
    }).strict().nullable(),
  }).strict()),
}).strict()

const refSchema = z.object({ environmentId: z.string().min(1), rootId: z.string().min(1) }).strict()
const remoteArgumentSchemas = {
  hello: z.tuple([z.string()]),
  'remote-snapshot': z.tuple([z.string().min(1)]),
  'remote-add': z.tuple([z.string().min(1), refSchema]),
  'remote-remove': z.tuple([z.string().min(1), refSchema]),
  'remote-withhold': z.tuple([z.string().min(1), refSchema, z.string().min(1).max(128)]),
  'remote-admit': z.tuple([z.string().min(1), z.object({
    purpose: z.enum(['read', 'write', 'exec', 'transfer']),
    endpoints: z.array(refSchema).min(1).max(2),
    manifestDigest: z.string().min(1),
  }).strict()]),
}
export function parseRemoteArguments(method: RemoteMethod, args: unknown[]): unknown[] {
  try {
    return remoteArgumentSchemas[method].parse(args)
  } catch (error) {
    throw new AuthorityRpcError('invalid-arguments', `invalid remote arguments: ${error instanceof Error ? error.message : String(error)}`)
  }
}
