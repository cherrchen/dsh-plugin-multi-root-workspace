/** Public durable file activity, normalized without loading an optional tool runtime. */
import { isAbsolute, resolve } from 'node:path'
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

/** Rebuild read-only discovery candidates from successful durable activity after resume. */
export function replayedInstructionTargets(events: readonly unknown[], origin: string | undefined): readonly string[] {
  let cwd = origin
  const pending = new Map<string, { name: string; arguments: string; directories: Set<string> }>()
  const paths = new Set<string>()
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
      pending.set(call.callId, { name: call.name, arguments: call.arguments, directories: new Set(cwd === undefined ? [] : [cwd]) })
      if (pending.size > 512) throw new Error('review-context: durable activity index exceeded')
      continue
    }
    if (event.type !== 'tool/result' && ptc?.kind !== 'end') continue
    const message = event.data.message
    const id = ptc?.kind === 'end' ? ptc.id : message?.source?.callId
    if (typeof id !== 'string') throw new Error('review-context: incomplete durable result')
    const call = pending.get(id)
    pending.delete(id)
    if (call === undefined) continue
    const failed = ptc?.kind === 'end'
      ? ptc.failed
      : event.data.error !== undefined || toolResultFailed(message ?? {})
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
  return [...paths]
}

/** One explicit fs-tool target, shared with live touch capture. */
export function touchedPathOfToolCall(name: string, argumentsJson: string): string | undefined {
  if (!['read', 'write', 'edit'].includes(name)) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(argumentsJson) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || !('file_path' in parsed) || typeof parsed.file_path !== 'string') return undefined
  return parsed.file_path.trim() || undefined
}
