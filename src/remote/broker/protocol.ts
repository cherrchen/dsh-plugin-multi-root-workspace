/**
 * The credential broker's local wire contract (ADR-0036).
 *
 * One JSON object per line over the kernel-attested Unix socket; the broker
 * sends `hello` first and then answers requests and streams process output as
 * events. Binary payloads (SFTP data, stdout/stderr) are base64 with a hard
 * per-message budget, so a client can never make the broker buffer an
 * unbounded amount. Unknown methods, unknown fields, out-of-range values and
 * oversized lines are refused — the caller is a local Host, but the broker
 * still treats every byte as untrusted input.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-broker/protocol
 */
import { z } from 'zod'
import type { Channel } from '../../authority/native.ts'

/** The only protocol this broker speaks. */
export const BROKER_PROTOCOL = 2
/** One line, including the newline, must fit this budget. */
export const MAX_LINE = 2 * 1024 * 1024
/** One binary field (SFTP data, stdout/stderr chunk) must fit this budget. */
export const MAX_DATA = 256 * 1024
/** A command keeps room for bytes beyond the declared result limit to detect truncation. */
export const MAX_COMMAND_OUTPUT = MAX_DATA / 2
/** Concurrent requests one connection may have in flight. */
export const MAX_IN_FLIGHT = 32
/** Concurrent child processes one connection may own. */
export const MAX_PROCESSES = 8

/** The methods the broker exposes; there is deliberately no key/config method. */
export const METHODS = ['openSftp', 'sftp', 'open', 'confine', 'spawn', 'wait', 'terminate', 'dispose'] as const
export type BrokerMethod = typeof METHODS[number]

const base64 = z.string().max(Math.ceil(MAX_DATA / 3) * 4 + 4)
const environmentId = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
const policy = z.object({
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  workspaceRoot: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(256),
}).strict()
const argv = z.array(z.string().max(4096)).min(1).max(64)
const outputLimit = z.number().int().nonnegative().max(MAX_DATA)

const sftpParams = z.discriminatedUnion('op', [
  z.object({ environmentId, op: z.literal('realpath'), path: z.string().max(4096) }).strict(),
  z.object({ environmentId, op: z.literal('lstat'), path: z.string().max(4096) }).strict(),
  z.object({ environmentId, op: z.literal('open'), path: z.string().max(4096), flags: z.number().int().nonnegative(), permissions: z.number().int().nonnegative().optional() }).strict(),
  z.object({ environmentId, op: z.literal('read'), handle: base64, offset: z.number().int().nonnegative(), length: z.number().int().positive().max(MAX_DATA) }).strict(),
  z.object({ environmentId, op: z.literal('write'), handle: base64, offset: z.number().int().nonnegative(), data: base64 }).strict(),
  z.object({ environmentId, op: z.literal('close'), handle: base64 }).strict(),
  z.object({ environmentId, op: z.literal('remove'), path: z.string().max(4096) }).strict(),
  z.object({ environmentId, op: z.literal('hardlink'), oldPath: z.string().max(4096), newPath: z.string().max(4096) }).strict(),
  z.object({ environmentId, op: z.literal('fsync'), handle: base64 }).strict(),
  z.object({ environmentId, op: z.literal('dispose') }).strict(),
])

const paramsByMethod = {
  openSftp: z.object({ environmentId }).strict(),
  sftp: sftpParams,
  open: z.object({ environmentId }).strict(),
  confine: z.object({ environmentId, argv, policy }).strict(),
  spawn: z.object({
    environmentId,
    argv,
    cwd: z.string().min(1).max(4096),
    env: z.record(z.string().max(256), z.string().max(8192)).refine(value => Object.keys(value).length <= 64, 'too many environment entries'),
    stdoutLimit: outputLimit,
    stderrLimit: outputLimit,
    graceMs: z.number().int().nonnegative().max(60_000),
    generation: z.string().min(1).max(128),
  }).strict(),
  wait: z.object({ process: z.number().int().positive(), timeoutMs: z.number().int().nonnegative().max(60_000) }).strict(),
  terminate: z.object({ process: z.number().int().positive() }).strict(),
  dispose: z.object({ environmentId }).strict(),
} as const

const requestSchema = z.object({ protocol: z.literal(BROKER_PROTOCOL), id: z.number().int().positive(), method: z.enum(METHODS), params: z.unknown() }).strict()
const replySchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), code: z.string().min(1).max(128), message: z.string().max(4096) }).strict(),
])
const eventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('hello'), protocol: z.literal(BROKER_PROTOCOL), brokerUid: z.number().int(),
    environmentIds: z.array(environmentId).max(256), manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({ event: z.enum(['stdout', 'stderr']), process: z.number().int().positive(), data: base64 }).strict(),
  z.object({
    event: z.literal('exit'), process: z.number().int().positive(),
    exitCode: z.number().int().nullable(), signal: z.string().max(64).nullable(),
    /** Whether the broker confirmed the whole process scope exited. */
    scope: z.boolean(),
  }).strict(),
])

/** One validated client request. */
export interface BrokerRequest {
  readonly id: number
  readonly method: BrokerMethod
  readonly params: unknown
}

/** The broker's first message on a new connection. */
export interface BrokerHello {
  readonly protocol: typeof BROKER_PROTOCOL
  readonly brokerUid: number
  readonly environmentIds: readonly string[]
  readonly manifestDigest: string
}

/** A broker request reply. */
export type BrokerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly code: string; readonly message: string }

/** A streamed broker event. */
export type BrokerEvent =
  | ({ readonly event: 'hello' } & BrokerHello)
  | { readonly event: 'stdout' | 'stderr'; readonly process: number; readonly data: string }
  | { readonly event: 'exit'; readonly process: number; readonly exitCode: number | null; readonly signal: string | null; readonly scope: boolean }

/** A stable broker refusal; the Host maps it to a tool/result code. */
export class BrokerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BrokerError'
  }
}

/**
 * Validate one request line.
 * @param value - parsed JSON.
 * @returns the request, with its params narrowed by the method schema.
 * @throws {BrokerError} `protocol-invalid` for any shape or bound violation.
 */
export function parseBrokerRequest(value: unknown): BrokerRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) throw new BrokerError('protocol-invalid', 'invalid broker request or protocol version')
  const params = paramsByMethod[parsed.data.method].safeParse(parsed.data.params)
  if (!params.success) throw new BrokerError('protocol-invalid', `invalid ${parsed.data.method} params: ${params.error.issues[0]?.message ?? 'shape'}`)
  return { id: parsed.data.id, method: parsed.data.method, params: params.data }
}

/** Validate one reply line. */
export function parseBrokerReply(value: unknown): BrokerReply {
  const parsed = replySchema.safeParse(value)
  if (!parsed.success) throw new BrokerError('protocol-invalid', 'invalid broker reply')
  return parsed.data
}

/** Validate one event line (including the required hello). */
export function parseBrokerEvent(value: unknown): BrokerEvent {
  const parsed = eventSchema.safeParse(value)
  if (!parsed.success) throw new BrokerError('protocol-invalid', 'invalid broker event or protocol version')
  return parsed.data
}

/** Encode a binary field, refusing anything above {@link MAX_DATA}. */
export function encodeData(buffer: Buffer): string {
  if (buffer.length > MAX_DATA) throw new BrokerError('too-large', 'the binary field exceeds the broker budget')
  return buffer.toString('base64')
}

/** Decode a binary field, refusing anything above {@link MAX_DATA}. */
export function decodeData(text: string): Buffer {
  const buffer = Buffer.from(text, 'base64')
  if (buffer.length > MAX_DATA) throw new BrokerError('too-large', 'the binary field exceeds the broker budget')
  return buffer
}

/**
 * Read newline-delimited JSON from one channel.
 * @param channel - the authenticated connection.
 * @param body - called once per complete line.
 * @param overflow - called before the channel is destroyed on an oversized line.
 */
export function readBrokerLines(channel: Channel, body: (value: unknown) => void, overflow: (error: Error) => void): void {
  let data = Buffer.alloc(0)
  channel.on('data', (chunk: Buffer) => {
    try {
      if (data.length + chunk.length > MAX_LINE) throw new BrokerError('too-large', 'the broker line exceeds its budget')
      data = Buffer.concat([data, chunk])
      for (;;) {
        const end = data.indexOf(10)
        if (end < 0) break
        const line = data.subarray(0, end)
        data = data.subarray(end + 1)
        if (line.length === 0) continue
        body(JSON.parse(line.toString('utf8')))
      }
    } catch (error) {
      overflow(error instanceof Error ? error : new Error(String(error)))
      channel.destroy()
    }
  })
}

/**
 * Write one JSON line, refusing to queue past {@link MAX_LINE}.
 * @returns whether the line was accepted.
 */
export function writeBrokerLine(channel: Channel, value: unknown): boolean {
  const text = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(text) > MAX_LINE || (channel.writableLength ?? 0) + Buffer.byteLength(text) > MAX_LINE) {
    channel.destroy()
    return false
  }
  channel.write(text)
  return true
}
