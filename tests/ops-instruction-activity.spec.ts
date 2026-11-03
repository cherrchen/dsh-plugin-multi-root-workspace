import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { normalizeOpsFileActivity, pendingInstructionTargets } from '../src/compat/instruction-activity.ts'

let base: string
let cwd: string
let a: string
let b: string
let c: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ops-activity-'))
  cwd = join(base, 'cwd')
  a = join(base, 'a.txt')
  b = join(base, 'b.txt')
  c = join(base, 'c.txt')
  mkdirSync(cwd, { recursive: true })
  for (const file of [a, b, c]) writeFileSync(file, 'x')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

const canon = (path: string) => canonicalPath(path)
const REV = 'ab'.repeat(32)
const REV2 = 'cd'.repeat(32)

const fileReceipt = (path: string, extra: Record<string, unknown> = {}) => ({
  bytes: 1, changed: 0, complete: true, failed: 0,
  items: [{ line: 1, path, text: 'x' }],
  lineCount: 1, matched: 1, nextOffset: 2, omitted: 0, path, phase: 'verify',
  revision: REV, skipped: 0, status: 'completed', total: 1, truncated: false, ...extra,
})
const readFilesReceipt = (items: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  changed: 0, complete: true, effectState: 'none', failed: 0, items,
  matched: items.length, nextIndex: items.length, pending: 0, phase: 'verify',
  status: 'completed', total: items.length, truncated: false, ...extra,
})
const writeFacts = (path: string, extra: Record<string, unknown> = {}) => ({
  bytes: 1, bytesAfter: 1, bytesBefore: 0, lineCount: 1, path, revision: REV2, revisionBefore: 'absent', ...extra,
})
const writeReceipt = (items: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  bytes: 1, changed: 1, complete: true, dryRun: false, items,
  lineCount: 1, phase: 'verify', revision: REV2, status: 'completed', ...extra,
})
const removeItem = (path: string) => ({ path, removed: true })
const errorReceipt = (effectState = 'none') => ({
  status: 'error',
  error: { code: 'ACCESS_DENIED', effectState, message: 'denied', phase: 'preflight', retryable: false },
})

const readInput = (over: Record<string, unknown> = {}) => ({
  name: 'ops_read_files', args: { files: [{ path: a }] }, cwd,
  finalValue: readFilesReceipt([fileReceipt(a)]), observedPaths: [a], ...over,
})
const writeInput = (over: Record<string, unknown> = {}) => ({
  name: 'ops_write_file', args: { path: a, content: 'y' }, cwd,
  finalValue: writeReceipt([writeFacts(a)]), observedPaths: [a], ...over,
})

describe('normalizeOpsFileActivity — receipt envelope', () => {
  it('requires a recognized receipt status for native reads', () => {
    for (const status of [undefined, 'unknown', 'rejected', 'conflict']) {
      const activity = normalizeOpsFileActivity(readInput({
        finalValue: { ...readFilesReceipt([fileReceipt(a)]), status },
      }))
      expect(activity, String(status)).toEqual({ targets: [], complete: false })
    }
  })

  it('validates the PTC wrapper before reading data; outer failures grant nothing', () => {
    for (const status of ['error', 'rejected', 'conflict', 'unknown']) {
      const activity = normalizeOpsFileActivity(readInput({
        finalValue: { status, data: readFilesReceipt([fileReceipt(a)]) },
      }))
      expect(activity, status).toEqual({ targets: [], complete: false })
    }
    const good = normalizeOpsFileActivity(readInput({
      finalValue: { status: 'completed', data: readFilesReceipt([fileReceipt(a)]) },
    }))
    expect(good).toEqual({ targets: [{ path: canon(a), kind: 'read' }], complete: true })
  })

  it('does not let a completed status hide a receipt-level error', () => {
    const activity = normalizeOpsFileActivity(readInput({
      finalValue: { status: 'completed', error: { code: 'X' }, data: readFilesReceipt([fileReceipt(a)]) },
    }))
    expect(activity.targets).toEqual([])
    expect(activity.complete).toBe(false)
  })

  it('maps a native error with effectState none to a complete empty activity', () => {
    expect(normalizeOpsFileActivity(writeInput({ isError: true, finalValue: errorReceipt('none'), observedPaths: [] })))
      .toEqual({ targets: [], complete: true })
    expect(normalizeOpsFileActivity(writeInput({ isError: true, finalValue: errorReceipt('applied'), observedPaths: [] })))
      .toEqual({ targets: [], complete: false })
  })
})

describe('normalizeOpsFileActivity — reads', () => {
  it('keeps proven siblings of a partial read_files and refuses misordered items', () => {
    const activity = normalizeOpsFileActivity(readInput({
      args: { files: [{ path: a }, { path: b }, { path: c }] },
      finalValue: readFilesReceipt([fileReceipt(a), fileReceipt(c), fileReceipt(b)], { complete: false, failed: 0 }),
      observedPaths: [a, b, c],
    }))
    expect(activity.targets).toEqual([{ path: canon(a), kind: 'read' }])
    expect(activity.complete).toBe(false)
  })

  it('requires status, a 64-hex revision, safe bytes, index and observation per item', () => {
    const bad = [
      readInput({ finalValue: readFilesReceipt([{ ...fileReceipt(a), status: 'error', error: { code: 'X' } }]) }),
      readInput({ finalValue: readFilesReceipt([{ ...fileReceipt(a), revision: 'zzz' }]) }),
      readInput({ finalValue: readFilesReceipt([{ ...fileReceipt(a), bytes: -1 }]) }),
      readInput({ observedPaths: [b] }),
      readInput({ finalValue: readFilesReceipt([fileReceipt(b)]) }),
      readInput({ finalValue: readFilesReceipt([{ ...fileReceipt(a), status: 'pending' }], { pending: 1, complete: false }) }),
      readInput({ finalValue: readFilesReceipt([fileReceipt(a)], { complete: true, failed: 1 }) }),
    ]
    for (const [index, input] of bad.entries()) {
      const activity = normalizeOpsFileActivity(input)
      expect(activity.complete, `case ${index}`).toBe(false)
    }
    expect(normalizeOpsFileActivity(bad[4]! as never).targets).toEqual([])
    expect(normalizeOpsFileActivity(bad[3]! as never).targets).toEqual([])
  })

  it('fails closed on a request over 32 files and a partial outer status', () => {
    const over = normalizeOpsFileActivity(readInput({
      args: { files: Array(33).fill({ path: a }) },
      finalValue: readFilesReceipt([fileReceipt(a)], { total: 33, matched: 33 }),
    }))
    expect(over).toEqual({ targets: [], complete: false })
    const partial = normalizeOpsFileActivity(readInput({
      finalValue: { status: 'partial', data: readFilesReceipt([fileReceipt(a)]) },
    }))
    expect(partial.targets).toEqual([{ path: canon(a), kind: 'read' }])
    expect(partial.complete).toBe(false)
  })

  it('dedupes the same path at multiple requested indexes', () => {
    const activity = normalizeOpsFileActivity(readInput({
      args: { files: [{ path: a }, { path: a }] },
      finalValue: readFilesReceipt([fileReceipt(a), fileReceipt(a)], { total: 2, matched: 2 }),
      observedPaths: [a],
    }))
    expect(activity).toEqual({ targets: [{ path: canon(a), kind: 'read' }], complete: true })
  })

  it('reads inspect and stat from their own receipt evidence', () => {
    const inspect = normalizeOpsFileActivity({
      name: 'ops_inspect_local_file', args: { path: a }, cwd,
      finalValue: fileReceipt(a), observedPaths: [a],
    })
    expect(inspect).toEqual({ targets: [{ path: canon(a), kind: 'read' }], complete: true })
    const noTopPath = { ...fileReceipt(a) }
    delete noTopPath.path
    const derived = normalizeOpsFileActivity({
      name: 'ops_inspect_local_file', args: { path: a }, cwd,
      finalValue: noTopPath, observedPaths: [a],
    })
    expect(derived).toEqual({ targets: [{ path: canon(a), kind: 'read' }], complete: true })
    const mixedRows = { ...noTopPath, items: [{ line: 1, path: a, text: 'x' }, { line: 1, path: b, text: 'y' }] }
    expect(normalizeOpsFileActivity({
      name: 'ops_inspect_local_file', args: { path: a }, cwd,
      finalValue: mixedRows, observedPaths: [a, b],
    })).toEqual({ targets: [], complete: false })
    const rowError = { ...noTopPath, items: [{ line: 1, path: a, text: 'x', error: { code: 'X' } }] }
    expect(normalizeOpsFileActivity({
      name: 'ops_inspect_local_file', args: { path: a }, cwd,
      finalValue: rowError, observedPaths: [a],
    })).toEqual({ targets: [], complete: false })
    const stat = normalizeOpsFileActivity({
      name: 'ops_stat', args: { path: a }, cwd,
      finalValue: { bytes: 1, complete: true, exists: true, lineCount: 1, mode: '0644', path: a, readonly: false, revision: REV, status: 'completed' },
      observedPaths: [a],
    })
    expect(stat).toEqual({ targets: [{ path: canon(a), kind: 'read' }], complete: true })
    const statDenied = normalizeOpsFileActivity({
      name: 'ops_stat', args: { path: a }, cwd,
      finalValue: { bytes: 1, complete: true, exists: false, path: a, revision: REV, status: 'completed' }, observedPaths: [a],
    })
    expect(statDenied).toEqual({ targets: [], complete: false })
  })

  it('stays incomplete for unadapted names', () => {
    for (const name of ['ops_grep', 'ops_glob', 'ops_batch', 'ops_result', 'ops_bash', 'ops_discover_tools', 'ops_mystery', 'read']) {
      expect(normalizeOpsFileActivity({ name, args: {}, cwd, finalValue: {}, observedPaths: [] }), name)
        .toEqual({ targets: [], complete: false })
    }
  })
})

describe('normalizeOpsFileActivity — mutations', () => {
  it('requires completed status, verify phase and a positive changed count', () => {
    const bad = [
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), status: 'partial' } }),
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), phase: 'plan' } }),
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), phase: undefined } }),
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), changed: 'x' } }),
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), error: { code: 'X' } } }),
      writeInput({ finalValue: { ...writeReceipt([writeFacts(a)]), status: 'unknown', complete: true } }),
    ]
    for (const [index, input] of bad.entries()) {
      expect(normalizeOpsFileActivity(input).targets, `case ${index}`).toEqual([])
      expect(normalizeOpsFileActivity(input).complete, `case ${index}`).toBe(false)
    }
  })

  it('records write, copy destination, and remove from real item shapes', () => {
    expect(normalizeOpsFileActivity(writeInput())).toEqual({
      targets: [{ path: canon(a), kind: 'write' }], complete: true,
    })
    const copy = normalizeOpsFileActivity({
      name: 'ops_copy', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(b)]), observedPaths: [a, b],
    })
    expect(copy).toEqual({ targets: [{ path: canon(b), kind: 'write' }], complete: true })
    const remove = normalizeOpsFileActivity({
      name: 'ops_remove', args: { path: a }, cwd,
      finalValue: writeReceipt([removeItem(a)], { revisionBefore: REV, items: [removeItem(a)] }), observedPaths: [a],
    })
    expect(remove).toEqual({ targets: [{ path: canon(a), kind: 'remove' }], complete: true })
    const removeMissing = normalizeOpsFileActivity({
      name: 'ops_remove', args: { path: a }, cwd,
      finalValue: writeReceipt([{ path: a, status: 'completed' }]), observedPaths: [a],
    })
    expect(removeMissing).toEqual({ targets: [], complete: false })
  })

  it('records move source remove only from its own removed item and observation', () => {
    const move = normalizeOpsFileActivity({
      name: 'ops_move', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(b), removeItem(a)]), observedPaths: [a, b],
    })
    expect(move).toEqual({
      targets: [{ path: canon(b), kind: 'write' }, { path: canon(a), kind: 'remove' }],
      complete: true,
    })
    const noSourceItem = normalizeOpsFileActivity({
      name: 'ops_move', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(b)]), observedPaths: [a, b],
    })
    expect(noSourceItem).toEqual({ targets: [{ path: canon(b), kind: 'write' }], complete: false })
    const sourceAsWrite = normalizeOpsFileActivity({
      name: 'ops_copy', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(a)]), observedPaths: [a, b],
    })
    expect(sourceAsWrite).toEqual({ targets: [], complete: false })
    const moveUnobservedSource = normalizeOpsFileActivity({
      name: 'ops_move', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(b), removeItem(a)]), observedPaths: [b],
    })
    expect(moveUnobservedSource).toEqual({ targets: [{ path: canon(b), kind: 'write' }], complete: false })
    const destMarked = normalizeOpsFileActivity({
      name: 'ops_move', args: { path: a, to: b }, cwd,
      finalValue: writeReceipt([writeFacts(b, { removed: true })]), observedPaths: [a, b],
    })
    expect(destMarked).toEqual({ targets: [], complete: false })
  })

  it('bounds replace targets to files under the requested directory', () => {
    const sub = join(cwd, 'sub')
    mkdirSync(sub, { recursive: true })
    const inside1 = join(sub, 'one.txt')
    const inside2 = join(sub, 'two.txt')
    writeFileSync(inside1, 'x'); writeFileSync(inside2, 'x')
    const activity = normalizeOpsFileActivity({
      name: 'ops_replace', args: { path: cwd, pattern: 'x', replacement: 'y' }, cwd,
      finalValue: writeReceipt([writeFacts(inside1), writeFacts(inside2), writeFacts(inside1)], {
        changed: 3, items: [writeFacts(inside1), writeFacts(inside2), writeFacts(inside1)],
      }),
      observedPaths: [inside1, inside2],
    })
    expect(activity.targets).toEqual([
      { path: canon(inside1), kind: 'write' },
      { path: canon(inside2), kind: 'write' },
    ])
    expect(activity.complete).toBe(true)
  })

  it('treats proven dryRun, planned and no-op receipts as complete-empty; unknown stays incomplete', () => {
    const dryRun = normalizeOpsFileActivity({
      name: 'ops_write_file', args: { path: a, content: 'y', dryRun: true }, cwd,
      finalValue: writeReceipt([writeFacts(a)], { dryRun: true }), observedPaths: [a],
    })
    expect(dryRun).toEqual({ targets: [], complete: true })
    const observeDryRun = normalizeOpsFileActivity({
      name: 'ops_write_file', args: { path: a, content: 'y' }, cwd,
      finalValue: { status: 'completed', phase: 'observe', changed: 0, complete: true, dryRun: true, items: [] },
      observedPaths: [a],
    })
    expect(observeDryRun).toEqual({ targets: [], complete: true })
    const noop = normalizeOpsFileActivity(writeInput({
      finalValue: { status: 'completed', phase: 'verify', changed: 0, complete: true, items: [] },
    }))
    expect(noop).toEqual({ targets: [], complete: true })
    const unknown = normalizeOpsFileActivity(writeInput({
      finalValue: { status: 'unknown', phase: 'verify', changed: 0, complete: true, items: [] },
    }))
    expect(unknown).toEqual({ targets: [], complete: false })
  })
})

describe('pendingInstructionTargets', () => {
  it('keeps official fs tools at file_path and preserves the old no-throw shape', () => {
    expect(pendingInstructionTargets('read', { file_path: ' x.md ' })).toEqual(['x.md'])
    expect(pendingInstructionTargets('read', {})).toEqual([])
    expect(pendingInstructionTargets('read', '{invalid')).toEqual([])
  })

  it('returns fixed paths for supported OPS tools', () => {
    expect(pendingInstructionTargets('ops_inspect_local_file', { path: ' p ' })).toEqual(['p'])
    expect(pendingInstructionTargets('ops_stat', { path: '/abs' })).toEqual(['/abs'])
    expect(pendingInstructionTargets('ops_read_files', { files: [{ path: 'a' }, { path: 'b' }] })).toEqual(['a', 'b'])
    expect(pendingInstructionTargets('ops_copy', { path: 'a', to: 'b' })).toEqual(['a', 'b'])
    expect(pendingInstructionTargets('ops_move', { path: 'a', to: 'b' })).toEqual(['a', 'b'])
    expect(pendingInstructionTargets('ops_remove', { path: 'a' })).toEqual(['a'])
  })

  it('returns empty only for publish tools and non-OPS names', () => {
    expect(pendingInstructionTargets('ops_discover_tools', {})).toEqual([])
    expect(pendingInstructionTargets('ops_load_sdk', {})).toEqual([])
    expect(pendingInstructionTargets('bash', { command: 'x' })).toEqual([])
  })

  it('throws for dynamic OPS targets — ops_status included — and incomplete arguments', () => {
    for (const name of ['ops_replace', 'ops_batch', 'ops_result', 'ops_bash', 'ops_status', 'ops_mystery']) {
      expect(() => pendingInstructionTargets(name, {}), name).toThrow('review-context')
    }
    expect(() => pendingInstructionTargets('ops_read_files', { files: [] })).toThrow('review-context')
    expect(() => pendingInstructionTargets('ops_read_files', { files: Array(33).fill({ path: 'a' }) })).toThrow('review-context')
    expect(() => pendingInstructionTargets('ops_copy', { path: 'a' })).toThrow('review-context')
  })
})

describe('replayedInstructionTargets — OPS live evidence', () => {
  it('requires live evidence for completed OPS calls and merges proven targets', async () => {
    const { replayedInstructionTargets, opsActivityEvidenceKey, stableOpsJson } = await import('../src/compat/instruction-activity.ts')
    const { createHash } = await import('node:crypto')
    const args = { path: a }
    const key = opsActivityEvidenceKey('native', 'c1', 'ops_read_files', { files: [{ path: a }] })
    const events = [
      { type: 'tool/call', data: { callId: 'c1', name: 'ops_read_files', arguments: JSON.stringify({ files: [{ path: a }] }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }] } } },
    ]
    const evidence = new Map([[key, { targets: [{ path: canonicalPath(a), kind: 'read' as const }], complete: true }]])
    expect(replayedInstructionTargets(events, cwd, evidence, undefined, { opsCompatibility: true })).toEqual([canonicalPath(a)])
    expect(() => replayedInstructionTargets(events, cwd, undefined, undefined, { opsCompatibility: true })).toThrow('review-context')
    expect(() => replayedInstructionTargets(events, cwd, new Map(), undefined, { opsCompatibility: true })).toThrow('review-context')
    expect(() => replayedInstructionTargets(events, cwd, new Map([[key, { targets: [], complete: false }]]), undefined, { opsCompatibility: true })).toThrow('review-context')
    expect(createHash('sha256').update(stableOpsJson(args)).digest('hex').length).toBe(64)
  })

  it('matches PTC subcalls by subCallId and exempts publish tools and the exact pending exec', async () => {
    const { replayedInstructionTargets, opsActivityEvidenceKey } = await import('../src/compat/instruction-activity.ts')
    const ptcKey = opsActivityEvidenceKey('ptc', 'sub9', 'ops_read_files', { files: [{ path: a }] })
    const events = [
      { type: 'tool/ptc-dispatch-start', data: { subCallId: 'sub9', name: 'ops_read_files', arguments: { files: [{ path: a }] } } },
      { type: 'tool/ptc-dispatch', data: { subCallId: 'sub9', isError: false } },
      { type: 'tool/call', data: { callId: 'pub', name: 'ops_discover_tools', arguments: '{}' } },
      { type: 'tool/result', data: { message: { source: { callId: 'pub' }, content: [{ type: 'tool-result', toolCallId: 'pub', content: [], isError: false }] } } },
      { type: 'tool/call', data: { callId: 'cur', name: 'ops_write_file', arguments: JSON.stringify({ path: b }) } },
    ]
    const evidence = new Map([[ptcKey, { targets: [{ path: canonicalPath(a), kind: 'read' as const }], complete: true }]])
    expect(replayedInstructionTargets(events, cwd, evidence, { callId: 'cur', name: 'ops_write_file', arguments: { path: b } }, { opsCompatibility: true }))
      .toEqual([canonicalPath(a)])
    expect(() => replayedInstructionTargets(events, cwd, evidence, undefined, { opsCompatibility: true })).toThrow('review-context')
    expect(() => replayedInstructionTargets(events, cwd, evidence, { callId: 'other', name: 'ops_write_file', arguments: { path: b } }, { opsCompatibility: true })).toThrow('review-context')
  })

  it('honours effect-none evidence on a failed OPS call and still requires it', async () => {
    const { replayedInstructionTargets, opsActivityEvidenceKey } = await import('../src/compat/instruction-activity.ts')
    const key = opsActivityEvidenceKey('native', 'c2', 'ops_write_file', { path: a })
    const events = [
      { type: 'tool/call', data: { callId: 'c2', name: 'ops_write_file', arguments: JSON.stringify({ path: a }) } },
      { type: 'tool/result', data: { error: { code: 'ACCESS_DENIED' }, message: { source: { callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [], isError: true }] } } },
    ]
    const evidence = new Map([[key, { targets: [], complete: true }]])
    expect(replayedInstructionTargets(events, cwd, evidence, undefined, { opsCompatibility: true })).toEqual([])
    expect(() => replayedInstructionTargets(events, cwd, new Map(), undefined, { opsCompatibility: true })).toThrow('review-context')
  })
})
