/**
 * The advertised copy/bash schemas and the execute-boundary validator are one
 * declaration: every rule shown to the model is enforced at dispatch, before
 * any Registry admission or SSH I/O, with the offending field located.
 */
import { describe, expect, it } from 'vitest'
import { remoteBashTool } from '../src/remote/exec-tool.ts'
import { remoteCopyTool } from '../src/remote/transfer.ts'
import {
  parseRemoteBashArguments,
  parseRemoteCopyArguments,
  REMOTE_BASH_PARAMETERS,
  REMOTE_COPY_ENDPOINT_PARAMETERS,
  REMOTE_COPY_PARAMETERS,
  safeLabelPart,
  validateToolArguments,
  type ArgumentIssue,
  type ParsedArguments,
} from '../src/remote/tool-arguments.ts'

const endpoint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ rootId: 'primary', relativePath: 'a.txt', ...over })
const copyArgs = (from: unknown, to: unknown) => ({ from, to })

function issuesOf<T>(parsed: ParsedArguments<T>): readonly ArgumentIssue[] {
  if (parsed.ok) throw new Error('expected the arguments to be invalid')
  return parsed.issues
}

describe('remote_copy endpoint arguments', () => {
  it('uses one endpoint definition for both sides', () => {
    expect(REMOTE_COPY_PARAMETERS.properties.from).toEqual(REMOTE_COPY_PARAMETERS.properties.to)
    expect(REMOTE_COPY_PARAMETERS.properties.from).toEqual(REMOTE_COPY_ENDPOINT_PARAMETERS)
    expect(REMOTE_COPY_PARAMETERS.required).toEqual(['from', 'to'])
    expect(REMOTE_COPY_ENDPOINT_PARAMETERS.required).toEqual(['rootId', 'relativePath'])
    expect(REMOTE_COPY_PARAMETERS.additionalProperties).toBe(false)
  })

  it('defaults only an omitted environmentId to local, on both sides', () => {
    expect(parseRemoteCopyArguments(copyArgs(endpoint(), endpoint()))).toEqual({
      ok: true,
      value: {
        from: { environmentId: 'local', rootId: 'primary', relativePath: 'a.txt' },
        to: { environmentId: 'local', rootId: 'primary', relativePath: 'a.txt' },
      },
    })
  })

  it('keeps an explicit local and an explicit remote environment id', () => {
    const parsed = parseRemoteCopyArguments(copyArgs(endpoint({ environmentId: 'local' }), endpoint({ environmentId: 'build' })))
    expect(parsed).toMatchObject({ ok: true, value: { from: { environmentId: 'local' }, to: { environmentId: 'build' } } })
  })

  it('locates a missing field, a wrong type and an unknown nested field', () => {
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint(), { rootId: 'app' }))))
      .toEqual([{ path: 'to.relativePath', detail: 'is required' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint({ rootId: 5 }), endpoint()))))
      .toEqual([{ path: 'from.rootId', detail: 'must be a string' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint({ sessionId: 'forged' }), endpoint()))))
      .toEqual([{ path: 'from.sessionId', detail: 'is not an accepted field' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint(), endpoint({ toolName: 'other' })))))
      .toEqual([{ path: 'to.toolName', detail: 'is not an accepted field' }])
  })

  it('rejects unknown root fields and non-object arguments', () => {
    expect(issuesOf(parseRemoteCopyArguments({ ...copyArgs(endpoint(), endpoint()), extra: true })))
      .toEqual([{ path: 'extra', detail: 'is not an accepted field' }])
    expect(issuesOf(parseRemoteCopyArguments(null))).toEqual([{ path: '', detail: 'must be an object' }])
    expect(issuesOf(parseRemoteCopyArguments([]))).toEqual([{ path: '', detail: 'must be an object' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs('local', endpoint())))).toEqual([{ path: 'from', detail: 'must be an object' }])
  })

  it('rejects null and empty environment ids instead of defaulting them', () => {
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint({ environmentId: null }), endpoint()))))
      .toEqual([{ path: 'from.environmentId', detail: 'must be a string' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint(), endpoint({ environmentId: '' })))))
      .toEqual([{ path: 'to.environmentId', detail: 'must not be empty' }])
  })

  it('rejects an empty relativePath and an empty rootId as structural errors', () => {
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint({ relativePath: '' }), endpoint()))))
      .toEqual([{ path: 'from.relativePath', detail: 'must not be empty' }])
    expect(issuesOf(parseRemoteCopyArguments(copyArgs(endpoint(), endpoint({ rootId: '' })))))
      .toEqual([{ path: 'to.rootId', detail: 'must not be empty' }])
  })

  it('reports at most the bounded issue list', () => {
    const issues = validateToolArguments(REMOTE_COPY_PARAMETERS, {
      from: { rootId: 1, relativePath: 2, extra: 3 },
      to: { rootId: 4, relativePath: 5, extra: 6 },
      extra: 7,
    })
    expect(issues.length).toBeLessThanOrEqual(8)
    expect(issues.length).toBeGreaterThan(0)
  })
})

describe('remote_bash arguments', () => {
  const valid = { environmentId: 'build', rootId: 'app', command: 'ls', timeoutMs: 1_000 }

  it('applies the documented cwdRelative default and keeps maxOutputBytes optional', () => {
    expect(parseRemoteBashArguments(valid)).toEqual({
      ok: true,
      value: { environmentId: 'build', rootId: 'app', command: 'ls', timeoutMs: 1_000, cwdRelative: '' },
    })
    expect(parseRemoteBashArguments({ ...valid, cwdRelative: 'src/app', maxOutputBytes: 4_096 }))
      .toMatchObject({ ok: true, value: { cwdRelative: 'src/app', maxOutputBytes: 4_096 } })
  })

  it('requires the dispatch-owned fields and rejects forged ones', () => {
    expect(issuesOf(parseRemoteBashArguments({ rootId: 'app', command: 'ls', timeoutMs: 1 })))
      .toEqual([{ path: 'environmentId', detail: 'is required' }])
    expect(issuesOf(parseRemoteBashArguments({ ...valid, sessionId: 'forged', toolName: 'other' }))).toEqual([
      { path: 'sessionId', detail: 'is not an accepted field' },
      { path: 'toolName', detail: 'is not an accepted field' },
    ])
  })

  it('rejects wrong value types for the optional and numeric fields', () => {
    expect(issuesOf(parseRemoteBashArguments({ ...valid, timeoutMs: 1.5 })))
      .toEqual([{ path: 'timeoutMs', detail: 'must be an integer' }])
    expect(issuesOf(parseRemoteBashArguments({ ...valid, timeoutMs: 0 })))
      .toEqual([{ path: 'timeoutMs', detail: 'must be at least 1' }])
    expect(issuesOf(parseRemoteBashArguments({ ...valid, maxOutputBytes: 0 })))
      .toEqual([{ path: 'maxOutputBytes', detail: 'must be at least 1' }])
    expect(issuesOf(parseRemoteBashArguments({ ...valid, cwdRelative: 5 })))
      .toEqual([{ path: 'cwdRelative', detail: 'must be a string' }])
  })

  it('advertises the same required list the parser enforces', () => {
    expect(REMOTE_BASH_PARAMETERS.required).toEqual(['environmentId', 'rootId', 'command', 'timeoutMs'])
    expect(REMOTE_BASH_PARAMETERS.additionalProperties).toBe(false)
  })
})

describe('tool definitions', () => {
  it('advertises the unified copy endpoints with an upload and a download example', () => {
    const tool = remoteCopyTool({ registry: {} as never, deps: {} as never })
    expect(tool.description).toContain('Upload example:')
    expect(tool.description).toContain('Download example:')
    expect(tool.description).toContain('omitted environmentId')
    expect(tool.description).toContain('0600')
    expect(tool.description).toContain('mtime')
    expect(tool.parameters.properties.from).toEqual(tool.parameters.properties.to)
  })

  it('advertises the per-stream preview cap and its unknown totals', () => {
    const tool = remoteBashTool({ registry: {} as never, backendFor: () => undefined })
    expect(tool.description).toContain('64 KiB')
    expect(tool.description).toContain('maxOutputBytes')
    expect(tool.description).toContain('totalBytes')
    expect(tool.description).toContain('droppedBytes')
    expect(tool.description).toContain('reconcileId')
  })
})

describe('result label sanitisation', () => {
  it('bounds model-supplied fragments and strips control characters', () => {
    expect(safeLabelPart('a\nb\u0000c')).toBe('a b c')
    expect(safeLabelPart('x'.repeat(200), 20)).toBe(`${'x'.repeat(17)}...`)
    expect(safeLabelPart('short')).toBe('short')
  })
})
