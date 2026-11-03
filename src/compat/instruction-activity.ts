/** Public durable file activity, normalized without loading an optional tool runtime. */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { toolResultFailed, type ToolResultFailureShape } from './tool-result.ts'

export type FileActivity =
  | { kind: 'start'; id: string; name: string; arguments: string }
  | { kind: 'end'; id: string; failed: boolean }

interface DurableActivity {
  type: string
  data: {
    cwd?: unknown
    callId?: unknown
    subCallId?: unknown
    name?: unknown
    arguments?: unknown
    isError?: unknown
    error?: unknown
    message?: ToolResultFailureShape & { source?: { callId?: unknown } }
  }
}

export function ptcFileActivity(event: unknown): FileActivity | undefined {
  const row = event as DurableActivity
  const data = row.data
  if (typeof data?.subCallId !== 'string') return undefined
  const id = `ptc:${data.subCallId}`
  if (row.type === 'tool/ptc-dispatch-start' && typeof data.name === 'string') {
    const args = JSON.stringify(data.arguments)
    if (args === undefined) throw new Error('review-context: incomplete durable PTC action')
    return { kind: 'start', id, name: data.name, arguments: args }
  }
  if (row.type === 'tool/ptc-dispatch') {
    return { kind: 'end', id, failed: data.isError !== false || data.error !== undefined }
  }
  return undefined
}

const OPS_STABLE_MAX_BYTES = 2 * 1024 * 1024

export function stableOpsJson(value: unknown): string {
  const seen = new Set<object>()
  let nodes = 0, bytes = 0
  const over = (): never => { throw new Error('multi-root workspace: OPS fingerprint exceeded its budget') }
  const walk = (entry: unknown, depth: number): unknown => {
    if (depth > 24) over()
    nodes += 1
    if (nodes > 65536) over()
    if (entry === undefined) over()
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      if (typeof entry === 'string') { bytes += entry.length; if (bytes > OPS_STABLE_MAX_BYTES) over() }
      return entry
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) over()
      return entry
    }
    if (typeof entry !== 'object' || entry === null) over()
    const obj = entry as object
    if (seen.has(obj)) over()
    seen.add(obj)
    if (Array.isArray(obj)) {
      const out = obj.map(item => walk(item, depth + 1))
      seen.delete(obj)
      return out
    }
    const keys = Object.keys(obj)
    if (keys.length > 4096) over()
    for (const key of keys) { bytes += key.length; if (bytes > OPS_STABLE_MAX_BYTES) over() }
    const out = Object.fromEntries(keys.sort().map(key => [key, walk((obj as Record<string, unknown>)[key], depth + 1)]))
    seen.delete(obj)
    return out
  }
  const json = JSON.stringify(walk(value, 0))
  if (json === undefined || Buffer.byteLength(json, 'utf8') > OPS_STABLE_MAX_BYTES) over()
  return json
}

const OPS_OPSID = (kind: 'native' | 'ptc', id: string, name: string, args: unknown): string =>
  JSON.stringify([kind, id, name, createHash('sha256').update(stableOpsJson(args)).digest('hex')])
export const opsActivityEvidenceKey = OPS_OPSID

export interface OpsActivityEvidence {
  readonly targets: readonly OpsFileTarget[]
  readonly complete: boolean
}

const OPS_PUBLISH: Record<string, true> = { ops_discover_tools: true, ops_load_sdk: true }

/** Rebuild read-only discovery candidates from successful durable activity after resume. */
export function replayedInstructionTargets(events: readonly unknown[], origin: string | undefined,
  liveOpsEvidence?: ReadonlyMap<string, OpsActivityEvidence>,
  pendingExec?: { readonly callId: string; readonly name: string; readonly arguments: unknown; readonly parent?: unknown }): readonly string[] {
  let cwd = origin
  const pending = new Map<string, { kind: 'native' | 'ptc'; id: string; name: string; arguments: string; directories: Set<string> }>()
  const eventsPrior = new Map<string, { name: string }>()
  const ended = new Set<string>()
  const paths = new Set<string>()
  const isCurrentExec = (call: { kind: 'native' | 'ptc'; id: string; name: string; arguments: string }): boolean => {
    if (pendingExec === undefined || call.name !== pendingExec.name) return false
    const kind = pendingExec.parent === undefined ? 'native' : 'ptc'
    if (call.kind !== kind || call.id !== pendingExec.callId) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
      return stableOpsJson(parsed) === stableOpsJson(pendingExec.arguments)
    } catch { return false }
  }
  const opsEntry = (call: { kind: 'native' | 'ptc'; id: string; name: string; arguments: string }): OpsActivityEvidence => {
    if (liveOpsEvidence === undefined) throw new Error('review-context: OPS file activity lacks live evidence')
    let parsed: unknown
    try { parsed = JSON.parse(call.arguments) } catch { throw new Error('review-context: incomplete durable OPS arguments') }
    const entry = liveOpsEvidence.get(OPS_OPSID(call.kind, call.id, call.name, parsed))
    if (entry === undefined) throw new Error('review-context: OPS file activity lacks live evidence')
    if (entry.complete !== true) throw new Error('review-context: incomplete OPS file activity evidence')
    return entry
  }
  for (const raw of events) {
    const event = raw as DurableActivity
    if (event.type === 'working-directory/change' && typeof event.data.cwd === 'string') {
      cwd = event.data.cwd
      for (const call of pending.values()) call.directories.add(cwd)
      continue
    }
    const ptc = ptcFileActivity(event)
    if (event.type === 'tool/call' || ptc?.kind === 'start') {
      const call = ptc?.kind === 'start'
        ? { callId: ptc.id, name: ptc.name, arguments: ptc.arguments }
        : event.data
      if (typeof call.callId !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
        throw new Error('review-context: incomplete durable file activity')
      }
      const kind = ptc?.kind === 'start' ? 'ptc' : 'native'
      const id = ptc?.kind === 'start' ? ptc.id.slice(4) : call.callId
      const key = JSON.stringify([kind, id])
      if (call.name.startsWith('ops_') && (pending.has(key) || ended.has(key))) {
        throw new Error('review-context: duplicate durable OPS call')
      }
      pending.set(key, {
        kind, id, name: call.name, arguments: call.arguments,
        directories: new Set(cwd === undefined ? [] : [cwd]),
      })
      if (pending.size > 512) throw new Error('review-context: durable activity index exceeded')
      continue
    }
    if (event.type !== 'tool/result' && ptc?.kind !== 'end') continue
    const message = event.data.message
    const rawId = ptc?.kind === 'end' ? ptc.id : message?.source?.callId
    if (typeof rawId !== 'string') throw new Error('review-context: incomplete durable result')
    const kind = ptc?.kind === 'end' ? 'ptc' : 'native'
    const id = ptc?.kind === 'end' ? ptc.id.slice(4) : rawId
    const key = JSON.stringify([kind, id])
    const call = pending.get(key)
    if (call === undefined) {
      const prior = eventsPrior.get(key)
      if (prior !== undefined && prior.name.startsWith('ops_') && OPS_PUBLISH[prior.name] !== true) {
        throw new Error('review-context: duplicate durable OPS result')
      }
      continue
    }
    pending.delete(key)
    if (call.name.startsWith('ops_') && OPS_PUBLISH[call.name] !== true) {
      eventsPrior.set(key, call)
      ended.add(key)
      if (ended.size > 512) throw new Error('review-context: durable OPS result index exceeded')
    }
    const failed = ptc?.kind === 'end'
      ? ptc.failed
      : event.data.error !== undefined || toolResultFailed(message ?? {})
    if (call.name.startsWith('ops_') && OPS_PUBLISH[call.name] !== true) {
      const entry = opsEntry(call)
      if (failed && entry.targets.length > 0) {
        throw new Error('review-context: OPS activity contradicts its durable failure')
      }
      for (const target of entry.targets) paths.add(target.path)
      if (paths.size > 512) throw new Error('review-context: durable work index exceeded')
      continue
    }
    if (failed) continue
    const path = touchedPathOfToolCall(call.name, call.arguments)
    if (path === undefined) continue
    if (isAbsolute(path)) paths.add(path)
    else {
      if (call.directories.size === 0) throw new Error('review-context: durable file activity has no cwd')
      // No canonical observation is persisted for a relative operation spanning
      // cwd changes. Inspect all known candidate chains without recording a touch.
      for (const directory of call.directories) paths.add(resolve(directory, path))
    }
    if (paths.size > 512) throw new Error('review-context: durable work index exceeded')
  }
  for (const call of pending.values()) {
    if (!call.name.startsWith('ops_') || OPS_PUBLISH[call.name] === true) continue
    if (isCurrentExec(call)) continue
    throw new Error('review-context: OPS file activity has no final result')
  }
  return [...paths]
}

/** fs tools whose success touches the file at their `file_path` argument. */
export const FILE_TOUCH_TOOL_NAMES: Record<string, true> = { read: true, write: true, edit: true }

/** One explicit fs-tool target, shared with live touch capture. */
export function touchedPathOfToolCall(name: string, argumentsJson: string): string | undefined {
  if (FILE_TOUCH_TOOL_NAMES[name] !== true) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(argumentsJson) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || !('file_path' in parsed) || typeof parsed.file_path !== 'string') return undefined
  return parsed.file_path.trim() || undefined
}

export interface OpsFileActivityInput {
  name: string
  args: unknown
  cwd: string | undefined
  finalValue: unknown
  observedPaths: readonly string[]
  isError?: boolean
}

export interface OpsFileTarget {
  path: string
  kind: 'read' | 'write' | 'remove'
}

export interface OpsFileActivity {
  targets: readonly OpsFileTarget[]
  complete: boolean
}

const OPS_READ_TARGETS: Record<string, true> = { inspect_local_file: true, stat: true, read_files: true }
const OPS_WRITE_TARGETS: Record<string, true> = { write_file: true, edit_file: true, replace: true, copy: true }
const OPS_TARGETS: Record<string, true> = { ...OPS_READ_TARGETS, ...OPS_WRITE_TARGETS, move: true, remove: true }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  try {
    return canonicalPath(path)
  } catch {
    return undefined
  }
}

function itemPath(item: unknown): string | undefined {
  if (!record(item) || typeof item.path !== 'string' || item.path === '') return undefined
  return item.path
}

function canonicalizeArg(path: unknown, cwd: string | undefined): string | undefined {
  if (typeof path !== 'string' || path.trim() === '') return undefined
  const absolute = isAbsolute(path) ? path : cwd === undefined ? undefined : resolve(cwd, path)
  return absolute === undefined ? undefined : canonicalize(absolute)
}

function requestCanonicals(name: string, args: unknown, cwd: string | undefined): readonly string[] | undefined {
  if (!record(args)) return undefined
  if (name === 'ops_read_files') {
    if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 32) return undefined
    const paths = args.files.map(file => canonicalizeArg(record(file) ? file.path : undefined, cwd))
    return paths.every(path => path !== undefined) ? paths as string[] : undefined
  }
  const path = canonicalizeArg(args.path, cwd)
  if (path === undefined) return undefined
  const to = name === 'ops_copy' || name === 'ops_move' ? canonicalizeArg(args.to, cwd) : undefined
  if ((name === 'ops_copy' || name === 'ops_move') && to === undefined) return undefined
  return to === undefined ? [path] : [path, to]
}

function observed(observedPaths: readonly string[], path: string): boolean {
  const canonical = canonicalize(path)
  return canonical !== undefined && observedPaths.some(candidate => canonicalize(candidate) === canonical)
}

const REVISION = /^[0-9a-f]{64}$/
const safeBytes = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function dedupe(targets: OpsFileTarget[]): readonly OpsFileTarget[] {
  const seen = new Set<string>()
  return targets.filter(target => {
    const key = `${target.kind}:${canonicalize(target.path) ?? target.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const inside = (directory: string, path: string): boolean => {
  const rel = relative(directory, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function normalizeOpsFileActivity(input: OpsFileActivityInput): OpsFileActivity {
  const bare = input.name.startsWith('ops_') ? input.name.slice(4) : undefined
  if (bare === undefined || OPS_TARGETS[bare] !== true) return { targets: [], complete: false }
  const value = input.finalValue
  if (input.isError === true) {
    return { targets: [], complete: record(value) && record(value.error) && value.error.effectState === 'none' }
  }
  if (!record(value) || typeof value.status !== 'string') return { targets: [], complete: false }
  if (value.status === 'error') {
    const effect = record(value.error) ? value.error.effectState : undefined
    return { targets: [], complete: effect === 'none' }
  }
  if (value.status !== 'completed' && value.status !== 'partial') return { targets: [], complete: false }
  const receipt = 'data' in value ? (record(value.data) ? value.data : undefined) : value
  if (!record(receipt)) return { targets: [], complete: false }
  const outerPartial = value.status === 'partial'
  const incomplete = record(value.error) || record(receipt.error)
    || (typeof receipt.status === 'string' && receipt.status !== 'completed' && receipt.status !== 'partial')
  if (incomplete) return { targets: [], complete: false }
  const outerCwd = typeof receipt.resolvedFrom === 'string' ? receipt.resolvedFrom : undefined
  if (outerCwd !== undefined && input.cwd !== undefined && canonicalize(outerCwd) !== canonicalize(input.cwd)) {
    return { targets: [], complete: false }
  }
  const proven = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    const canonical = canonicalize(path)
    return canonical !== undefined && observed(input.observedPaths, canonical) ? canonical : undefined
  }

  if (OPS_WRITE_TARGETS[bare] === true || bare === 'move' || bare === 'remove') {
    const args = record(input.args) ? input.args : {}
    if (receipt.status !== 'completed') return { targets: [], complete: false }
    if (record(receipt.error)) return { targets: [], complete: false }
    const dryRun = args.dryRun === true || receipt.dryRun === true || receipt.planned === true
    if (dryRun) return { targets: [], complete: true }
    if (receipt.phase !== 'verify') return { targets: [], complete: false }
    if (receipt.changed === 0) return { targets: [], complete: true }
    if (typeof receipt.changed !== 'number' || !Number.isSafeInteger(receipt.changed) || receipt.changed <= 0) {
      return { targets: [], complete: false }
    }
    const items = Array.isArray(receipt.items) ? receipt.items : undefined
    if (items === undefined || items.length === 0) return { targets: [], complete: false }
    const request = requestCanonicals(input.name, input.args, input.cwd)
    const targets: OpsFileTarget[] = []
    let unproven = false
    let destProven = false
    let sourceProven = false
    for (const item of items) {
      const path = itemPath(item)
      const canonical = proven(path)
      if (path === undefined || canonical === undefined) { unproven = true; continue }
      if (record(item) && record(item.error)) { unproven = true; continue }
      if (record(item) && item.removed === true) {
        if ((bare === 'move' || bare === 'remove') && request !== undefined && request[0] === canonical) {
          targets.push({ path: canonical, kind: 'remove' })
          sourceProven = true
        } else unproven = true
        continue
      }
      if (bare === 'remove') { unproven = true; continue }
      const bytesAfter = record(item) && safeBytes(item.bytesAfter)
      const revision = record(item) && (typeof item.revision === 'string' && REVISION.test(item.revision)
        || typeof item.revisionAfter === 'string' && REVISION.test(item.revisionAfter))
      if (!bytesAfter || !revision) { unproven = true; continue }
      const bound = bare === 'replace'
        ? request !== undefined && (request[0] === canonical || inside(request[0]!, canonical))
        : request !== undefined && request[bare === 'copy' || bare === 'move' ? 1 : 0] === canonical
      if (!bound) { unproven = true; continue }
      targets.push({ path: canonical, kind: 'write' })
      destProven = true
    }
    if (bare === 'move' && (!destProven || !sourceProven)) unproven = true
    const complete = !unproven && !outerPartial
      && receipt.complete === true && (receipt.failed === undefined || receipt.failed === 0) && (receipt.pending === undefined || receipt.pending === 0)
    return { targets: dedupe(targets), complete }
  }

  if (bare === 'stat') {
    const canonical = proven(itemPath(receipt))
    const request = canonicalizeArg(record(input.args) ? input.args.path : undefined, input.cwd)
    const provenStat = canonical !== undefined && receipt.exists === true
      && typeof receipt.revision === 'string' && REVISION.test(receipt.revision)
      && safeBytes(receipt.bytes) && request === canonical
    return {
      targets: provenStat ? [{ path: canonical!, kind: 'read' }] : [],
      complete: provenStat === true && receipt.complete === true,
    }
  }

  const topItems = Array.isArray(receipt.items) ? receipt.items : undefined
  if (topItems === undefined && bare === 'inspect_local_file') return { targets: [], complete: false }
  const requests = requestCanonicals(input.name, input.args, input.cwd)
  const targets: OpsFileTarget[] = []
  let unproven = false
  if (bare === 'read_files') {
    if (topItems === undefined || requests === undefined) return { targets: [], complete: false }
    const provenIndexes = new Set<number>()
    for (const [index, item] of topItems.entries()) {
      if (!record(item) || item.status !== 'completed' || record(item.error)) { unproven = true; continue }
      const canonical = proven(itemPath(item))
      const expected = requests[index]
      if (canonical === undefined || expected === undefined || canonical !== expected) { unproven = true; continue }
      if (typeof item.revision !== 'string' || !REVISION.test(item.revision) || !safeBytes(item.bytes)) { unproven = true; continue }
      provenIndexes.add(index)
      targets.push({ path: canonical, kind: 'read' })
    }
    for (const index of requests.keys()) {
      if (!provenIndexes.has(index)) unproven = true
    }
    const complete = !unproven && !outerPartial && provenIndexes.size === requests.length
      && receipt.complete === true && (receipt.failed === undefined || receipt.failed === 0) && (receipt.pending === undefined || receipt.pending === 0)
    return { targets: dedupe(targets), complete }
  }

  if (receipt.status !== 'completed' || record(receipt.error)) return { targets: [], complete: false }
  const rows = topItems ?? []
  const request = requests?.[0]
  let path = proven(itemPath(receipt))
  let unprovenRow = false
  for (const row of rows) {
    if (!record(row) || record(row.error)) { unprovenRow = true; continue }
    const rowPath = proven(itemPath(row))
    if (rowPath === undefined) { unprovenRow = true; continue }
    const textRow = Number.isSafeInteger(row.line) && (row.line as number) > 0 && typeof row.text === 'string'
    const hexRow = row.view === 'hex' && Number.isSafeInteger(row.offset) && (row.offset as number) >= 0 && typeof row.text === 'string'
    if (!textRow && !hexRow) { unprovenRow = true; continue }
    if (path === undefined) path = rowPath
    else if (path !== rowPath) { unprovenRow = true }
  }
  const provenInspect = path !== undefined && request === path && !unprovenRow
    && typeof receipt.revision === 'string' && REVISION.test(receipt.revision)
    && safeBytes(receipt.bytes)
  return {
    targets: provenInspect === true ? [{ path: path!, kind: 'read' }] : [],
    complete: provenInspect === true && receipt.complete === true && !outerPartial,
  }
}

const PENDING_EMPTY: Record<string, true> = { discover_tools: true, load_sdk: true }
const PENDING_PATH: Record<string, true> = {
  inspect_local_file: true, stat: true, read_table: true, read_docx: true, read_pdf: true,
  write_file: true, edit_file: true, remove: true,
}
const PENDING_PAIR: Record<string, true> = { copy: true, move: true }

export function pendingInstructionTargets(name: string, args: unknown): readonly string[] {
  if (FILE_TOUCH_TOOL_NAMES[name] === true) {
    const parsed = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return undefined } })() : args
    if (!record(parsed) || typeof parsed.file_path !== 'string' || parsed.file_path.trim() === '') return []
    return [parsed.file_path.trim()]
  }
  if (!name.startsWith('ops_')) return []
  const bare = name.slice(4)
  if (PENDING_EMPTY[bare] === true) return []
  if (!record(args)) throw new Error(`review-context: ${name} arguments are incomplete`)
  if (bare === 'read_files') {
    if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 32) {
      throw new Error(`review-context: ${name} files argument is incomplete`)
    }
    return args.files.map(file => {
      if (!record(file) || typeof file.path !== 'string' || file.path.trim() === '') {
        throw new Error(`review-context: ${name} files argument is incomplete`)
      }
      return file.path.trim()
    })
  }
  if (PENDING_PAIR[bare] === true) {
    const paths = [args.path, args.to]
    if (paths.some(path => typeof path !== 'string' || (path as string).trim() === '')) {
      throw new Error(`review-context: ${name} path arguments are incomplete`)
    }
    return (paths as string[]).map(path => path.trim())
  }
  if (PENDING_PATH[bare] === true) {
    if (typeof args.path !== 'string' || args.path.trim() === '') {
      throw new Error(`review-context: ${name} path argument is incomplete`)
    }
    return [args.path.trim()]
  }
  throw new Error(`review-context: ${name} has dynamic instruction targets that cannot be determined`)
}
